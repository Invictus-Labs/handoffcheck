// Negative controls for the bundle step-receipt cross-check (src/evidence/bundle.ts): a step record in run.json must agree with
// the step receipt object it points to, field by field. Every forgery below recomputes run.json's hash, size, the header file
// list and the root hash (forgeBundle does), so ONLY the cross-check can catch it: hashes are all consistent.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as api from "../../src/api.js";
import { forgeBundle } from "../helpers/bundle.js";
import { makeCtx } from "../helpers/drill.js";
import { runDrill, stepOf } from "../helpers/run.js";
import { walkFiles } from "../helpers/scan.js";
import { makeTmp, registerTmpCleanup } from "../helpers/tmp.js";

registerTmpCleanup();

// a well-formed id of some other run, assembled so no raw UUID literal sits in the source
const ANOTHER_RUN = ["00000000", "0000", "4000", "8000", "0000000000ff"].join("-");
type Step = Record<string, unknown> & { step_key: string };
const FIELDS: [string, (s: Step) => void][] = [
  ["status (a failed step recorded as PASS)", (s) => void (s["status"] = s["status"] === "PASS" ? "FAIL" : "PASS")],
  ["reason_code", (s) => void (s["reason_code"] = s["reason_code"] === "OK" ? "SCRIPT_FAILED" : "OK")],
  ["action", (s) => void (s["action"] = s["action"] === "install" ? "recover" : "install")],
  ["step_key", (s) => void (s["step_key"] = `${s.step_key}-renamed`)],
  ["drill_id (a receipt from another run)", (s) => void (s["drill_id"] = ANOTHER_RUN)]
];

describe("bundle step-receipt cross-check", () => {
  async function exported() {
    // a run with one genuinely FAILED step, so a forged PASS is a real downgrade of the truth
    const { ctx, result } = await runDrill({ scripts: { "recover.sh": "#!/bin/sh\ntrue\n" }, manifest: (m) => { m.steps[3].deadline_seconds = 20; m.steps[3].max_recovery_seconds = 10; } });
    expect(stepOf(result, "recover").status).toBe("FAIL");
    const path = join(makeTmp("hc-stepcheck-"), "run.hcb");
    await api.exportBundle(ctx, { runId: result.run_id, outPath: path });
    return { bytes: readFileSync(path), path };
  }

  it("positive control: the unmodified bundle and a re-forged copy with identical content verify (so a rejection below is the cross-check, not the forger)", async () => {
    const { bytes, path } = await exported();
    expect((await api.verifyBundle({}, { bundlePath: path })).ok).toBe(true);
    const same = join(makeTmp("hc-stepcheck-"), "same.hcb");
    writeFileSync(same, forgeBundle(bytes));
    expect((await api.verifyBundle({}, { bundlePath: same })).errors).toEqual([]);
  });

  for (const [field, mutate] of FIELDS) {
    it(`negative control: a step whose ${field} disagrees with its stored step receipt is BAD_FORMAT, even with every hash recomputed, and imports nothing`, async () => {
      const { bytes } = await exported();
      const forged = forgeBundle(bytes, { run: (r) => mutate(r.steps.find((s: Step) => s.step_key === "recover")) });
      const bad = join(makeTmp("hc-stepcheck-"), "forged.hcb");
      writeFileSync(bad, forged);
      const v = await api.verifyBundle({}, { bundlePath: bad });
      expect(v.ok, JSON.stringify(v.errors)).toBe(false);
      expect(v.errors.map((e) => e.code)).toContain("BAD_FORMAT");
      expect(v.errors.map((e) => e.message).join(" ")).toMatch(/does not match its stored step receipt/);
      const target = makeCtx();
      expect((await api.listRuns(target)).runs).toEqual([]);
      const objects = join(target.storeDir!, "objects");
      const objectFiles = () => existsSync(objects) ? walkFiles(objects) : [];
      const beforeObjects = objectFiles();
      await expect(api.importBundle(target, { bundlePath: bad })).rejects.toMatchObject({ code: "BUNDLE_CORRUPT" });
      expect((await api.listRuns(target)).runs).toEqual([]);
      expect(objectFiles()).toEqual(beforeObjects);
    });
  }
});
