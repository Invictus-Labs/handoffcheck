// CLI-level regression tests for the review fixes: the host-sandbox opt-in and its warning (P1-6), acceptance import
// that follows the run's own verdict (P1-5), identity normalisation (P2-3), purge (P2-4), check-reuse (AC-01 / P2-2)
// and recovery of a run whose harness was killed. In-process through the same `main` the packaged binary calls.
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as api from "../../src/api.js";
import { CLI_PATH, cleanEnv, ensureBuilt, runCli, runMain } from "../helpers/cli.js";
import { makeCtx, prepareDrill, sh, type DrillInputs } from "../helpers/drill.js";
import { makeFakeLima } from "../helpers/lima.js";
import { makeTmp, registerTmpCleanup } from "../helpers/tmp.js";

registerTmpCleanup();

const j = <T = Record<string, any>>(text: string): T => JSON.parse(text) as T; // eslint-disable-line @typescript-eslint/no-explicit-any

const inputArgs = (i: DrillInputs): string[] => ["--manifest", i.manifestPath, "--artifact", i.artifactPath, "--runbook", i.runbookPath];
// a well-formed run id that no store holds, assembled so no raw UUID literal sits in the source
const OTHER_RUN = ["00000000", "0000", "4000", "8000", "000000000999"].join("-");
const HUMAN = ["--operator-kind", "human", "--operator-ref", "operator-a", "--builder-ref", "builder-b"];

/** A completed VM-provider run through the fake limactl, as a human who is not the builder: INDEPENDENT_PASS plumbing. */
async function vmRun(store: string, cwd: string) {
  const lima = makeFakeLima();
  const inputs = prepareDrill({ manifest: (m) => void (m.runner.provider = "lima") });
  const r = await runMain(["run", ...inputArgs(inputs), "--output", store, "--json", ...HUMAN], { cwd, env: lima.env });
  const body = j<{ run_id: string; verdict: { verdict: string } }>(r.out);
  return { lima, inputs, r, body };
}

describe("P1-6 through the CLI: --allow-host-sandbox", () => {
  it("negative control: `run` without the flag exits 1, reports HOST_SANDBOX_NOT_ALLOWED, runs nothing and prints no host-execution warning", async () => {
    const inputs = prepareDrill();
    const cwd = makeTmp("hc-fix1-cli-");
    const r = await runMain(["run", ...inputArgs(inputs), "--output", join(cwd, "ev"), "--json"], { cwd });
    expect(r.code).toBe(1);
    const body = j<{ verdict: { verdict: string }; preflight: { status: string; findings: { code: string }[] }; steps: { status: string }[] }>(r.out);
    expect(body.verdict.verdict).toBe("FAIL");
    expect(body.preflight.status).toBe("REJECTED");
    expect(body.preflight.findings.map((f) => f.code)).toEqual(["HOST_SANDBOX_NOT_ALLOWED"]);
    expect(body.steps.every((s) => s.status === "SKIPPED")).toBe(true);
    expect(r.err).not.toMatch(/directly on this host/);
  });

  it("with the flag the run executes (exit 0, REHEARSAL) and stderr carries the warning in both text and JSON modes", async () => {
    const inputs = prepareDrill();
    const cwd = makeTmp("hc-fix1-cli-");
    const json = await runMain(["run", ...inputArgs(inputs), "--output", join(cwd, "ev1"), "--json", "--allow-host-sandbox"], { cwd });
    expect(json.code).toBe(0);
    expect(j<{ verdict: { verdict: string } }>(json.out).verdict.verdict).toBe("REHEARSAL");
    expect(json.err).toMatch(/warning: .*directly on this host/);
    const text = await runMain(["run", ...inputArgs(inputs), "--output", join(cwd, "ev2"), "--allow-host-sandbox"], { cwd });
    expect(text.code).toBe(0);
    expect(text.err).toMatch(/warning: .*directly on this host/);
  });

  it("the offline demo needs no flag and prints no host-execution warning", async () => {
    const cwd = makeTmp("hc-fix1-cli-");
    const r = await runMain(["demo", "--output", join(cwd, "demo")], { cwd });
    expect(r.code).toBe(0);
    expect(r.err).not.toMatch(/directly on this host/);
  });

  it("the VM provider needs no flag", async () => {
    const cwd = makeTmp("hc-fix1-cli-");
    const { r, body } = await vmRun(join(cwd, "ev"), cwd);
    expect(r.code).toBe(0);
    expect(body.verdict.verdict).toBe("INDEPENDENT_PASS");
    expect(r.err).not.toMatch(/directly on this host/);
  });
});

describe("P2-3 through the CLI: operator and builder identity", () => {
  it("negative control: a human operator who is the builder (case, spacing or compatibility form) is refused up front with exit 2 and runs nothing", async () => {
    const inputs = prepareDrill();
    for (const [ref, builder] of [["Alice", "alice"], [" alice ", "alice"], ["ａlice", "alice"]] as const) {
      const cwd = makeTmp("hc-fix1-cli-");
      const r = await runMain(["run", ...inputArgs(inputs), "--output", join(cwd, "ev"), "--json", "--allow-host-sandbox", "--operator-kind", "human", "--operator-ref", ref, "--builder-ref", builder], { cwd });
      expect(r.code, JSON.stringify(ref)).toBe(2);
      expect(j<{ error: { code: string; message: string } }>(r.out).error).toMatchObject({ code: "BAD_REQUEST" });
      expect(j<{ error: { message: string } }>(r.out).error.message).toMatch(/same identity/);
      expect(existsSync(join(cwd, "ev", "handoffcheck.sqlite"))).toBe(false);
    }
  });

  it("negative control: a blank operator or builder ref is a usage error (exit 2), not a silent REHEARSAL", async () => {
    const inputs = prepareDrill();
    for (const flagName of ["--operator-ref", "--builder-ref"]) {
      const cwd = makeTmp("hc-fix1-cli-");
      const args = ["run", ...inputArgs(inputs), "--output", join(cwd, "ev"), "--json", "--allow-host-sandbox", "--operator-kind", "human", "--operator-ref", "operator-a", "--builder-ref", "builder-b"];
      args[args.indexOf(flagName) + 1] = "   ";
      const r = await runMain(args, { cwd });
      expect(r.code, flagName).toBe(2);
      expect(j<{ error: { message: string } }>(r.out).error.message).toMatch(/must not be blank/);
    }
  });

  it("positive control: two different people on the VM provider are independent (fake limactl plumbing)", async () => {
    const cwd = makeTmp("hc-fix1-cli-");
    const { body } = await vmRun(join(cwd, "ev"), cwd);
    expect(body.verdict.verdict).toBe("INDEPENDENT_PASS");
  });
});

describe("P2-4 through the CLI: purge", () => {
  async function storeWithRun() {
    const inputs = prepareDrill();
    const cwd = makeTmp("hc-fix1-cli-");
    const store = join(cwd, "ev");
    const run = await runMain(["run", ...inputArgs(inputs), "--output", store, "--json", "--allow-host-sandbox"], { cwd });
    return { cwd, store, runId: j<{ run_id: string }>(run.out).run_id };
  }

  it("--dry-run lists the run and deletes nothing; --older-than-days 0 then removes it; a second purge is empty", async () => {
    const { cwd, store, runId } = await storeWithRun();
    const dry = await runMain(["purge", "--older-than-days", "0", "--dry-run", "--output", store, "--json"], { cwd });
    expect(dry.code).toBe(0);
    expect(j(dry.out)).toEqual({ purged: [runId], dry_run: true });
    const text = await runMain(["purge", "--older-than-days", "0", "--dry-run", "--output", store], { cwd });
    expect(text.out).toMatch(/would purge 1 run\(s\)/);
    expect(text.out).toContain("nothing was deleted");
    expect((await runMain(["report", "--run", runId, "--output", store, "--json"], { cwd })).code).toBe(0); // dry run deleted nothing
    const real = await runMain(["purge", "--older-than-days", "0", "--output", store, "--json"], { cwd });
    expect(real.code).toBe(0);
    expect(j(real.out)).toEqual({ purged: [runId], dry_run: false });
    const gone = await runMain(["report", "--run", runId, "--output", store, "--json"], { cwd });
    expect(gone.code).toBe(2);
    expect(j<{ error: { code: string } }>(gone.out).error.code).toBe("NOT_FOUND");
    expect(j((await runMain(["purge", "--output", store, "--json"], { cwd })).out)).toEqual({ purged: [], dry_run: false });
  });

  it("without options only expired runs go (a fresh run is kept), and a bad age is a usage error that deletes nothing", async () => {
    const { cwd, store, runId } = await storeWithRun();
    expect(j((await runMain(["purge", "--output", store, "--json"], { cwd })).out)).toEqual({ purged: [], dry_run: false });
    for (const bad of ["-1", "1.5", "abc"]) {
      const r = await runMain(["purge", "--older-than-days", bad, "--output", store, "--json"], { cwd });
      expect(r.code, bad).toBe(2);
      expect(j<{ error: { code: string } }>(r.out).error.code).toBe("BAD_REQUEST");
    }
    expect((await runMain(["report", "--run", runId, "--output", store, "--json"], { cwd })).code).toBe(0);
  });
});

describe("AC-01 / P2-2 through the CLI: check-reuse", () => {
  it("negative control: an empty store, a REHEARSAL, and changed inputs are never reusable (exit 1) and say why", async () => {
    const inputs = prepareDrill();
    const cwd = makeTmp("hc-fix1-cli-");
    const store = join(cwd, "ev");
    const empty = await runMain(["check-reuse", ...inputArgs(inputs), "--output", store, "--json"], { cwd });
    expect(empty.code).toBe(2); // no store yet: a usage/harness error, never an accepting answer
    expect(j<{ error: { code: string } }>(empty.out).error.code).toMatch(/NOT_FOUND|BAD_REQUEST/);
    const run = j<{ run_id: string }>((await runMain(["run", ...inputArgs(inputs), "--output", store, "--json", "--allow-host-sandbox"], { cwd })).out);
    const rehearsal = await runMain(["check-reuse", ...inputArgs(inputs), "--output", store, "--json"], { cwd });
    expect(rehearsal.code).toBe(1);
    expect(j(rehearsal.out)).toMatchObject({ reusable: false, reason: "PRIOR_NOT_ACCEPTED", verdict: "REHEARSAL", run_id: run.run_id });
    const changed = prepareDrill({ runbook: "# a different runbook\n" });
    const stale = await runMain(["check-reuse", ...inputArgs(changed), "--output", store, "--json"], { cwd });
    expect(stale.code).toBe(1);
    expect(j(stale.out)).toMatchObject({ reusable: false, reason: "BINDING_CHANGED", invalidated_run_ids: [run.run_id] });
  });

  it("an INDEPENDENT_PASS (fake limactl plumbing) is reusable for identical inputs (exit 0); naming a different run, or changing the runbook, is not", async () => {
    const cwd = makeTmp("hc-fix1-cli-");
    const store = join(cwd, "ev");
    const { inputs, body } = await vmRun(store, cwd);
    const ok = await runMain(["check-reuse", ...inputArgs(inputs), "--output", store, "--json"], { cwd });
    expect(ok.code).toBe(0);
    expect(j(ok.out)).toMatchObject({ reusable: true, reason: "REUSABLE", run_id: body.run_id, verdict: "INDEPENDENT_PASS" });
    const text = await runMain(["check-reuse", ...inputArgs(inputs), "--output", store], { cwd });
    expect(text.out).toMatch(/reuse:\s+REUSABLE/);
    const named = await runMain(["check-reuse", ...inputArgs(inputs), "--run", OTHER_RUN, "--output", store, "--json"], { cwd });
    expect(named.code).toBe(1);
    expect(j(named.out)).toMatchObject({ reusable: false, requested_run_id: OTHER_RUN });
    expect(j<{ note: string }>(named.out).note).toContain(`not ${OTHER_RUN}`);
    const sameName = await runMain(["check-reuse", ...inputArgs(inputs), "--run", body.run_id, "--output", store, "--json"], { cwd });
    expect(sameName.code).toBe(0);
  });
});

describe("P1-5 through the CLI: an accepted claim is honoured only when the run's own verdict accepts", () => {
  const ENABLE = ["--enable-adapters"];

  async function receiptFor(store: string, cwd: string, runId: string, env: Record<string, string> = {}) {
    const r = await runMain(["adapter", "export-receipt", "--run", runId, "--out", join(cwd, "receipts"), "--output", store, "--json", ...ENABLE], { cwd, env });
    expect(r.code, r.out + r.err).toBe(0);
    return j<{ envelope: { event_id: string; evidence_ref: string; revision: number } }>(r.out).envelope;
  }
  function claim(cwd: string, runId: string, receipt: { event_id: string; evidence_ref: string }, over: Record<string, unknown> = {}) {
    const file = join(cwd, `acceptance-${Math.random().toString(16).slice(2)}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        schema_version: 1,
        event_id: `evt-${Math.random().toString(16).slice(2, 10)}`,
        source: "proofgate",
        resource_id: runId,
        event_type: "acceptance.accepted",
        occurred_at: "2026-01-01T00:00:00Z",
        revision: 1,
        evidence_ref: receipt.evidence_ref,
        correlation_id: receipt.event_id,
        ...over
      })
    );
    return file;
  }
  const importClaim = (store: string, cwd: string, file: string, env: Record<string, string> = {}) =>
    runMain(["adapter", "import-acceptance", "--file", file, "--output", store, "--json", ...ENABLE], { cwd, env });

  it("negative control: a perfectly formed accepted claim for a REHEARSAL run is downgraded to unknown, and says the run's own verdict is not accepting", async () => {
    const cwd = makeTmp("hc-fix1-cli-");
    const store = join(cwd, "ev");
    const run = j<{ run_id: string }>((await runMain(["run", ...inputArgs(prepareDrill()), "--output", store, "--json", "--allow-host-sandbox"], { cwd })).out);
    const receipt = await receiptFor(store, cwd, run.run_id);
    const out = await importClaim(store, cwd, claim(cwd, run.run_id, receipt));
    const body = j<{ applied: number; results: { effective_state: string; reason: string }[] }>(out.out);
    expect(body.applied).toBe(1);
    expect(body.results[0]?.effective_state).toBe("unknown");
    expect(body.results[0]?.reason).toMatch(/the run's own verdict is REHEARSAL/);
  });

  it("negative control: an accepted claim for a run the store has never seen cannot be honoured", async () => {
    const cwd = makeTmp("hc-fix1-cli-");
    const store = join(cwd, "ev");
    await runMain(["run", ...inputArgs(prepareDrill()), "--output", store, "--json", "--allow-host-sandbox"], { cwd });
    const out = await importClaim(store, cwd, claim(cwd, "run-that-does-not-exist", { event_id: "x", evidence_ref: `sha256:${"a".repeat(64)}` }));
    expect(j<{ results: { effective_state: string }[] }>(out.out).results[0]?.effective_state).toBe("unknown");
  });

  it("a claim that pins the exported report digest, answers the receipt and matches an INDEPENDENT_PASS run is accepted; a file: ref, a wrong digest and a changed run are not", async () => {
    const cwd = makeTmp("hc-fix1-cli-");
    const store = join(cwd, "ev");
    const { lima, body } = await vmRun(store, cwd);
    const receipt = await receiptFor(store, cwd, body.run_id, lima.env);
    const accepted = await importClaim(store, cwd, claim(cwd, body.run_id, receipt), lima.env);
    expect(j<{ results: { effective_state: string }[] }>(accepted.out).results[0]?.effective_state).toBe("accepted");
    // wrong digest and file: refs verify nothing (newer revisions so they are not stale)
    const wrong = await importClaim(store, cwd, claim(cwd, body.run_id, receipt, { revision: 2, evidence_ref: `sha256:${"b".repeat(64)}` }), lima.env);
    expect(j<{ results: { effective_state: string }[] }>(wrong.out).results[0]?.effective_state).toBe("unknown");
    const fileRef = await importClaim(store, cwd, claim(cwd, body.run_id, receipt, { revision: 3, evidence_ref: "file:report.json" }), lima.env);
    expect(j<{ results: { effective_state: string }[] }>(fileRef.out).results[0]?.effective_state).toBe("unknown");
    // the run changes after the receipt (an intervention makes it ASSISTED): a fresh, otherwise perfect claim is stale or unknown, never accepted
    await runMain(["record-intervention", "--run", body.run_id, "--reason", "asked for help", "--output", store, "--json"], { cwd, env: lima.env });
    const after = await importClaim(store, cwd, claim(cwd, body.run_id, receipt, { revision: 4 }), lima.env);
    const state = j<{ results: { effective_state: string }[] }>(after.out).results[0]?.effective_state;
    expect(["stale", "unknown"]).toContain(state);
  });
});

describe("a harness killed mid-run leaves a run that cleanup can recover, and never one that looks accepted", () => {
  /** Start a real packaged-CLI run whose install step sleeps, and wait until the store shows it RUNNING. */
  async function startSlowRun(tz: string) {
    ensureBuilt();
    const inputs = prepareDrill({ scripts: { "install.sh": sh(`"$NODE" "$SVC" install\nsleep 120`) } });
    const cwd = makeTmp("hc-orphan-");
    const store = join(cwd, "ev");
    const child = spawn(process.execPath, [CLI_PATH, "run", ...inputArgs(inputs), "--output", store, "--json", "--allow-host-sandbox"], { cwd, env: cleanEnv({ TZ: tz }), stdio: "ignore" });
    let runId = "";
    for (let i = 0; i < 160 && runId === ""; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (!existsSync(join(store, "handoffcheck.sqlite"))) continue;
      const running = (await api.listRuns(makeCtx({ storeDir: store }))).runs.find((r) => r.state === "RUNNING");
      if (running) runId = running.id;
    }
    expect(runId, "the run never reached RUNNING").not.toBe("");
    const kill = async () => {
      child.kill("SIGKILL");
      await new Promise((r) => child.once("exit", r));
    };
    return { cwd, store, runId, kill };
  }
  const cli = (cwd: string, tz: string, ...args: string[]) => runCli(args, { cwd, env: { TZ: tz } });

  it("cleanup refuses while the owner is alive (CONFLICT), and after the owner is killed it aborts the run, cleans what it provisioned and the verdict stays red", async () => {
    const { cwd, store, runId, kill } = await startSlowRun("UTC");
    try {
      const alive = cli(cwd, "UTC", "cleanup", "--run", runId, "--output", store, "--json");
      expect(alive.status, alive.stdout).toBe(2);
      expect(j<{ error: { code: string; message: string } }>(alive.stdout).error.code).toBe("CONFLICT");
      expect(j<{ error: { message: string } }>(alive.stdout).error.message).toMatch(/owner process is still alive/);
      expect((await api.listRuns(makeCtx({ storeDir: store }))).runs[0]?.state).toBe("RUNNING"); // the refused cleanup changed nothing
    } finally {
      await kill();
    }
    const recovered = cli(cwd, "UTC", "cleanup", "--run", runId, "--output", store, "--json");
    expect(recovered.status, recovered.stdout + recovered.stderr).toBe(0);
    expect(j<{ state: string; receipt: { status: string } }>(recovered.stdout)).toMatchObject({ state: "CLEANUP_VERIFIED", receipt: { status: "VERIFIED" } });
    const report = j<{ verdict: { verdict: string; exit_code: number; reasons: { code: string }[] }; run: { outcome: string } }>(cli(cwd, "UTC", "report", "--run", runId, "--output", store, "--json").stdout);
    expect(report.run.outcome).toBe("ABORTED");
    expect(report.verdict.verdict).toBe("FAIL");
    expect(report.verdict.exit_code).toBe(1);
    expect(report.verdict.reasons.map((r) => r.code)).toContain("RUN_ABORTED");
  }, 120_000);

  it("a later run in the same store reaps the killed harness's orphan first (startup scan), and a live owner is never reaped", async () => {
    const { cwd, store, runId, kill } = await startSlowRun("UTC");
    const stateOf = async () => (await api.listRuns(makeCtx({ storeDir: store }))).runs.find((r) => r.id === runId)?.state;
    try {
      // while the owner is alive another invocation in the same store must leave the run alone
      const during = cli(cwd, "UTC", "demo", "--output", store, "--json");
      expect(during.status, during.stdout + during.stderr).toBe(0);
      expect(await stateOf()).toBe("RUNNING");
    } finally {
      await kill();
    }
    const after = cli(cwd, "UTC", "demo", "--output", store, "--json");
    expect(after.status, after.stdout + after.stderr).toBe(0);
    expect(await stateOf()).toBe("CLEANUP_VERIFIED");
    const report = j<{ verdict: { verdict: string }; run: { outcome: string } }>(cli(cwd, "UTC", "report", "--run", runId, "--output", store, "--json").stdout);
    expect(report.run.outcome).toBe("ABORTED");
    expect(report.verdict.verdict).toBe("FAIL");
  }, 120_000);

  // Regression for a defect found by hc-qa and fixed by hc-domain: the owner start time is `ps lstart` text, which used to be
  // rendered in the caller's TZ/locale, so a cleanup from a shell with another TZ saw a LIVE run as "owner gone" and tore it down.
  it("a cleanup invoked with a different TZ than the run's harness must still see the live owner (CONFLICT), not abort the run", async () => {
    const { cwd, store, runId, kill } = await startSlowRun("Asia/Tokyo");
    try {
      const alive = cli(cwd, "America/Los_Angeles", "cleanup", "--run", runId, "--output", store, "--json");
      expect(alive.status, alive.stdout).toBe(2);
      expect(j<{ error: { code: string } }>(alive.stdout).error.code).toBe("CONFLICT");
    } finally {
      await kill();
      cli(cwd, "Asia/Tokyo", "cleanup", "--run", runId, "--output", store, "--json"); // reap whatever the killed harness left behind
    }
  }, 120_000);
});
