import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function makeSandbox(): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "solo-crm-"));
  return { dir, file: path.join(dir, "crm.json") };
}
export function removeSandbox(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}
