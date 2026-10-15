import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
import { safe, UserError } from "./result.js";
import * as st from "./store.js";
import { issueToken, verifyToken } from "./confirm.js";
import { draftOutreach, PURPOSES } from "./outreach.js";

export const VERSION = "1.0.0";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const id = (p: string) => z.string().regex(new RegExp(`^${p}_[a-f0-9]{10}$`), `Expected an id like ${p}_0123456789`);
const confirm_token = z.string().max(200).optional().describe("Omit on the first call to get a preview. Pass the token from the preview (with identical arguments) to apply the change.");

interface Plan {
  summary: string;
  changes: unknown;
  apply: (s: st.Store) => unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyArgs = Record<string, any>;

function writeTool(
  server: McpServer,
  name: string,
  cfg: { title: string; description: string; inputSchema: ZodRawShape; destructive: boolean; idempotent?: boolean },
  plan: (s: st.Store, args: AnyArgs) => Plan,
) {
  server.registerTool(
    name,
    {
      title: cfg.title,
      description: `${cfg.description} TWO-STEP: the first call (no confirm_token) only returns a preview and a confirm_token; nothing is written. Show the preview to the user, and only after they approve call again with the same arguments plus confirm_token.`,
      inputSchema: { ...cfg.inputSchema, confirm_token },
      annotations: { readOnlyHint: false, destructiveHint: cfg.destructive, idempotentHint: cfg.idempotent ?? false, openWorldHint: false },
    },
    safe(async (all: AnyArgs) => {
      const { confirm_token: token, ...args } = all;
      const store = await st.load();
      const p = plan(store, args);
      if (!token) {
        return {
          status: "preview",
          summary: p.summary,
          changes: p.changes,
          confirm_token: issueToken(name, args, store.revision),
          next_step: `Nothing has been saved. Show this preview to the user. If they approve, call ${name} again with identical arguments plus this confirm_token (valid 10 minutes, single use).`,
        };
      }
      verifyToken(String(token), name, args, store.revision);
      const result = p.apply(store);
      store.revision += 1;
      await st.save(store);
      return { status: "applied", summary: p.summary, result };
    }) as never,
  );
}

const contactFields = {
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254).optional(),
  company: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(40).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  notes: z.string().max(2000).optional(),
};

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "solo-crm", version: VERSION },
    { instructions: "Minimal local CRM. All data lives in one JSON file on this machine (SOLO_CRM_PATH). Every write tool is two-step: call once for a preview, show it to the user, then call again with confirm_token only after the user approves. draft_outreach only drafts text; this server cannot send anything." },
  );

  // ---------- reads ----------
  server.registerTool("list_contacts", {
    title: "List / search contacts",
    description: "List contacts, optionally filtered by a search string (name, email, company, notes) or tag.",
    inputSchema: { query: z.string().max(200).optional(), tag: z.string().max(40).optional(), limit: z.number().int().min(1).max(500).optional() },
    annotations: RO,
  }, safe(async ({ query, tag, limit }) => {
    const s = await st.load();
    const q = query?.toLowerCase();
    const rows = s.contacts.filter((c) => (!tag || c.tags.includes(tag)) && (!q || [c.name, c.email, c.company, c.notes].some((f) => f?.toLowerCase().includes(q))));
    return { total: rows.length, contacts: rows.slice(0, limit ?? 50).map((c) => ({ ...c, open_deals: s.deals.filter((d) => d.contact_id === c.id && !["won", "lost"].includes(d.stage)).length })) };
  }));

  server.registerTool("get_contact", {
    title: "Get contact with history",
    description: "Full contact record with their deals, open follow-ups and the 20 most recent activities.",
    inputSchema: { contact_id: id("c") },
    annotations: RO,
  }, safe(async ({ contact_id }) => {
    const s = await st.load();
    const c = st.findContact(s, contact_id);
    return {
      contact: c,
      deals: s.deals.filter((d) => d.contact_id === c.id),
      follow_ups: s.follow_ups.filter((f) => f.contact_id === c.id && !f.done).sort((a, b) => a.due.localeCompare(b.due)),
      activities: s.activities.filter((a) => a.contact_id === c.id).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20),
    };
  }));

  server.registerTool("list_deals", {
    title: "List deals",
    description: "List deals, optionally by stage or contact. Includes the contact name.",
    inputSchema: { stage: z.enum(st.STAGES).optional(), contact_id: id("c").optional(), open_only: z.boolean().optional() },
    annotations: RO,
  }, safe(async ({ stage, contact_id, open_only }) => {
    const s = await st.load();
    const deals = s.deals.filter((d) => (!stage || d.stage === stage) && (!contact_id || d.contact_id === contact_id) && (!open_only || !["won", "lost"].includes(d.stage)));
    return { total: deals.length, deals: deals.map((d) => ({ ...d, contact_name: s.contacts.find((c) => c.id === d.contact_id)?.name })) };
  }));

  server.registerTool("list_follow_ups", {
    title: "List follow-ups",
    description: "Open follow-ups sorted by due date, flagged overdue / due today. Use due_within_days to limit.",
    inputSchema: { as_of: date.optional().describe("Treat this date as today (default: today)"), due_within_days: z.number().int().min(0).max(365).optional(), include_done: z.boolean().optional() },
    annotations: RO,
  }, safe(async ({ as_of, due_within_days, include_done }) => {
    const s = await st.load();
    const t = st.today(as_of);
    const limit = due_within_days === undefined ? null : new Date(Date.parse(t) + due_within_days * 86400000).toISOString().slice(0, 10);
    const rows = s.follow_ups
      .filter((f) => (include_done || !f.done) && (!limit || f.due <= limit))
      .sort((a, b) => a.due.localeCompare(b.due))
      .map((f) => ({ ...f, contact_name: s.contacts.find((c) => c.id === f.contact_id)?.name, status: f.done ? "done" : f.due < t ? "overdue" : f.due === t ? "due_today" : "upcoming" }));
    return { as_of: t, total: rows.length, overdue: rows.filter((r) => r.status === "overdue").length, follow_ups: rows };
  }));

  server.registerTool("pipeline_summary", {
    title: "Pipeline summary",
    description: "Deals and value per stage, weighted forecast, win rate, overdue follow-ups and stale open deals (no activity in N days).",
    inputSchema: { as_of: date.optional(), stale_after_days: z.number().int().min(1).max(365).optional() },
    annotations: RO,
  }, safe(async ({ as_of, stale_after_days }) => {
    const s = await st.load();
    const t = st.today(as_of);
    const staleDays = stale_after_days ?? 14;
    const stages = st.STAGES.map((stage) => {
      const ds = s.deals.filter((d) => d.stage === stage);
      const value = ds.reduce((a, d) => a + d.value, 0);
      return { stage, deals: ds.length, value, weighted_value: Math.round(value * st.STAGE_PROBABILITY[stage] * 100) / 100 };
    });
    const open = s.deals.filter((d) => !["won", "lost"].includes(d.stage));
    const won = s.deals.filter((d) => d.stage === "won").length;
    const lost = s.deals.filter((d) => d.stage === "lost").length;
    const lastTouch = (d: st.Deal) => [d.updated_at, ...s.activities.filter((a) => a.deal_id === d.id || (!a.deal_id && a.contact_id === d.contact_id)).map((a) => a.at)].sort().pop()!;
    const cutoff = new Date(Date.parse(t) - staleDays * 86400000).toISOString();
    const currencies = [...new Set(s.deals.map((d) => d.currency))];
    return {
      as_of: t,
      currencies,
      contacts: s.contacts.length,
      open_deals: open.length,
      open_value: open.reduce((a, d) => a + d.value, 0),
      weighted_forecast: Math.round(open.reduce((a, d) => a + d.value * st.STAGE_PROBABILITY[d.stage], 0) * 100) / 100,
      win_rate: won + lost ? Math.round((won / (won + lost)) * 1000) / 10 : null,
      by_stage: stages,
      overdue_follow_ups: s.follow_ups.filter((f) => !f.done && f.due < t).length,
      stale_deals: open.filter((d) => lastTouch(d) < cutoff).map((d) => ({ id: d.id, title: d.title, stage: d.stage, last_touch: lastTouch(d).slice(0, 10) })),
      note: currencies.length > 1 ? "Deals use multiple currencies; totals are summed without conversion." : undefined,
    };
  }));

  server.registerTool("draft_outreach", {
    title: "Draft outreach (never sends)",
    description: "Draft an email/DM for a contact using their CRM context (deal, last activity). Returns text only; this server has no ability to send messages.",
    inputSchema: {
      contact_id: id("c"),
      purpose: z.enum(PURPOSES),
      tone: z.enum(["friendly", "professional", "brief"]).optional(),
      channel: z.enum(["email", "dm"]).optional(),
      key_points: z.array(z.string().max(300)).max(5).optional(),
      sender_name: z.string().max(80).optional(),
    },
    annotations: RO,
  }, safe(async (a) => {
    const s = await st.load();
    const c = st.findContact(s, a.contact_id);
    const deal = s.deals.filter((d) => d.contact_id === c.id && !["won", "lost"].includes(d.stage)).sort((x, y) => y.updated_at.localeCompare(x.updated_at))[0];
    const last = s.activities.filter((x) => x.contact_id === c.id).sort((x, y) => y.at.localeCompare(x.at))[0];
    return { ...draftOutreach({ contact: c, deal, lastActivity: last, ...a }), sent: false, note: "Draft only. Nothing was sent. Review and send it yourself, or log it afterwards with log_activity." };
  }));

  // ---------- writes (two-step) ----------
  writeTool(server, "upsert_contact", {
    title: "Create or update contact",
    description: "Create a contact, or update one when contact_id is given (only provided fields change).",
    inputSchema: { contact_id: id("c").optional(), ...contactFields, name: contactFields.name.optional() },
    destructive: true,
  }, (s, a) => {
    const { contact_id, ...fields } = a;
    if (contact_id) {
      const c = st.findContact(s, contact_id);
      const changes = Object.fromEntries(Object.entries(fields).filter(([k, v]) => v !== undefined && JSON.stringify((c as never)[k]) !== JSON.stringify(v)).map(([k, v]) => [k, { from: (c as never)[k] ?? null, to: v }]));
      if (Object.keys(changes).length === 0) throw new UserError("No changes: every provided field already has that value.");
      return {
        summary: `Update contact ${c.name} (${c.id}): ${Object.keys(changes).join(", ")}`,
        changes,
        apply: (store) => {
          const t = st.findContact(store, contact_id);
          Object.assign(t, Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)), { updated_at: st.nowIso() });
          return t;
        },
      };
    }
    if (!fields.name) throw new UserError("name is required to create a contact");
    const dup = s.contacts.find((c) => (fields.email && c.email?.toLowerCase() === String(fields.email).toLowerCase()));
    if (dup) throw new UserError(`A contact with email ${fields.email} already exists (${dup.id}, ${dup.name}). Pass contact_id to update it.`);
    return {
      summary: `Create contact ${fields.name}`,
      changes: { new_contact: { ...fields, tags: fields.tags ?? [] } },
      apply: (store) => {
        const now = st.nowIso();
        const c: st.Contact = { id: st.newId("c"), ...fields, tags: fields.tags ?? [], name: fields.name, created_at: now, updated_at: now };
        store.contacts.push(c);
        return c;
      },
    };
  });

  writeTool(server, "delete_contact", {
    title: "Delete contact",
    description: "Permanently delete a contact AND their deals, follow-ups and activities.",
    inputSchema: { contact_id: id("c") },
    destructive: true,
    idempotent: true,
  }, (s, { contact_id }) => {
    const c = st.findContact(s, contact_id);
    const counts = { deals: s.deals.filter((d) => d.contact_id === c.id).length, follow_ups: s.follow_ups.filter((f) => f.contact_id === c.id).length, activities: s.activities.filter((a) => a.contact_id === c.id).length };
    return {
      summary: `PERMANENTLY delete ${c.name} (${c.id}) plus ${counts.deals} deal(s), ${counts.follow_ups} follow-up(s), ${counts.activities} activit(ies)`,
      changes: { delete: c, cascade: counts },
      apply: (store) => {
        store.contacts = store.contacts.filter((x) => x.id !== contact_id);
        store.deals = store.deals.filter((x) => x.contact_id !== contact_id);
        store.follow_ups = store.follow_ups.filter((x) => x.contact_id !== contact_id);
        store.activities = store.activities.filter((x) => x.contact_id !== contact_id);
        return { deleted: contact_id, ...counts };
      },
    };
  });

  writeTool(server, "upsert_deal", {
    title: "Create or update deal",
    description: "Create a deal for a contact, or update an existing deal (e.g. move stage, change value) when deal_id is given.",
    inputSchema: {
      deal_id: id("d").optional(),
      contact_id: id("c").optional(),
      title: z.string().trim().min(1).max(160).optional(),
      value: z.number().min(0).max(1e10).optional(),
      currency: z.string().regex(/^[A-Z]{3}$/, "3-letter ISO code, e.g. USD").optional(),
      stage: z.enum(st.STAGES).optional(),
      expected_close: date.optional(),
    },
    destructive: true,
  }, (s, a) => {
    const { deal_id, ...f } = a;
    if (deal_id) {
      const d = st.findDeal(s, deal_id);
      if (f.contact_id) st.findContact(s, f.contact_id);
      const changes = Object.fromEntries(Object.entries(f).filter(([k, v]) => v !== undefined && (d as never)[k] !== v).map(([k, v]) => [k, { from: (d as never)[k] ?? null, to: v }]));
      if (Object.keys(changes).length === 0) throw new UserError("No changes: every provided field already has that value.");
      return {
        summary: `Update deal "${d.title}" (${d.id}): ${Object.entries(changes).map(([k, v]) => `${k} ${JSON.stringify((v as { from: unknown }).from)} → ${JSON.stringify((v as { to: unknown }).to)}`).join("; ")}`,
        changes,
        apply: (store) => {
          const t = st.findDeal(store, deal_id);
          const now = st.nowIso();
          if (f.stage && f.stage !== t.stage) t.stage_history.push({ stage: f.stage, at: now });
          Object.assign(t, Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)), { updated_at: now });
          return t;
        },
      };
    }
    if (!f.contact_id || !f.title) throw new UserError("contact_id and title are required to create a deal");
    const c = st.findContact(s, f.contact_id);
    const deal = { contact_id: c.id, title: f.title, value: f.value ?? 0, currency: f.currency ?? "USD", stage: (f.stage ?? "lead") as st.Stage, expected_close: f.expected_close };
    return {
      summary: `Create deal "${deal.title}" for ${c.name}: ${deal.currency} ${deal.value}, stage ${deal.stage}`,
      changes: { new_deal: deal },
      apply: (store) => {
        const now = st.nowIso();
        const d: st.Deal = { id: st.newId("d"), ...deal, created_at: now, updated_at: now, stage_history: [{ stage: deal.stage, at: now }] };
        store.deals.push(d);
        return d;
      },
    };
  });

  writeTool(server, "delete_deal", {
    title: "Delete deal",
    description: "Permanently delete a deal (follow-ups linked to it are unlinked, not deleted).",
    inputSchema: { deal_id: id("d") },
    destructive: true,
    idempotent: true,
  }, (s, { deal_id }) => {
    const d = st.findDeal(s, deal_id);
    return {
      summary: `PERMANENTLY delete deal "${d.title}" (${d.id}, ${d.currency} ${d.value}, ${d.stage})`,
      changes: { delete: d },
      apply: (store) => {
        store.deals = store.deals.filter((x) => x.id !== deal_id);
        for (const f of store.follow_ups) if (f.deal_id === deal_id) delete f.deal_id;
        for (const a of store.activities) if (a.deal_id === deal_id) delete a.deal_id;
        return { deleted: deal_id };
      },
    };
  });

  writeTool(server, "add_follow_up", {
    title: "Add follow-up",
    description: "Schedule a follow-up reminder for a contact (optionally tied to a deal).",
    inputSchema: { contact_id: id("c"), deal_id: id("d").optional(), due: date, note: z.string().trim().min(1).max(500) },
    destructive: false,
  }, (s, a) => {
    const c = st.findContact(s, a.contact_id);
    if (a.deal_id && st.findDeal(s, a.deal_id).contact_id !== c.id) throw new UserError("That deal belongs to a different contact");
    return {
      summary: `Follow up with ${c.name} on ${a.due}: ${a.note}`,
      changes: { new_follow_up: a },
      apply: (store) => {
        const f: st.FollowUp = { id: st.newId("f"), contact_id: a.contact_id, deal_id: a.deal_id, due: a.due, note: a.note, done: false, created_at: st.nowIso() };
        store.follow_ups.push(f);
        return f;
      },
    };
  });

  writeTool(server, "complete_follow_up", {
    title: "Complete follow-up",
    description: "Mark a follow-up as done.",
    inputSchema: { follow_up_id: id("f") },
    destructive: false,
    idempotent: true,
  }, (s, { follow_up_id }) => {
    const f = s.follow_ups.find((x) => x.id === follow_up_id);
    if (!f) throw new UserError(`No follow-up with id ${follow_up_id}`);
    if (f.done) throw new UserError("That follow-up is already done");
    return {
      summary: `Mark done: "${f.note}" (due ${f.due})`,
      changes: { follow_up_id, done: { from: false, to: true } },
      apply: (store) => {
        const t = store.follow_ups.find((x) => x.id === follow_up_id)!;
        t.done = true;
        t.done_at = st.nowIso();
        return t;
      },
    };
  });

  writeTool(server, "log_activity", {
    title: "Log activity",
    description: "Record a call, email, meeting, DM or note against a contact (and optionally a deal).",
    inputSchema: { contact_id: id("c"), deal_id: id("d").optional(), type: z.enum(["call", "email", "meeting", "note", "dm"]), summary: z.string().trim().min(1).max(2000), at: z.string().datetime({ offset: true }).optional().describe("ISO timestamp (default now)") },
    destructive: false,
  }, (s, a) => {
    const c = st.findContact(s, a.contact_id);
    if (a.deal_id && st.findDeal(s, a.deal_id).contact_id !== c.id) throw new UserError("That deal belongs to a different contact");
    return {
      summary: `Log ${a.type} with ${c.name}: ${a.summary.slice(0, 120)}`,
      changes: { new_activity: a },
      apply: (store) => {
        const act: st.Activity = { id: st.newId("a"), contact_id: a.contact_id, deal_id: a.deal_id, type: a.type, summary: a.summary, at: a.at ? new Date(a.at).toISOString() : st.nowIso() };
        store.activities.push(act);
        return act;
      },
    };
  });

  return server;
}
