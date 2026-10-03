import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as api from "../../src/api.js";
import { readFixtureScript } from "../helpers/drill.js";
import { expectRed, runDrill, stepLogs, stepOf } from "../helpers/run.js";
import { filesContaining } from "../helpers/scan.js";
import { makeTmp, registerTmpCleanup } from "../helpers/tmp.js";

registerTmpCleanup();
const secret = ["arbitrary", "rotation", "future", "314159"].join("-");
const print = `printf %s "${secret}" > "$HC_STATE/credential.new"\necho "new=${secret}"\necho "again ${secret}" >&2\n`;
async function noStoredSecret(ctx: api.ApiContext, result: api.RunResult, learned: boolean): Promise<void> {
  expectRed(result);
  const logs = (await stepLogs(ctx, result.run_id)).filter((l) => l.step_key === "rotate").map((l) => l.text).join("\n");
  expect(logs).not.toContain(secret);
  expect(logs).toContain(learned ? "[REDACTED" : "[OUTPUT WITHHELD:");
  expect(filesContaining(ctx.storeDir, [secret])).toEqual([]);
  const out = join(makeTmp("hc-rotation-failure-"), "run.hcb");
  await api.exportBundle(ctx, { runId: result.run_id, outPath: out });
  expect(readFileSync(out).includes(secret)).toBe(false);
  if (learned) {
    await api.recordIntervention(ctx, { runId: result.run_id, reason: `typed ${secret}`, actorRef: "operator-a" });
    const report = await api.getReport(ctx, { runId: result.run_id });
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(report.interventions[0]?.reason).toContain("[REDACTED");
    expect(filesContaining(ctx.storeDir, [secret])).toEqual([]);
  }
}
describe("HC-P1-ROTATE-FAIL-SECRET", () => {
  it("exit1 preserves failed verdict and learns new literal before logs/export/later intervention", async () => {
    const { ctx, result } = await runDrill({ scripts: { "rotate.sh": `#!/bin/sh\nset -eu\n${print}exit 1\n` }, manifest: (m) => void (m.synthetic_secrets = []) });
    expect(stepOf(result, "rotate").status).toBe("FAIL");
    expect(stepOf(result, "rotate").reason_code).toBe("SCRIPT_FAILED");
    await noStoredSecret(ctx, result, true);
  });
  it("timeout preserves timed-out verdict and learns new literal before logs/export/later intervention", async () => {
    const { ctx, result } = await runDrill({ scripts: { "rotate.sh": `#!/bin/sh\nset -eu\n${print}sleep 5\n` }, manifest: (m) => { m.synthetic_secrets = []; const rotate = m.steps.find((s: { id: string }) => s.id === "rotate"); if (!rotate) throw new Error("required rotate fixture step missing"); rotate.deadline_seconds = 1; } });
    expect(stepOf(result, "rotate").status).toBe("TIMEOUT");
    expect(stepOf(result, "rotate").reason_code).toBe("SCRIPT_TIMEOUT");
    await noStoredSecret(ctx, result, true);
  });
  it("unavailable new file withholds possible secret output while preserving script failure", async () => {
    const rotate = `${readFixtureScript("rotate.sh")}rm -f "$HC_STATE/credential.new"\necho "unknown=${secret}"\nexit 1\n`;
    const { ctx, result } = await runDrill({ scripts: { "rotate.sh": rotate }, manifest: (m) => void (m.synthetic_secrets = []) });
    expect(stepOf(result, "rotate").status).toBe("FAIL");
    expect(stepOf(result, "rotate").reason_code).toBe("SCRIPT_FAILED");
    await noStoredSecret(ctx, result, false);
  });
  it("successful ordinary rotation still passes and retains safe useful output", async () => {
    const { ctx, result } = await runDrill({ scripts: { "rotate.sh": `${readFixtureScript("rotate.sh")}echo rotation-completed-safe\n` }, manifest: (m) => void (m.synthetic_secrets = []) });
    expect(stepOf(result, "rotate").status).toBe("PASS");
    expect((await stepLogs(ctx, result.run_id)).filter((l) => l.step_key === "rotate").map((l) => l.text).join("\n")).toContain("rotation-completed-safe");
  });
});
