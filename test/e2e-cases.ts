import { expect } from "vitest";
import { makeSandbox, removeSandbox } from "./helpers.js";

let dir = "";
export const e2eEnv: Record<string, string> = {};
export async function setupE2E() {
  const s = makeSandbox();
  dir = s.dir;
  return { SOLO_CRM_PATH: s.file };
}
export async function teardownE2E() {
  removeSandbox(dir);
}

export const expectedTools = ["list_contacts", "get_contact", "list_deals", "list_follow_ups", "pipeline_summary", "draft_outreach", "upsert_contact", "delete_contact", "upsert_deal", "delete_deal", "add_follow_up", "complete_follow_up", "log_activity"];

export interface Case {
  tool: string;
  args: (ctx: Record<string, unknown>) => Record<string, unknown>;
  isError?: boolean;
  check?: (text: string, ctx: Record<string, unknown>) => void;
}

const tag = () => `e2e${Math.random().toString(36).slice(2, 8)}`;
const j = (t: string) => JSON.parse(t);

/** preview + confirm pair for a write tool; stores applied result in ctx[key]. */
function write(tool: string, args: (ctx: Record<string, unknown>) => Record<string, unknown>, key: string): Case[] {
  return [
    { tool, args, check: (t, ctx) => { expect(j(t).status).toBe("preview"); ctx[`${key}_token`] = j(t).confirm_token; ctx[`${key}_args`] = args(ctx); } },
    { tool, args: (ctx) => ({ ...(ctx[`${key}_args`] as object), confirm_token: ctx[`${key}_token`] }), check: (t, ctx) => { expect(j(t).status).toBe("applied"); ctx[key] = j(t).result; } },
  ];
}
const idOf = (ctx: Record<string, unknown>, k: string) => (ctx[k] as { id: string }).id;
let email = "";

export const cases: Case[] = [
  { tool: "list_contacts", args: () => ({}), check: (t, ctx) => { ctx.startCount = j(t).total; email = `${tag()}@example.com`; } },
  ...write("upsert_contact", () => ({ name: "Ada Lovelace", email, company: "Analytical Co" }), "contact"),
  { tool: "get_contact", args: (ctx) => ({ contact_id: idOf(ctx, "contact") }), check: (t) => expect(j(t).contact.name).toBe("Ada Lovelace") },
  ...write("upsert_deal", (ctx) => ({ contact_id: idOf(ctx, "contact"), title: "Brand kit", value: 1200, stage: "proposal" }), "deal"),
  { tool: "list_deals", args: (ctx) => ({ contact_id: idOf(ctx, "contact") }), check: (t) => expect(j(t).total).toBe(1) },
  ...write("add_follow_up", (ctx) => ({ contact_id: idOf(ctx, "contact"), due: "2026-01-01", note: "Nudge on proposal" }), "fu"),
  { tool: "list_follow_ups", args: () => ({ as_of: "2026-06-01" }), check: (t) => expect(j(t).overdue).toBeGreaterThanOrEqual(1) },
  ...write("complete_follow_up", (ctx) => ({ follow_up_id: idOf(ctx, "fu") }), "fu_done"),
  ...write("log_activity", (ctx) => ({ contact_id: idOf(ctx, "contact"), type: "call", summary: "Discussed scope" }), "act"),
  { tool: "pipeline_summary", args: () => ({}), check: (t) => expect(j(t).by_stage.find((s: { stage: string }) => s.stage === "proposal").deals).toBeGreaterThanOrEqual(1) },
  { tool: "draft_outreach", args: (ctx) => ({ contact_id: idOf(ctx, "contact"), purpose: "proposal_nudge", sender_name: "Paris" }), check: (t) => { expect(j(t).sent).toBe(false); expect(j(t).body).toContain("Brand kit"); } },
  { tool: "delete_deal", args: (ctx) => ({ deal_id: idOf(ctx, "deal"), confirm_token: "123.bogus" }), isError: true, check: (t) => expect(t).toMatch(/does not match|expired/) },
  ...write("delete_deal", (ctx) => ({ deal_id: idOf(ctx, "deal") }), "deal_del"),
  ...write("delete_contact", (ctx) => ({ contact_id: idOf(ctx, "contact") }), "contact_del"),
];
