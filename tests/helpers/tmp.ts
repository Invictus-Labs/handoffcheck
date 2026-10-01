import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/** Deterministic UTC clock used wherever a test needs "now" (never the wall clock). */
export const FIXED_NOW = "2026-01-01T00:00:00.000Z";
export const FIXED_EPOCH_MS = Date.parse(FIXED_NOW);

const created: string[] = [];

/** Fresh temporary directory removed after the test file finishes. */
export function makeTmp(prefix = "hc-qa-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function registerTmpCleanup(): void {
  afterAll(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
}
