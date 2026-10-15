import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { UserError } from "./result.js";

export const STAGES = ["lead", "qualified", "proposal", "negotiation", "won", "lost"] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_PROBABILITY: Record<Stage, number> = { lead: 0.1, qualified: 0.25, proposal: 0.5, negotiation: 0.75, won: 1, lost: 0 };

export interface Contact { id: string; name: string; email?: string; company?: string; phone?: string; tags: string[]; notes?: string; created_at: string; updated_at: string }
export interface Deal { id: string; contact_id: string; title: string; value: number; currency: string; stage: Stage; expected_close?: string; created_at: string; updated_at: string; stage_history: Array<{ stage: Stage; at: string }> }
export interface FollowUp { id: string; contact_id: string; deal_id?: string; due: string; note: string; done: boolean; done_at?: string; created_at: string }
export interface Activity { id: string; contact_id: string; deal_id?: string; type: "call" | "email" | "meeting" | "note" | "dm"; summary: string; at: string }
export interface Store { version: 1; revision: number; contacts: Contact[]; deals: Deal[]; follow_ups: FollowUp[]; activities: Activity[] }

export function storePath(): string {
  const p = process.env.SOLO_CRM_PATH ?? path.join(os.homedir(), ".solo-crm", "crm.json");
  if (!p.endsWith(".json")) throw new UserError("SOLO_CRM_PATH must point to a .json file");
  return path.resolve(p);
}

export const emptyStore = (): Store => ({ version: 1, revision: 0, contacts: [], deals: [], follow_ups: [], activities: [] });

export async function load(): Promise<Store> {
  const p = storePath();
  if (!existsSync(p)) return emptyStore();
  let data: Store;
  try {
    data = JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    throw new UserError(`CRM file at ${p} is not valid JSON. Fix or move it; nothing was changed.`);
  }
  if (data?.version !== 1 || !Array.isArray(data.contacts)) throw new UserError(`CRM file at ${p} has an unknown format`);
  return { ...emptyStore(), ...data };
}

let writeChain: Promise<unknown> = Promise.resolve();

/** Atomic write (temp file + rename), serialised within the process. */
export async function save(store: Store): Promise<void> {
  const p = storePath();
  const run = async () => {
    await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    await fs.rename(tmp, p);
  };
  const next = writeChain.then(run, run);
  writeChain = next.catch(() => undefined);
  await next;
}

export const newId = (prefix: string) => `${prefix}_${randomBytes(5).toString("hex")}`;
export const nowIso = () => new Date().toISOString();
export const today = (asOf?: string) => asOf ?? new Date().toISOString().slice(0, 10);

export function findContact(s: Store, id: string): Contact {
  const c = s.contacts.find((x) => x.id === id);
  if (!c) throw new UserError(`No contact with id ${id}. Use list_contacts to find ids.`);
  return c;
}
export function findDeal(s: Store, id: string): Deal {
  const d = s.deals.find((x) => x.id === id);
  if (!d) throw new UserError(`No deal with id ${id}. Use list_deals to find ids.`);
  return d;
}
