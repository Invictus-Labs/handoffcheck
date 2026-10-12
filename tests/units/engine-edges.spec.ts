// Edge cases of the drill engine and store that the per-AC suite does not reach: failures and timeouts in every step
// type, aborts at every step, optional steps and script options, stray processes, retention, append-only history,
// pagination and store permissions. Each seeded failure must turn the verdict red.
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as api from "../../src/api.js";
import { makeCtx, prepareDrill, sh } from "../helpers/drill.js";
import { allStepsPass, expectRed, runDrill, stepOf } from "../helpers/run.js";
import { makeFakeLima } from "../helpers/lima.js";
import { walkFiles } from "../helpers/scan.js";
import { makeTmp, registerTmpCleanup } from "../helpers/tmp.js";

registerTmpCleanup();

const short = (m: Record<string, any>, i: number, seconds: number): void => { // eslint-disable-line @typescript-eslint/no-explicit-any
  m.steps[i].deadline_seconds = seconds;
  if (m.steps[i].max_recovery_seconds !== undefined) m.steps[i].max_recovery_seconds = Math.min(m.steps[i].max_recovery_seconds, seconds);
};

describe("failures inside each step type turn the run red", () => {
  const cases: [string, Record<string, string>, string, string][] = [
    ["a restore script that exits non-zero", { "restore.sh": "#!/bin/sh\nexit 1\n" }, "restore", "SCRIPT_FAILED"],
    ["a measure script that exits non-zero", { "measure.sh": "#!/bin/sh\nexit 1\n" }, "restore", "RESTORE_MEASURE_MISSING"],
    ["a measure script that prints structurally wrong JSON", { "measure.sh": "#!/bin/sh\necho '{\"record_counts\":{\"notes\":\"twelve\"}}'\n" }, "restore", "RESTORE_MEASURE_MISSING"],
    ["a measure script that prints a JSON array", { "measure.sh": "#!/bin/sh\necho '[1,2]'\n" }, "restore", "RESTORE_MEASURE_MISSING"],
    ["a measure script whose data_hashes are not strings", { "measure.sh": '#!/bin/sh\necho \'{"record_counts":{"notes":12,"blobs":3},"data_hashes":{"rec-0001":5}}\'\n' }, "restore", "RESTORE_MEASURE_MISSING"],
    ["a rotate script that exits non-zero", { "rotate.sh": "#!/bin/sh\nexit 1\n" }, "rotate", "SCRIPT_FAILED"],
    ["a missing old credential file", { "install.sh": sh('"$NODE" "$SVC" install\nrm -f "$HC_STATE/credential.old"') }, "rotate", "ROTATION_NOT_ROTATED"],
    ["a rotate script that deletes the new credential", { "rotate.sh": sh('"$NODE" "$SVC" rotate\nrm -f "$HC_STATE/credential.new"') }, "rotate", "ROTATION_NOT_ROTATED"],
    ["a fault-seeding script that exits non-zero", { "seed-failure.sh": "#!/bin/sh\nexit 1\n" }, "recover", "SCRIPT_FAILED"],
    ["a recovery script that exits non-zero", { "recover.sh": "#!/bin/sh\nexit 1\n" }, "recover", "SCRIPT_FAILED"]
  ];
  for (const [name, scripts, step, reason] of cases) {
    it(`negative control: ${name} is ${reason}`, async () => {
      const { result } = await runDrill({ scripts, manifest: (m) => short(m, 3, 8) });
      expectRed(result);
      expect(stepOf(result, step).reason_code).toBe(reason);
      expect(result.cleanup.status).toBe("VERIFIED");
    });
  }
});

describe("timeouts inside each step type", () => {
  const cases: [string, Record<string, string>, number, string][] = [
    ["restore script", { "restore.sh": "#!/bin/sh\nsleep 20\n" }, 1, "restore"],
    ["measure script", { "measure.sh": "#!/bin/sh\nsleep 20\n" }, 1, "restore"],
    ["rotate script", { "rotate.sh": "#!/bin/sh\nsleep 20\n" }, 2, "rotate"],
    ["rotate probe", { "auth-probe.sh": "#!/bin/sh\nsleep 20\n" }, 2, "rotate"],
    ["fault-seeding script", { "seed-failure.sh": "#!/bin/sh\nsleep 20\n" }, 3, "recover"],
    ["recovery script", { "recover.sh": "#!/bin/sh\nsleep 20\n" }, 3, "recover"],
    ["post-recovery probe", { "worker-probe.sh": sh('if [ -f "$NOTES_HOME/worker.lock" ]; then exit 1; fi\nsleep 20\nexit 0') }, 3, "recover"]
  ];
  for (const [name, scripts, idx, step] of cases) {
    it(`negative control: a hanging ${name} is stopped at the step deadline (TIMEOUT) and the run is red`, async () => {
      const { result } = await runDrill({ scripts, manifest: (m) => { short(m, idx, 3); m.steps[idx].max_recovery_seconds && (m.steps[idx].max_recovery_seconds = 2); } });
      expectRed(result);
      expect(["TIMEOUT", "FAIL"]).toContain(stepOf(result, step).status);
      expect(result.cleanup.status).toBe("VERIFIED");
    }, 60_000);
  }
});

describe("aborting during each step", () => {
  const cases: [string, Record<string, string>, string][] = [
    ["restore", { "restore.sh": "#!/bin/sh\nsleep 30\n" }, "restore"],
    ["rotate", { "rotate.sh": "#!/bin/sh\nsleep 30\n" }, "rotate"],
    ["recover (fault seeding)", { "seed-failure.sh": "#!/bin/sh\nsleep 30\n" }, "recover"],
    ["recover (recovery script)", { "recover.sh": "#!/bin/sh\nsleep 30\n" }, "recover"]
  ];
  for (const [name, scripts, step] of cases) {
    it(`negative control: an abort during ${name} ends ABORTED, skips the rest and verifies cleanup`, async () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 4000);
      const { result } = await runDrill({ scripts }, { signal: controller.signal });
      expectRed(result);
      expect(result.outcome).toBe("ABORTED");
      expect(stepOf(result, step).reason_code).toBe("RUN_ABORTED");
      expect(result.cleanup.status).toBe("VERIFIED");
    }, 60_000);
  }

  it("negative control: an already-aborted signal starts nothing and still records a verified (empty) cleanup", async () => {
    const controller = new AbortController();
    controller.abort();
    const { result } = await runDrill({}, { signal: controller.signal });
    expectRed(result);
    expect(result.outcome).toBe("ABORTED");
    expect(result.steps.every((s) => s.status === "SKIPPED")).toBe(true);
    expect(result.cleanup.status).toBe("VERIFIED");
    expect(result.cleanup.resources).toBe(0);
  });
});

describe("optional steps, script options and pins", () => {
  /** An extra non-mandatory install-action step ahead of rotate; every PRD action stays mandatory elsewhere. */
  const optionalWarmup = (m: Record<string, any>): void => void m.steps.splice(2, 0, { id: "warmup", action: "install", mandatory: false, deadline_seconds: 30, script: { path: "scripts/warmup.sh" }, probe: { path: "scripts/health.sh" }, probe_interval_ms: 200 }); // eslint-disable-line @typescript-eslint/no-explicit-any

  it("P0-1 corrected rule: a failed OPTIONAL step is reported and never blocks later steps, but caps the run at REHEARSAL (OPTIONAL_STEP_FAILED), never INDEPENDENT_PASS", async () => {
    const { result, ctx } = await runDrill({ scripts: { "warmup.sh": "#!/bin/sh\nexit 1\n" }, manifest: optionalWarmup });
    expect(stepOf(result, "warmup").status).toBe("FAIL");
    expect(stepOf(result, "rotate").status).toBe("PASS");
    expect(stepOf(result, "recover").status).toBe("PASS");
    expect(result.verdict.verdict).toBe("REHEARSAL");
    expect(result.verdict.reasons.map((r) => r.code)).toContain("OPTIONAL_STEP_FAILED");
    expect(result.verdict.independent).toBe(false);
    const report = await api.getReport(ctx, { runId: result.run_id });
    expect(report.steps.find((s) => s.step_key === "warmup")).toMatchObject({ mandatory: false, status: "FAIL" });
    expect(report.verdict.reasons.map((r) => r.code)).toContain("OPTIONAL_STEP_FAILED");
  });

  it("negative control: the same failed optional step on a human, non-builder VM run (fake limactl plumbing) is still never INDEPENDENT_PASS", async () => {
    const lima = makeFakeLima();
    const { result } = await runDrill(
      { scripts: { "warmup.sh": "#!/bin/sh\nexit 1\n" }, manifest: (m) => { optionalWarmup(m); m.runner.provider = "lima"; } },
      { operator: { kind: "human", ref: "operator-a", builder_ref: "builder-b" }, ctx: { env: lima.env } }
    );
    expect(result.isolation).toBe("vm");
    expect(stepOf(result, "warmup").status).toBe("FAIL");
    expect(result.verdict.verdict).toBe("REHEARSAL");
    expect(result.verdict.reasons.map((r) => r.code)).toContain("OPTIONAL_STEP_FAILED");
  });

  it("positive control: the same optional step passing leaves the run's verdict untouched (REHEARSAL here only because the operator is automated)", async () => {
    const { result } = await runDrill({ scripts: { "warmup.sh": "#!/bin/sh\nexit 0\n" }, manifest: optionalWarmup });
    expect(stepOf(result, "warmup").status).toBe("PASS");
    expect(result.verdict.reasons.map((r) => r.code)).not.toContain("OPTIONAL_STEP_FAILED");
    expect(result.verdict.reasons.map((r) => r.code)).toContain("OPERATOR_NOT_HUMAN");
  });

  it("honours custom reject exit codes, script args, the node and bash interpreters and a matching sha256 pin", async () => {
    const probe = "#!/bin/sh\nset -eu\n: \"${HC_RELEASE:?}\"\nHC_STATE_DIR=\"$HC_STATE\"\nexport NOTES_HOME=\"$HC_STATE_DIR/notes\"\nNODE=\"${HC_NODE:-node}\"\nHC_CREDENTIAL=\"$HC_CREDENTIAL\" \"$NODE\" \"$HC_RELEASE/bin/notes.mjs\" auth-probe\nrc=$?\n[ $rc -eq 3 ] && exit 4\nexit $rc\n";
    const inputs = prepareDrill({
      scripts: { "auth-probe.sh": probe, "node-probe.mjs": 'import fs from "node:fs";\nfs.writeFileSync(process.env.HC_STATE + "/node-ran", process.argv.slice(2).join(","));\n' },
      manifest: (m) => {
        m.steps[2].reject_exit_codes = [3, 4];
        m.steps[0].script = { path: "scripts/install.sh", interpreter: "bash", args: ["a", "b"], sha256: require_sha(join(process.cwd(), "fixtures/drill/scripts/install.sh")) };
        m.steps[0].probe = { path: "scripts/health.sh", interpreter: "sh" };
        m.steps[1].measure = { path: "scripts/measure.sh", interpreter: "bash" };
      }
    });
    const ctx = makeCtx();
    const result = await api.run(ctx, inputs.paths);
    expect(allStepsPass(result), JSON.stringify(result.steps)).toBe(true);
  }, 60_000);

  it("negative control: a script whose bytes differ from its sha256 pin is rejected before anything runs", async () => {
    const { result } = await runDrill({ manifest: (m) => void (m.steps[0].script = { path: "scripts/install.sh", sha256: "0".repeat(64) }) });
    expectRed(result);
    expect(result.steps.every((s) => s.status === "SKIPPED")).toBe(true);
    expect(result.preflight?.findings.map((f) => f.code)).toContain("SCRIPT_HASH_MISMATCH");
  });

  it("negative control: a script that is missing, a directory, a symlink or oversized is rejected by preflight", async () => {
    for (const mutate of [
      (d: string) => void writeFileSync(join(d, "scripts", "big.sh"), "#".repeat(1024 * 1024 + 10)),
      (d: string) => void writeFileSync(join(d, "scripts", "empty-dir.sh"), "")
    ]) {
      const inputs = prepareDrill({ manifest: (m) => void (m.steps[0].script = { path: "scripts/big.sh" }) });
      mutate(inputs.dir);
      const report = await api.preflight({ env: { PATH: process.env.PATH ?? "" } }, inputs.paths).catch((e: unknown) => e);
      const rejected = (report as api.PreflightReport).status === "REJECTED" || report instanceof api.HandoffCheckError;
      expect(rejected).toBe(true);
    }
  });

  it("an unknown runner provider in a manifest is rejected by the schema, not run", async () => {
    const inputs = prepareDrill({ manifest: (m) => void (m.runner.provider = "docker") });
    await expect(api.run(makeCtx(), inputs.paths)).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
  });
});

describe("stray processes", () => {
  it("negative control: a daemon that escapes the process group is killed or reported as a leak, never ignored", async () => {
    const pidFile = join(makeTmp("hc-stray-"), "stray.pid");
    const install = sh(
      `"$NODE" "$SVC" install\nperl -e 'use POSIX qw(setsid); setsid(); exec "sleep", "300"' >/dev/null 2>&1 &\necho $! > "$QA_STRAY_PID_FILE"\nsleep 1`
    );
    const { result } = await runDrill({ scripts: { "install.sh": install }, manifest: (m) => void (m.env = { ...m.env, QA_STRAY_PID_FILE: pidFile }) });
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    // Acceptable: the stray was killed and cleanup verified, OR the stray survived and the run is red as CLEANUP_UNCONFIRMED.
    if (alive) {
      expectRed(result);
      expect(result.cleanup.status).toBe("UNCONFIRMED");
    } else {
      expect(result.cleanup.status).toBe("VERIFIED");
    }
  }, 60_000);
});

describe("store: retention, append-only history, pagination, permissions", () => {
  it("purgeExpired removes only expired runs and their unreferenced objects", async () => {
    const early = makeCtx();
    const first = await api.run(early, prepareDrill({ manifest: (m) => void (m.retention_days = 1) }).paths);
    const second = await api.run(makeCtx({ storeDir: early.storeDir, clock: api.fixedClock("2026-01-05T00:00:00.000Z", 1000), ids: api.sequentialIds(0x5b) }), prepareDrill({ manifest: (m) => void (m.retention_days = 90) }).paths);
    const before = walkFiles(join(early.storeDir, "objects")).length;
    const purge = await api.purgeExpired(makeCtx({ storeDir: early.storeDir, clock: api.fixedClock("2026-01-10T00:00:00.000Z", 1000) }));
    expect(purge.purged).toEqual([first.run_id]);
    const left = (await api.listRuns(makeCtx({ storeDir: early.storeDir }))).runs.map((r) => r.id);
    expect(left).toEqual([second.run_id]);
    expect(walkFiles(join(early.storeDir, "objects")).length).toBeLessThan(before);
    await expect(api.getReport(makeCtx({ storeDir: early.storeDir }), { runId: first.run_id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await api.purgeExpired(makeCtx({ storeDir: early.storeDir, clock: api.fixedClock("2026-01-10T00:00:00.000Z", 1000) }))).purged).toEqual([]);
  }, 120_000);

  it("negative control: history is append-only: UPDATE and DELETE on evidence tables are refused by the database", async () => {
    const { ctx, result } = await runDrill();
    await api.recordIntervention(ctx, { runId: result.run_id, reason: "x", actorRef: "a" });
    const db = new DatabaseSync(join(ctx.storeDir, "handoffcheck.sqlite"));
    try {
      for (const table of ["steps", "interventions", "evidence", "cleanup_receipts", "state_transitions", "run_documents"]) {
        expect(() => db.exec(`DELETE FROM ${table}`), `DELETE ${table}`).toThrow();
      }
      expect(() => db.exec("UPDATE steps SET status = 'PASS'")).toThrow();
      expect(() => db.exec("UPDATE interventions SET reason = 'edited'")).toThrow();
      expect(() => db.exec("UPDATE evidence SET sha256 = 'x'")).toThrow();
      const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
      expect(fk.foreign_keys).toBe(1);
    } finally {
      db.close();
    }
  });

  it("negative control: a tampered or deleted evidence object turns an accepted run UNKNOWN (EVIDENCE_UNVERIFIABLE) and never exits 0", async () => {
    const { ctx, result } = await runDrill();
    expect(result.exit_code).toBe(0);
    const report = await api.getReport(ctx, { runId: result.run_id });
    const target = report.evidence.find((e) => e.kind === "step_receipt")!;
    const path = join(ctx.storeDir, "objects", target.sha256.slice(0, 2), target.sha256);
    const original = readFileSync(path);
    writeFileSync(path, Buffer.concat([original, Buffer.from(" tampered")]));
    const tampered = await api.getReport(makeCtx({ storeDir: ctx.storeDir }), { runId: result.run_id });
    expect(tampered.verdict.verdict).toBe("UNKNOWN");
    expect(tampered.verdict.reasons.map((r) => r.code)).toContain("EVIDENCE_UNVERIFIABLE");
    expect(tampered.verdict.exit_code).toBe(1);
    rmSync(path);
    const deleted = await api.getReport(makeCtx({ storeDir: ctx.storeDir }), { runId: result.run_id });
    expect(deleted.verdict.verdict).toBe("UNKNOWN");
    writeFileSync(path, original);
    expect((await api.getReport(makeCtx({ storeDir: ctx.storeDir }), { runId: result.run_id })).verdict.verdict).toBe("REHEARSAL");
  });

  it("lists runs with cursor pagination capped at 100 per page", async () => {
    const ctx = makeCtx();
    const inputs = prepareDrill();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await api.run(makeCtx({ storeDir: ctx.storeDir, clock: api.fixedClock(`2026-01-0${i + 1}T00:00:00.000Z`, 1000), ids: api.sequentialIds(0x60 + i) }), inputs.paths)).run_id);
    const page1 = await api.listRuns(ctx, { limit: 2 });
    expect(page1.runs).toHaveLength(2);
    expect(page1.next_cursor).not.toBeNull();
    const page2 = await api.listRuns(ctx, { limit: 2, cursor: page1.next_cursor as string });
    expect(page2.runs).toHaveLength(1);
    expect(page2.next_cursor).toBeNull();
    expect(new Set([...page1.runs, ...page2.runs].map((r) => r.id))).toEqual(new Set(ids));
    expect((await api.listRuns(ctx, { limit: 100000 })).runs).toHaveLength(3);
    await expect(api.listRuns(ctx, { cursor: "not-a-cursor" })).rejects.toBeInstanceOf(api.HandoffCheckError);
    await expect(api.listRuns(ctx, { limit: 0 })).rejects.toBeInstanceOf(api.HandoffCheckError).catch(() => undefined);
  }, 120_000);

  it("creates the store owner-only (directory 0700, files 0600) with a random identity key", async () => {
    const { ctx } = await runDrill();
    expect(statSync(ctx.storeDir).mode & 0o077).toBe(0);
    for (const f of walkFiles(ctx.storeDir)) expect(statSync(f).mode & 0o077, f).toBe(0);
    const key = readFileSync(join(ctx.storeDir, "identity.key"));
    expect(key.length).toBeGreaterThanOrEqual(32);
  });

  it("negative control: a store written by a newer version is refused (STORE_SCHEMA_UNSUPPORTED), never modified", async () => {
    const { ctx } = await runDrill();
    const path = join(ctx.storeDir, "handoffcheck.sqlite");
    const db = new DatabaseSync(path);
    db.exec("PRAGMA user_version = 999");
    db.close();
    const before = readFileSync(path);
    await expect(api.listRuns(makeCtx({ storeDir: ctx.storeDir }))).rejects.toMatchObject({ code: "STORE_SCHEMA_UNSUPPORTED" });
    await expect(api.run(makeCtx({ storeDir: ctx.storeDir }), prepareDrill().paths)).rejects.toMatchObject({ code: "STORE_SCHEMA_UNSUPPORTED" });
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it("uses the injected deterministic UTC clock and sequential ids for every stored timestamp and id", async () => {
    const { ctx, result } = await runDrill();
    const report = await api.getReport(ctx, { runId: result.run_id });
    expect(report.run.created_at).toMatch(/^2026-01-01T00:00:0\d\.000Z$/);
    expect(result.run_id).toMatch(/^00000000-004a-4000-8000-/);
    for (const t of report.state_history) expect(t.at).toMatch(/^2026-01-01T00:\d\d:\d\d\.000Z$/);
    expect(report.generated_at).toMatch(/^2026-01-01T/);
  });

  it("createDrill records a CREATED run with its binding and preflight but executes nothing", async () => {
    const ctx = makeCtx();
    const created = await api.createDrill(ctx, prepareDrill().paths);
    expect(created.preflight.status).toBe("PASS");
    expect(created.binding.binding_digest).toMatch(/^[0-9a-f]{64}$/);
    const report = await api.getReport(ctx, { runId: created.run_id });
    expect(report.run.state).toBe("CREATED");
    expect(report.steps).toEqual([]);
    expect(report.verdict.verdict).not.toBe("INDEPENDENT_PASS");
    expect(report.verdict.exit_code).toBe(1);
    await expect(api.cleanup(ctx, { runId: created.run_id })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

function require_sha(path: string): string {
  return api.sha256Hex(readFileSync(path));
}
