import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { makeSandbox, removeSandbox } from "./helpers.js";

type Text = { type: string; text: string };
let sandbox: { dir: string; file: string };
let client: Client;

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Text[])[0].text;
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* error text */ }
  return { isError: Boolean(res.isError), text, json };
}
/** preview then confirm */
async function commit(name: string, args: Record<string, unknown>) {
  const p = await call(name, args);
  expect(p.isError, p.text).toBe(false);
  expect(p.json.status).toBe("preview");
  const a = await call(name, { ...args, confirm_token: p.json.confirm_token });
  expect(a.isError, a.text).toBe(false);
  expect(a.json.status).toBe("applied");
  return a.json.result;
}
const disk = () => JSON.parse(readFileSync(sandbox.file, "utf8"));

beforeEach(async () => {
  sandbox = makeSandbox();
  process.env.SOLO_CRM_PATH = sandbox.file;
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  client = new Client({ name: "unit", version: "1" });
  await client.connect(b);
});
afterEach(() => removeSandbox(sandbox.dir));

describe("two-step confirmation", () => {
  it("preview writes nothing", async () => {
    const p = await call("upsert_contact", { name: "Grace Hopper", email: "grace@example.com" });
    expect(p.json.status).toBe("preview");
    expect(p.json.confirm_token).toMatch(/^\d+\./);
    expect(p.json.next_step).toMatch(/Nothing has been saved/);
    expect(existsSync(sandbox.file)).toBe(false);
  });
  it("confirm applies and the file is private (0600)", async () => {
    const c = await commit("upsert_contact", { name: "Grace Hopper", email: "grace@example.com" });
    expect(c.id).toMatch(/^c_[a-f0-9]{10}$/);
    expect(disk().contacts).toHaveLength(1);
    expect(disk().revision).toBe(1);
    if (process.platform !== "win32") expect(statSync(sandbox.file).mode & 0o777).toBe(0o600);
  });
  it("token is bound to the exact arguments", async () => {
    const p = await call("upsert_contact", { name: "Grace Hopper" });
    const r = await call("upsert_contact", { name: "Mallory", confirm_token: p.json.confirm_token });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/does not match/);
    const t = await call("upsert_deal", { contact_id: "c_0000000000", title: "x", confirm_token: p.json.confirm_token });
    expect(t.isError).toBe(true);
  });
  it("token is single-use and invalidated when the CRM changes", async () => {
    const p1 = await call("upsert_contact", { name: "A" });
    const p2 = await call("upsert_contact", { name: "B" });
    expect((await call("upsert_contact", { name: "A", confirm_token: p1.json.confirm_token })).isError).toBe(false);
    const reuse = await call("upsert_contact", { name: "A", confirm_token: p1.json.confirm_token });
    expect(reuse.text).toMatch(/already used/);
    const stale = await call("upsert_contact", { name: "B", confirm_token: p2.json.confirm_token });
    expect(stale.isError).toBe(true);
    expect(stale.text).toMatch(/CRM changed/);
  });
  it("rejects malformed and expired tokens", async () => {
    expect((await call("upsert_contact", { name: "A", confirm_token: "garbage" })).text).toMatch(/Malformed/);
    expect((await call("upsert_contact", { name: "A", confirm_token: "1.abc" })).text).toMatch(/expired/);
  });
  it("every write tool is annotated as non-read-only and deletes as destructive", async () => {
    const { tools } = await client.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    for (const w of ["upsert_contact", "delete_contact", "upsert_deal", "delete_deal", "add_follow_up", "complete_follow_up", "log_activity"]) {
      expect(by[w]?.readOnlyHint).toBe(false);
      expect(tools.find((t) => t.name === w)!.inputSchema.properties).toHaveProperty("confirm_token");
    }
    expect(by.delete_contact?.destructiveHint).toBe(true);
    expect(by.delete_deal?.destructiveHint).toBe(true);
    expect(by.add_follow_up?.destructiveHint).toBe(false);
    for (const r of ["list_contacts", "get_contact", "list_deals", "list_follow_ups", "pipeline_summary", "draft_outreach"]) expect(by[r]?.readOnlyHint).toBe(true);
    for (const t of tools) expect(t.annotations?.openWorldHint).toBe(false);
  });
});

describe("contacts", () => {
  it("creates, searches, updates with a diff, and blocks duplicate emails", async () => {
    const c = await commit("upsert_contact", { name: "Ada Lovelace", email: "ada@example.com", tags: ["vip"] });
    expect((await call("list_contacts", { query: "lovelace" })).json.total).toBe(1);
    expect((await call("list_contacts", { tag: "vip" })).json.total).toBe(1);
    expect((await call("list_contacts", { tag: "nope" })).json.total).toBe(0);
    const p = await call("upsert_contact", { contact_id: c.id, company: "Analytical Co" });
    expect(p.json.changes).toEqual({ company: { from: null, to: "Analytical Co" } });
    await commit("upsert_contact", { contact_id: c.id, company: "Analytical Co" });
    expect((await call("get_contact", { contact_id: c.id })).json.contact.company).toBe("Analytical Co");
    expect((await call("upsert_contact", { contact_id: c.id, company: "Analytical Co" })).text).toMatch(/No changes/);
    expect((await call("upsert_contact", { name: "Imposter", email: "ADA@example.com" })).text).toMatch(/already exists/);
  });
  it("validates input", async () => {
    expect((await call("upsert_contact", { name: "X", email: "not-an-email" })).isError).toBe(true);
    expect((await call("upsert_contact", { email: "a@b.co" })).text).toMatch(/name is required/);
    expect((await call("get_contact", { contact_id: "../../etc" })).isError).toBe(true);
    expect((await call("get_contact", { contact_id: "c_0000000000" })).text).toMatch(/No contact/);
  });
  it("delete cascades and the preview states the impact", async () => {
    const c = await commit("upsert_contact", { name: "Temp" });
    await commit("upsert_deal", { contact_id: c.id, title: "Small job", value: 50 });
    await commit("log_activity", { contact_id: c.id, type: "note", summary: "hi" });
    const p = await call("delete_contact", { contact_id: c.id });
    expect(p.json.summary).toMatch(/PERMANENTLY delete Temp .* 1 deal/);
    await commit("delete_contact", { contact_id: c.id });
    const d = disk();
    expect(d.contacts).toHaveLength(0);
    expect(d.deals).toHaveLength(0);
    expect(d.activities).toHaveLength(0);
  });
});

describe("deals, follow-ups, activities, summary", () => {
  it("deal lifecycle with stage history", async () => {
    const c = await commit("upsert_contact", { name: "Linus" });
    expect((await call("upsert_deal", { title: "No contact" })).text).toMatch(/required/);
    const d = await commit("upsert_deal", { contact_id: c.id, title: "Website", value: 3000, currency: "EUR", stage: "qualified" });
    const p = await call("upsert_deal", { deal_id: d.id, stage: "won" });
    expect(p.json.summary).toContain('stage "qualified" → "won"');
    const won = await commit("upsert_deal", { deal_id: d.id, stage: "won" });
    expect(won.stage_history.map((h: { stage: string }) => h.stage)).toEqual(["qualified", "won"]);
    expect((await call("list_deals", { stage: "won" })).json.deals[0].contact_name).toBe("Linus");
    expect((await call("list_deals", { open_only: true })).json.total).toBe(0);
    expect((await call("upsert_deal", { contact_id: c.id, title: "x", currency: "euro" })).isError).toBe(true);
    await commit("delete_deal", { deal_id: d.id });
    expect(disk().deals).toHaveLength(0);
  });
  it("follow-ups: overdue flags, window, completion", async () => {
    const c = await commit("upsert_contact", { name: "Mia" });
    const f1 = await commit("add_follow_up", { contact_id: c.id, due: "2026-03-01", note: "old" });
    await commit("add_follow_up", { contact_id: c.id, due: "2026-03-10", note: "today" });
    await commit("add_follow_up", { contact_id: c.id, due: "2026-05-01", note: "later" });
    const l = (await call("list_follow_ups", { as_of: "2026-03-10" })).json;
    expect(l.follow_ups.map((f: { status: string }) => f.status)).toEqual(["overdue", "due_today", "upcoming"]);
    expect((await call("list_follow_ups", { as_of: "2026-03-10", due_within_days: 7 })).json.total).toBe(2);
    await commit("complete_follow_up", { follow_up_id: f1.id });
    expect((await call("complete_follow_up", { follow_up_id: f1.id })).text).toMatch(/already done/);
    expect((await call("list_follow_ups", { as_of: "2026-03-10" })).json.overdue).toBe(0);
    expect((await call("add_follow_up", { contact_id: c.id, due: "next tuesday", note: "x" })).isError).toBe(true);
  });
  it("rejects linking a deal from another contact", async () => {
    const a = await commit("upsert_contact", { name: "A" });
    const b = await commit("upsert_contact", { name: "B" });
    const d = await commit("upsert_deal", { contact_id: a.id, title: "A's deal" });
    expect((await call("log_activity", { contact_id: b.id, deal_id: d.id, type: "call", summary: "x" })).text).toMatch(/different contact/);
    expect((await call("add_follow_up", { contact_id: b.id, deal_id: d.id, due: "2026-01-01", note: "x" })).text).toMatch(/different contact/);
  });
  it("pipeline summary: stages, weighted forecast, win rate, stale deals", async () => {
    const c = await commit("upsert_contact", { name: "Pipeline" });
    await commit("upsert_deal", { contact_id: c.id, title: "P", value: 1000, stage: "proposal" });
    await commit("upsert_deal", { contact_id: c.id, title: "N", value: 2000, stage: "negotiation" });
    await commit("upsert_deal", { contact_id: c.id, title: "W", value: 500, stage: "won" });
    await commit("upsert_deal", { contact_id: c.id, title: "L", value: 700, stage: "lost" });
    const s = (await call("pipeline_summary", {})).json;
    expect(s.open_deals).toBe(2);
    expect(s.open_value).toBe(3000);
    expect(s.weighted_forecast).toBe(2000);
    expect(s.win_rate).toBe(50);
    expect(s.stale_deals).toHaveLength(0);
    const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    expect((await call("pipeline_summary", { as_of: future })).json.stale_deals).toHaveLength(2);
  });
  it("log_activity validates timestamps", async () => {
    const c = await commit("upsert_contact", { name: "T" });
    const a = await commit("log_activity", { contact_id: c.id, type: "meeting", summary: "Kickoff", at: "2026-02-03T10:00:00+02:00" });
    expect(a.at).toBe("2026-02-03T08:00:00.000Z");
    expect((await call("log_activity", { contact_id: c.id, type: "meeting", summary: "x", at: "yesterday" })).isError).toBe(true);
  });
});

describe("draft_outreach", () => {
  it("uses context, never sends, and handles tone/channel", async () => {
    const c = await commit("upsert_contact", { name: "Sam Rivera", email: "sam@example.com", company: "Rivera Studio" });
    await commit("upsert_deal", { contact_id: c.id, title: "Logo refresh", value: 800, stage: "proposal" });
    await commit("log_activity", { contact_id: c.id, type: "call", summary: "Scoped it" });
    const before = readFileSync(sandbox.file, "utf8");
    const d = (await call("draft_outreach", { contact_id: c.id, purpose: "follow_up", tone: "professional", sender_name: "Paris", key_points: ["Can start Monday"] })).json;
    expect(d.sent).toBe(false);
    expect(d.to).toBe("sam@example.com");
    expect(d.subject).toBe("Following up: Logo refresh");
    expect(d.body).toMatch(/^Hi Sam,/);
    expect(d.body).toContain("since our last call");
    expect(d.body).toContain("- Can start Monday");
    expect(d.body).toContain("Best regards,\nParis");
    const dm = (await call("draft_outreach", { contact_id: c.id, purpose: "intro", channel: "dm", tone: "brief" })).json;
    expect(dm.subject).toBeNull();
    expect(dm.body).not.toContain("\n");
    expect(readFileSync(sandbox.file, "utf8")).toBe(before);
  });
});

describe("store robustness", () => {
  it("refuses a corrupt file without overwriting it", async () => {
    writeFileSync(sandbox.file, "{not json");
    const r = await call("list_contacts", {});
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not valid JSON/);
    expect(readFileSync(sandbox.file, "utf8")).toBe("{not json");
  });
  it("rejects a non-.json store path", async () => {
    process.env.SOLO_CRM_PATH = sandbox.file.replace(/\.json$/, ".txt");
    expect((await call("list_contacts", {})).text).toMatch(/must point to a \.json/);
  });
});
