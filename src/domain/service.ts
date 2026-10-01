import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiContext, RunInput } from "../api.js";
import { exportRunBundle, importBundleFile, verifyBundleFile } from "../evidence/bundle.js";
import { defaultProviders } from "../runner/index.js";
import { buildDemoInputs } from "../runner/demo.js";
import { runPreflight } from "../security/preflight.js";
import { Redactor } from "../security/redact.js";
import { Store } from "../store/store.js";
import { executeDrill, createRun, reapOrphans, retryCleanup } from "./engine.js";
import type { EngineContext } from "./engine.js";
import { HandoffCheckError } from "./errors.js";
import { loadInputs } from "./inputs.js";
import { packageVersion } from "./pkg.js";
import { buildReport, deriveVerdict } from "./report.js";
import { randomIds, systemClock } from "./runtime.js";
import { DEFAULT_LIMITS, SCHEMA_VERSION } from "./types.js";
import type {
  Binding,
  BindingCheck,
  BundleInfo,
  BundleVerification,
  CleanupReceipt,
  Clock,
  DrillRecord,
  IdGenerator,
  ImportResult,
  InputPaths,
  InterventionRecord,
  Limits,
  PreflightReport,
  ProviderRegistry,
  RunnerProvider,
  CleanupStatus,
  ReportData,
  ReuseDecision,
  RunEvent,
  RunResult
} from "./types.js";

type PartialCtx = Omit<ApiContext, "storeDir"> & { storeDir?: string };

interface Resolved {
  clock: Clock;
  ids: IdGenerator;
  env: NodeJS.ProcessEnv;
  limits: Limits;
  providers: ProviderRegistry;
  faultInjected: boolean;
  emit: (e: RunEvent) => void;
}

function resolve(ctx: PartialCtx): Resolved {
  const env = ctx.env ?? process.env;
  const defaults = defaultProviders(env);
  const overridden = ctx.providers?.["local-sandbox"] !== undefined;
  return {
    clock: ctx.clock ?? systemClock(),
    ids: ctx.ids ?? randomIds(),
    env,
    limits: { ...DEFAULT_LIMITS, ...(ctx.limits ?? {}) },
    providers: { ...defaults.providers, ...(ctx.providers ?? {}) },
    faultInjected: defaults.faultInjected && !overridden,
    emit: (e) => {
      try {
        ctx.onEvent?.(e);
      } catch {
        /* progress hooks must never break a run */
      }
    }
  };
}

function withStore<T>(ctx: ApiContext, r: Resolved, fn: (store: Store) => Promise<T> | T): Promise<T> {
  if (!ctx.storeDir) throw new HandoffCheckError("BAD_REQUEST", "storeDir is required");
  const store = Store.open(ctx.storeDir, { nowIso: () => r.clock.nowIso(), newId: () => r.ids.uuid() });
  return Promise.resolve()
    .then(() => fn(store))
    .finally(() => store.close());
}

function engine(store: Store, r: Resolved): EngineContext {
  return { store, clock: r.clock, ids: r.ids, providers: r.providers, faultInjected: r.faultInjected, limits: r.limits, emit: r.emit };
}

function isolationFor(r: Resolved, name: string): "vm" | "none" {
  return (r.providers[name] as RunnerProvider).isolation; // manifest providers are always registered
}

// a finished run always has a cleanup receipt, so the status is never "MISSING" here
function toRunResult(report: ReportData, binding: Binding): RunResult {
  const leaked = report.cleanup.resources.filter((x) => x.state !== "removed").length;
  return {
    run_id: report.run.id,
    state: report.run.state,
    outcome: report.run.outcome,
    verdict: report.verdict,
    binding,
    provider: report.run.provider,
    isolation: report.run.isolation,
    preflight: report.preflight,
    steps: report.steps.map((s) => ({ step_key: s.step_key, action: s.action, status: s.status, reason_code: s.reason_code })),
    cleanup: { status: report.cleanup.status as CleanupStatus, resources: report.cleanup.resources.length, leaked },
    exit_code: report.verdict.exit_code
  };
}

/* ------------------------------------------------------------------ API */

export async function createDrill(ctx: ApiContext, input: RunInput): Promise<{ run_id: string; binding: Binding; preflight: PreflightReport }> {
  const r = resolve(ctx);
  const loaded = loadInputs(input, r.limits);
  const name = loaded.manifest.runner.provider;
  const isolation = isolationFor(r, name);
  const preflight = runPreflight(loaded, { name, isolation, ...(input.allowHostSandbox ? { allowHostSandbox: true } : {}) });
  return withStore(ctx, r, (store) => {
    const { drill } = createRun(engine(store, r), loaded, input.operator, { name, isolation });
    return { run_id: drill.id, binding: loaded.binding, preflight };
  });
}

export async function preflight(ctx: PartialCtx, input: InputPaths & { allowHostSandbox?: boolean }): Promise<PreflightReport> {
  const r = resolve(ctx);
  const loaded = loadInputs(input, r.limits);
  const name = loaded.manifest.runner.provider;
  return runPreflight(loaded, { name, isolation: isolationFor(r, name), ...(input.allowHostSandbox ? { allowHostSandbox: true } : {}) });
}

const HOST_SANDBOX_WARNING =
  "WARNING: local-sandbox runs the manifest scripts directly on this host (isolation none, no VM, no network or filesystem confinement). Only run scripts you wrote and trust.";

export async function run(ctx: ApiContext, input: RunInput): Promise<RunResult> {
  return runInternal(ctx, input, false);
}

/** `builtin` marks the shipped demo scenario, which is exempt from the host-sandbox opt-in and its warning. */
async function runInternal(ctx: ApiContext, input: RunInput, builtin: boolean): Promise<RunResult> {
  const r = resolve(ctx);
  const loaded = loadInputs(input, r.limits);
  const allowHost = builtin || input.allowHostSandbox === true;
  return withStore(ctx, r, async (store) => {
    await reapOrphans(engine(store, r)); // close out runs whose harness was killed (owner gone) before starting a new one
    const id = await executeDrill(engine(store, r), {
      loaded,
      allowHostSandbox: allowHost,
      ...(input.operator ? { operator: input.operator } : {}),
      ...(input.signal ? { signal: input.signal } : {})
    });
    const result = toRunResult(buildReport(store, r.clock, id, "MATCH"), loaded.binding);
    const hostRun = result.isolation === "none" && result.preflight?.status === "PASS";
    return !builtin && hostRun ? { ...result, warnings: [HOST_SANDBOX_WARNING] } : result;
  });
}

export async function recordIntervention(
  ctx: ApiContext,
  input: { runId: string; reason: string; actorRef: string; stepKey?: string }
): Promise<InterventionRecord> {
  const r = resolve(ctx);
  const reason = input.reason.trim();
  const actor = input.actorRef.trim();
  if (reason.length === 0 || reason.length > 2000) throw new HandoffCheckError("BAD_REQUEST", "reason must be 1-2000 characters");
  if (actor.length === 0 || actor.length > 128) throw new HandoffCheckError("BAD_REQUEST", "actor must be 1-128 characters");
  if (input.stepKey !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.stepKey)) throw new HandoffCheckError("BAD_REQUEST", "stepKey is not a valid step id");
  return withStore(ctx, r, (store) => {
    store.requireDrill(input.runId);
    const redactor = new Redactor(store.runSecrets(input.runId));
    const base = {
      id: r.ids.uuid(),
      drill_id: input.runId,
      actor_ref: redactor.redact(actor).text,
      reason: redactor.redact(reason).text,
      occurred_at: r.clock.nowIso(),
      step_key: input.stepKey ?? null
    };
    const rec: InterventionRecord = { schema_version: SCHEMA_VERSION, ...base, signature: store.sign(base), attestation: "local-identity-unsigned-by-third-party" };
    store.insertIntervention(rec);
    r.emit({ type: "intervention", run_id: input.runId, id: rec.id, at: rec.occurred_at });
    return rec;
  });
}

export async function getReport(ctx: ApiContext, input: { runId: string; currentInputs?: InputPaths }): Promise<ReportData> {
  const r = resolve(ctx);
  let check: BindingCheck = "NOT_CHECKED";
  let current: string | null = null;
  if (input.currentInputs) current = loadInputs(input.currentInputs, r.limits).binding.binding_digest;
  return withStore(ctx, r, (store) => {
    if (current !== null) check = store.requireDrill(input.runId).binding_digest === current ? "MATCH" : "MISMATCH";
    return buildReport(store, r.clock, input.runId, check);
  });
}

export async function checkReuse(ctx: ApiContext, input: InputPaths): Promise<ReuseDecision> {
  const r = resolve(ctx);
  const loaded = loadInputs(input, r.limits);
  return withStore(ctx, r, (store) => {
    const prior = store.drillsForScenario(loaded.manifest.scenario.id);
    const invalidated = prior.filter((d) => d.binding_digest !== loaded.binding.binding_digest).map((d) => d.id);
    const same = prior.filter((d) => d.binding_digest === loaded.binding.binding_digest);
    for (const d of same) {
      const v = deriveVerdict(store, d, "MATCH");
      // reuse only for an independent, VM-isolated, human-attested pass: rehearsals and assisted runs are never reusable
      if (v.verdict === "INDEPENDENT_PASS") {
        return { reusable: true, binding: loaded.binding, run_id: d.id, reason: "REUSABLE", verdict: v.verdict, invalidated_run_ids: invalidated } satisfies ReuseDecision;
      }
    }
    const first = same[0];
    if (first) {
      return { reusable: false, binding: loaded.binding, run_id: first.id, reason: "PRIOR_NOT_ACCEPTED", verdict: deriveVerdict(store, first, "MATCH").verdict, invalidated_run_ids: invalidated } satisfies ReuseDecision;
    }
    return { reusable: false, binding: loaded.binding, reason: invalidated.length > 0 ? "BINDING_CHANGED" : "NO_PRIOR_RUN", invalidated_run_ids: invalidated } satisfies ReuseDecision;
  });
}

export async function cleanup(
  ctx: ApiContext,
  input: { runId: string }
): Promise<{ run_id: string; state: DrillRecord["state"]; receipt: CleanupReceipt; exit_code: 0 | 1 }> {
  const r = resolve(ctx);
  return withStore(ctx, r, async (store) => {
    const receipt = await retryCleanup(engine(store, r), input.runId);
    const d = store.requireDrill(input.runId);
    return { run_id: d.id, state: d.state, receipt: { ...receipt, resources: receipt.resources.map((x) => ({ ...x, locator: "" })) }, exit_code: receipt.status === "VERIFIED" ? 0 : 1 };
  });
}

export async function exportBundle(ctx: ApiContext, input: { runId: string; outPath: string }): Promise<BundleInfo> {
  const r = resolve(ctx);
  return withStore(ctx, r, (store) => {
    const d = store.requireDrill(input.runId);
    return exportRunBundle({ store, clock: r.clock, producerVersion: packageVersion(), runId: d.id, outPath: input.outPath, verdict: deriveVerdict(store, d, "NOT_CHECKED"), limits: r.limits });
  });
}

export async function verifyBundle(ctx: Pick<ApiContext, "limits" | "clock" | "env">, input: { bundlePath: string }): Promise<BundleVerification> {
  const r = resolve(ctx);
  return { ...verifyBundleFile(input.bundlePath, r.limits), note: "integrity only, provenance not verified" };
}

export async function importBundle(ctx: ApiContext, input: { bundlePath: string }): Promise<ImportResult> {
  const r = resolve(ctx);
  return withStore(ctx, r, (store) => importBundleFile(store, input.bundlePath, r.limits, () => r.clock.nowIso()));
}

export async function demo(ctx: ApiContext, input?: { signal?: AbortSignal }): Promise<RunResult> {
  const work = mkdtempSync(join(tmpdir(), "hc-demo-"));
  try {
    const paths = buildDemoInputs(work);
    return await runInternal(ctx, { ...paths, ...(input?.signal ? { signal: input.signal } : {}) }, true);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function purgeExpired(ctx: ApiContext, input?: { olderThanDays?: number; dryRun?: boolean }): Promise<{ purged: string[]; dry_run: boolean }> {
  const r = resolve(ctx);
  const days = input?.olderThanDays;
  if (days !== undefined && (!Number.isInteger(days) || days < 0)) throw new HandoffCheckError("BAD_REQUEST", "olderThanDays must be an integer >= 0");
  const dry = input?.dryRun === true;
  return withStore(ctx, r, (store) => {
    const now = r.clock.nowIso();
    const ids = days === undefined ? store.expiredDrillIds(now) : store.drillIdsCreatedBefore(new Date(Date.parse(now) - days * 86_400_000).toISOString());
    if (dry) return { purged: ids, dry_run: true };
    const orphans = store.purgeDrills(ids);
    for (const sha of orphans) store.objects.remove(sha);
    return { purged: ids, dry_run: false };
  });
}

export async function listRuns(ctx: ApiContext, input?: { limit?: number; cursor?: string }): Promise<{ runs: DrillRecord[]; next_cursor: string | null }> {
  const r = resolve(ctx);
  const limit = Math.min(100, Math.max(1, Math.floor(input?.limit ?? 50)));
  let after: { created_at: string; id: string } | undefined;
  if (input?.cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as { created_at?: unknown; id?: unknown };
      if (typeof parsed.created_at !== "string" || typeof parsed.id !== "string") throw new Error("bad cursor");
      after = { created_at: parsed.created_at, id: parsed.id };
    } catch {
      throw new HandoffCheckError("BAD_REQUEST", "cursor is not valid");
    }
  }
  return withStore(ctx, r, (store) => {
    const rows = store.listDrills(limit + 1, after);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const next = rows.length > limit && last ? Buffer.from(JSON.stringify({ created_at: last.created_at, id: last.id })).toString("base64url") : null;
    return { runs: page, next_cursor: next };
  });
}
