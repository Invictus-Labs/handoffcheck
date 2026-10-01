/**
 * HandoffCheck library API (FROZEN contract). The CLI (src/cli.ts, src/cli/**) calls only this module and
 * the types re-exported from it; it never imports src/store/** or src/runner/** internals.
 *
 * Conventions
 *  - Every function takes an explicit `ApiContext`; nothing reads process-global state except the env passed in.
 *  - Failures that are *results* (rejected preflight, failed step, unconfirmed cleanup, blocked provider) are
 *    returned as data with `exit_code` 1. Failures that are *harness/usage errors* (bad input, oversize, schema
 *    invalid, unknown run id, corrupt bundle) throw `HandoffCheckError` -> exit 2, rendered with `toErrorBody`.
 *  - All strings in returned data are already redacted. Renderers must still HTML-escape.
 */

import type {
  Clock,
  IdGenerator,
  InputPaths,
  Limits,
  OperatorDecl,
  ProviderRegistry,
  BundleInfo,
  BundleVerification,
  CleanupReceipt,
  DrillRecord,
  ImportResult,
  InterventionRecord,
  PreflightReport,
  ReportData,
  ReuseDecision,
  RunEvent,
  RunResult,
  Binding
} from "./domain/types.js";
import * as impl from "./domain/service.js";

export type {
  Binding,
  BundleInfo,
  BundleVerification,
  CleanupReceipt,
  DrillRecord,
  ImportResult,
  InterventionRecord,
  PreflightReport,
  ReportData,
  ReuseDecision,
  RunEvent,
  RunResult,
  Clock,
  IdGenerator,
  InputPaths,
  Limits,
  OperatorDecl,
  ProviderRegistry
};
export * from "./domain/types.js";
export { HandoffCheckError, toErrorBody, exitCodeForError, requireConnector } from "./domain/errors.js";
export { canonicalJson, sha256Hex } from "./domain/canonical.js";
export { fixedClock, systemClock, sequentialIds, randomIds } from "./domain/runtime.js";

export interface ApiContext {
  /** Evidence/store directory (`--output`). Created with owner-only permissions. */
  storeDir: string;
  clock?: Clock;
  ids?: IdGenerator;
  /** Override or extend runner providers (tests inject fakes; `lima` and `local-sandbox` are built in). */
  providers?: ProviderRegistry;
  /** Environment used for provider discovery (HANDOFFCHECK_LIMACTL, HANDOFFCHECK_TEST_FAULT). Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** Explicit limit overrides (e.g. `--allow-large`). Defaults are the PRD limits. */
  limits?: Partial<Limits>;
  /** Progress hook for CLI output. Must not throw. */
  onEvent?: (event: RunEvent) => void;
  /** Request id echoed in error bodies. Default: generated. */
  requestId?: string;
}

export interface RunInput extends InputPaths {
  /** Overrides manifest.operator fields (CLI flags). */
  operator?: Partial<OperatorDecl>;
  /** Abort (SIGINT/SIGTERM): kills the sandbox, outcome ABORTED, cleanup still runs and is verified. */
  signal?: AbortSignal;
  /**
   * local-sandbox (isolation none) executes the manifest scripts directly on this host. Default false: such a run is
   * refused at preflight (RunResult with preflight REJECTED, finding HOST_SANDBOX_NOT_ALLOWED, verdict FAIL, exit 1;
   * not an exception). The CLI passes true only for `run --allow-host-sandbox`; `demo()` is built in and exempt.
   * When allowed, RunResult.warnings carries a message the caller must print to stderr.
   */
  allowHostSandbox?: boolean;
}

/** Validate inputs, compute the binding, run preflight, create the run in CREATED and return without executing. */
export function createDrill(ctx: ApiContext, input: RunInput): Promise<{ run_id: string; binding: Binding; preflight: PreflightReport }> {
  return impl.createDrill(ctx, input);
}

/** Preflight only: no store writes, no workload execution. `status: "REJECTED"` is data, not an exception. */
export function preflight(ctx: Omit<ApiContext, "storeDir"> & { storeDir?: string }, input: InputPaths & { allowHostSandbox?: boolean }): Promise<PreflightReport> {
  return impl.preflight(ctx, input);
}

/** Full drill: preflight -> provision -> steps -> cleanup + verification. Always attempts cleanup. */
export function run(ctx: ApiContext, input: RunInput): Promise<RunResult> {
  return impl.run(ctx, input);
}

/** Append a builder/operator intervention. Any intervention makes the verdict ASSISTED, even after the run ended. */
export function recordIntervention(
  ctx: ApiContext,
  input: { runId: string; reason: string; actorRef: string; stepKey?: string }
): Promise<InterventionRecord> {
  return impl.recordIntervention(ctx, input);
}

/** Report data for JSON output and the HTML renderer. Optionally checks the current inputs against the binding. */
export function getReport(ctx: ApiContext, input: { runId: string; currentInputs?: InputPaths }): Promise<ReportData> {
  return impl.getReport(ctx, input);
}

/** Decide whether a prior accepted result may be reused for these inputs (modified inputs invalidate it). */
export function checkReuse(ctx: ApiContext, input: InputPaths): Promise<ReuseDecision> {
  return impl.checkReuse(ctx, input);
}

/** Retry/verify cleanup for an existing run (appends a new cleanup receipt; can move UNCONFIRMED -> VERIFIED). */
export function cleanup(ctx: ApiContext, input: { runId: string }): Promise<{ run_id: string; state: DrillRecord["state"]; receipt: CleanupReceipt; exit_code: 0 | 1 }> {
  return impl.cleanup(ctx, input);
}

/** Export a versioned evidence bundle (single file). Overwrites nothing: fails with CONFLICT if outPath exists. */
export function exportBundle(ctx: ApiContext, input: { runId: string; outPath: string }): Promise<BundleInfo> {
  return impl.exportBundle(ctx, input);
}

/** Read-only verification of a bundle. Never throws for corruption: returns { ok:false, errors }. */
export function verifyBundle(ctx: Pick<ApiContext, "limits" | "clock" | "env">, input: { bundlePath: string }): Promise<BundleVerification> {
  return impl.verifyBundle(ctx, input);
}

/** Atomic all-or-nothing import. Throws BUNDLE_CORRUPT/UNSUPPORTED_VERSION/CONFLICT; on failure no state is added. */
export function importBundle(ctx: ApiContext, input: { bundlePath: string }): Promise<ImportResult> {
  return impl.importBundle(ctx, input);
}

/** Offline synthetic drill end to end with local-sandbox (isolation none, labelled). No network, no accounts. */
export function demo(ctx: ApiContext, input?: { signal?: AbortSignal }): Promise<RunResult> {
  return impl.demo(ctx, input);
}

/**
 * Retention purge, the only path that deletes history. Without options it deletes runs whose retain_until has passed
 * (default retention 90 days from creation, set per manifest by retention_days). With `olderThanDays` (integer >= 0) it
 * deletes runs created more than that many days ago instead. `dryRun` deletes nothing and returns what would be purged.
 * Orphaned evidence blobs are removed in the same call, so primary deletion completes when it is invoked.
 */
export function purgeExpired(ctx: ApiContext, input?: { olderThanDays?: number; dryRun?: boolean }): Promise<{ purged: string[]; dry_run: boolean }> {
  return impl.purgeExpired(ctx, input);
}

/** Resolve a run from the store: lists with cursor pagination (max 100 per page). */
export function listRuns(ctx: ApiContext, input?: { limit?: number; cursor?: string }): Promise<{ runs: DrillRecord[]; next_cursor: string | null }> {
  return impl.listRuns(ctx, input);
}
