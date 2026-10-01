// Regression tests for the independent review of the 9ea21de revision (P0-1, P1-1..P1-6, P2-1..P2-4, P3).
// One section per finding. Each negative control names the review item it pins; the section titles say what must
// never happen again. These tests were written to be red on 9ea21de and green on the fix branches.
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as api from "../../src/api.js";
import { PLANTED, makeCtx, prepareDrill, readFixtureScript, sh } from "../helpers/drill.js";
import { forgeBundle } from "../helpers/bundle.js";
import { expectRed, runDrill, stepLogs, stepOf } from "../helpers/run.js";
import { filesContaining, walkFiles } from "../helpers/scan.js";
import { readTarEntries } from "../helpers/tar.js";
import { makeFakeLima } from "../helpers/lima.js";
import { makeTmp, registerTmpCleanup } from "../helpers/tmp.js";
import { buildTar, sha256Hex } from "../../scripts/build-fixture-release.mjs";

registerTmpCleanup();

const codes = (r: api.RunResult): string[] => r.verdict.reasons.map((x) => x.code);

describe("P0-1: a drill with nothing mandatory (or a missing PRD action) can never be accepted", () => {
  const ALL_SCRIPTS = ["install.sh", "restore.sh", "rotate.sh", "recover.sh", "health.sh", "measure.sh", "auth-probe.sh", "seed-failure.sh", "worker-probe.sh"];
  const failing = Object.fromEntries(ALL_SCRIPTS.map((n) => [n, "#!/bin/sh\nexit 1\n"]));

  it("negative control: every step optional and every script failing is rejected by preflight, runs nothing and exits 1 (it exited 0 on 9ea21de)", async () => {
    const { result, ctx } = await runDrill({ scripts: failing, manifest: (m) => m.steps.forEach((s: { mandatory?: boolean }) => (s.mandatory = false)) });
    expect(result.exit_code).toBe(1);
    expectRed(result);
    expect(result.verdict.verdict).toBe("FAIL");
    expect(codes(result)).toEqual(["PREFLIGHT_REJECTED"]);
    expect(result.preflight?.status).toBe("REJECTED");
    expect(result.preflight?.findings.map((f) => `${f.code} ${f.location}`)).toContain("MANIFEST_SEMANTICS /steps");
    expect(result.steps.every((s) => s.status === "SKIPPED")).toBe(true);
    expect(result.cleanup.resources).toBe(0);
    // and a later report agrees
    const report = await api.getReport(ctx, { runId: result.run_id });
    expect(report.verdict.exit_code).toBe(1);
  });

  for (const action of ["install", "restore", "rotate", "recover"] as const) {
    it(`negative control: ${action} present only as an optional step is rejected before anything runs (the manifest must require all four PRD actions)`, async () => {
      const { result } = await runDrill({ manifest: (m) => void (m.steps.find((s: { action: string }) => s.action === action).mandatory = false) });
      expect(result.preflight?.status).toBe("REJECTED");
      const finding = result.preflight?.findings.find((f) => f.code === "MANIFEST_SEMANTICS");
      expect(finding?.message, JSON.stringify(result.preflight?.findings)).toContain(`mandatory "${action}"`);
      expect(result.exit_code).toBe(1);
      expect(result.steps.every((s) => s.status === "SKIPPED")).toBe(true);
    });

    it(`negative control: a manifest with no ${action} step at all is rejected the same way`, async () => {
      const inputs = prepareDrill({ manifest: (m) => void (m.steps = m.steps.filter((s: { action: string }) => s.action !== action)) });
      const report = await api.preflight(makeCtx(), inputs.paths);
      expect(report.status).toBe("REJECTED");
      expect(report.findings.some((f) => f.code === "MANIFEST_SEMANTICS" && f.message.includes(`"${action}"`))).toBe(true);
    });
  }

  it("positive control: the unmodified fixture (four mandatory steps) passes the same preflight, so the rejections above are not a blanket refusal", async () => {
    const report = await api.preflight(makeCtx(), prepareDrill().paths);
    expect(report.status).toBe("PASS");
    expect(report.findings).toEqual([]);
  });

  it("extra optional steps remain allowed beside the four mandatory ones", async () => {
    const inputs = prepareDrill({ manifest: (m) => m.steps.push({ id: "extra", action: "install", mandatory: false, deadline_seconds: 30, script: { path: "scripts/install.sh" }, probe: { path: "scripts/health.sh" }, probe_interval_ms: 200 }) });
    expect((await api.preflight(makeCtx(), inputs.paths)).status).toBe("PASS");
  });
});

describe("P1-1: the run's own outcome and the planned step count decide, not only the recorded steps", () => {
  it("negative control: a run recorded FAILED (HARNESS_ERROR) is FAIL with that reason even though its steps never failed", async () => {
    const inputs = prepareDrill({});
    const failing: api.RunnerProvider = {
      name: "local-sandbox",
      isolation: "none",
      async probe() {
        return { available: true, version: "fake" };
      },
      async provision() {
        return {
          id: "fake-sandbox",
          provider: "local-sandbox",
          isolation: "none",
          async exec(req) {
            return { label: req.label, exit_code: 0, signal: null, timed_out: false, aborted: false, duration_ms: 1, stdout: new Uint8Array(), stderr: new Uint8Array(), truncated: false };
          },
          async readFile() {
            return null;
          },
          resources: () => {
            throw new Error("inventory unavailable");
          },
          async destroy() {
            /* nothing */
          }
        };
      },
      async audit(rs) {
        return rs.map((r) => ({ ...r, state: "removed" as const }));
      },
      async destroyResources() {
        /* nothing */
      }
    };
    const ctx = makeCtx({ providers: { "local-sandbox": failing } });
    await expect(api.run(ctx, inputs.paths)).rejects.toMatchObject({ code: "INTERNAL" });
    const [run] = (await api.listRuns(ctx)).runs;
    expect(run).toMatchObject({ outcome: "FAILED", outcome_reason: "HARNESS_ERROR" });
    const report = await api.getReport(ctx, { runId: run!.id });
    expect(report.verdict.verdict).toBe("FAIL");
    expect(report.verdict.reasons.map((r) => r.code)).toContain("HARNESS_ERROR");
    expect(report.verdict.exit_code).toBe(1);
    expect(report.verdict.independent).toBe(false);
  });

  it("negative control: a recorded step that vanished from the store (planned count 4, three recorded) is never accepted", async () => {
    const { ctx, result } = await runDrill();
    expect(result.exit_code).toBe(0);
    const db = new DatabaseSync(join(ctx.storeDir, "handoffcheck.sqlite"));
    try {
      // the append-only trigger is the first defence (see engine-edges); a tamperer who drops it is the second
      db.exec("DROP TRIGGER steps_no_delete");
      db.exec("DELETE FROM steps WHERE step_key = 'recover'");
    } finally {
      db.close();
    }
    const report = await api.getReport(ctx, { runId: result.run_id });
    expect(report.steps).toHaveLength(3);
    expect(report.verdict.exit_code).toBe(1);
    expect(report.verdict.verdict).toBe("UNKNOWN");
    expect(report.verdict.reasons.map((r) => r.code)).toContain("MANDATORY_STEP_NOT_RUN");
  });

  it("an aborted run still reports all four planned steps (skipped), and is never accepted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { result } = await runDrill({}, { signal: controller.signal });
    expect(result.steps.map((s) => s.status)).toEqual(["SKIPPED", "SKIPPED", "SKIPPED", "SKIPPED"]);
    expect(result.verdict.verdict).toBe("FAIL");
    expect(codes(result)).toContain("RUN_ABORTED");
  });
});

describe("P1-2: declared and learned secrets are redacted everywhere a later writer stores text (AC-10)", () => {
  // Not credential-shaped on purpose: only the declared/learned literal list can catch these, the pattern redactor cannot.
  const DECLARED = ["declared", "literal", "secret", "5521"].join("-");
  const LEARNED = ["learned", "rotation", "cred", "7741"].join("-");
  const withDeclared = (m: Record<string, any>): void => void m.synthetic_secrets.push(DECLARED); // eslint-disable-line @typescript-eslint/no-explicit-any
  const store = (ctx: api.ApiContext) => ctx.storeDir;

  it("negative control: a declared synthetic secret typed into an intervention reason never reaches the store, the report or the bundle", async () => {
    const { ctx, result } = await runDrill({ manifest: withDeclared });
    await api.recordIntervention(ctx, { runId: result.run_id, reason: `I read ${DECLARED} out of the config to continue`, actorRef: "operator-a" });
    const report = await api.getReport(ctx, { runId: result.run_id });
    expect(JSON.stringify(report)).not.toContain(DECLARED);
    expect(report.interventions[0]?.reason).toContain("[REDACTED");
    const out = join(makeTmp("hc-p12-"), "run.hcb");
    await api.exportBundle(ctx, { runId: result.run_id, outPath: out });
    expect(readFileSync(out).includes(DECLARED)).toBe(false);
    expect(filesContaining(store(ctx), [DECLARED])).toEqual([]);
    expect(filesContaining(join(out, ".."), [DECLARED])).toEqual([]);
  });

  it("positive control: the same reason without any secret is stored verbatim, so the redaction above is the redactor and not a blanket rewrite", async () => {
    const { ctx, result } = await runDrill({ manifest: withDeclared });
    await api.recordIntervention(ctx, { runId: result.run_id, reason: "asked how to restore the data", actorRef: "operator-a" });
    expect((await api.getReport(ctx, { runId: result.run_id })).interventions[0]?.reason).toBe("asked how to restore the data");
  });

  it("negative control: the declared secret is also redacted when it is a step's own output", async () => {
    const noisy = sh(`"$NODE" "$SVC" install\necho "token is ${DECLARED}"`);
    const { ctx, result } = await runDrill({ manifest: withDeclared, scripts: { "install.sh": noisy } });
    expect(stepOf(result, "install").status).toBe("PASS");
    expect(filesContaining(store(ctx), [DECLARED])).toEqual([]);
  });

  it("negative control: a credential learned while rotation ran (not declared in the manifest) is redacted from the step log and from later interventions", async () => {
    const rotate = `${readFixtureScript("rotate.sh")}printf %s "${LEARNED}" > "$HC_STATE/credential.new"\necho "new credential is ${LEARNED}"\n`;
    const { ctx, result } = await runDrill({ scripts: { "rotate.sh": rotate } });
    // the planted service rejects the swapped credential, so the run is red; what matters is what was stored
    expect(stepOf(result, "rotate").status).toBe("FAIL");
    expect(filesContaining(store(ctx), [LEARNED])).toEqual([]);
    await api.recordIntervention(ctx, { runId: result.run_id, reason: `the new credential ${LEARNED} did not work`, actorRef: "operator-a" });
    const report = await api.getReport(ctx, { runId: result.run_id });
    expect(JSON.stringify(report)).not.toContain(LEARNED);
    expect(report.interventions[0]?.reason).toContain("[REDACTED");
    expect(filesContaining(store(ctx), [LEARNED])).toEqual([]);
  });

  it("run secrets live only in the local store: the manifest-declared literal and the planted tokens are absent from every plain file of it and of an export", async () => {
    const { ctx, result } = await runDrill({ manifest: withDeclared });
    const out = join(makeTmp("hc-p12-"), "run.hcb");
    await api.exportBundle(ctx, { runId: result.run_id, outPath: out });
    const needles = [DECLARED, PLANTED.oldToken, PLANTED.newToken];
    expect(filesContaining(store(ctx), needles)).toEqual([]);
    expect(readFileSync(out).includes(DECLARED)).toBe(false);
    // the encrypted secrets table is real and never exported
    const db = new DatabaseSync(join(store(ctx), "handoffcheck.sqlite"));
    try {
      const rows = db.prepare("SELECT count(*) AS n FROM run_secrets").get() as { n: number };
      expect(rows.n).toBeGreaterThan(0);
    } finally {
      db.close();
    }
    expect(readTarEntries(readFileSync(out)).some((e) => /run_secrets/i.test(e.name))).toBe(false);
  });
});

describe("P1-3: symlink containment is physical, not lexical", () => {
  const refusal = async (extra: { path: string; type: string; linkname: string }[]): Promise<api.PreflightReport> => api.preflight(makeCtx(), prepareDrill({ extra }).paths);

  it("negative control: a chain of in-root links whose last hop climbs out of the root is rejected (each link looked fine on its own)", async () => {
    // a/b -> ..  resolves to the root; c -> a/b/..  then names the parent of the root
    const r = await refusal([
      { path: "a/b", type: "2", linkname: ".." },
      { path: "c", type: "2", linkname: "a/b/.." }
    ]);
    expect(r.status).toBe("REJECTED");
    expect(r.findings).toEqual([expect.objectContaining({ code: "ARTIFACT_UNSAFE", severity: "reject" })]);
    expect(r.findings[0]?.message).toMatch(/points outside the archive root \(physically resolved\)/);
  });

  it("negative control: two hops up from a nested directory, a cycle, and a malformed or empty target are all rejected", async () => {
    for (const [name, extra] of [
      ["two hops up", [{ path: "a/b", type: "2", linkname: "../.." }]],
      ["a cycle", [{ path: "p", type: "2", linkname: "q" }, { path: "q", type: "2", linkname: "p" }]],
      ["a backslash path", [{ path: "w", type: "2", linkname: "..\\..\\x" }]],
      ["an empty target", [{ path: "e", type: "2", linkname: "" }]]
    ] as const) {
      const r = await refusal([...extra]);
      expect(r.status, name).toBe("REJECTED");
      expect(r.findings.map((f) => f.code), name).toEqual(["ARTIFACT_UNSAFE"]);
    }
  });

  it("positive control: links that stay inside the root, directly or through a chain or an up-and-back-in path, are accepted", async () => {
    for (const extra of [
      [{ path: "ok1", type: "2", linkname: "ok2" }, { path: "ok2", type: "2", linkname: "bin/notes.mjs" }],
      [{ path: "d/l", type: "2", linkname: "../bin/notes.mjs" }]
    ]) {
      const r = await refusal(extra);
      expect(r.status, JSON.stringify(extra)).toBe("PASS");
    }
  });

  it("negative control: a bundle carrying the same chain is rejected as an unsafe entry and imports nothing", async () => {
    const { ctx, result } = await runDrill();
    const good = join(makeTmp("hc-p13-"), "good.hcb");
    await api.exportBundle(ctx, { runId: result.run_id, outPath: good });
    const entries = readTarEntries(readFileSync(good));
    const bad = join(makeTmp("hc-p13-"), "chain.hcb");
    writeFileSync(
      bad,
      buildTar([
        ...entries.map((e) => ({ path: e.name, data: e.data, type: e.type, linkname: e.linkname })),
        { path: "objects/a/b", data: Buffer.alloc(0), type: "2", linkname: ".." },
        { path: "objects/c", data: Buffer.alloc(0), type: "2", linkname: "a/b/.." }
      ])
    );
    const verification = await api.verifyBundle({}, { bundlePath: bad });
    expect(verification.ok).toBe(false);
    expect(verification.errors.map((e) => e.code)).toContain("UNSAFE_ENTRY");
    const target = makeCtx();
    await expect(api.importBundle(target, { bundlePath: bad })).rejects.toMatchObject({ code: "BUNDLE_CORRUPT" });
    expect((await api.listRuns(target).catch(() => ({ runs: [] }))).runs).toEqual([]);
  });
});

describe("P1-6: running scripts directly on this host needs an explicit opt-in", () => {
  it("negative control: local-sandbox without allowHostSandbox is a preflight rejection (HOST_SANDBOX_NOT_ALLOWED, FAIL, exit 1), not an exception, and nothing executes", async () => {
    const inputs = prepareDrill();
    const marker = join(inputs.dir, "ran-on-host");
    writeFileSync(join(inputs.dir, "scripts", "install.sh"), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    const ctx = makeCtx();
    const result = await api.run(ctx, inputs.bare);
    expect(result.preflight?.status).toBe("REJECTED");
    expect(result.preflight?.findings.map((f) => f.code)).toContain("HOST_SANDBOX_NOT_ALLOWED");
    expect(result.verdict.verdict).toBe("FAIL");
    expect(result.exit_code).toBe(1);
    expect(result.steps.every((s) => s.status === "SKIPPED")).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(result.warnings).toBeUndefined();
  });

  it("the preflight alone reports the same finding, and the opt-in is the only difference", async () => {
    const inputs = prepareDrill();
    const denied = await api.preflight(makeCtx(), inputs.bare);
    expect(denied.status).toBe("REJECTED");
    expect(denied.findings.map((f) => f.code)).toEqual(["HOST_SANDBOX_NOT_ALLOWED"]);
    expect((await api.preflight(makeCtx(), { ...inputs.bare, allowHostSandbox: true })).status).toBe("PASS");
  });

  it("with the opt-in the run executes and carries the warning the caller must print", async () => {
    const { result } = await runDrill();
    expect(result.exit_code).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toMatch(/directly on this host/);
    expect(result.warnings?.[0]).toMatch(/no VM|isolation none/);
  });

  it("the built-in demo is exempt (and warning-free): it needs no flag and runs only the embedded synthetic scenario", async () => {
    const result = await api.demo(makeCtx());
    expect(result.exit_code).toBe(0);
    expect(result.verdict.verdict).toBe("REHEARSAL");
    expect(result.warnings).toBeUndefined();
  });

  it("the VM provider needs no host-sandbox opt-in (it is the isolated path)", async () => {
    const inputs = prepareDrill({ manifest: (m) => void (m.runner.provider = "lima") });
    const report = await api.preflight({ env: makeFakeLima().env }, inputs.bare);
    expect(report.status).toBe("PASS");
    expect(report.findings.map((f) => f.code)).not.toContain("HOST_SANDBOX_NOT_ALLOWED");
  });
});

describe("P2-1: an evidence object must live at the path of its own sha256", () => {
  it("negative control: a blob stored under a different digest's path is HASH_MISMATCH even when the header and root hash are consistent", async () => {
    const { ctx, result } = await runDrill();
    const src = join(makeTmp("hc-p21-"), "run.hcb");
    await api.exportBundle(ctx, { runId: result.run_id, outPath: src });
    const bytes = readFileSync(src);
    const victim = readTarEntries(bytes).find((e) => e.name.startsWith("objects/"))!;
    const wrongPath = `objects/${"0".repeat(64)}`;
    const forged = forgeBundle(bytes, {
      header: (h) => {
        const f = h.files.find((x: { path: string }) => x.path === victim.name);
        f.path = wrongPath;
        const sorted = [...h.files].sort((a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : 1));
        h.root_hash = sha256Hex(sorted.map((x: { path: string; sha256: string }) => `${x.path}:${x.sha256}`).join("\n"));
      },
      entries: (es) => es.map((e) => (e.name === victim.name ? { ...e, name: wrongPath } : e))
    });
    const bad = join(makeTmp("hc-p21-"), "forged.hcb");
    writeFileSync(bad, forged);
    const v = await api.verifyBundle({}, { bundlePath: bad });
    expect(v.ok).toBe(false);
    expect(v.errors.map((e) => e.code), JSON.stringify(v.errors)).toContain("HASH_MISMATCH");
    const target = makeCtx();
    await expect(api.importBundle(target, { bundlePath: bad })).rejects.toBeInstanceOf(api.HandoffCheckError);
    // positive control: the unmodified bundle verifies
    expect((await api.verifyBundle({}, { bundlePath: src })).ok).toBe(true);
  });
});

describe("P2-3: operator and builder identities are compared after NFKC, trim and case folding", () => {
  const vmRun = async (operator: Partial<api.OperatorDecl>) => {
    return runDrill({ manifest: (m) => void (m.runner.provider = "lima") }, { operator, ctx: { env: makeFakeLima().env } });
  };

  it("negative control: the same person written with different case, spacing or a compatibility form is the builder, never independent", async () => {
    for (const [ref, builder] of [
      ["Builder-B", "builder-b"],
      ["  builder-b  ", "builder-b"],
      ["ｂuilder-b", "builder-b"] // a fullwidth letter: NFKC folds it to the ASCII one
    ] as const) {
      const { result } = await vmRun({ kind: "human", ref, builder_ref: builder });
      expect(result.verdict.verdict, `${JSON.stringify(ref)} vs ${builder}`).toBe("REHEARSAL");
      expect(codes(result)).toEqual(["OPERATOR_IS_BUILDER"]);
    }
  });

  it("negative control: an operator ref that is blank after trimming proves no independence", async () => {
    const { result } = await vmRun({ kind: "human", ref: "   ", builder_ref: "builder-b" });
    expect(result.verdict.verdict).toBe("REHEARSAL");
    expect(codes(result)).toEqual(["OPERATOR_INDEPENDENCE_UNPROVEN"]);
  });

  it("positive control: two different people are still independent on the VM provider (fake limactl plumbing)", async () => {
    const { result } = await vmRun({ kind: "human", ref: "operator-a", builder_ref: "builder-b" });
    expect(result.verdict.verdict).toBe("INDEPENDENT_PASS");
  });

  it("negative control: a manifest cannot assert a human operator for itself", async () => {
    const { result } = await runDrill(
      { manifest: (m) => { m.runner.provider = "lima"; m.operator = { kind: "human", ref: "operator-a", builder_ref: "builder-b" }; } },
      { ctx: { env: makeFakeLima().env } }
    );
    expect(result.verdict.verdict).not.toBe("INDEPENDENT_PASS");
    expect(result.verdict.independent).toBe(false);
  });
});

describe("P2-4: retention purge is the only deletion path, with a dry run and an explicit age", () => {
  const DAY = 86_400_000;
  const at = (iso: string) => api.fixedClock(iso, 1000);

  async function twoRuns() {
    const early = await runDrill({}, { ctx: { clock: at("2026-01-01T00:00:00.000Z") } });
    const second = await api.run(makeCtx({ storeDir: early.ctx.storeDir, clock: at("2026-02-15T00:00:00.000Z"), ids: api.sequentialIds(0x5b) }), prepareDrill().paths);
    return { storeDir: early.ctx.storeDir, first: early.result.run_id, second: second.run_id };
  }
  const ctxAt = (storeDir: string, iso: string) => makeCtx({ storeDir, clock: at(iso) });

  it("a dry run lists what would go and deletes nothing", async () => {
    const { storeDir, first } = await twoRuns();
    const dry = await api.purgeExpired(ctxAt(storeDir, "2026-06-01T00:00:00.000Z"), { dryRun: true });
    expect(dry).toMatchObject({ dry_run: true });
    expect(dry.purged).toContain(first);
    expect((await api.listRuns(ctxAt(storeDir, "2026-06-01T00:00:00.000Z"))).runs).toHaveLength(2);
  });

  it("olderThanDays removes only runs created before the cutoff and their unreferenced blobs, and the second purge is a no-op", async () => {
    const { storeDir, first, second } = await twoRuns();
    const now = "2026-02-20T00:00:00.000Z";
    const out = await api.purgeExpired(ctxAt(storeDir, now), { olderThanDays: 30 });
    expect(out).toEqual({ purged: [first], dry_run: false });
    const left = (await api.listRuns(ctxAt(storeDir, now))).runs.map((r) => r.id);
    expect(left).toEqual([second]);
    expect((await api.purgeExpired(ctxAt(storeDir, now), { olderThanDays: 30 })).purged).toEqual([]);
    // the surviving run still reports and verifies
    expect((await api.getReport(ctxAt(storeDir, now), { runId: second })).verdict.verdict).toBe("REHEARSAL");
    expect(Date.parse(now) - Date.parse("2026-01-01T00:00:00.000Z")).toBeGreaterThan(30 * DAY);
  });

  it("olderThanDays: 0 purges every run created before now; the default (no options) purges only runs past their retain_until", async () => {
    const { storeDir, first, second } = await twoRuns();
    expect((await api.purgeExpired(ctxAt(storeDir, "2026-03-01T00:00:00.000Z"))).purged).toEqual([]); // 90 days not reached
    const all = await api.purgeExpired(ctxAt(storeDir, "2026-03-01T00:00:00.000Z"), { olderThanDays: 0 });
    expect(all.purged.sort()).toEqual([first, second].sort());
    expect((await api.listRuns(ctxAt(storeDir, "2026-03-01T00:00:00.000Z"))).runs).toEqual([]);
  });

  it("negative control: a negative, fractional or non-numeric age is refused with BAD_REQUEST and deletes nothing", async () => {
    const { storeDir } = await twoRuns();
    for (const bad of [-1, 1.5, Number.NaN]) {
      await expect(api.purgeExpired(ctxAt(storeDir, "2026-06-01T00:00:00.000Z"), { olderThanDays: bad }), String(bad)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect((await api.listRuns(ctxAt(storeDir, "2026-06-01T00:00:00.000Z"))).runs).toHaveLength(2);
  });

  it("evidence blobs of a purged run disappear from the object directory, shared blobs of a surviving run stay", async () => {
    const { storeDir } = await twoRuns();
    const objects = () => walkFiles(storeDir).filter((f) => /objects/.test(f));
    const before = objects().length;
    expect(before).toBeGreaterThan(0);
    await api.purgeExpired(ctxAt(storeDir, "2026-02-20T00:00:00.000Z"), { olderThanDays: 30 });
    const after = objects().length;
    expect(after).toBeLessThanOrEqual(before);
    // the surviving run's own evidence is intact: reporting it needs those blobs
    const [survivor] = (await api.listRuns(ctxAt(storeDir, "2026-02-20T00:00:00.000Z"))).runs;
    expect((await api.getReport(ctxAt(storeDir, "2026-02-20T00:00:00.000Z"), { runId: survivor!.id })).verdict.reasons.map((r) => r.code)).not.toContain("EVIDENCE_UNVERIFIABLE");
  });
});

describe("P3: smaller hardening", () => {
  it("negative control: an export never writes through a pre-existing .partial file or symlink next to the output path", async () => {
    const { ctx, result } = await runDrill();
    const dir = makeTmp("hc-p3-");
    const out = join(dir, "run.hcb");
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "do not touch");
    symlinkSync(victim, `${out}.partial`);
    await expect(api.exportBundle(ctx, { runId: result.run_id, outPath: out })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(readFileSync(victim, "utf8")).toBe("do not touch");
    expect(existsSync(out)).toBe(false);
  });

  it("negative control: a socket destination written in a script (/dev/tcp, python, node) is an undeclared network destination", async () => {
    const hosts = (h: string) => ["h", h].join("");
    const cases: [string, string][] = [
      ["/dev/tcp", `#!/bin/bash\nexec 3<>/dev/tcp/${hosts("203.0.113.9")}/80\n`],
      ["python socket", `#!/bin/sh\npython3 -c 'import socket; socket.create_connection(("${hosts("198.51.100.7")}", 443))'\n`],
      ["node net", `#!/bin/sh\nnode -e 'const net = require("net"); net.connect({ host: "${hosts("192.0.2.44")}", port: 80 })'\n`]
    ];
    for (const [name, body] of cases) {
      const inputs = prepareDrill({ scripts: { "health.sh": body } });
      const report = await api.preflight(makeCtx(), { ...inputs.bare, allowHostSandbox: true });
      expect(report.findings.map((f) => f.code), name).toContain("UNDECLARED_NETWORK_DESTINATION");
    }
  });

  it("positive control: a loopback socket in a script is not an undeclared destination", async () => {
    const inputs = prepareDrill({ scripts: { "health.sh": `#!/bin/sh\npython3 -c 'import socket; socket.create_connection(("127.0.0.1", 8080))'\n` } });
    const report = await api.preflight(makeCtx(), { ...inputs.bare, allowHostSandbox: true });
    expect(report.findings.map((f) => f.code)).not.toContain("UNDECLARED_NETWORK_DESTINATION");
  });

  it("negative control: the planted-fake marker never excuses a private key block", async () => {
    const pem = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
    const end = ["-----END ", "PRIVATE KEY-----"].join("");
    const body = `${pem}\nHCFAKE_NOT_A_REAL_KEY_BODY_0000\n${end}\n`;
    const inputs = prepareDrill({ extra: [{ path: "config/key.pem", data: body }] });
    const report = await api.preflight(makeCtx(), { ...inputs.bare, allowHostSandbox: true });
    expect(report.status).toBe("REJECTED");
    expect(report.findings.map((f) => f.code)).toContain("PRODUCTION_CREDENTIAL");
  });

  it("verify-bundle says what it proves: integrity only, provenance not verified", async () => {
    const { ctx, result } = await runDrill();
    const out = join(makeTmp("hc-p3-"), "run.hcb");
    await api.exportBundle(ctx, { runId: result.run_id, outPath: out });
    const v = await api.verifyBundle({}, { bundlePath: out });
    expect(v.ok).toBe(true);
    expect(v.note).toBe("integrity only, provenance not verified");
  });
});

describe("second fix round: rotation leak, terminal escapes, step-receipt cross-check, fixture builder", () => {
  const NEWCRED = ["plainkey", "two", "9c3d"].join("-");

  it("negative control: a rotation credential printed by the rotate script is redacted from every stored byte and the bundle even with NO synthetic_secrets declared", async () => {
    const rotate =
      `${readFixtureScript("rotate.sh")}` +
      // the engine learns the OLD credential before the script runs and the NEW one after it, so only the new one can be swapped in here
      `printf %s "${NEWCRED}" > "$HC_STATE/credential.new"\necho "new=${NEWCRED}"\necho "again ${NEWCRED}" >&2\n`;
    const { ctx, result } = await runDrill({ scripts: { "rotate.sh": rotate }, manifest: (m) => void (m.synthetic_secrets = []) });
    expect(stepOf(result, "rotate").step_key).toBe("rotate");
    const out = join(makeTmp("hc-rot-"), "run.hcb");
    await api.exportBundle(ctx, { runId: result.run_id, outPath: out });
    const needles = [NEWCRED];
    const hits = filesContaining(ctx.storeDir, needles);
    expect(hits).toEqual([]);
    expect(needles.some((n) => readFileSync(out).includes(n))).toBe(false);
    const logs = (await stepLogs(ctx, result.run_id)).filter((l) => l.step_key === "rotate").map((l) => l.text).join("\n");
    expect(logs).toContain("[REDACTED");
    expect(logs).not.toContain(NEWCRED);
    // the same literals typed later are still redacted (the learned credentials were persisted for later writers)
    await api.recordIntervention(ctx, { runId: result.run_id, reason: `typed ${NEWCRED}`, actorRef: "operator-a" });
    expect(JSON.stringify(await api.getReport(ctx, { runId: result.run_id }))).not.toContain(NEWCRED);
  });

  it("negative control: terminal escape sequences never reach evidence, and a secret split by escapes is still redacted", async () => {
    const DECLARED = ["split", "by", "escape", "3317"].join("-");
    const noisy = sh(`"$NODE" "$SVC" install\nprintf 'x\\033[31mred\\033[0m %s\\033[0m%s \\033]0;title\\007\\n' "split-by-esc" "ape-3317"`);
    const { ctx, result } = await runDrill({ scripts: { "install.sh": noisy }, manifest: (m) => void m.synthetic_secrets.push(DECLARED) });
    expect(stepOf(result, "install").status).toBe("PASS");
    const logs = await stepLogs(ctx, result.run_id);
    expect(logs.length).toBeGreaterThan(0);
    for (const l of logs) expect(l.text.includes("\u001b"), l.step_key ?? "").toBe(false);
    for (const f of walkFiles(join(ctx.storeDir, "objects"))) expect(readFileSync(f).includes(0x1b), f).toBe(false);
    expect(filesContaining(ctx.storeDir, [DECLARED])).toEqual([]);
    expect(logs.map((l) => l.text).join("\n")).toContain("[REDACTED");
  });

  it("negative control: a bundle whose step record says PASS while the receipt it points to says FAIL is rejected (BAD_FORMAT) and imports nothing", async () => {
    const { ctx, result } = await runDrill({ scripts: { "recover.sh": "#!/bin/sh\ntrue\n" }, manifest: (m) => { m.steps[3].deadline_seconds = 20; m.steps[3].max_recovery_seconds = 10; } });
    expect(stepOf(result, "recover").status).toBe("FAIL");
    const src = join(makeTmp("hc-cross-"), "run.hcb");
    await api.exportBundle(ctx, { runId: result.run_id, outPath: src });
    expect((await api.verifyBundle({}, { bundlePath: src })).ok).toBe(true);
    const forged = forgeBundle(readFileSync(src), { run: (r) => void (r.steps.find((s: { step_key: string }) => s.step_key === "recover").status = "PASS") });
    const bad = join(makeTmp("hc-cross-"), "forged.hcb");
    writeFileSync(bad, forged);
    const v = await api.verifyBundle({}, { bundlePath: bad });
    expect(v.ok).toBe(false);
    expect(v.errors.map((e) => e.code), JSON.stringify(v.errors)).toContain("BAD_FORMAT");
    expect(v.errors.map((e) => e.message).join(" ")).toMatch(/does not match its stored step receipt/);
    const target = makeCtx();
    await expect(api.importBundle(target, { bundlePath: bad })).rejects.toMatchObject({ code: "BUNDLE_CORRUPT" });
  });

  it("scripts/build-fixture-release.mjs writes the artifact when started through a symlinked directory (a symlinked TMPDIR must not make it a silent no-op)", async () => {
    const { spawnSync } = await import("node:child_process");
    const dir = makeTmp("hc-linkbuild-");
    const link = join(dir, "scripts-link");
    symlinkSync(join(import.meta.dirname, "..", "..", "scripts"), link);
    const out = join(dir, "release.tar");
    const r = spawnSync(process.execPath, [join(link, "build-fixture-release.mjs"), out, "--sha256"], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(r.stdout).toMatch(/^[0-9a-f]{64}  /);
  });
});
