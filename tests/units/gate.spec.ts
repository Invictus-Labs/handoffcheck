// The quality gate must be able to fail: scripts/verify-quality.sh carries its own self-test with seeded failures, and it
// refuses an unsupported runtime before doing anything else. These tests drive the real script (selftest mode only; the
// full gate is the thing being tested, so it is never run recursively from inside the suite).
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../helpers/cli.js";
import { makeTmp, registerTmpCleanup } from "../helpers/tmp.js";

registerTmpCleanup();

const gate = (env: Record<string, string>) =>
  spawnSync("bash", ["scripts/verify-quality.sh"], { cwd: REPO_ROOT, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: makeTmp("hc-gate-"), ...env }, timeout: 120_000 });

describe("gate self-test", () => {
  it("every seeded failure (failed/skipped/missing tests, failing step, old runtime, stray package file, seeded secret, seeded personal path) turns the gate red, and clean inputs stay green", () => {
    const r = gate({ HC_GATE_ONLY: "selftest" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    for (const line of [
      "count_tests with a seeded 'failed' report turns red",
      "count_tests with a seeded 'skipped' report turns red",
      "count_tests with no report at all turns red",
      "run_step on a failing command turns red",
      "an unsupported node (20.x) on PATH turns red",
      "package hygiene with a seeded sqlite file turns red",
      "sec-scan on a seeded credential-shaped literal turns red",
      "sanitize-content on a seeded personal path turns red",
      "count_tests on an all-passing report stays green"
    ]) expect(r.stdout, line).toContain(line);
    expect(r.stdout).toContain("all seeded failures were detected");
  }, 180_000);

  it("negative control: a node older than 22.13 on PATH aborts the gate with exit 2 and a clear message, before any check runs", () => {
    const dir = makeTmp("hc-oldnode-");
    const fake = join(dir, "node");
    writeFileSync(fake, '#!/bin/sh\ncase "$*" in *versions.node*) echo 20.11.0 ;; esac\nexit 0\n');
    chmodSync(fake, 0o755);
    const r = gate({ PATH: `${dir}:/usr/bin:/bin` });
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stderr).toMatch(/unsupported runtime: node 20\.11\.0 \(need >= 22\.13\)/);
    expect(r.stdout).not.toContain("== typecheck");
  });

  it("negative control: the live receipt script without a real limactl exits 2 (BLOCKED) and writes nothing that could pass for evidence", () => {
    const out = join(makeTmp("hc-receipt-"), "receipt");
    const bin = makeTmp("hc-nolima-");
    symlinkSync("/usr/bin/dirname", join(bin, "dirname")); // the only tool the script needs before it looks for limactl
    const r = spawnSync("/bin/bash", ["scripts/live-receipt.sh", out], { cwd: REPO_ROOT, encoding: "utf8", env: { PATH: bin, HOME: process.env.HOME ?? "" } });
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stderr).toMatch(/BLOCKED: limactl not found/);
    expect(existsSync(out)).toBe(false);
  });
});
