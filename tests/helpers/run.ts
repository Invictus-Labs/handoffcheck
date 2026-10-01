import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import * as api from "../../src/api.js";
import { makeCtx, prepareDrill, type DrillInputs, type PrepareOptions } from "./drill.js";

export interface Executed {
  inputs: DrillInputs;
  ctx: api.ApiContext;
  result: api.RunResult;
}

export async function runDrill(
  opts: PrepareOptions = {},
  over: { operator?: Partial<api.OperatorDecl>; ctx?: Partial<api.ApiContext>; signal?: AbortSignal } = {}
): Promise<Executed> {
  const inputs = prepareDrill(opts);
  const ctx = makeCtx(over.ctx);
  const result = await api.run(ctx, { ...inputs.paths, operator: over.operator, signal: over.signal });
  return { inputs, ctx, result };
}

export const stepOf = (r: api.RunResult, key: string) => {
  const s = r.steps.find((x) => x.step_key === key);
  if (!s) throw new Error(`no step ${key} in ${JSON.stringify(r.steps)}`);
  return s;
};

/** Every mandatory outcome that is not a clean pass must be red: exit 1, never an accepting verdict. */
export function expectRed(r: api.RunResult): void {
  expect(r.exit_code).toBe(1);
  expect(r.verdict.exit_code).toBe(1);
  expect(["FAIL", "UNKNOWN", "BLOCKED", "ASSISTED"]).toContain(r.verdict.verdict);
  expect(r.verdict.steps_and_cleanup_pass).toBe(false);
  expect(r.verdict.independent).toBe(false);
}

export const allStepsPass = (r: api.RunResult): boolean => r.steps.every((s) => s.status === "PASS");

/** Raw bytes of a stored evidence object (content-addressed under objects/<first two hex>/<sha256>). */
export function readEvidenceObject(storeDir: string, sha256: string): Buffer {
  return readFileSync(join(storeDir, "objects", sha256.slice(0, 2), sha256));
}

/** The stored (already redacted) step logs of a run, as text, keyed by step. */
export async function stepLogs(ctx: api.ApiContext, runId: string): Promise<{ step_key: string | null; text: string }[]> {
  const report = await api.getReport(ctx, { runId });
  return report.evidence.filter((e) => e.kind === "step_log").map((e) => ({ step_key: e.step_key, text: readEvidenceObject(ctx.storeDir, e.sha256).toString("utf8") }));
}
