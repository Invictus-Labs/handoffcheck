/**
 * HandoffCheck domain contract (FROZEN). Changes after the freeze go through the coordinator.
 * Every serialized document carries `schema_version`; the JSON Schemas in `schemas/` are the
 * authority and are executed at runtime by `src/domain/schema.ts`. Keep this file in sync.
 */

export const SCHEMA_VERSION = 1 as const;
export const BUNDLE_FORMAT = "handoffcheck-evidence-bundle" as const;
export const BUNDLE_FORMAT_VERSION = 1 as const;
export const ENVELOPE_SCHEMA_VERSION = 1 as const;

/* ------------------------------------------------------------------ enums */

export const RUN_STATES = [
  "CREATED",
  "PREFLIGHT",
  "RUNNING",
  "COMPLETE",
  "FAILED",
  "ABORTED",
  "CLEANUP_VERIFIED",
  "CLEANUP_UNCONFIRMED"
] as const;
export type RunState = (typeof RUN_STATES)[number];

/** The terminal execution outcome that precedes cleanup. Preserved after state moves to CLEANUP_*. */
export const RUN_OUTCOMES = ["COMPLETE", "FAILED", "ABORTED"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export const STEP_ACTIONS = ["install", "restore", "rotate", "recover"] as const;
export type StepAction = (typeof STEP_ACTIONS)[number];

/** SKIPPED = never executed (earlier mandatory failure, abort, preflight rejection, blocked provider). */
export const STEP_STATUSES = ["PASS", "FAIL", "TIMEOUT", "ERROR", "SKIPPED"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const OPERATOR_KINDS = ["human", "ai_assisted", "automated"] as const;
export type OperatorKind = (typeof OPERATOR_KINDS)[number];

export const VERDICTS = ["INDEPENDENT_PASS", "ASSISTED", "REHEARSAL", "FAIL", "UNKNOWN", "BLOCKED"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const ISOLATIONS = ["vm", "none"] as const;
export type Isolation = (typeof ISOLATIONS)[number];

export const CLEANUP_STATUSES = ["VERIFIED", "UNCONFIRMED"] as const;
export type CleanupStatus = (typeof CLEANUP_STATUSES)[number];

export const RESOURCE_STATES = ["removed", "leaked", "unknown"] as const;
export type ResourceState = (typeof RESOURCE_STATES)[number];

export const EVIDENCE_KINDS = [
  "manifest",
  "preflight_report",
  "step_receipt",
  "step_log",
  "cleanup_receipt",
  "run_receipt"
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export type ProviderName = "local-sandbox" | "lima";

/** Stable machine reason codes carried in verdicts, step receipts and preflight findings. */
export const REASON_CODES = [
  "OK",
  "PREFLIGHT_REJECTED",
  "PROVIDER_UNAVAILABLE",
  "ISOLATION_NONE",
  "OPERATOR_NOT_HUMAN",
  "OPERATOR_IS_BUILDER",
  "OPERATOR_INDEPENDENCE_UNPROVEN",
  "IMPORT_UNAUTHENTICATED",
  "INTERVENTION_RECORDED",
  "MANDATORY_STEP_FAILED",
  "MANDATORY_STEP_TIMEOUT",
  "MANDATORY_STEP_ERROR",
  "MANDATORY_STEP_NOT_RUN",
  "RUN_ABORTED",
  "RUN_TIMEOUT",
  "CLEANUP_UNCONFIRMED",
  "CLEANUP_MISSING",
  "RUN_NOT_FINISHED",
  "STALE_BINDING",
  "EVIDENCE_UNVERIFIABLE",
  "NO_MANDATORY_STEPS",
  "OPTIONAL_STEP_FAILED",
  "REQUIRED_ACTION_NOT_PASSED",
  "SCRIPT_FAILED",
  "SCRIPT_TIMEOUT",
  "HEALTH_PROBE_FAILED",
  "RESTORE_MEASURE_MISSING",
  "RESTORE_COUNT_MISMATCH",
  "RESTORE_HASH_MISMATCH",
  "RESTORE_BLOB_MISMATCH",
  "ROTATION_OLD_ACCEPTED",
  "ROTATION_NEW_REJECTED",
  "ROTATION_NOT_ROTATED",
  "ROTATION_PROBE_ERROR",
  "RECOVERY_FAULT_NOT_OBSERVED",
  "RECOVERY_NOT_RESTORED",
  "RECOVERY_TOO_SLOW",
  "HARNESS_ERROR"
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/* --------------------------------------------------------------- manifest */

export interface ScriptRef {
  /** Path relative to the manifest directory. Must not escape it; symlinks are rejected. */
  path: string;
  interpreter?: "sh" | "bash" | "node";
  args?: string[];
  /** Optional pin; mismatch is a preflight rejection. */
  sha256?: string;
}

export interface StepBase {
  id: string;
  deadline_seconds: number;
  /** Default true. A failed optional step never blocks acceptance but is always reported. */
  mandatory?: boolean;
}

export interface InstallStep extends StepBase {
  action: "install";
  script: ScriptRef;
  /** Polled until exit 0 or the step deadline. */
  probe: ScriptRef;
  probe_interval_ms?: number;
}

export interface RestoreExpect {
  /** Name -> expected record count. At least one entry. */
  record_counts: Record<string, number>;
  /** Name -> expected sha256 of selected data, as reported by the measure script. */
  data_hashes?: Record<string, string>;
  /** Files inside the sandbox workspace hashed independently by the harness. */
  blobs?: { path: string; sha256: string }[];
}

export interface RestoreStep extends StepBase {
  action: "restore";
  script: ScriptRef;
  /** Separate measurement script. Prints JSON {record_counts, data_hashes?} on stdout. */
  measure: ScriptRef;
  expect: RestoreExpect;
}

export interface RotateStep extends StepBase {
  action: "rotate";
  script: ScriptRef;
  /** Sandbox-relative files holding the synthetic credential before (old) and after (new) rotation. */
  credentials: { old_file: string; new_file: string };
  /** Run with HC_CREDENTIAL set. Exit 0 = accepted; an exit code in reject_exit_codes = rejected. */
  probe: ScriptRef;
  reject_exit_codes?: number[];
}

export interface RecoverStep extends StepBase {
  action: "recover";
  /** Seeds the bounded worker failure. */
  seed_fault: ScriptRef;
  /** Exit 0 = healthy. Must fail after seeding and pass after recovery. */
  probe: ScriptRef;
  /** The documented recovery steps, as an explicit script. */
  script: ScriptRef;
  max_recovery_seconds: number;
}

export type ManifestStep = InstallStep | RestoreStep | RotateStep | RecoverStep;

export interface OperatorDecl {
  kind: OperatorKind;
  ref: string;
  /** Who built the release. If equal to ref the drill cannot be independent. */
  builder_ref?: string;
}

export interface DrillManifest {
  schema_version: typeof SCHEMA_VERSION;
  scenario: { id: string; version: string; title?: string; synthetic: boolean };
  operator: OperatorDecl;
  runner: {
    provider: ProviderName;
    wall_seconds: number;
    max_output_bytes?: number;
    resources?: { cpus: number; memory_mb: number; disk_mb: number };
  };
  /** Declared network destinations (host or host:port). Loopback is implicit. */
  network: { allow: string[] };
  env?: Record<string, string>;
  /** Planted fake secret values, redacted verbatim from every stored byte. */
  synthetic_secrets?: string[];
  retention_days?: number;
  steps: ManifestStep[];
}

/* --------------------------------------------------------------- binding */

export interface Binding {
  artifact_digest: string;
  runbook_hash: string;
  scenario_version: string;
  /** sha256 of canonical JSON of the manifest plus every referenced script's sha256. */
  manifest_digest: string;
  /** sha256 of canonical JSON {artifact_digest, runbook_hash, scenario_version, manifest_digest}. */
  binding_digest: string;
}

export interface InputPaths {
  manifestPath: string;
  artifactPath: string;
  runbookPath: string;
}

export type BindingCheck = "MATCH" | "MISMATCH" | "NOT_CHECKED";

export interface ReuseDecision {
  reusable: boolean;
  binding: Binding;
  /** Present only when a prior run has the identical binding digest and an accepting verdict. */
  run_id?: string;
  reason: "REUSABLE" | "NO_PRIOR_RUN" | "BINDING_CHANGED" | "PRIOR_NOT_ACCEPTED";
  /** Verdict of the matching prior run, when one exists (additive field). */
  verdict?: Verdict;
  /** Prior runs for the same scenario whose binding differs: those results are invalidated. */
  invalidated_run_ids: string[];
}

/* ------------------------------------------------------------- persistence */

export interface DrillRecord {
  schema_version: typeof SCHEMA_VERSION;
  id: string;
  workspace_id: string;
  scenario_id: string;
  scenario_version: string;
  artifact_digest: string;
  runbook_hash: string;
  manifest_digest: string;
  binding_digest: string;
  operator_ref: string;
  operator_kind: OperatorKind;
  builder_ref: string | null;
  provider: string;
  isolation: Isolation;
  state: RunState;
  outcome: RunOutcome | null;
  outcome_reason: ReasonCode | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  retain_until: string;
  imported: boolean;
  fault_injected: boolean;
  /** Additive: the real number of manifest steps, fixed at creation (0 only for records written before it existed). */
  planned_steps?: number;
}

export interface StateTransition {
  seq: number;
  from_state: RunState | null;
  to_state: RunState;
  reason: string | null;
  at: string;
}

export interface StepRecord {
  schema_version: typeof SCHEMA_VERSION;
  id: string;
  drill_id: string;
  seq: number;
  step_key: string;
  action: StepAction;
  deadline_seconds: number;
  mandatory: boolean;
  status: StepStatus;
  reason_code: ReasonCode;
  /** sha256 of the stored step receipt evidence document (null only for SKIPPED steps). */
  evidence_hash: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
}

export interface InterventionRecord {
  schema_version: typeof SCHEMA_VERSION;
  id: string;
  drill_id: string;
  actor_ref: string;
  reason: string;
  occurred_at: string;
  /** Step being executed when recorded, if any. */
  step_key: string | null;
  /** HMAC-SHA256 under the local store key: local tamper evidence, not third-party attestation. */
  signature: string;
  attestation: "local-identity-unsigned-by-third-party";
}

export interface EvidenceRecord {
  schema_version: typeof SCHEMA_VERSION;
  id: string;
  drill_id: string;
  step_key: string | null;
  kind: EvidenceKind;
  sha256: string;
  media_type: string;
  size_bytes: number;
  /** True when the stored bytes passed through the redactor. */
  redacted: boolean;
  redaction_count: number;
  created_at: string;
}

export interface ResourceRecord {
  kind: "directory" | "process" | "process-scan" | "vm-instance";
  /** Opaque public label, safe to show. */
  id: string;
  /** Provider-specific handle needed to re-verify or retry cleanup. Omitted from public report views. */
  locator: string;
  state: ResourceState;
  detail?: string;
}

export interface CleanupReceipt {
  schema_version: typeof SCHEMA_VERSION;
  id: string;
  drill_id: string;
  seq: number;
  provider: string;
  isolation: Isolation;
  status: CleanupStatus;
  resources: ResourceRecord[];
  verified_at: string;
  note: string | null;
}

/* --------------------------------------------------------------- preflight */

export type FindingSeverity = "reject" | "warn";

export interface PreflightFinding {
  code:
    | "PRODUCTION_CREDENTIAL"
    | "UNDECLARED_NETWORK_DESTINATION"
    | "SCRIPT_MISSING"
    | "SCRIPT_PATH_UNSAFE"
    | "SCRIPT_HASH_MISMATCH"
    | "NOT_SYNTHETIC"
    | "HOST_SANDBOX_NOT_ALLOWED"
    | "MISSING_RESOURCE_LIMITS"
    | "ARTIFACT_UNSAFE"
    | "ARTIFACT_LIMIT"
    | "ENV_UNSAFE"
    | "MANIFEST_SEMANTICS";
  severity: FindingSeverity;
  /** Where: manifest pointer, script path, or artifact entry name. */
  location: string;
  /** Redacted description. Never contains the matched secret. */
  message: string;
  /** Pattern family, e.g. "aws-access-key". */
  kind?: string;
}

export interface PreflightReport {
  schema_version: typeof SCHEMA_VERSION;
  status: "PASS" | "REJECTED";
  provider: string;
  isolation: Isolation;
  findings: PreflightFinding[];
  checked: { manifest: boolean; scripts: number; artifact_entries: number; runbook: boolean };
}

/* ----------------------------------------------------------------- verdict */

export interface VerdictReason {
  code: ReasonCode;
  message: string;
}

export interface VerdictResult {
  verdict: Verdict;
  /** True only for INDEPENDENT_PASS and REHEARSAL (all mandatory steps and cleanup PASS). */
  steps_and_cleanup_pass: boolean;
  /** True only for INDEPENDENT_PASS: the independent-operability criterion (AC-08) is evidenced by the harness. */
  independent: boolean;
  /** 0 | 1 (2 is reserved for thrown harness errors). */
  exit_code: 0 | 1;
  reasons: VerdictReason[];
  /** AC-08 is always a human receipt: agents record PENDING_HUMAN_RECEIPT, never PASS. */
  human_receipt: "PENDING_HUMAN_RECEIPT" | "HARNESS_RECORDED";
  binding_check: BindingCheck;
}

export interface AcceptanceInput {
  state: RunState;
  outcome: RunOutcome | null;
  /** Additive: the run was imported from a bundle. Bundles prove integrity, not provenance: the verdict is UNKNOWN. */
  imported?: boolean;
  /** Additive: false when any stored evidence object is missing or fails its hash; the verdict is then UNKNOWN. Default true. */
  evidence_verified?: boolean;
  /** Optional detail (additive): RUN_TIMEOUT distinguishes a wall-clock abort from an operator abort. */
  outcome_reason?: ReasonCode | null;
  provider_blocked: boolean;
  preflight_rejected: boolean;
  binding_check: BindingCheck;
  steps: { mandatory: boolean; status: StepStatus; action?: StepAction }[];
  /** Number of planned steps; fewer recorded steps than planned means partial. */
  planned_steps: number;
  cleanup: CleanupStatus | null;
  operator: OperatorDecl;
  isolation: Isolation;
  interventions: number;
}

/* ------------------------------------------------------------------ report */

export interface StepReport {
  step_key: string;
  action: StepAction;
  mandatory: boolean;
  status: StepStatus;
  reason_code: ReasonCode;
  deadline_seconds: number;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  evidence_hash: string | null;
  /** Check lines from the stored step receipt (already redacted). */
  checks: { name: string; status: "PASS" | "FAIL"; expected?: string; actual?: string; detail?: string }[];
  intervention_ids: string[];
}

export interface ReportData {
  schema_version: typeof SCHEMA_VERSION;
  generated_at: string;
  run: {
    id: string;
    workspace_id: string;
    scenario: { id: string; version: string };
    state: RunState;
    outcome: RunOutcome | null;
    provider: string;
    isolation: Isolation;
    /** Always present and conspicuous when isolation is "none". */
    labels: string[];
    created_at: string;
    started_at: string | null;
    finished_at: string | null;
    imported: boolean;
    fault_injected: boolean;
  };
  binding: Binding;
  operator: OperatorDecl;
  verdict: VerdictResult;
  /** Additive: for imported runs, the verdict recorded in the bundle. Display-only and unauthenticated; never accepted. */
  claimed_verdict?: VerdictResult | null;
  preflight: PreflightReport | null;
  steps: StepReport[];
  interventions: { id: string; actor_ref: string; reason: string; occurred_at: string; step_key: string | null }[];
  evidence: { id: string; kind: EvidenceKind; step_key: string | null; sha256: string; media_type: string; size_bytes: number; redacted: boolean }[];
  cleanup: {
    status: CleanupStatus | "MISSING";
    verified_at: string | null;
    resources: { kind: ResourceRecord["kind"]; id: string; state: ResourceState; detail?: string }[];
    note: string | null;
  };
  state_history: StateTransition[];
}

export interface RunResult {
  run_id: string;
  state: RunState;
  outcome: RunOutcome | null;
  verdict: VerdictResult;
  binding: Binding;
  provider: string;
  isolation: Isolation;
  preflight: PreflightReport | null;
  steps: { step_key: string; action: StepAction; status: StepStatus; reason_code: ReasonCode }[];
  cleanup: { status: CleanupStatus; resources: number; leaked: number };
  /** Same as verdict.exit_code. */
  exit_code: 0 | 1;
  /** Additive: warnings the caller must show on stderr (e.g. a local-sandbox run executes scripts directly on this host). */
  warnings?: string[];
}

/* ------------------------------------------------------------------ bundle */

export interface BundleFileEntry {
  path: string;
  sha256: string;
  size_bytes: number;
}

export interface BundleHeader {
  format: typeof BUNDLE_FORMAT;
  format_version: typeof BUNDLE_FORMAT_VERSION;
  schema_version: typeof SCHEMA_VERSION;
  created_at: string;
  producer: { name: "handoffcheck"; version: string };
  run_id: string;
  binding_digest: string;
  files: BundleFileEntry[];
  /** sha256 over newline-joined "<path>:<sha256>" of `files` sorted by path. */
  root_hash: string;
  metadata_bytes: number;
  blob_bytes: number;
}

export interface BundleInfo {
  path: string;
  bundle_sha256: string;
  header: BundleHeader;
  bytes: number;
}

export type BundleErrorCode =
  | "TRUNCATED"
  | "UNSUPPORTED_VERSION"
  | "BAD_FORMAT"
  | "HASH_MISMATCH"
  | "MISSING_FILE"
  | "EXTRA_FILE"
  | "LIMIT_EXCEEDED"
  | "UNSAFE_ENTRY"
  | "SCHEMA_INVALID"
  | "ROOT_HASH_MISMATCH";

export interface BundleVerification {
  ok: boolean;
  /** Additive: always "integrity only, provenance not verified" (hashes prove integrity, never who made the bundle). */
  note?: string;
  header: BundleHeader | null;
  files_checked: number;
  errors: { code: BundleErrorCode; message: string }[];
}

export interface ImportResult {
  run_id: string;
  files_imported: number;
  bundle_sha256: string;
  binding_digest: string;
}

/* ------------------------------------------------------------------ limits */

export interface Limits {
  max_metadata_bytes: number;
  max_files: number;
  max_blob_bytes: number;
  max_output_bytes: number;
  max_steps: number;
  max_script_bytes: number;
}

export const DEFAULT_LIMITS: Limits = {
  max_metadata_bytes: 25 * 1024 * 1024,
  max_files: 1000,
  max_blob_bytes: 250 * 1024 * 1024,
  max_output_bytes: 1024 * 1024,
  max_steps: 50,
  max_script_bytes: 1024 * 1024
};

/* ------------------------------------------------------- clock / ids / env */

export interface Clock {
  /** UTC ISO-8601 with millisecond precision, e.g. 2026-01-01T00:00:00.000Z. */
  nowIso(): string;
  /** Monotonic milliseconds for durations. */
  monotonicMs(): number;
}

export interface IdGenerator {
  /** RFC 4122 shaped lowercase UUID. */
  uuid(): string;
}

/* --------------------------------------------------------- runner provider */

export interface ProviderAvailability {
  available: boolean;
  /** Human reason when unavailable (e.g. "limactl not found"). Never success when unavailable. */
  reason?: string;
  version?: string;
}

export interface ArtifactEntry {
  path: string;
  type: "file" | "directory" | "symlink";
  mode: number;
  data?: Uint8Array;
  linkname?: string;
}

export interface ProvisionRequest {
  run_id: string;
  limits: { wall_seconds: number; max_output_bytes: number; resources?: { cpus: number; memory_mb: number; disk_mb: number } };
  env: Record<string, string>;
  /** Extracted, validated artifact tree to stage into the sandbox workspace. */
  artifact: { entries: ArtifactEntry[] };
  /** Script files (relative path -> bytes) to stage read-only in the sandbox. */
  scripts: { path: string; bytes: Uint8Array }[];
  synthetic: boolean;
  /** Additive: aborts provisioning (e.g. a slow VM start) when the run is aborted. */
  signal?: AbortSignal;
}

export interface ExecRequest {
  script: ScriptRef;
  label: string;
  timeout_ms: number;
  extra_env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface ExecResult {
  label: string;
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  aborted: boolean;
  duration_ms: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  truncated: boolean;
}

export interface Sandbox {
  readonly id: string;
  readonly provider: string;
  readonly isolation: Isolation;
  /** Additive: facts about the sandbox for the run receipt (egress state, limits, VM type). Never claim what was not proven. */
  readonly facts?: Record<string, string>;
  exec(req: ExecRequest): Promise<ExecResult>;
  /** Read a sandbox-relative file (bounded). Returns null when absent. */
  readFile(relPath: string, maxBytes: number): Promise<Uint8Array | null>;
  /** Everything that must be gone after destroy(): used to build the cleanup receipt. */
  resources(): ResourceRecord[];
  /** Kill everything and remove the sandbox. Must not throw for already-gone resources. */
  destroy(): Promise<void>;
}

export interface RunnerProvider {
  readonly name: string;
  readonly isolation: Isolation;
  probe(): Promise<ProviderAvailability>;
  provision(req: ProvisionRequest): Promise<Sandbox>;
  /** Independent post-destroy check by locator; never trusts destroy()'s own claim. */
  audit(resources: ResourceRecord[]): Promise<ResourceRecord[]>;
  /** Retry removal for `handoffcheck cleanup --run <id>`. */
  destroyResources(resources: ResourceRecord[]): Promise<void>;
}

export type ProviderRegistry = Record<string, RunnerProvider>;

/* ------------------------------------------------------------------ errors */

export type ErrorCode =
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "SCHEMA_INVALID"
  | "POLICY_REJECTED"
  | "UNSUPPORTED_VERSION"
  | "BUNDLE_CORRUPT"
  | "PROVIDER_UNAVAILABLE"
  | "CONNECTOR_DISCONNECTED"
  | "INSUFFICIENT_CAPACITY"
  | "STORE_SCHEMA_UNSUPPORTED"
  | "INTERNAL";

export interface ErrorBody {
  error: { code: ErrorCode; message: string; request_id: string };
}

/* ----------------------------------------------------------- run progress */

export type RunEvent =
  | { type: "state"; run_id: string; state: RunState; at: string }
  | { type: "step_started"; run_id: string; step_key: string; action: StepAction; at: string }
  | { type: "step_finished"; run_id: string; step_key: string; status: StepStatus; at: string }
  | { type: "intervention"; run_id: string; id: string; at: string };
