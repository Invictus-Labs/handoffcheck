// HandoffCheck acceptance suite. One describe per acceptance criterion (docs/DOD.md, docs/qa/AC-MATRIX.md).
// Library API + real SQLite + the real local-sandbox provider against the synthetic fixture release.
// Titles that start with "negative control" seed a mandatory failure and assert the verdict turns red.
// AC-08 and AC-12 are human-receipt criteria: only their automated plumbing is asserted here.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as api from "../src/api.js";
import { DECOYS, DECOY_KINDS } from "./helpers/decoys.js";
import {
  PLANTED,
  fixtureRunbook,
  makeCtx,
  prepareDrill,
  readFixtureScript,
  readReleaseFile,
  sh,
  type PrepareOptions
} from "./helpers/drill.js";
import { allStepsPass, expectRed, runDrill, stepOf, type Executed } from "./helpers/run.js";
import { runMain } from "./helpers/cli.js";
import { makeFakeLima } from "./helpers/lima.js";
import { forgeBundle } from "./helpers/bundle.js";
import { filesContaining, walkFiles, withNetworkDenied } from "./helpers/scan.js";
import { readTarEntries } from "./helpers/tar.js";
import { makeTmp, registerTmpCleanup } from "./helpers/tmp.js";
import { buildTar, sha256Hex } from "../scripts/build-fixture-release.mjs";
import { evaluateAcceptance } from "../src/domain/verdict.js";
import { COMMANDS } from "../src/cli/args.js";

registerTmpCleanup();

// A clean fixture drill is expensive (it really executes the scripts); share one across read-only assertions.
let clean: Executed;
beforeAll(async () => {
  clean = await runDrill();
}, 120_000);

describe("fixture sanity (the clean drill is green, so every red below is caused by its seeded fault)", () => {
  it("clean fixture drill passes every step, verifies cleanup and exits 0 as a REHEARSAL", () => {
    expect(clean.result.steps.map((s) => s.step_key)).toEqual(["install", "restore", "rotate", "recover"]);
    expect(allStepsPass(clean.result)).toBe(true);
    expect(clean.result.cleanup.status).toBe("VERIFIED");
    expect(clean.result.cleanup.leaked).toBe(0);
    expect(clean.result.verdict.verdict).toBe("REHEARSAL");
    expect(clean.result.exit_code).toBe(0);
  });
});

describe("AC-01 input binding", () => {
  it("binds the artifact sha256, runbook sha256 and scenario version into the binding digest", async () => {
    const b = clean.result.binding;
    expect(b.artifact_digest).toBe(clean.inputs.artifactSha256);
    expect(b.runbook_hash).toBe(clean.inputs.runbookSha256);
    expect(b.scenario_version).toBe("1.0.0");
    expect(b.manifest_digest).toMatch(/^[0-9a-f]{64}$/);
    const expected = api.sha256Hex(
      api.canonicalJson({
        artifact_digest: b.artifact_digest,
        runbook_hash: b.runbook_hash,
        scenario_version: b.scenario_version,
        manifest_digest: b.manifest_digest
      })
    );
    expect(b.binding_digest).toBe(expected);
  });

  it("the same bytes bind to the same digest (deterministic); a REHEARSAL on this host is never reusable (P2-2)", async () => {
    const decision = await api.checkReuse(makeCtx({ storeDir: clean.ctx.storeDir }), clean.inputs.paths);
    expect(clean.result.verdict.verdict).toBe("REHEARSAL");
    expect(decision.reusable).toBe(false);
    expect(decision.reason).toBe("PRIOR_NOT_ACCEPTED");
    expect(decision.verdict).toBe("REHEARSAL");
    expect(decision.run_id).toBe(clean.result.run_id);
    expect(decision.binding.binding_digest).toBe(clean.result.binding.binding_digest);
    expect(decision.invalidated_run_ids).toEqual([]);
  });

  it("an INDEPENDENT_PASS (human, VM, no help; protocol plumbing via the fake limactl) is reusable for the same bytes only", async () => {
    const lima = makeFakeLima();
    const inputs = prepareDrill({ manifest: (m) => void (m.runner.provider = "lima") });
    const ctx = makeCtx({ env: lima.env });
    const result = await api.run(ctx, { ...inputs.paths, operator: { kind: "human", ref: "operator-a", builder_ref: "builder-b" } });
    expect(result.verdict.verdict).toBe("INDEPENDENT_PASS");
    const same = await api.checkReuse(makeCtx({ storeDir: ctx.storeDir }), inputs.paths);
    expect(same).toMatchObject({ reusable: true, reason: "REUSABLE", run_id: result.run_id, verdict: "INDEPENDENT_PASS" });
    const changed = prepareDrill({ manifest: (m) => void (m.runner.provider = "lima"), release: { "config/service.env": readReleaseFile("config/service.env").replace("RETENTION_DAYS=90", "RETENTION_DAYS=91") } });
    const after = await api.checkReuse(makeCtx({ storeDir: ctx.storeDir }), changed.paths);
    expect(after.reusable).toBe(false);
    expect(after.reason).toBe("BINDING_CHANGED");
    expect(after.invalidated_run_ids).toEqual([result.run_id]);
  });

  it("an empty store has nothing reusable", async () => {
    const decision = await api.checkReuse(makeCtx(), clean.inputs.paths);
    expect(decision.reusable).toBe(false);
    expect(decision.reason).toBe("NO_PRIOR_RUN");
  });

  async function reuseAgainst(opts: PrepareOptions) {
    const changed = prepareDrill(opts);
    return api.checkReuse(makeCtx({ storeDir: clean.ctx.storeDir }), changed.paths);
  }

  it("negative control: one changed artifact byte invalidates reuse and lists the earlier run", async () => {
    const d = await reuseAgainst({ release: { "config/service.env": readReleaseFile("config/service.env").replace("RETENTION_DAYS=90", "RETENTION_DAYS=91") } });
    expect(d.reusable).toBe(false);
    expect(d.reason).toBe("BINDING_CHANGED");
    expect(d.invalidated_run_ids).toContain(clean.result.run_id);
    expect(d.run_id).toBeUndefined();
  });

  it("negative control: a one-character runbook edit invalidates reuse", async () => {
    const d = await reuseAgainst({ runbook: `${fixtureRunbook()}\n.` });
    expect(d.reusable).toBe(false);
    expect(d.reason).toBe("BINDING_CHANGED");
    expect(d.invalidated_run_ids).toContain(clean.result.run_id);
  });

  it("negative control: a bumped scenario version invalidates reuse", async () => {
    const d = await reuseAgainst({ manifest: (m) => void (m.scenario.version = "1.0.1") });
    expect(d.reusable).toBe(false);
    expect(d.reason).toBe("BINDING_CHANGED");
  });

  it("negative control: editing a referenced script invalidates reuse (the manifest digest covers script bytes)", async () => {
    const d = await reuseAgainst({ scripts: { "health.sh": `${readFixtureScript("health.sh")}# edited\n` } });
    expect(d.reusable).toBe(false);
    expect(d.reason).toBe("BINDING_CHANGED");
  });

  it("negative control: a stale binding at report time is UNKNOWN (STALE_BINDING), never a pass", async () => {
    const changed = prepareDrill({ runbook: `${fixtureRunbook()}\nextra line\n` });
    const fresh = await api.getReport(makeCtx({ storeDir: clean.ctx.storeDir }), { runId: clean.result.run_id });
    expect(fresh.verdict.verdict).toBe("REHEARSAL");
    const stale = await api.getReport(makeCtx({ storeDir: clean.ctx.storeDir }), { runId: clean.result.run_id, currentInputs: changed.paths });
    expect(stale.verdict.verdict).toBe("UNKNOWN");
    expect(stale.verdict.binding_check).toBe("MISMATCH");
    expect(stale.verdict.reasons.map((r) => r.code)).toContain("STALE_BINDING");
    expect(stale.verdict.exit_code).toBe(1);
  });

  it("matching current inputs report binding_check MATCH", async () => {
    const r = await api.getReport(makeCtx({ storeDir: clean.ctx.storeDir }), { runId: clean.result.run_id, currentInputs: clean.inputs.paths });
    expect(r.verdict.binding_check).toBe("MATCH");
    expect(r.verdict.verdict).toBe("REHEARSAL");
  });

  it("negative control: a failed prior run is not reusable even with an identical binding", async () => {
    const failing = prepareDrill({ scripts: { "health.sh": "#!/bin/sh\nexit 1\n" }, manifest: (m) => void (m.steps[0].deadline_seconds = 2) });
    const ctx = makeCtx();
    const run = await api.run(ctx, failing.paths);
    expectRed(run);
    const d = await api.checkReuse(makeCtx({ storeDir: ctx.storeDir }), failing.paths);
    expect(d.reusable).toBe(false);
    expect(d.reason).toBe("PRIOR_NOT_ACCEPTED");
  });
});

describe("AC-02 sandbox boundary", () => {
  const locations: { name: string; opts: (secret: string) => PrepareOptions }[] = [
    { name: "an artifact file", opts: (s) => ({ extra: [{ path: "config/prod.env", data: `API_KEY=${s}\n` }] }) },
    { name: "a drill script", opts: (s) => ({ scripts: { "health.sh": `${readFixtureScript("health.sh")}# ${s}\n` } }) },
    { name: "a manifest env value", opts: (s) => ({ manifest: (m) => void (m.env = { ...m.env, UPSTREAM_KEY: s }) }) }
  ];

  for (const kind of DECOY_KINDS) {
    for (const loc of locations) {
      it(`negative control: preflight rejects a production-credential decoy (${kind}) in ${loc.name} without echoing it`, async () => {
        const secret = DECOYS[kind];
        const inputs = prepareDrill(loc.opts(secret));
        const report = await api.preflight({ env: { PATH: process.env.PATH ?? "" } }, inputs.paths);
        expect(report.status).toBe("REJECTED");
        expect(report.findings.some((f) => f.severity === "reject" && (f.code === "PRODUCTION_CREDENTIAL" || f.code === "ENV_UNSAFE"))).toBe(true);
        expect(JSON.stringify(report)).not.toContain(secret);
      });
    }
  }

  it("a planted fake credential carrying the HCFAKE marker is allowed", async () => {
    const inputs = prepareDrill({ extra: [{ path: "config/planted.env", data: `API_KEY=AKIAHCFAKE0123456789\nTOKEN=${PLANTED.oldToken}\n` }] });
    const report = await api.preflight({ env: { PATH: process.env.PATH ?? "" } }, inputs.paths);
    expect(report.status).toBe("PASS");
  });

  it("negative control: a rejected preflight provisions nothing, executes no step and exits 1", async () => {
    const { result, ctx } = await runDrill({ extra: [{ path: "config/prod.env", data: `K=${DECOYS.stripeLiveKey}\n` }] });
    expectRed(result);
    expect(result.verdict.verdict).toBe("FAIL");
    expect(result.verdict.reasons.map((r) => r.code)).toContain("PREFLIGHT_REJECTED");
    expect(result.preflight?.status).toBe("REJECTED");
    expect(result.steps.every((s) => s.status === "SKIPPED")).toBe(true);
    expect(result.cleanup.resources).toBe(0);
    const report = await api.getReport(ctx, { runId: result.run_id });
    expect(report.steps.every((s) => s.status === "SKIPPED")).toBe(true);
    expect(JSON.stringify(report)).not.toContain(DECOYS.stripeLiveKey);
  });

  it("negative control: an undeclared network destination is rejected; loopback and declared hosts are allowed", async () => {
    const env = { PATH: process.env.PATH ?? "" };
    const bad = prepareDrill({ scripts: { "health.sh": `${readFixtureScript("health.sh")}curl --silent https://updates.example.org/check\n` } });
    const rejected = await api.preflight({ env }, bad.paths);
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.findings.map((f) => f.code)).toContain("UNDECLARED_NETWORK_DESTINATION");

    const ip = prepareDrill({ scripts: { "health.sh": `${readFixtureScript("health.sh")}curl http://203.0.113.9:8080/x\n` } });
    expect((await api.preflight({ env }, ip.paths)).findings.map((f) => f.code)).toContain("UNDECLARED_NETWORK_DESTINATION");

    const loopback = prepareDrill({ scripts: { "health.sh": `${readFixtureScript("health.sh")}curl http://localhost:8080/health\ncurl http://127.0.0.1:8080/health\n` } });
    expect((await api.preflight({ env }, loopback.paths)).findings.map((f) => f.code)).not.toContain("UNDECLARED_NETWORK_DESTINATION");

    const declared = prepareDrill({
      scripts: { "health.sh": `${readFixtureScript("health.sh")}curl https://updates.example.org/check\n` },
      manifest: (m) => void (m.network.allow = ["updates.example.org"])
    });
    expect((await api.preflight({ env }, declared.paths)).findings.map((f) => f.code)).not.toContain("UNDECLARED_NETWORK_DESTINATION");
  });

  it("negative control: the local-sandbox provider refuses a manifest that is not declared synthetic", async () => {
    const inputs = prepareDrill({ manifest: (m) => void (m.scenario.synthetic = false) });
    const report = await api.preflight({ env: { PATH: process.env.PATH ?? "" } }, inputs.paths);
    expect(report.status).toBe("REJECTED");
    expect(report.findings.map((f) => f.code)).toContain("NOT_SYNTHETIC");
  });

  it("negative control: the VM provider requires declared resource limits", async () => {
    const inputs = prepareDrill({ manifest: (m) => { m.runner.provider = "lima"; delete m.runner.resources; } });
    const report = await api.preflight({ env: { PATH: process.env.PATH ?? "" } }, inputs.paths);
    expect(report.status).toBe("REJECTED");
    expect(report.findings.map((f) => f.code)).toContain("MISSING_RESOURCE_LIMITS");
  });

  it("negative control: a missing limactl is BLOCKED explicitly, never success", async () => {
    const { result, ctx } = await runDrill(
      { manifest: (m) => void (m.runner.provider = "lima") },
      { ctx: { env: { PATH: process.env.PATH ?? "", HANDOFFCHECK_LIMACTL: join(makeTmp(), "no-such-limactl") } } }
    );
    expectRed(result);
    expect(result.verdict.verdict).toBe("BLOCKED");
    expect(result.verdict.reasons.map((r) => r.code)).toContain("PROVIDER_UNAVAILABLE");
    expect(result.steps.every((s) => s.status === "SKIPPED")).toBe(true);
    const report = await api.getReport(ctx, { runId: result.run_id });
    expect(report.verdict.verdict).toBe("BLOCKED");
    expect(report.run.provider).toBe("lima");
  });

  it("local-sandbox receipts are labelled isolation=none and can never satisfy a VM-isolation criterion", async () => {
    const report = await api.getReport(makeCtx({ storeDir: clean.ctx.storeDir }), { runId: clean.result.run_id });
    expect(report.run.isolation).toBe("none");
    expect(report.run.provider).toBe("local-sandbox");
    expect(report.run.labels.join(" ").toLowerCase()).toContain("isolation");
    expect(report.verdict.independent).toBe(false);
    expect(report.verdict.verdict).not.toBe("INDEPENDENT_PASS");
    expect(report.verdict.reasons.map((r) => r.code)).toContain("ISOLATION_NONE");
  });

  it("negative control: even a human, non-builder operator on isolation none is only a REHEARSAL", async () => {
    const { result } = await runDrill({}, { operator: { kind: "human", ref: "operator-a", builder_ref: "builder-b" } });
    expect(result.verdict.verdict).toBe("REHEARSAL");
    expect(result.verdict.independent).toBe(false);
  });

  it("the live VM isolation criterion is BLOCKED unless a real limactl is present and the live run is opted in", () => {
    // Live evidence comes only from the opt-in spec (a separate vitest run with HC_LIVE_VM=1). This test pins its contract so it
    // behaves identically with and without the opt-in: it must report BLOCKED without a real limactl and must never use a fake.
    const live = readFileSync(join(import.meta.dirname, "live", "vm.spec.ts"), "utf8");
    expect(live).toContain('process.env.HC_LIVE_VM === "1" && limactl !== null');
    expect(live).toContain("BLOCKED: live VM drill not run");
    expect((live.match(/ctx\.skip\(blockedNote\)/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect(live).not.toMatch(/makeFakeLima|fake-limactl/);
    // a fake limactl run, however green, is labelled protocol evidence and can never be the live record
    expect(readFileSync(join(import.meta.dirname, "helpers", "fake-limactl.sh"), "utf8")).toMatch(/NOT a VM/);
  });

  it("output beyond max_output_bytes is capped rather than stored whole", async () => {
    const { result, ctx } = await runDrill({
      scripts: { "install.sh": sh('"$NODE" "$SVC" install\nhead -c 3000000 /dev/zero | tr "\\0" "A"') },
      manifest: (m) => void (m.runner.max_output_bytes = 4096)
    });
    expect(stepOf(result, "install").status).toBe("PASS");
    const report = await api.getReport(ctx, { runId: result.run_id });
    const logs = report.evidence.filter((e) => e.kind === "step_log");
    expect(logs.length).toBeGreaterThan(0);
    for (const e of logs) expect(e.size_bytes).toBeLessThanOrEqual(64 * 1024);
  });
});

describe("AC-03 fresh install", () => {
  it("installs from the supplied scripts in a fresh sandbox and passes the declared health probe within the deadline", async () => {
    const report = await api.getReport(makeCtx({ storeDir: clean.ctx.storeDir }), { runId: clean.result.run_id });
    const install = report.steps.find((s) => s.step_key === "install");
    expect(install?.status).toBe("PASS");
    expect(install?.reason_code).toBe("OK");
    expect(install?.duration_ms).not.toBeNull();
    expect((install?.duration_ms ?? Infinity) / 1000).toBeLessThanOrEqual(install?.deadline_seconds ?? 0);
    expect(install?.evidence_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a probe that fails once and then passes within the deadline still passes", async () => {
    const { result } = await runDrill({
      scripts: { "health.sh": sh('if [ -f "$HC_STATE/probed" ]; then exec "$NODE" "$SVC" health; fi\ntouch "$HC_STATE/probed"\nexit 1') }
    });
    expect(stepOf(result, "install").status).toBe("PASS");
    expect(result.exit_code).toBe(0);
  });

  it("negative control: a health probe that never passes fails the install and turns the run red", async () => {
    const { result } = await runDrill({
      scripts: { "health.sh": "#!/bin/sh\nexit 1\n" },
      manifest: (m) => void (m.steps[0].deadline_seconds = 2)
    });
    expectRed(result);
    const install = stepOf(result, "install");
    expect(["FAIL", "TIMEOUT"]).toContain(install.status);
    expect(["HEALTH_PROBE_FAILED", "SCRIPT_TIMEOUT"]).toContain(install.reason_code);
    expect(result.steps.filter((s) => s.step_key !== "install").every((s) => s.status === "SKIPPED")).toBe(true);
    expect(result.cleanup.status).toBe("VERIFIED");
  });

  it("negative control: an install slower than the scenario deadline times out", async () => {
    const { result } = await runDrill({
      scripts: { "install.sh": readFixtureScript("install-slow.sh") },
      manifest: (m) => void (m.steps[0].deadline_seconds = 1)
    });
    expectRed(result);
    expect(stepOf(result, "install").status).toBe("TIMEOUT");
    expect(stepOf(result, "install").reason_code).toBe("SCRIPT_TIMEOUT");
    expect(result.cleanup.status).toBe("VERIFIED");
  });

  it("negative control: an install script that exits non-zero is SCRIPT_FAILED", async () => {
    const { result } = await runDrill({ scripts: { "install.sh": "#!/bin/sh\necho broken >&2\nexit 7\n" } });
    expectRed(result);
    expect(stepOf(result, "install").status).toBe("FAIL");
    expect(stepOf(result, "install").reason_code).toBe("SCRIPT_FAILED");
  });

  it("scripts run with a scrubbed environment: ambient parent variables are not inherited", async () => {
    process.env.HC_QA_PARENT_SENTINEL = "HCFAKE_PARENT_SENTINEL";
    try {
      const { result } = await runDrill({
        scripts: { "health.sh": sh('[ -z "${HC_QA_PARENT_SENTINEL:-}" ] || exit 9\nexec "$NODE" "$SVC" health') }
      });
      expect(stepOf(result, "install").status).toBe("PASS");
    } finally {
      delete process.env.HC_QA_PARENT_SENTINEL;
    }
  });
});

describe("AC-04 data restoration", () => {
  it("restores the synthetic backup and compares record counts, selected data hashes and blob hashes", async () => {
    const report = await api.getReport(makeCtx({ storeDir: clean.ctx.storeDir }), { runId: clean.result.run_id });
    const restore = report.steps.find((s) => s.step_key === "restore");
    expect(restore?.status).toBe("PASS");
    const names = (restore?.checks ?? []).map((c) => c.name.toLowerCase());
    // counts (2) + selected data hashes (4) + blob hashes (3), each an independent check
    expect(restore?.checks.length).toBeGreaterThanOrEqual(9);
    expect(restore?.checks.every((c) => c.status === "PASS")).toBe(true);
    expect(names.some((n) => n.includes("count"))).toBe(true);
    expect(names.some((n) => n.includes("hash") || n.includes("data"))).toBe(true);
    expect(names.some((n) => n.includes("blob"))).toBe(true);
  });

  it("negative control: a restore that only starts the service (data not restored) does not pass", async () => {
    const { result } = await runDrill({ scripts: { "restore.sh": sh('"$NODE" "$SVC" wipe\n"$NODE" "$SVC" health || true') } });
    expectRed(result);
    expect(stepOf(result, "restore").status).toBe("FAIL");
    expect(["RESTORE_COUNT_MISMATCH", "RESTORE_MEASURE_MISSING"]).toContain(stepOf(result, "restore").reason_code);
    expect(stepOf(result, "rotate").status).toBe("SKIPPED");
  });

  it("negative control: the right record count with one corrupted record fails on the data hash", async () => {
    const corrupt = sh(
      '"$NODE" "$SVC" wipe\n"$NODE" "$SVC" restore "$HC_RELEASE/backup"\nsed -i.bak "s/Synthetic note 3/Tampered note 3/" "$NOTES_HOME/records.ndjson"\nrm -f "$NOTES_HOME/records.ndjson.bak"'
    );
    const { result } = await runDrill({ scripts: { "restore.sh": corrupt } });
    expectRed(result);
    expect(stepOf(result, "restore").reason_code).toBe("RESTORE_HASH_MISMATCH");
  });

  it("negative control: a damaged blob fails on the independently computed blob hash", async () => {
    const damaged = sh(
      '"$NODE" "$SVC" wipe\n"$NODE" "$SVC" restore "$HC_RELEASE/backup"\nfor f in "$NOTES_HOME"/blobs/*.bin; do head -c 100 "$f" > "$f.cut"; mv "$f.cut" "$f"; break; done'
    );
    const { result } = await runDrill({ scripts: { "restore.sh": damaged } });
    expectRed(result);
    expect(stepOf(result, "restore").reason_code).toBe("RESTORE_BLOB_MISMATCH");
  });

  it("negative control: a restore script that exits 0 but prints no valid measurement fails", async () => {
    const { result } = await runDrill({ scripts: { "measure.sh": "#!/bin/sh\necho 'all good, trust me'\n" } });
    expectRed(result);
    expect(stepOf(result, "restore").reason_code).toBe("RESTORE_MEASURE_MISSING");
  });

  it("negative control: an expected record count that does not match reality fails the restore", async () => {
    const { result } = await runDrill({ manifest: (m) => void (m.steps[1].expect.record_counts.notes = 13) });
    expectRed(result);
    expect(stepOf(result, "restore").reason_code).toBe("RESTORE_COUNT_MISMATCH");
  });

  it("negative control: a restore step with no expected hashes is rejected before anything runs", async () => {
    const inputs = prepareDrill({
      manifest: (m) => {
        delete m.steps[1].expect.data_hashes;
        delete m.steps[1].expect.blobs;
      }
    });
    let rejected = false;
    try {
      const report = await api.preflight({ env: { PATH: process.env.PATH ?? "" } }, inputs.paths);
      rejected = report.status === "REJECTED";
    } catch (err) {
      rejected = err instanceof api.HandoffCheckError && (err.code === "SCHEMA_INVALID" || err.code === "POLICY_REJECTED");
    }
    expect(rejected).toBe(true);
  });
});

describe("AC-05 credential rotation", () => {
  it("rotates a synthetic credential: the old credential is rejected and the new one accepted", async () => {
    const report = await api.getReport(makeCtx({ storeDir: clean.ctx.storeDir }), { runId: clean.result.run_id });
    const rotate = report.steps.find((s) => s.step_key === "rotate");
    expect(rotate?.status).toBe("PASS");
    expect(rotate?.checks.length).toBeGreaterThanOrEqual(2);
    expect(rotate?.checks.every((c) => c.status === "PASS")).toBe(true);
  });

  it("negative control: a rotation that leaves the old credential valid fails with ROTATION_OLD_ACCEPTED", async () => {
    const svc = readReleaseFile("bin/notes.mjs");
    const broken = svc.replace("token_sha256: [hashToken(next)] }));\n    if (CREDENTIAL_DIR)", "token_sha256: [hashToken(next), ...auth.token_sha256] }));\n    if (CREDENTIAL_DIR)");
    expect(broken).not.toBe(svc);
    const { result } = await runDrill({ release: { "bin/notes.mjs": broken } });
    expectRed(result);
    expect(stepOf(result, "rotate").reason_code).toBe("ROTATION_OLD_ACCEPTED");
  });

  it("negative control: a rotation that changes nothing fails with ROTATION_NOT_ROTATED", async () => {
    const { result } = await runDrill({ scripts: { "rotate.sh": sh('cp "$HC_STATE/credential.old" "$HC_STATE/credential.new"') } });
    expectRed(result);
    expect(stepOf(result, "rotate").reason_code).toBe("ROTATION_NOT_ROTATED");
  });

  it("negative control: a new credential the service rejects fails with ROTATION_NEW_REJECTED", async () => {
    const { result } = await runDrill({ scripts: { "rotate.sh": sh(`printf '%s' ${PLANTED.newToken} > "$HC_STATE/credential.new"\nprintf '%s' '{"generation":2,"token_sha256":[]}' > "$NOTES_HOME/auth.json"`) } });
    expectRed(result);
    expect(stepOf(result, "rotate").reason_code).toBe("ROTATION_NEW_REJECTED");
  });

  it("negative control: a probe that crashes is ROTATION_PROBE_ERROR, because unknown never passes", async () => {
    const { result } = await runDrill({ scripts: { "auth-probe.sh": "#!/bin/sh\nexit 1\n" } });
    expectRed(result);
    expect(stepOf(result, "rotate").reason_code).toBe("ROTATION_PROBE_ERROR");
  });
});

describe("AC-06 recovery and intervention", () => {
  it("recovers the bounded seeded worker failure with documented steps and records timing", async () => {
    const report = await api.getReport(makeCtx({ storeDir: clean.ctx.storeDir }), { runId: clean.result.run_id });
    const recover = report.steps.find((s) => s.step_key === "recover");
    expect(recover?.status).toBe("PASS");
    expect(recover?.started_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(recover?.finished_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(recover?.duration_ms).toBeGreaterThanOrEqual(0);
    expect(report.interventions).toEqual([]);
  });

  it("negative control: a seeded fault that never happens is RECOVERY_FAULT_NOT_OBSERVED", async () => {
    const { result } = await runDrill({ scripts: { "seed-failure.sh": "#!/bin/sh\ntrue\n" } });
    expectRed(result);
    expect(stepOf(result, "recover").reason_code).toBe("RECOVERY_FAULT_NOT_OBSERVED");
  });

  it("negative control: a recovery script that does nothing is RECOVERY_NOT_RESTORED", async () => {
    const { result } = await runDrill({
      scripts: { "recover.sh": "#!/bin/sh\ntrue\n" },
      manifest: (m) => {
        m.steps[3].deadline_seconds = 6;
        m.steps[3].max_recovery_seconds = 3;
      }
    });
    expectRed(result);
    expect(stepOf(result, "recover").reason_code).toBe("RECOVERY_NOT_RESTORED");
  });

  it("negative control: a recovery slower than max_recovery_seconds is RECOVERY_TOO_SLOW", async () => {
    const { result } = await runDrill({
      scripts: { "recover.sh": sh('sleep 2\n"$NODE" "$SVC" recover') },
      manifest: (m) => void (m.steps[3].max_recovery_seconds = 1)
    });
    expectRed(result);
    expect(stepOf(result, "recover").reason_code).toBe("RECOVERY_TOO_SLOW");
  });

  it("records every builder intervention and any intervention makes the verdict ASSISTED even after a clean run", async () => {
    const ex = await runDrill();
    expect(ex.result.verdict.verdict).toBe("REHEARSAL");
    expect(ex.result.exit_code).toBe(0);
    const first = await api.recordIntervention(ex.ctx, { runId: ex.result.run_id, reason: "builder re-ran the install by hand", actorRef: "builder-b" });
    await api.recordIntervention(ex.ctx, { runId: ex.result.run_id, reason: "builder explained the recovery order", actorRef: "builder-b", stepKey: "recover" });
    expect(first.actor_ref).toBe("builder-b");
    expect(first.attestation).toBe("local-identity-unsigned-by-third-party");
    expect(first.signature).toMatch(/^[0-9a-f]{64}$/);
    const report = await api.getReport(ex.ctx, { runId: ex.result.run_id });
    expect(report.interventions.map((i) => i.actor_ref)).toEqual(["builder-b", "builder-b"]);
    expect(report.interventions[1]?.step_key).toBe("recover");
    expect(report.verdict.verdict).toBe("ASSISTED");
    expect(report.verdict.reasons.map((r) => r.code)).toContain("INTERVENTION_RECORDED");
    expect(report.verdict.independent).toBe(false);
    expect(report.verdict.exit_code).toBe(1);
  });

  it("negative control: an intervention flips an accepted result and keeps it flipped on a later read", async () => {
    const ex = await runDrill({}, { operator: { kind: "human", ref: "operator-a", builder_ref: "builder-b" } });
    expect(ex.result.exit_code).toBe(0);
    await api.recordIntervention(ex.ctx, { runId: ex.result.run_id, reason: "asked the builder which flag to use", actorRef: "operator-a" });
    const later = await api.getReport(makeCtx({ storeDir: ex.ctx.storeDir }), { runId: ex.result.run_id });
    expect(later.verdict.verdict).toBe("ASSISTED");
    expect(later.verdict.exit_code).toBe(1);
  });

  it("an intervention reason is redacted before storage", async () => {
    const ex = await runDrill();
    await api.recordIntervention(ex.ctx, { runId: ex.result.run_id, reason: `pasted ${PLANTED.oldToken} into chat`, actorRef: "builder-b" });
    const report = await api.getReport(ex.ctx, { runId: ex.result.run_id });
    expect(JSON.stringify(report)).not.toContain(PLANTED.oldToken);
    expect(report.interventions).toHaveLength(1);
  });

  it("recording an intervention for an unknown run is NOT_FOUND", async () => {
    const ctx = makeCtx({ storeDir: clean.ctx.storeDir });
    await expect(api.recordIntervention(ctx, { runId: "run-does-not-exist", reason: "x", actorRef: "a" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("AC-07 abort cleanup", () => {
  it("negative control: a timed-out step is killed and cleanup is still verified", async () => {
    const { result, ctx } = await runDrill({
      scripts: { "install.sh": "#!/bin/sh\nsleep 30\n" },
      manifest: (m) => void (m.steps[0].deadline_seconds = 1)
    });
    expectRed(result);
    expect(stepOf(result, "install").status).toBe("TIMEOUT");
    expect(result.cleanup.status).toBe("VERIFIED");
    const report = await api.getReport(ctx, { runId: result.run_id });
    expect(report.cleanup.status).toBe("VERIFIED");
    expect(report.cleanup.resources.every((r) => r.state === "removed")).toBe(true);
    expect(report.state_history.at(-1)?.to_state).toBe("CLEANUP_VERIFIED");
  });

  it("negative control: exceeding the run wall clock aborts the run and still verifies cleanup", async () => {
    const { result } = await runDrill({
      scripts: { "install.sh": "#!/bin/sh\nsleep 30\n" },
      manifest: (m) => void (m.runner.wall_seconds = 2)
    });
    expectRed(result);
    expect(result.outcome === "ABORTED" || result.outcome === "FAILED").toBe(true);
    expect(result.cleanup.status).toBe("VERIFIED");
    expect(["RUN_TIMEOUT", "SCRIPT_TIMEOUT", "RUN_ABORTED"]).toContain(result.verdict.reasons[0]?.code);
  });

  it("negative control: an abort signal kills the sandbox, ends ABORTED and cleanup is verified", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1200);
    const { result, ctx } = await runDrill({ scripts: { "install.sh": "#!/bin/sh\nsleep 30\n" } }, { signal: controller.signal });
    expectRed(result);
    expect(result.outcome).toBe("ABORTED");
    expect(result.verdict.reasons.map((r) => r.code)).toContain("RUN_ABORTED");
    expect(result.cleanup.status).toBe("VERIFIED");
    const report = await api.getReport(ctx, { runId: result.run_id });
    expect(report.state_history.map((t) => t.to_state)).toContain("ABORTED");
  });

  it("negative control: a leaked resource gives CLEANUP_UNCONFIRMED and a failing exit code even when every step passed", async () => {
    const { result, ctx } = await runDrill({}, { ctx: { env: { PATH: process.env.PATH ?? "", HANDOFFCHECK_TEST_FAULT: "leak-resource" } } });
    expect(allStepsPass(result)).toBe(true);
    expectRed(result);
    expect(result.state).toBe("CLEANUP_UNCONFIRMED");
    expect(result.cleanup.status).toBe("UNCONFIRMED");
    expect(result.cleanup.leaked).toBeGreaterThanOrEqual(1);
    expect(result.verdict.verdict).toBe("FAIL");
    expect(result.verdict.reasons.map((r) => r.code)).toContain("CLEANUP_UNCONFIRMED");
    const report = await api.getReport(ctx, { runId: result.run_id });
    expect(report.run.fault_injected).toBe(true);
    expect(report.cleanup.resources.some((r) => r.state === "leaked")).toBe(true);

    // retrying cleanup while the fault persists stays red; once the leak is gone cleanup can verify
    const stillLeaking = await api.cleanup(ctx, { runId: result.run_id });
    expect(stillLeaking.exit_code).toBe(1);
    const healed = await api.cleanup(makeCtx({ storeDir: ctx.storeDir }), { runId: result.run_id });
    expect(healed.receipt.status).toBe("VERIFIED");
    expect(healed.exit_code).toBe(0);
    expect(healed.state).toBe("CLEANUP_VERIFIED");
  });

  it("a clean run records a verified cleanup receipt with every resource removed", async () => {
    const report = await api.getReport(makeCtx({ storeDir: clean.ctx.storeDir }), { runId: clean.result.run_id });
    expect(report.cleanup.status).toBe("VERIFIED");
    expect(report.cleanup.resources.length).toBeGreaterThan(0);
    expect(report.cleanup.resources.every((r) => r.state === "removed")).toBe(true);
    expect(report.state_history.map((t) => t.to_state)).toEqual(["CREATED", "PREFLIGHT", "RUNNING", "COMPLETE", "CLEANUP_VERIFIED"]);
  });

  it("cleanup for an unknown run is NOT_FOUND", async () => {
    await expect(api.cleanup(makeCtx({ storeDir: clean.ctx.storeDir }), { runId: "run-also-missing" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("AC-08 independent operator protocol (automated plumbing only; the human drill is a separate receipt)", () => {
  it("records who performed the work on the run and keeps the human receipt pending", async () => {
    const { result, ctx } = await runDrill({}, { operator: { kind: "human", ref: "operator-a", builder_ref: "builder-b" } });
    const report = await api.getReport(ctx, { runId: result.run_id });
    expect(report.operator).toMatchObject({ kind: "human", ref: "operator-a", builder_ref: "builder-b" });
    expect(report.verdict.human_receipt).toBe("PENDING_HUMAN_RECEIPT");
    expect(report.verdict.independent).toBe(false);
  });

  it("negative control: an AI-assisted rehearsal is labelled ASSISTED and cannot satisfy the independent criterion", async () => {
    const { result } = await runDrill({}, { operator: { kind: "ai_assisted", ref: "agent-run", builder_ref: "builder-b" } });
    expect(allStepsPass(result)).toBe(true);
    expectRed(result);
    expect(result.verdict.verdict).toBe("ASSISTED");
    expect(result.verdict.reasons.map((r) => r.code)).toContain("OPERATOR_NOT_HUMAN");
  });

  it("negative control: the operator being the builder is never independent", async () => {
    const { result } = await runDrill({}, { operator: { kind: "human", ref: "same-person", builder_ref: "same-person" } });
    expect(result.verdict.independent).toBe(false);
    expect(result.verdict.verdict).not.toBe("INDEPENDENT_PASS");
    expect(result.verdict.reasons.map((r) => r.code)).toContain("OPERATOR_IS_BUILDER");
  });

  it("an automated operator is a REHEARSAL, never independent", async () => {
    expect(clean.result.verdict.verdict).toBe("REHEARSAL");
    expect(clean.result.verdict.reasons.map((r) => r.code)).toContain("OPERATOR_NOT_HUMAN");
    expect(clean.result.verdict.human_receipt).toBe("PENDING_HUMAN_RECEIPT");
  });

  describe("evaluateAcceptance decision table (plumbing; not a human receipt)", () => {
    const ACTIONS = ["install", "restore", "rotate", "recover"] as const;
    const steps = (patch: (a: (typeof ACTIONS)[number]) => Partial<api.AcceptanceInput["steps"][number]> = () => ({})) =>
      ACTIONS.map((action) => ({ mandatory: true, status: "PASS", action, ...patch(action) })) as unknown as api.AcceptanceInput["steps"];
    const base: api.AcceptanceInput = {
      state: "CLEANUP_VERIFIED",
      outcome: "COMPLETE",
      provider_blocked: false,
      preflight_rejected: false,
      binding_check: "MATCH",
      steps: steps(),
      planned_steps: 4,
      cleanup: "VERIFIED",
      operator: { kind: "human", ref: "operator-a", builder_ref: "builder-b" },
      isolation: "vm",
      interventions: 0
    };

    it("grants INDEPENDENT_PASS only for a human, non-builder operator on VM isolation with no intervention", () => {
      const v = evaluateAcceptance(base);
      expect(v.verdict).toBe("INDEPENDENT_PASS");
      expect(v.independent).toBe(true);
      expect(v.exit_code).toBe(0);
      expect(v.human_receipt).toBe("HARNESS_RECORDED");
    });

    // [name, patch, exact verdict, exact ordered reason codes, exit code]. A loose "UNKNOWN or FAIL" row proves nothing (P2-7).
    type Row = [string, Partial<api.AcceptanceInput>, string, string[], 0 | 1];
    const rows: Row[] = [
      ["isolation none", { isolation: "none" }, "REHEARSAL", ["ISOLATION_NONE"], 0],
      ["one intervention", { interventions: 1 }, "ASSISTED", ["INTERVENTION_RECORDED"], 1],
      ["ai_assisted operator", { operator: { kind: "ai_assisted", ref: "x", builder_ref: "y" } as never }, "ASSISTED", ["OPERATOR_NOT_HUMAN"], 1],
      ["automated operator", { operator: { kind: "automated", ref: "x", builder_ref: "y" } as never }, "REHEARSAL", ["OPERATOR_NOT_HUMAN"], 0],
      ["operator equals builder", { operator: { kind: "human", ref: "p", builder_ref: "p" } as never }, "REHEARSAL", ["OPERATOR_IS_BUILDER"], 0],
      ["operator equals builder after trim and case folding (P2-3)", { operator: { kind: "human", ref: " P ", builder_ref: "p" } as never }, "REHEARSAL", ["OPERATOR_IS_BUILDER"], 0],
      ["a human operator with no builder named (independence unproven)", { operator: { kind: "human", ref: "p" } as never }, "REHEARSAL", ["OPERATOR_INDEPENDENCE_UNPROVEN"], 0],
      ["a blank operator ref (P2-3)", { operator: { kind: "human", ref: "  ", builder_ref: "p" } as never }, "REHEARSAL", ["OPERATOR_INDEPENDENCE_UNPROVEN"], 0],
      ["an imported run (integrity is not provenance)", { imported: true }, "UNKNOWN", ["IMPORT_UNAUTHENTICATED"], 1],
      ["stored evidence that fails its hash check", { evidence_verified: false }, "UNKNOWN", ["EVIDENCE_UNVERIFIABLE"], 1],
      ["provider unavailable", { provider_blocked: true }, "BLOCKED", ["PROVIDER_UNAVAILABLE"], 1],
      ["preflight rejected", { preflight_rejected: true }, "FAIL", ["PREFLIGHT_REJECTED"], 1],
      ["stale binding", { binding_check: "MISMATCH" }, "UNKNOWN", ["STALE_BINDING"], 1],
      ["cleanup unconfirmed", { cleanup: "UNCONFIRMED" }, "FAIL", ["CLEANUP_UNCONFIRMED"], 1],
      ["cleanup missing", { cleanup: null }, "UNKNOWN", ["CLEANUP_MISSING"], 1],
      ["run not finished", { state: "RUNNING" as never, outcome: null }, "UNKNOWN", ["RUN_NOT_FINISHED"], 1],
      ["aborted", { outcome: "ABORTED" }, "FAIL", ["RUN_ABORTED"], 1],
      [
        "a mandatory step failed (the rest never ran)",
        { steps: steps((a) => (a === "install" ? { status: "FAIL" } : a === "restore" ? { status: "SKIPPED" } : { status: "SKIPPED" })) },
        "FAIL",
        ["MANDATORY_STEP_FAILED", "MANDATORY_STEP_NOT_RUN"],
        1
      ],
      [
        "a mandatory step timed out (the rest never ran)",
        { steps: steps((a) => (a === "install" ? { status: "TIMEOUT" } : { status: "SKIPPED" })) },
        "FAIL",
        ["MANDATORY_STEP_TIMEOUT", "MANDATORY_STEP_NOT_RUN"],
        1
      ],
      ["fewer recorded steps than planned (partial run, P1-1)", { planned_steps: 5 }, "UNKNOWN", ["MANDATORY_STEP_NOT_RUN"], 1],
      // P0-1: nothing required to pass can never be accepting
      ["every step optional and failing (P0-1)", { steps: steps(() => ({ mandatory: false, status: "FAIL" })) }, "UNKNOWN", ["NO_MANDATORY_STEPS", "REQUIRED_ACTION_NOT_PASSED"], 1],
      ["every step optional and passing (P0-1)", { steps: steps(() => ({ mandatory: false })) }, "UNKNOWN", ["NO_MANDATORY_STEPS", "REQUIRED_ACTION_NOT_PASSED"], 1],
      ["no steps at all (P0-1)", { steps: [], planned_steps: 0 }, "UNKNOWN", ["NO_MANDATORY_STEPS"], 1],
      ["a required action missing entirely (P0-1)", { steps: steps().filter((s) => s.action !== "rotate"), planned_steps: 3 }, "UNKNOWN", ["REQUIRED_ACTION_NOT_PASSED"], 1],
      ["a required action present only as an optional step (P0-1)", { steps: steps((a) => (a === "rotate" ? { mandatory: false } : {})) }, "UNKNOWN", ["REQUIRED_ACTION_NOT_PASSED"], 1],
      // P1-1: the run's own outcome counts even when every recorded step passed and cleanup verified
      ["outcome FAILED with every step passing (P1-1)", { outcome: "FAILED" }, "FAIL", ["HARNESS_ERROR"], 1],
      ["outcome FAILED with an explicit harness reason (P1-1)", { outcome: "FAILED", outcome_reason: "HARNESS_ERROR" }, "FAIL", ["HARNESS_ERROR"], 1],
      ["a non-OK outcome reason on an otherwise clean run (P1-1)", { outcome_reason: "PROVIDER_UNAVAILABLE" }, "FAIL", ["PROVIDER_UNAVAILABLE"], 1],
      [
        "a failed optional step on an otherwise independent run (capped, never independent)",
        { steps: [...steps(), { mandatory: false, status: "FAIL", action: "install" } as never], planned_steps: 5 },
        "REHEARSAL",
        ["OPTIONAL_STEP_FAILED"],
        0
      ]
    ];
    for (const [name, patch, verdict, codes, exit] of rows) {
      it(`negative control: ${name} is exactly ${verdict} [${codes.join(", ")}], never INDEPENDENT_PASS`, () => {
        const v = evaluateAcceptance({ ...base, ...patch });
        expect(v.independent).toBe(false);
        expect(v.verdict).toBe(verdict);
        expect(v.reasons.map((r) => r.code)).toEqual(codes);
        expect(v.exit_code).toBe(exit);
      });
    }

    it("a failed non-mandatory step never blocks acceptance by itself, but is not hidden: it is flagged and caps the verdict (P0-1 corrected rule)", () => {
      const v = evaluateAcceptance({ ...base, steps: [...steps(), { mandatory: false, status: "FAIL", action: "install" } as never], planned_steps: 5 });
      expect(v.verdict).toBe("REHEARSAL");
      expect(v.reasons.map((r) => r.code)).toEqual(["OPTIONAL_STEP_FAILED"]);
      // legacy records carry no step actions or planned count: they still evaluate (the action rule needs every step's action)
      expect(evaluateAcceptance({ ...base, steps: [{ mandatory: true, status: "PASS" }], planned_steps: 0 }).verdict).toBe("INDEPENDENT_PASS");
    });
  });
});

describe("AC-09 offline synthetic demo", () => {
  it("the synthetic demo completes without accounts, telemetry or network and is labelled isolation none", async () => {
    const ctx = makeCtx();
    const { value: result, attempts } = await withNetworkDenied(() => api.demo(ctx));
    expect(attempts).toEqual([]);
    expect(result.exit_code).toBe(0);
    expect(result.verdict.verdict).toBe("REHEARSAL");
    expect(result.provider).toBe("local-sandbox");
    expect(result.isolation).toBe("none");
    expect(allStepsPass(result)).toBe(true);
    expect(result.cleanup.status).toBe("VERIFIED");
    const report = await api.getReport(ctx, { runId: result.run_id });
    expect(report.run.labels.join(" ").toLowerCase()).toContain("isolation");
  });

  it("negative control: the outbound-denied harness actually catches an attempted connection", async () => {
    const { attempts } = await withNetworkDenied(async () => {
      await fetch("http://localhost:9/never").catch(() => undefined);
    });
    expect(attempts.length).toBe(1);
  });

  // The scan is only evidence if it can fail: BANNED is exercised against known-bad and known-good text first (P3 positive control).
  const BANNED = /from\s+["']node:(http|https|http2|net|dgram|dns|tls|dns\/promises)["']|import\s+\w+\s+from\s+["']node:(http|https|net|dgram|dns|tls)["']|require\(["'](http|https|net|dgram|dns|tls)["']\)|\bfetch\s*\(|new\s+WebSocket\b|XMLHttpRequest|\.listen\(/;

  it("positive control: the static no-network pattern matches every banned construct and none of the allowed ones", () => {
    const bad = [
      'import http from "node:http";',
      'import { connect } from "node:net";',
      'import * as dns from "node:dns/promises";',
      'import https from "node:https";',
      'const net = require("net");',
      'await fetch("http://localhost:1/x");',
      'const ws = new WebSocket("ws://localhost");',
      "new XMLHttpRequest()",
      "server.listen(8080)"
    ];
    for (const text of bad) expect(BANNED.test(text), text).toBe(true);
    const fine = ['import { createHash } from "node:crypto";', 'import { spawn } from "node:child_process";', "const prefetched = 1; // fetched later", 'import { join } from "node:path";'];
    for (const text of fine) expect(BANNED.test(text), text).toBe(false);
  });

  it("the deterministic core, including the embedded demo scenario, imports no network modules and never calls fetch (static scan of src/)", () => {
    const sources = walkFiles(join(import.meta.dirname, "..", "src")).filter((f) => f.endsWith(".ts"));
    expect(sources.length).toBeGreaterThan(10);
    expect(sources.some((f) => f.endsWith("/runner/demo.ts"))).toBe(true);
    const offenders = sources.filter((f) => BANNED.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the embedded demo scenario is socket-free: it names no URL and opens no listener, so it also runs with loopback denied", () => {
    const text = readFileSync(join(import.meta.dirname, "..", "src", "runner", "demo.ts"), "utf8");
    expect(text).not.toMatch(/https?:\/\//i);
    expect(text).not.toMatch(/\.listen\(|createServer|node:net|node:http/);
  });

  it("no telemetry: the source contains no analytics or beacon endpoints", () => {
    const sources = walkFiles(join(import.meta.dirname, "..", "src")).filter((f) => f.endsWith(".ts"));
    const offenders = sources.filter((f) => /\b(sentry|posthog|segment\.io|google-analytics|mixpanel|amplitude)\b/i.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("negative control: live connector operations fail explicitly when disconnected", () => {
    expect(() => api.requireConnector("proofgate", false)).toThrowError(api.HandoffCheckError);
    try {
      api.requireConnector("proofgate", false);
    } catch (e) {
      expect((e as api.HandoffCheckError).code).toBe("CONNECTOR_DISCONNECTED");
      expect((e as api.HandoffCheckError).status).toBe(503);
    }
    expect(() => api.requireConnector("proofgate", true)).not.toThrow();
  });

  it("negative control: the optional adapters are disabled by default and fail explicitly, with no side effects", async () => {
    const cwd = makeTmp("hc-adapter-");
    const r = await runMain(["adapter", "export-receipt", "--run", "run-1", "--out", "receipts", "--json"], { cwd });
    expect(r.code).toBe(2);
    const body = JSON.parse(r.out) as { error: { code: string; message: string; request_id: string } };
    expect(body.error.code).toBe("CONNECTOR_DISCONNECTED");
    expect(body.error.request_id).toBeTruthy();
    expect(existsSync(join(cwd, "receipts"))).toBe(false);
  });

  it("two demos with the same fixed clock and ids bind identically (deterministic core)", async () => {
    const a = await api.demo(makeCtx());
    const b = await api.demo(makeCtx());
    expect(a.binding.binding_digest).toBe(b.binding.binding_digest);
    expect(a.steps).toEqual(b.steps);
  });
});

describe("AC-10 redaction and hostile input", () => {
  const allSecrets = [PLANTED.oldToken, PLANTED.newToken, "HCFAKE_UNDECLARED_9F8E7D6C5B4A", "supersecretbearer123456"];
  const noisyInstall = sh(
    [
      '"$NODE" "$SVC" install',
      'echo "diagnostic: $(cat "$HC_RELEASE/config/service.env")"',
      'echo "credential in use: $(cat "$HC_STATE/credential.old")"',
      'echo "planted but undeclared: HCFAKE_UNDECLARED_9F8E7D6C5B4A"',
      'echo "Authorization: Bearer supersecretbearer123456"',
      'echo "to stderr: $(cat "$HC_STATE/credential.old")" >&2'
    ].join("\n")
  );

  it("planted secret tokens never appear in the store, logs, reports or an exported bundle", async () => {
    const ex = await runDrill({ scripts: { "install.sh": noisyInstall } });
    expect(ex.result.exit_code).toBe(0);
    const cwd = makeTmp("hc-out-");
    const out = join(cwd, "bundle.hcb");
    await api.exportBundle(ex.ctx, { runId: ex.result.run_id, outPath: out });
    const html = await runMain(["report", "--run", ex.result.run_id, "--output", ex.ctx.storeDir, "--format", "both", "--out", join(cwd, "reports")], { cwd });
    expect([0, 1]).toContain(html.code);
    expect(filesContaining(ex.ctx.storeDir, allSecrets)).toEqual([]);
    expect(filesContaining(cwd, allSecrets)).toEqual([]);
    expect(html.out + html.err).not.toMatch(/HCFAKE_(OLD|NEW|UNDECLARED)/);
    // non-vacuous: the redactor really ran on captured output
    const report = await api.getReport(ex.ctx, { runId: ex.result.run_id });
    const logs = report.evidence.filter((e) => e.kind === "step_log");
    expect(logs.length).toBeGreaterThan(0);
    const bodies = logs.map((e) => readFileSync(join(ex.ctx.storeDir, "objects", e.sha256.slice(0, 2), e.sha256), "utf8"));
    expect(bodies.some((b) => b.includes("[REDACTED"))).toBe(true);
    expect(logs.every((e) => e.redacted)).toBe(true);
  });

  it("negative control: the secret scan itself detects a planted secret (the check is not vacuous)", () => {
    const dir = makeTmp("hc-scan-");
    writeFileSync(join(dir, "leak.log"), `value=${PLANTED.oldToken}\n`);
    expect(filesContaining(dir, [PLANTED.oldToken])).toEqual(["leak.log"]);
  });

  it("the scenario title, script output and intervention text render as text in the static HTML report", async () => {
    const evil = '<script>window.__pwned=1</script><img src=x onerror="window.__pwned=1">';
    const ex = await runDrill({
      scripts: { "install.sh": sh(`"$NODE" "$SVC" install\necho '${evil}'`) },
      manifest: (m) => void (m.scenario.title = evil)
    });
    await api.recordIntervention(ex.ctx, { runId: ex.result.run_id, reason: `"><svg onload=alert(1)> ${evil}`, actorRef: "<b>actor</b>" });
    const cwd = makeTmp("hc-html-");
    const r = await runMain(["report", "--run", ex.result.run_id, "--output", ex.ctx.storeDir, "--format", "html", "--out", join(cwd, "r.html")], { cwd });
    expect([0, 1]).toContain(r.code);
    const html = readFileSync(join(cwd, "r.html"), "utf8");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<svg onload");
    expect(html).not.toContain("<b>actor</b>");
    expect(html).toContain("&lt;");
    expect(html).not.toMatch(/\bonerror\s*=\s*"?window/); // would only occur if the raw tag survived
  });

  const oversizeManifest = (bytes: number) => `# padding\n${"#".repeat(120)}\n`.repeat(Math.ceil(bytes / 123));

  async function expectRejectedBeforeExecution(opts: PrepareOptions, ctxOver: Partial<api.ApiContext> = {}): Promise<void> {
    const inputs = prepareDrill(opts);
    const ctx = makeCtx(ctxOver);
    let result: api.RunResult | undefined;
    try {
      result = await api.run(ctx, inputs.paths);
    } catch (err) {
      expect(err).toBeInstanceOf(api.HandoffCheckError);
      expect(["SCHEMA_INVALID", "POLICY_REJECTED", "PAYLOAD_TOO_LARGE", "BAD_REQUEST"]).toContain((err as api.HandoffCheckError).code);
      return;
    }
    expectRed(result);
    expect(result.preflight?.status).toBe("REJECTED");
    expect(result.steps.every((s) => s.status === "SKIPPED")).toBe(true);
    expect(result.cleanup.resources).toBe(0);
  }

  it("negative control: an oversized manifest (over 25 MiB) is rejected before processing and no run is recorded", async () => {
    const inputs = prepareDrill();
    writeFileSync(inputs.manifestPath, oversizeManifest(26 * 1024 * 1024));
    const ctx = makeCtx();
    await expect(api.run(ctx, inputs.paths)).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE", status: 413 });
    if (existsSync(ctx.storeDir)) expect((await api.listRuns(ctx)).runs).toEqual([]);
  });

  it("negative control: an explicit lower metadata limit rejects an otherwise valid manifest", async () => {
    await expectRejectedBeforeExecution({}, { limits: { max_metadata_bytes: 200 } });
  });

  const invalidManifests: [string, (m: Record<string, any>) => void][] = [ // eslint-disable-line @typescript-eslint/no-explicit-any
    ["an unknown top-level field", (m) => void (m.surprise = true)],
    ["an unsupported schema_version", (m) => void (m.schema_version = 2)],
    ["an unknown runner provider", (m) => void (m.runner.provider = "docker")],
    ["an unknown step action", (m) => void (m.steps[0].action = "deploy")],
    ["no steps", (m) => void (m.steps = [])],
    ["a zero deadline", (m) => void (m.steps[0].deadline_seconds = 0)],
    ["duplicate step ids", (m) => void (m.steps[1].id = m.steps[0].id)],
    ["a script path that escapes the manifest directory", (m) => void (m.steps[0].script.path = "../../etc/passwd")],
    ["an absolute script path", (m) => void (m.steps[0].script.path = "/bin/sh")],
    ["a missing script file", (m) => void (m.steps[0].script.path = "scripts/does-not-exist.sh")],
    ["a pinned script hash that does not match", (m) => void (m.steps[0].script.sha256 = "0".repeat(64))],
    ["recovery longer than the step deadline", (m) => void (m.steps[3].max_recovery_seconds = 600)]
  ];
  for (const [name, mutate] of invalidManifests) {
    it(`negative control: ${name} is rejected before any step executes`, async () => {
      await expectRejectedBeforeExecution({ manifest: mutate });
    });
  }

  it("negative control: a YAML alias bomb is rejected quickly", async () => {
    const inputs = prepareDrill();
    const levels = ["a: &a0 [lol, lol, lol, lol, lol, lol, lol, lol, lol]"];
    for (let i = 1; i < 9; i++) levels.push(`b${i}: &a${i} [${Array(9).fill(`*a${i - 1}`).join(", ")}]`);
    writeFileSync(inputs.manifestPath, `${levels.join("\n")}\n`);
    const started = Date.now();
    await expect(api.run(makeCtx(), inputs.paths)).rejects.toBeInstanceOf(api.HandoffCheckError);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  const hostileEntries: [string, PrepareOptions][] = [
    ["a path-traversal entry", { extra: [{ path: "../evil.txt", data: "x" }] }],
    ["a nested traversal entry", { extra: [{ path: "bin/../../evil.txt", data: "x" }] }],
    ["an absolute-path entry", { extra: [{ path: "/tmp/hc-evil.txt", data: "x" }] }],
    ["a symlink pointing at an absolute target", { extra: [{ path: "link", type: "2", linkname: "/etc/passwd" }] }],
    ["a symlink escaping the extraction root", { extra: [{ path: "link", type: "2", linkname: "../../outside" }] }],
    ["a hard link", { extra: [{ path: "hard", type: "1", linkname: "bin/notes.mjs" }] }],
    ["a device node", { extra: [{ path: "dev", type: "3" }] }],
    ["a duplicate entry name", { extra: [{ path: "bin/notes.mjs", data: "dup" }] }]
  ];
  for (const [name, opts] of hostileEntries) {
    it(`negative control: an artifact with ${name} is rejected before extraction`, async () => {
      await expectRejectedBeforeExecution(opts);
    });
  }

  it("negative control: an artifact over the 1,000-file cap is rejected before extraction", async () => {
    const files = Array.from({ length: 1001 }, (_, i) => ({ path: `many/f${i}.txt`, data: "x" }));
    await expectRejectedBeforeExecution({ extra: files });
  });

  it("negative control: a truncated artifact is rejected, not partially extracted", async () => {
    const full = buildTar([{ path: "bin/notes.mjs", data: "x".repeat(5000) }]);
    await expectRejectedBeforeExecution({ artifact: full.subarray(0, 1500) });
  });

  it("negative control: an archive that declares more bytes than the blob cap is rejected before reading content", async () => {
    const bomb = buildTar([{ path: "big.bin", data: "x", declaredSize: 300 * 1024 * 1024 }]);
    await expectRejectedBeforeExecution({ artifact: bomb });
  });

  it("negative control: a gzip bomb is stopped at the inflation cap", async () => {
    const inner = buildTar([{ path: "zeros.bin", data: Buffer.alloc(6 * 1024 * 1024) }]);
    await expectRejectedBeforeExecution({ artifact: gzipSync(inner) }, { limits: { max_blob_bytes: 1024 * 1024 } });
  });

  it("negative control: a missing input file is a harness error with the documented error body shape", async () => {
    const inputs = prepareDrill();
    const cwd = makeTmp("hc-err-");
    const r = await runMain(["run", "--manifest", join(cwd, "nope.yaml"), "--artifact", inputs.artifactPath, "--runbook", inputs.runbookPath, "--output", join(cwd, "ev"), "--json"], { cwd });
    expect(r.code).toBe(2);
    const body = JSON.parse(r.out) as { error: { code: string; message: string; request_id: string } };
    expect(Object.keys(body)).toEqual(["error"]);
    expect(Object.keys(body.error).sort()).toEqual(["code", "message", "request_id"]);
    expect(["NOT_FOUND", "BAD_REQUEST"]).toContain(body.error.code);
  });
});

describe("AC-11 portability and corruption", () => {
  let source: Executed;
  let bundlePath: string;
  let bundle: Buffer;
  let info: api.BundleInfo;

  const snapshot = async (ctx: api.ApiContext) => ({
    runs: existsSync(ctx.storeDir) ? (await api.listRuns(ctx)).runs.map((r) => r.id).sort() : [],
    objects: existsSync(join(ctx.storeDir, "objects")) ? walkFiles(join(ctx.storeDir, "objects")).map((f) => f.slice(ctx.storeDir.length)) : []
  });

  beforeAll(async () => {
    source = await runDrill();
    await api.recordIntervention(source.ctx, { runId: source.result.run_id, reason: "builder nudged the restore step", actorRef: "builder-b" });
    bundlePath = join(makeTmp("hc-bundle-"), "evidence.hcb");
    info = await api.exportBundle(source.ctx, { runId: source.result.run_id, outPath: bundlePath });
    bundle = readFileSync(bundlePath);
  }, 120_000);

  /** Rebuild a tampered copy of the bundle from its entries. */
  function rewrite(mutate: (entries: ReturnType<typeof readTarEntries>) => ReturnType<typeof readTarEntries>): string {
    const entries = mutate(readTarEntries(bundle));
    const path = join(makeTmp("hc-tamper-"), "tampered.hcb");
    writeFileSync(path, buildTar(entries.map((e) => ({ path: e.name, data: e.data, type: e.type, linkname: e.linkname }))));
    return path;
  }

  async function expectNoPartialState(bad: string, expectedCode: string, verifyCode: string | string[]): Promise<void> {
    const target = makeCtx();
    const other = await runDrill();
    const ctx = makeCtx({ storeDir: other.ctx.storeDir });
    const before = await snapshot(ctx);
    const v = await api.verifyBundle({}, { bundlePath: bad });
    expect(v.ok).toBe(false);
    expect(v.errors.map((e) => e.code).some((c) => [verifyCode].flat().includes(c)), JSON.stringify(v.errors)).toBe(true);
    await expect(api.importBundle(ctx, { bundlePath: bad })).rejects.toMatchObject({ code: expectedCode });
    expect(await snapshot(ctx)).toEqual(before);
    await expect(api.importBundle(target, { bundlePath: bad })).rejects.toBeInstanceOf(api.HandoffCheckError);
    expect((await snapshot(target)).runs).toEqual([]);
    expect((await snapshot(target)).objects).toEqual([]);
  }

  it("exports a versioned bundle with a root hash over the sorted file list", () => {
    expect(info.header.format).toBe("handoffcheck-evidence-bundle");
    expect(info.header.format_version).toBe(1);
    expect(info.header.run_id).toBe(source.result.run_id);
    expect(info.header.binding_digest).toBe(source.result.binding.binding_digest);
    expect(info.bundle_sha256).toBe(sha256Hex(bundle));
    const sorted = [...info.header.files].sort((a, b) => (a.path < b.path ? -1 : 1));
    expect(info.header.root_hash).toBe(sha256Hex(sorted.map((f) => `${f.path}:${f.sha256}`).join("\n")));
  });

  it("restores and reads the bundle in a clean installation with matching hashes", async () => {
    const clean2 = makeCtx();
    const v = await api.verifyBundle({}, { bundlePath });
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
    const imported = await api.importBundle(clean2, { bundlePath });
    expect(imported.run_id).toBe(source.result.run_id);
    expect(imported.binding_digest).toBe(source.result.binding.binding_digest);
    expect(imported.bundle_sha256).toBe(info.bundle_sha256);
    const a = await api.getReport(source.ctx, { runId: source.result.run_id });
    const b = await api.getReport(clean2, { runId: source.result.run_id });
    expect(b.run.imported).toBe(true);
    expect(b.binding).toEqual(a.binding);
    expect(b.steps.map((s) => [s.step_key, s.status, s.evidence_hash])).toEqual(a.steps.map((s) => [s.step_key, s.status, s.evidence_hash]));
    expect(b.evidence.map((e) => e.sha256).sort()).toEqual(a.evidence.map((e) => e.sha256).sort());
    // integrity round-trips; provenance does not: the imported run's own verdict is UNKNOWN, the bundle's claim is display-only
    expect(b.verdict.verdict).toBe("UNKNOWN");
    expect(b.verdict.exit_code).toBe(1);
    expect(b.verdict.reasons.map((r) => r.code)).toContain("IMPORT_UNAUTHENTICATED");
    expect(b.claimed_verdict?.verdict).toBe(a.verdict.verdict);
    expect(b.interventions.map((i) => i.reason)).toEqual(a.interventions.map((i) => i.reason));
    for (const e of b.evidence) {
      const blob = readFileSync(join(clean2.storeDir, "objects", e.sha256.slice(0, 2), e.sha256));
      expect(sha256Hex(blob)).toBe(e.sha256);
    }
  });

  it("an intervention survives the round trip, and the imported run is never an accepting verdict", async () => {
    const c = makeCtx();
    await api.importBundle(c, { bundlePath });
    const report = await api.getReport(c, { runId: source.result.run_id });
    expect(report.interventions).toHaveLength(1);
    expect(report.verdict.verdict).toBe("UNKNOWN");
    expect(report.verdict.exit_code).toBe(1);
    expect(report.claimed_verdict?.verdict).toBe("ASSISTED");
  });

  it("negative control: a hand-forged, self-consistent bundle never imports as INDEPENDENT_PASS", async () => {
    const forged = forgeBundle(bundle, {
      run: (r) => {
        r.drill.operator_kind = "human";
        r.drill.operator_ref = "forger";
        r.drill.builder_ref = "someone-else";
        r.drill.isolation = "vm";
        r.drill.provider = "lima";
        for (const c of r.cleanup_receipts) c.isolation = "vm";
        r.interventions = [];
      }
    });
    const path = join(makeTmp("hc-forge-"), "forged.hcb");
    writeFileSync(path, forged);
    expect((await api.verifyBundle({}, { bundlePath: path })).ok).toBe(true); // hashes are consistent: integrity alone proves nothing
    const c = makeCtx();
    await api.importBundle(c, { bundlePath: path });
    const report = await api.getReport(c, { runId: source.result.run_id });
    expect(report.verdict.verdict).not.toBe("INDEPENDENT_PASS");
    expect(report.verdict.independent).toBe(false);
    expect(report.verdict.exit_code).toBe(1);
    expect(report.verdict.human_receipt).toBe("PENDING_HUMAN_RECEIPT");
  });

  it("negative control: importing the same run twice is a CONFLICT and changes nothing", async () => {
    const c = makeCtx();
    await api.importBundle(c, { bundlePath });
    const before = await snapshot(c);
    await expect(api.importBundle(c, { bundlePath })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await snapshot(c)).toEqual(before);
  });

  it("negative control: exporting over an existing path is a CONFLICT and does not overwrite", async () => {
    await expect(api.exportBundle(source.ctx, { runId: source.result.run_id, outPath: bundlePath })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(readFileSync(bundlePath).equals(bundle)).toBe(true);
  });

  for (const [label, cut] of [
    ["empty file", () => 0],
    ["inside the first header", () => 100],
    ["after the first header", () => 512],
    ["halfway", () => Math.floor(bundle.length / 2)],
    ["end-of-archive marker missing", () => bundle.length - 1024],
    ["one byte short", () => bundle.length - 1]
  ] as [string, () => number][]) {
    it(`negative control: a bundle truncated (${label}) fails verification and import leaves no partial state`, async () => {
      const path = join(makeTmp("hc-trunc-"), "trunc.hcb");
      writeFileSync(path, bundle.subarray(0, cut()));
      await expectNoPartialState(path, "BUNDLE_CORRUPT", cut() === 0 ? ["TRUNCATED", "BAD_FORMAT"] : "TRUNCATED");
    });
  }

  it("negative control: trailing garbage after the archive is not accepted", async () => {
    const path = join(makeTmp("hc-trail-"), "trail.hcb");
    writeFileSync(path, Buffer.concat([bundle, Buffer.from("trailing-bytes")]));
    const v = await api.verifyBundle({}, { bundlePath: path });
    expect(v.ok).toBe(false);
    await expect(api.importBundle(makeCtx(), { bundlePath: path })).rejects.toMatchObject({ code: "BUNDLE_CORRUPT" });
  });

  it("negative control: an unsupported format_version fails without partial accepted state", async () => {
    const path = rewrite((entries) =>
      entries.map((e) => (e.name === "bundle.json" ? { ...e, data: Buffer.from(JSON.stringify({ ...JSON.parse(e.data.toString("utf8")), format_version: 2 })) } : e))
    );
    await expectNoPartialState(path, "UNSUPPORTED_VERSION", "UNSUPPORTED_VERSION");
  });

  it("negative control: a tampered blob fails hash verification without partial accepted state", async () => {
    const path = rewrite((entries) => {
      const i = entries.findIndex((e) => e.name.startsWith("objects/"));
      const copy = entries.map((e) => ({ ...e }));
      const target = copy[i]!;
      const flipped = Buffer.from(target.data);
      flipped[0] = (flipped[0] ?? 0) ^ 0xff;
      target.data = flipped;
      return copy;
    });
    await expectNoPartialState(path, "BUNDLE_CORRUPT", "HASH_MISMATCH");
  });

  it("negative control: a tampered LAST blob leaves none of the earlier blobs installed (atomic import)", async () => {
    const path = rewrite((entries) => {
      const copy = entries.map((e) => ({ ...e }));
      const lastObject = [...copy].reverse().find((e) => e.name.startsWith("objects/"))!;
      const flipped = Buffer.from(lastObject.data);
      flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 0xff;
      lastObject.data = flipped;
      return copy;
    });
    const c = makeCtx();
    await expect(api.importBundle(c, { bundlePath: path })).rejects.toMatchObject({ code: "BUNDLE_CORRUPT" });
    expect((await snapshot(c)).objects).toEqual([]);
    expect((await snapshot(c)).runs).toEqual([]);
  });

  it("negative control: a missing file in the bundle fails without partial accepted state", async () => {
    const path = rewrite((entries) => {
      const i = entries.findIndex((e) => e.name.startsWith("objects/"));
      return entries.filter((_, idx) => idx !== i);
    });
    await expectNoPartialState(path, "BUNDLE_CORRUPT", "MISSING_FILE");
  });

  it("negative control: an unlisted extra file in the bundle fails without partial accepted state", async () => {
    const path = rewrite((entries) => [...entries, { name: "objects/extra.sh", type: "0", data: Buffer.from("echo pwned"), linkname: "" }]);
    await expectNoPartialState(path, "BUNDLE_CORRUPT", "EXTRA_FILE");
  });

  it("negative control: unsafe entries (traversal, symlink) in a bundle are rejected", async () => {
    const traversal = rewrite((entries) => [...entries, { name: "../escape", type: "0", data: Buffer.from("x"), linkname: "" }]);
    await expectNoPartialState(traversal, "BUNDLE_CORRUPT", "UNSAFE_ENTRY");
    const symlink = rewrite((entries) => [...entries, { name: "objects/link", type: "2", data: Buffer.alloc(0), linkname: "/etc/passwd" }]);
    await expectNoPartialState(symlink, "BUNDLE_CORRUPT", "UNSAFE_ENTRY");
  });

  it("negative control: a bundle over an explicit file-count limit fails with LIMIT_EXCEEDED", async () => {
    const v = await api.verifyBundle({ limits: { max_files: 2 } }, { bundlePath });
    expect(v.ok).toBe(false);
    expect(v.errors.map((e) => e.code)).toContain("LIMIT_EXCEEDED");
    await expect(api.importBundle(makeCtx({ limits: { max_files: 2 } }), { bundlePath })).rejects.toBeInstanceOf(api.HandoffCheckError);
  });

  it("negative control: a tampered run document fails the schema/root hash check", async () => {
    const path = rewrite((entries) => entries.map((e) => (e.name === "run.json" ? { ...e, data: Buffer.from(e.data.toString("utf8").replace(/"scenario_id":"[^"]*"/, '"scenario_id":"tampered"')) } : e)));
    const v = await api.verifyBundle({}, { bundlePath: path });
    expect(v.ok).toBe(false);
    await expect(api.importBundle(makeCtx(), { bundlePath: path })).rejects.toBeInstanceOf(api.HandoffCheckError);
  });
});

describe("AC-12 release documentation (automated checks; the fresh-operator receipt stays PENDING_HUMAN_RECEIPT)", () => {
  const root = join(import.meta.dirname, "..");
  const read = (rel: string) => readFileSync(join(root, rel), "utf8");
  const section = (md: string, heading: string): string => {
    const start = md.search(new RegExp(`^## ${heading}\\b`, "m"));
    if (start < 0) return "";
    const rest = md.slice(start + 3);
    const next = rest.search(/^## /m);
    return next < 0 ? rest : rest.slice(0, next);
  };
  const readme = read("README.md");
  const docs = ["README.md", "docs/RUNBOOK.md", "docs/OPERATIONS.md", "docs/HUMAN-DRILL.md", "docs/qa/receipts/TEMPLATE.md", "fixtures/drill/RUNBOOK.md"];

  for (const heading of ["Install", "Upgrade", "Backup", "Restore", "Failure diagnosis", "Synthetic smoke procedure", "Honest limits"]) {
    it(`README documents "${heading}" with substantive content`, () => {
      const body = section(readme, heading);
      expect(body.length).toBeGreaterThan(300);
      if (["Install", "Upgrade", "Backup", "Restore", "Synthetic smoke procedure"].includes(heading)) expect(body).toMatch(/```|`[a-z]/);
    });
  }

  it("states the unknown, partial and blocked states and the human-receipt rule", () => {
    for (const phrase of ["UNKNOWN", "BLOCKED", "PENDING_HUMAN_RECEIPT", "REHEARSAL", "ASSISTED", "CLEANUP_UNCONFIRMED", "IMPORT_UNAUTHENTICATED", "not an isolation boundary", "localhost"]) {
      expect(readme, phrase).toContain(phrase);
    }
  });

  it("negative control: the documentation never presents a container as the isolation boundary", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toMatch(/NOT the isolation boundary/i);
    for (const rel of docs) expect(read(rel)).not.toMatch(/container (is|provides) (an? )?(adequate )?isolation/i);
  });

  it("negative control: no personal paths, emails, private hosts or non-loopback addresses in release docs", () => {
    for (const rel of [...docs, "Dockerfile"]) {
      const text = read(rel);
      expect(text, rel).not.toMatch(/\/Users\/[a-z]|\/home\/[a-z]|[A-Za-z]:\\Users\\/);
      expect(text, rel).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/);
      const ips = [...text.matchAll(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g)].map((m) => m[0]);
      for (const ip of ips) expect(["127.0.0.1", "203.0.113.9"], `${rel}: ${ip}`).toContain(ip);
    }
  });

  it("every documented command and flag exists in the CLI", async () => {
    const mdFiles = ["README.md", "docs/RUNBOOK.md", "docs/HUMAN-DRILL.md"].map(read).join("\n");
    const invocations = [...mdFiles.matchAll(/(?:node dist\/src\/cli\.js|(?:^|[\s`(])hc)\s+([a-z-]+)((?:\s+[^\n`|]*)?)/g)];
    expect(invocations.length).toBeGreaterThan(15);
    for (const [, command, rest] of invocations) {
      if (command === "--version" || command === "--help") continue;
      const spec = COMMANDS[command as string];
      expect(spec, `unknown command in docs: ${command}`).toBeDefined();
      let options = spec!.options;
      let tail = rest ?? "";
      if (spec!.subcommands) {
        const sub = tail.trim().split(/\s+/)[0] ?? "";
        const subSpec = spec!.subcommands[sub];
        expect(subSpec, `unknown sub-command in docs: ${command} ${sub}`).toBeDefined();
        options = subSpec!.options;
        tail = tail.trim().slice(sub.length);
      }
      for (const flag of tail.matchAll(/--([a-z-]+)/g)) {
        const name = flag[1] as string;
        const known = Object.entries(options).some(([n, o]) => n === name || o.alias === name);
        expect(known, `docs use --${name} which \`${command}\` does not accept`).toBe(true);
      }
    }
  });

  it("the human drill procedure names identity, timing, help received, step outcomes, cleanup receipt and how to file", () => {
    const hd = read("docs/HUMAN-DRILL.md");
    for (const phrase of ["Identity", "Timing", "Help received", "Step outcomes", "Cleanup receipt", "How to file", "record-intervention", "limactl list", "docs/qa/receipts/TEMPLATE.md"]) {
      expect(hd, phrase).toContain(phrase);
    }
    const template = read("docs/qa/receipts/TEMPLATE.md");
    for (const field of ["Operator handle", "Builder handle", "Repository revision", "Help received", "Cleanup receipt", "Attestation", "Reviewer"]) {
      expect(template, field).toContain(field);
    }
  });

  it("negative control: the AC matrix never records an agent PASS for the human-receipt criteria", () => {
    const matrix = read("docs/qa/AC-MATRIX.md");
    for (const ac of ["AC-08", "AC-12"]) {
      const row = matrix.split("\n").find((l) => l.startsWith(`| ${ac} `)) ?? "";
      expect(row, ac).toContain("PENDING_HUMAN_RECEIPT");
      expect(row, ac).not.toMatch(/\|\s*PASS\s*\|/);
    }
  });
});
