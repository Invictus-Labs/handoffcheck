// Engine behavior under an injected (fake) runner provider: failures the real local sandbox cannot be made to produce
// on demand (provisioning errors, audit and destroy failures, harness errors, aborts between steps, retry without a provider).
// Every failure must end red (exit 1) and keep the cleanup state honest.
import { describe, expect, it } from "vitest";
import * as api from "../../src/api.js";
import { ProvisionError } from "../../src/domain/provision.js";
import { makeCtx, prepareDrill } from "../helpers/drill.js";
import { expectRed, stepOf } from "../helpers/run.js";
import { registerTmpCleanup } from "../helpers/tmp.js";

registerTmpCleanup();

type Behavior = {
  provisionError?: Error | (() => Promise<never>);
  probe?: { available: boolean; reason?: string };
  exec?: (req: api.ExecRequest, call: number) => Promise<Partial<api.ExecResult>> | Partial<api.ExecResult>;
  destroyError?: Error;
  auditError?: Error;
  auditState?: api.ResourceState;
  resources?: api.ResourceRecord[];
  resourcesThrow?: boolean;
};

function fakeProvider(b: Behavior = {}): api.RunnerProvider {
  let calls = 0;
  const resources = b.resources ?? [{ kind: "directory", id: "fake-dir", locator: "fake://dir", state: "unknown" }];
  return {
    name: "local-sandbox",
    isolation: "none",
    async probe() {
      return b.probe ?? { available: true, version: "fake" };
    },
    async provision() {
      if (typeof b.provisionError === "function") await b.provisionError();
      if (b.provisionError instanceof Error) throw b.provisionError;
      return {
        id: "fake-sandbox",
        provider: "local-sandbox",
        isolation: "none",
        async exec(req) {
          calls += 1;
          const r = (await b.exec?.(req, calls)) ?? {};
          return { label: req.label, exit_code: 0, signal: null, timed_out: false, aborted: false, duration_ms: 1, stdout: new Uint8Array(), stderr: new Uint8Array(), truncated: false, ...r };
        },
        async readFile() {
          return null;
        },
        resources: () => {
          if (b.resourcesThrow) throw new Error("inventory unavailable");
          return resources;
        },
        async destroy() {
          if (b.destroyError) throw b.destroyError;
        }
      };
    },
    async audit(rs) {
      if (b.auditError) throw b.auditError;
      return rs.map((r) => ({ ...r, state: b.auditState ?? "removed" }));
    },
    async destroyResources() {
      /* nothing to do */
    }
  };
}

/** The manifest must keep all four mandatory PRD actions (a one-step drill is rejected by validation); the fake never runs the scripts. */
const installOnly = { manifest: (_m: Record<string, any>) => undefined }; // eslint-disable-line @typescript-eslint/no-explicit-any

async function runWith(b: Behavior, over: { signal?: AbortSignal; wall?: number } = {}) {
  const inputs = prepareDrill({ manifest: (m) => { installOnly.manifest(m); if (over.wall) m.runner.wall_seconds = over.wall; } });
  const ctx = makeCtx({ providers: { "local-sandbox": fakeProvider(b) } });
  const result = await api.run(ctx, { ...inputs.paths, ...(over.signal ? { signal: over.signal } : {}) });
  return { ctx, result, inputs };
}

describe("a clean fake run", () => {
  it("passes install with the fake provider (the harness itself is sound)", async () => {
    const { result } = await runWith({});
    expect(stepOf(result, "install").status).toBe("PASS");
    expect(result.cleanup.status).toBe("VERIFIED");
    // the fake cannot serve the restore file checks, so the drill is honestly red rather than accepted by exit codes alone
    expect(stepOf(result, "restore")).toMatchObject({ status: "FAIL", reason_code: "RESTORE_MEASURE_MISSING" });
    expect(result.steps.filter((s) => s.status === "SKIPPED").map((s) => s.step_key)).toEqual(["rotate", "recover"]);
    expect(result.verdict.verdict).toBe("FAIL");
    expect(result.exit_code).toBe(1);
  });
});

describe("provisioning and provider failures", () => {
  it("negative control: provisioning that throws ends FAILED (PROVIDER_UNAVAILABLE) with every step skipped and an honest empty cleanup", async () => {
    const { result } = await runWith({ provisionError: new Error("disk full") });
    expectRed(result);
    expect(result.outcome).toBe("FAILED");
    expect(result.steps.every((s) => s.status === "SKIPPED")).toBe(true);
    expect(result.cleanup.resources).toBe(0);
  });

  it("negative control: a provisioning error that reports leftovers is CLEANUP_UNCONFIRMED when the audit finds them", async () => {
    const left: api.ResourceRecord[] = [{ kind: "directory", id: "half-built", locator: "fake://half", state: "unknown" }];
    const { result } = await runWith({ provisionError: new ProvisionError("copy failed", left), auditState: "leaked" });
    expectRed(result);
    expect(result.cleanup.status).toBe("UNCONFIRMED");
    expect(result.cleanup.leaked).toBe(1);
  });

  it("negative control: an abort that arrives during provisioning ends ABORTED, not FAILED", async () => {
    const controller = new AbortController();
    const { result } = await runWith({ provisionError: async () => { controller.abort(); throw new Error("interrupted"); } }, { signal: controller.signal });
    expectRed(result);
    expect(result.outcome).toBe("ABORTED");
    expect(result.verdict.reasons.map((r) => r.code)).toContain("RUN_ABORTED");
  });

  it("negative control: a provider that is unavailable is BLOCKED; an unregistered provider name is BLOCKED too", async () => {
    const { result } = await runWith({ probe: { available: false, reason: "fake provider offline" } });
    expectRed(result);
    expect(result.verdict.verdict).toBe("BLOCKED");
    const inputs = prepareDrill({ manifest: (m) => { installOnly.manifest(m); m.runner.provider = "lima"; } });
    const ctx = makeCtx({ env: { PATH: "/nonexistent" } });
    expect((await api.run(ctx, inputs.paths)).verdict.verdict).toBe("BLOCKED");
  });
});

describe("cleanup honesty", () => {
  it("negative control: an audit that throws leaves every resource unknown, so cleanup is CLEANUP_UNCONFIRMED", async () => {
    const { result, ctx } = await runWith({ auditError: new Error("audit tool crashed") });
    expectRed(result);
    expect(result.cleanup.status).toBe("UNCONFIRMED");
    const report = await api.getReport(ctx, { runId: result.run_id });
    expect(report.cleanup.note ?? "").toMatch(/audit failed/);
    expect(report.cleanup.resources.every((r) => r.state === "unknown")).toBe(true);
  });

  it("negative control: a destroy that throws is recorded, and the verdict still depends on the independent audit", async () => {
    const leaked = await runWith({ destroyError: new Error("kill failed"), auditState: "leaked" });
    expectRed(leaked.result);
    expect((await api.getReport(leaked.ctx, { runId: leaked.result.run_id })).cleanup.note ?? "").toMatch(/destroy error/);
    const removed = await runWith({ destroyError: new Error("kill failed"), auditState: "removed" });
    expect(removed.result.cleanup.status).toBe("VERIFIED"); // the audit, not destroy(), is the authority
  });

  it("negative control: a cleanup retry stays CLEANUP_UNCONFIRMED while the audit still finds the leak, and verifies once it is gone", async () => {
    const { result, ctx } = await runWith({ auditState: "leaked" });
    expect(result.cleanup.status).toBe("UNCONFIRMED");
    const stillFaulty = await api.cleanup(makeCtx({ storeDir: ctx.storeDir, ids: api.sequentialIds(0x71), providers: { "local-sandbox": fakeProvider({ auditState: "leaked" }) } }), { runId: result.run_id });
    expect(stillFaulty.receipt.status).toBe("UNCONFIRMED");
    expect(stillFaulty.exit_code).toBe(1);
    const healed = await api.cleanup(makeCtx({ storeDir: ctx.storeDir, ids: api.sequentialIds(0x72), providers: { "local-sandbox": fakeProvider({ auditState: "removed" }) } }), { runId: result.run_id });
    expect(healed.receipt.status).toBe("VERIFIED");
    expect(healed.state).toBe("CLEANUP_VERIFIED");
    const again = await api.cleanup(makeCtx({ storeDir: ctx.storeDir, ids: api.sequentialIds(0x73), providers: { "local-sandbox": fakeProvider({}) } }), { runId: result.run_id });
    expect(again.exit_code).toBe(0); // a verified cleanup is final and returned as is
  });
});

describe("harness errors and aborts between steps", () => {
  it("negative control: an exec that throws is a HARNESS_ERROR step, the run is red and cleanup is still verified", async () => {
    const { result } = await runWith({ exec: () => { throw new Error("boom in the provider"); } });
    expectRed(result);
    expect(stepOf(result, "install").status).toBe("ERROR");
    expect(stepOf(result, "install").reason_code).toBe("HARNESS_ERROR");
    expect(result.cleanup.status).toBe("VERIFIED");
  });

  it("negative control: an abort between steps stops the run as ABORTED with the remaining steps skipped", async () => {
    const controller = new AbortController();
    const inputs = prepareDrill(); // all four steps
    const ctx = makeCtx({ providers: { "local-sandbox": fakeProvider({ exec: (req) => { if (req.label.startsWith("install:probe")) controller.abort(); return {}; } }) } });
    const result = await api.run(ctx, { ...inputs.paths, signal: controller.signal });
    expectRed(result);
    expect(result.outcome).toBe("ABORTED");
    expect(result.steps.filter((s) => s.status === "SKIPPED").length).toBeGreaterThanOrEqual(1);
  });

  it("negative control: the wall-clock limit expiring between steps ends ABORTED (RUN_TIMEOUT)", async () => {
    const inputs = prepareDrill({ manifest: (m) => void (m.runner.wall_seconds = 1) });
    const ctx = makeCtx({ providers: { "local-sandbox": fakeProvider({ exec: async (req) => { if (req.label.startsWith("install:probe")) await new Promise((r) => setTimeout(r, 1300)); return {}; } }) } });
    const result = await api.run(ctx, inputs.paths);
    expectRed(result);
    expect(result.outcome).toBe("ABORTED");
    expect(result.verdict.reasons.map((r) => r.code)).toContain("RUN_TIMEOUT");
  }, 30_000);

  it("a script that exits with a signal (no exit code) is a failure, never a pass", async () => {
    const { result } = await runWith({ exec: () => ({ exit_code: null, signal: "SIGKILL" }) });
    expectRed(result);
    expect(stepOf(result, "install").status).toBe("FAIL");
  });
});

describe("harness failures outside a step", () => {
  it("negative control: a provider whose inventory throws is a harness failure (exit 2), the run is recorded FAILED/HARNESS_ERROR and no result is accepted", async () => {
    const inputs = prepareDrill({});
    const ctx = makeCtx({ providers: { "local-sandbox": fakeProvider({ resourcesThrow: true }) } });
    await expect(api.run(ctx, inputs.paths)).rejects.toMatchObject({ code: "INTERNAL" });
    const runs = (await api.listRuns(ctx)).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: "FAILED", outcome_reason: "HARNESS_ERROR" });
    const report = await api.getReport(ctx, { runId: runs[0]!.id });
    expect(report.verdict.exit_code).toBe(1);
    expect(report.verdict.verdict).not.toBe("INDEPENDENT_PASS");
    expect(report.steps.every((s) => s.status === "SKIPPED")).toBe(true);
  });
});
