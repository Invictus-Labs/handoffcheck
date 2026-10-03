import { createHash } from "node:crypto";
import { EvidenceWriter } from "../evidence/writer.js";
import { runPreflight } from "../security/preflight.js";
import { Redactor } from "../security/redact.js";
import { psTable, sameProcess } from "../runner/procscan.js";
import type { Store } from "../store/store.js";
import { HandoffCheckError } from "./errors.js";
import { ProvisionError } from "./provision.js";
import type { LoadedInputs } from "./inputs.js";
import { SCHEMA_VERSION } from "./types.js";
import type {
  Clock,
  CleanupReceipt,
  DrillRecord,
  ArtifactEntry,
  ExecResult,
  IdGenerator,
  InstallStep,
  Limits,
  ManifestStep,
  OperatorDecl,
  PreflightReport,
  ProviderRegistry,
  ReasonCode,
  RecoverStep,
  ResourceRecord,
  RestoreStep,
  RotateStep,
  RunEvent,
  RunnerProvider,
  Sandbox,
  ScriptRef,
  StepStatus
} from "./types.js";

export interface EngineContext {
  store: Store;
  clock: Clock;
  ids: IdGenerator;
  providers: ProviderRegistry;
  /** True when a negative-control fault is active on the built-in local-sandbox. */
  faultInjected: boolean;
  limits: Limits;
  emit: (e: RunEvent) => void;
}

interface Check {
  name: string;
  status: "PASS" | "FAIL";
  expected?: string;
  actual?: string;
  detail?: string;
}

interface ExecEntry {
  label: string;
  script_sha256: string | null;
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number;
  stdout_sha256: string;
  stderr_sha256: string;
  truncated: boolean;
}

interface StepOutcome {
  status: StepStatus;
  reason_code: ReasonCode;
  reason: string;
}

const EMPTY_SHA = createHash("sha256").update("").digest("hex");
const clip = (s: string, n = 500): string => (s.length > n ? `${s.slice(0, n)}...` : s);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface StepCtx {
  ec: EngineContext;
  sandbox: Sandbox;
  loaded: LoadedInputs;
  redactor: Redactor;
  ev: EvidenceWriter;
  step: ManifestStep;
  deadlineAt: number;
  signal: AbortSignal;
  checks: Check[];
  executions: ExecEntry[];
  /** Log storage is deferred to the end of the step so literals learned during the step (new credentials) redact all of it. */
  pending: (() => void)[];
  /** Rotation output is withheld until its declared new credential has been safely learned. */
  withholdOutput?: boolean;
}

const remaining = (sc: StepCtx): number => Math.floor(sc.deadlineAt - performance.now());

function timedOutResult(label: string): ExecResult {
  return { label, exit_code: null, signal: null, timed_out: true, aborted: false, duration_ms: 0, stdout: new Uint8Array(), stderr: new Uint8Array(), truncated: false };
}

interface Executed {
  res: ExecResult;
  /** Store the redacted logs and record the execution (call once, for the attempt that matters). */
  commit: () => void;
}

/** Run one explicit script inside the sandbox; logging is deferred so polling can keep only the deciding attempt. */
async function execDeferred(
  sc: StepCtx,
  ref: ScriptRef,
  role: string,
  opts: { env?: Record<string, string>; poll?: boolean } = {}
): Promise<Executed> {
  const label = `${sc.step.id}:${role}`;
  const left = remaining(sc);
  if (left <= 0) return { res: timedOutResult(label), commit: () => undefined };
  const t0 = opts.poll ? 0 : sc.ec.clock.monotonicMs();
  const res = await sc.sandbox.exec({
    script: ref,
    label,
    timeout_ms: left,
    extra_env: { HC_STEP: sc.step.id, ...opts.env },
    signal: sc.signal
  });
  const duration = opts.poll ? 0 : sc.ec.clock.monotonicMs() - t0;
  const store = (): void => {
    const withheld = Buffer.from("[OUTPUT WITHHELD: rotation credential unavailable]\n");
    const stdout = sc.withholdOutput ? withheld : res.stdout;
    const stderr = sc.withholdOutput ? withheld : res.stderr;
    const stdoutSha = sc.ev.putText("step_log", sc.step.id, Buffer.concat([Buffer.from(`# ${label} stdout\n`), stdout]), res.truncated).sha256;
    const stderrSha = sc.ev.putText("step_log", sc.step.id, Buffer.concat([Buffer.from(`# ${label} stderr\n`), stderr]), res.truncated).sha256;
    sc.executions.push({
      label,
      script_sha256: (sc.loaded.scripts.get(ref.path) as { sha256: string | null }).sha256,
      exit_code: res.exit_code,
      timed_out: res.timed_out,
      duration_ms: duration,
      stdout_sha256: stdoutSha,
      stderr_sha256: stderrSha,
      truncated: res.truncated
    });
  };
  return { res, commit: () => void sc.pending.push(store) };
}

/** Run a script and always record it (the common case). */
async function exec(sc: StepCtx, ref: ScriptRef, role: string, opts: { env?: Record<string, string> } = {}): Promise<ExecResult> {
  const x = await execDeferred(sc, ref, role, opts);
  x.commit();
  return x.res;
}

function abortedOutcome(sc: StepCtx, what: string, wall: () => boolean): StepOutcome {
  return wall()
    ? { status: "ERROR", reason_code: "RUN_TIMEOUT", reason: `${what} was interrupted: the run exceeded its wall-clock limit` }
    : { status: "ERROR", reason_code: "RUN_ABORTED", reason: `${what} was interrupted: the run was aborted` };
}

function execOutcome(res: ExecResult, what: string, sc: StepCtx, wall: () => boolean): StepOutcome | null {
  if (res.aborted || sc.signal.aborted) return abortedOutcome(sc, what, wall);
  if (res.timed_out) return { status: "TIMEOUT", reason_code: "SCRIPT_TIMEOUT", reason: `${what} did not finish within the step deadline` };
  if (res.exit_code !== 0) {
    return { status: "FAIL", reason_code: "SCRIPT_FAILED", reason: `${what} exited with ${res.exit_code === null ? `signal ${res.signal ?? "unknown"}` : `code ${res.exit_code}`}` };
  }
  return null;
}

/* ---------------------------------------------------------------- steps */

async function runInstall(sc: StepCtx, step: InstallStep, wall: () => boolean): Promise<StepOutcome> {
  const res = await exec(sc, step.script, "script");
  const bad = execOutcome(res, "install script", sc, wall);
  if (bad) {
    sc.checks.push({ name: "install script exit 0", status: "FAIL", actual: clip(bad.reason) });
    return bad;
  }
  sc.checks.push({ name: "install script exit 0", status: "PASS" });
  const interval = step.probe_interval_ms ?? 500;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const a = await execDeferred(sc, step.probe, "probe", { poll: true });
    if (sc.signal.aborted || a.res.aborted) {
      a.commit();
      return abortedOutcome(sc, "health probe", wall);
    }
    if (!a.res.timed_out && a.res.exit_code === 0) {
      a.commit();
      sc.checks.push({ name: "health probe passes within deadline", status: "PASS", actual: `passed on attempt ${attempts}` });
      return { status: "PASS", reason_code: "OK", reason: "install script succeeded and the health probe passed within the deadline" };
    }
    if (a.res.timed_out || remaining(sc) <= interval) {
      a.commit();
      sc.checks.push({ name: "health probe passes within deadline", status: "FAIL", actual: `no passing probe after ${attempts} attempt(s) before the ${step.deadline_seconds}s deadline` });
      return { status: "TIMEOUT", reason_code: "HEALTH_PROBE_FAILED", reason: `health probe never passed within ${step.deadline_seconds}s` };
    }
    await sleep(Math.min(interval, Math.max(1, remaining(sc))));
  }
}

function parseMeasure(stdout: Uint8Array, truncated: boolean): { record_counts: Record<string, number>; data_hashes: Record<string, string> } | null {
  if (truncated) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(Buffer.from(stdout).toString("utf8"));
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null;
  const d = doc as Record<string, unknown>;
  const counts = d["record_counts"];
  if (counts === null || typeof counts !== "object" || Array.isArray(counts)) return null;
  const record_counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts as Record<string, unknown>)) {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return null;
    record_counts[k] = v;
  }
  const data_hashes: Record<string, string> = {};
  const hashes = d["data_hashes"];
  if (hashes !== undefined) {
    if (hashes === null || typeof hashes !== "object" || Array.isArray(hashes)) return null;
    for (const [k, v] of Object.entries(hashes as Record<string, unknown>)) {
      if (typeof v !== "string") return null;
      data_hashes[k] = v;
    }
  }
  return { record_counts, data_hashes };
}

async function runRestore(sc: StepCtx, step: RestoreStep, wall: () => boolean): Promise<StepOutcome> {
  const res = await exec(sc, step.script, "script");
  const bad = execOutcome(res, "restore script", sc, wall);
  if (bad) {
    sc.checks.push({ name: "restore script exit 0", status: "FAIL", actual: clip(bad.reason) });
    return bad;
  }
  sc.checks.push({ name: "restore script exit 0", status: "PASS", detail: "a restore script that merely exits 0 never passes: measured data is verified below" });

  const m = await exec(sc, step.measure, "measure");
  const mbad = execOutcome(m, "measure script", sc, wall);
  if (mbad) {
    sc.checks.push({ name: "measure script exit 0", status: "FAIL", actual: clip(mbad.reason) });
    return mbad.reason_code === "SCRIPT_FAILED" ? { status: "FAIL", reason_code: "RESTORE_MEASURE_MISSING", reason: "the measure script failed, so the restore was not verified" } : mbad;
  }
  const measured = parseMeasure(m.stdout, m.truncated);
  if (!measured) {
    sc.checks.push({ name: "measure output is valid", status: "FAIL", detail: "stdout must be JSON {record_counts:{name:int}, data_hashes?:{name:sha256}}" });
    return { status: "FAIL", reason_code: "RESTORE_MEASURE_MISSING", reason: "no valid measurement was produced after the restore" };
  }
  sc.checks.push({ name: "measure output is valid", status: "PASS" });

  let reason: ReasonCode = "OK";
  const setReason = (code: ReasonCode): void => {
    if (reason === "OK") reason = code;
  };
  for (const [name, expected] of Object.entries(step.expect.record_counts)) {
    const actual = measured.record_counts[name];
    const ok = actual === expected;
    sc.checks.push({ name: `record count: ${name}`, status: ok ? "PASS" : "FAIL", expected: String(expected), actual: actual === undefined ? "missing" : String(actual) });
    if (!ok) setReason("RESTORE_COUNT_MISMATCH");
  }
  for (const [name, expected] of Object.entries(step.expect.data_hashes ?? {})) {
    const actual = measured.data_hashes[name];
    const ok = actual === expected;
    sc.checks.push({ name: `data hash: ${name}`, status: ok ? "PASS" : "FAIL", expected, actual: actual ?? "missing" });
    if (!ok) setReason("RESTORE_HASH_MISMATCH");
  }
  for (const blob of step.expect.blobs ?? []) {
    const bytes = await sc.sandbox.readFile(blob.path, sc.ec.limits.max_blob_bytes);
    const actual = bytes ? createHash("sha256").update(bytes).digest("hex") : null;
    const ok = actual === blob.sha256;
    sc.checks.push({ name: `blob hash: ${blob.path}`, status: ok ? "PASS" : "FAIL", expected: blob.sha256, actual: actual ?? "missing or unreadable" });
    if (!ok) setReason("RESTORE_BLOB_MISMATCH");
  }
  return reason === "OK"
    ? { status: "PASS", reason_code: "OK", reason: "record counts and selected data and blob hashes match the expected restore" }
    : { status: "FAIL", reason_code: reason, reason: "the restored data does not match the expected record counts or hashes" };
}

async function runRotate(sc: StepCtx, step: RotateStep, wall: () => boolean): Promise<StepOutcome> {
  const readCred = async (rel: string): Promise<string | null> => {
    const bytes = await sc.sandbox.readFile(rel, 64 * 1024);
    const text = bytes ? Buffer.from(bytes).toString("utf8").trim() : "";
    if (text !== "") sc.redactor.addLiteral(text);
    return text === "" ? null : text;
  };
  const oldCred = await readCred(step.credentials.old_file);
  if (oldCred === null) {
    sc.checks.push({ name: "old credential present before rotation", status: "FAIL" });
    return { status: "FAIL", reason_code: "ROTATION_NOT_ROTATED", reason: "the old credential file is missing or empty, so rotation cannot be proven" };
  }
  sc.checks.push({ name: "old credential present before rotation", status: "PASS" });

  // Even a failed/timed-out script may have written and printed a future credential.
  // Keep output fail-closed on exceptions or an unavailable declared file.
  sc.withholdOutput = true;
  const res = await exec(sc, step.script, "script");
  let newCred: string | null = null;
  try { newCred = await readCred(step.credentials.new_file); } catch { /* keep output withheld */ }
  if (newCred !== null) sc.withholdOutput = false;
  const bad = execOutcome(res, "rotate script", sc, wall);
  if (bad) {
    sc.checks.push({ name: "rotate script exit 0", status: "FAIL", actual: clip(bad.reason) });
    return bad;
  }
  sc.checks.push({ name: "rotate script exit 0", status: "PASS" });

  if (newCred === null) {
    sc.checks.push({ name: "new credential present after rotation", status: "FAIL" });
    return { status: "FAIL", reason_code: "ROTATION_NOT_ROTATED", reason: "the new credential file is missing or empty after rotation" };
  }
  sc.checks.push({ name: "new credential present after rotation", status: "PASS" });
  if (newCred === oldCred) {
    sc.checks.push({ name: "credential changed", status: "FAIL", detail: "old and new credential are identical" });
    return { status: "FAIL", reason_code: "ROTATION_NOT_ROTATED", reason: "the credential did not change" };
  }
  sc.checks.push({ name: "credential changed", status: "PASS" });

  const rejectCodes = step.reject_exit_codes ?? [3];
  const probe = async (cred: string, role: string): Promise<"accepted" | "rejected" | "error" | "timeout" | "interrupted"> => {
    const p = await exec(sc, step.probe, role, { env: { HC_CREDENTIAL: cred } });
    if (p.aborted || sc.signal.aborted) return "interrupted";
    if (p.timed_out) return "timeout";
    if (p.exit_code === 0) return "accepted";
    if (p.exit_code !== null && rejectCodes.includes(p.exit_code)) return "rejected";
    return "error";
  };
  const oldResult = await probe(oldCred, "probe-old");
  if (oldResult === "interrupted") return abortedOutcome(sc, "rotation probe", wall);
  sc.checks.push({ name: "old credential is rejected", status: oldResult === "rejected" ? "PASS" : "FAIL", expected: `exit ${rejectCodes.join("|")}`, actual: oldResult });
  const newResult = await probe(newCred, "probe-new");
  if (newResult === "interrupted") return abortedOutcome(sc, "rotation probe", wall);
  sc.checks.push({ name: "new credential is accepted", status: newResult === "accepted" ? "PASS" : "FAIL", expected: "exit 0", actual: newResult });

  if (oldResult === "timeout" || newResult === "timeout") return { status: "TIMEOUT", reason_code: "SCRIPT_TIMEOUT", reason: "a rotation probe did not finish within the step deadline" };
  if (oldResult === "accepted") return { status: "FAIL", reason_code: "ROTATION_OLD_ACCEPTED", reason: "the old credential still works after rotation (negative control failed)" };
  if (oldResult === "error" || newResult === "error") return { status: "FAIL", reason_code: "ROTATION_PROBE_ERROR", reason: "a rotation probe exited with an unexpected code, so the result is unknown and cannot pass" };
  if (newResult === "rejected") return { status: "FAIL", reason_code: "ROTATION_NEW_REJECTED", reason: "the new credential was rejected" };
  return { status: "PASS", reason_code: "OK", reason: "the old credential fails and the new credential succeeds" };
}

async function runRecover(sc: StepCtx, step: RecoverStep, wall: () => boolean): Promise<StepOutcome> {
  const seeded = await exec(sc, step.seed_fault, "seed-fault");
  const sbad = execOutcome(seeded, "fault seeding script", sc, wall);
  if (sbad) {
    sc.checks.push({ name: "fault seeded", status: "FAIL", actual: clip(sbad.reason) });
    return sbad;
  }
  const pre = await exec(sc, step.probe, "probe-after-fault");
  if (pre.aborted || sc.signal.aborted) return abortedOutcome(sc, "probe", wall);
  if (pre.timed_out) {
    sc.checks.push({ name: "fault is observed", status: "FAIL", detail: "step deadline reached" });
    return { status: "TIMEOUT", reason_code: "SCRIPT_TIMEOUT", reason: "the step deadline passed before the seeded fault was observed" };
  }
  const observed = pre.timed_out || pre.exit_code !== 0;
  sc.checks.push({ name: "fault is observed (probe fails after seeding)", status: observed ? "PASS" : "FAIL", expected: "probe fails", actual: observed ? "probe failed" : "probe passed" });
  if (!observed) return { status: "FAIL", reason_code: "RECOVERY_FAULT_NOT_OBSERVED", reason: "the seeded fault was not observable: the probe still passed" };

  const maxMs = step.max_recovery_seconds * 1000;
  const startedAt = performance.now();
  const rec = await exec(sc, step.script, "recovery");
  const rbad = execOutcome(rec, "recovery script", sc, wall);
  if (rbad) {
    sc.checks.push({ name: "recovery script exit 0", status: "FAIL", actual: clip(rbad.reason) });
    return rbad;
  }
  sc.checks.push({ name: "recovery script exit 0", status: "PASS" });
  let healthyAt: number | null = null;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const a = await execDeferred(sc, step.probe, "probe-after-recovery", { poll: true });
    const p = a.res;
    if (sc.signal.aborted || p.aborted) {
      a.commit();
      return abortedOutcome(sc, "probe", wall);
    }
    if (!p.timed_out && p.exit_code === 0) {
      a.commit();
      healthyAt = performance.now();
      break;
    }
    const used = performance.now() - startedAt;
    if (p.timed_out) {
      a.commit();
      sc.checks.push({ name: "service healthy after recovery", status: "FAIL", detail: "step deadline reached" });
      return { status: "TIMEOUT", reason_code: "SCRIPT_TIMEOUT", reason: "the step deadline passed before the service became healthy" };
    }
    if (used >= maxMs) {
      a.commit();
      break;
    }
    await sleep(Math.min(250, Math.max(1, maxMs - used), Math.max(1, remaining(sc))));
  }
  if (healthyAt === null) {
    sc.checks.push({ name: "service healthy after recovery", status: "FAIL", actual: `not healthy after ${attempts} probe(s) within ${step.max_recovery_seconds}s` });
    return { status: "FAIL", reason_code: "RECOVERY_NOT_RESTORED", reason: "the service was not healthy again within the recovery bound" };
  }
  const tooSlow = healthyAt - startedAt > maxMs;
  sc.checks.push({ name: "service healthy after recovery", status: "PASS", actual: `healthy on probe ${attempts}` });
  sc.checks.push({ name: `recovery within ${step.max_recovery_seconds}s`, status: tooSlow ? "FAIL" : "PASS", expected: `<= ${step.max_recovery_seconds}s` });
  return tooSlow
    ? { status: "FAIL", reason_code: "RECOVERY_TOO_SLOW", reason: `recovery took longer than the bound of ${step.max_recovery_seconds}s` }
    : { status: "PASS", reason_code: "OK", reason: "the seeded worker failure was observed and recovered within the bound" };
}

/* ------------------------------------------------------------- lifecycle */

/**
 * The operator kind is "automated" unless the invoker explicitly sets it: a manifest may declare "automated" or
 * "ai_assisted" (which only lower the claim) but can never assert "human" for itself; `human` must come from the caller
 * (RunInput.operator.kind / --operator-kind human), together with the operator and builder identities.
 */
function operatorOf(loaded: LoadedInputs, override?: Partial<OperatorDecl>): OperatorDecl {
  const base = loaded.manifest.operator;
  return {
    kind: override?.kind ?? (base.kind === "human" ? "automated" : base.kind),
    ref: override?.ref ?? base.ref,
    ...((override?.builder_ref ?? base.builder_ref) !== undefined ? { builder_ref: (override?.builder_ref ?? base.builder_ref) as string } : {})
  };
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

/** Persist a CREATED drill and its manifest evidence. */
export function createRun(ec: EngineContext, loaded: LoadedInputs, override: Partial<OperatorDecl> | undefined, provider: { name: string; isolation: "vm" | "none" }): { drill: DrillRecord; redactor: Redactor; ev: EvidenceWriter } {
  const now = ec.clock.nowIso();
  const op = operatorOf(loaded, override);
  const redactor = new Redactor(loaded.manifest.synthetic_secrets);
  const drill: DrillRecord = {
    schema_version: SCHEMA_VERSION,
    id: ec.ids.uuid(),
    workspace_id: ec.store.workspaceId,
    scenario_id: loaded.manifest.scenario.id,
    scenario_version: loaded.manifest.scenario.version,
    artifact_digest: loaded.binding.artifact_digest,
    runbook_hash: loaded.binding.runbook_hash,
    manifest_digest: loaded.binding.manifest_digest,
    binding_digest: loaded.binding.binding_digest,
    operator_ref: redactor.redact(op.ref).text,
    operator_kind: op.kind,
    builder_ref: op.builder_ref === undefined ? null : redactor.redact(op.builder_ref).text,
    provider: provider.name,
    isolation: provider.isolation,
    state: "CREATED",
    outcome: null,
    outcome_reason: null,
    created_at: now,
    started_at: null,
    finished_at: null,
    retain_until: addDays(now, loaded.manifest.retention_days ?? 90),
    imported: false,
    fault_injected: ec.faultInjected,
    planned_steps: loaded.manifest.steps.length
  };
  ec.store.tx(() => {
    ec.store.insertDrill(drill);
    ec.store.recordCreated(drill.id, now);
  });
  ec.store.putRunSecrets(drill.id, redactor.declared);
  ec.store.setOwner(drill.id, process.pid, psTable()?.find((r) => r.pid === process.pid)?.lstart ?? "");
  const ev = new EvidenceWriter(ec.store, ec.clock, ec.ids, drill.id, redactor);
  ev.putJson("manifest", null, loaded.manifest);
  ec.emit({ type: "state", run_id: drill.id, state: "CREATED", at: now });
  return { drill, redactor, ev };
}

function move(ec: EngineContext, id: string, to: DrillRecord["state"], patch: Parameters<Store["transition"]>[3] = {}): void {
  const at = ec.clock.nowIso();
  ec.store.transition(id, to, at, patch);
  ec.emit({ type: "state", run_id: id, state: to, at });
}

function insertSkipped(ec: EngineContext, drillId: string, steps: readonly ManifestStep[], from: number, reason: ReasonCode, onlyMissing = false): void {
  const have = onlyMissing ? new Set(ec.store.steps(drillId).map((r) => r.step_key)) : new Set<string>();
  const used = new Set<string>(steps.slice(0, from).map((s) => s.id));
  for (let i = from; i < steps.length; i++) {
    const step = steps[i] as ManifestStep;
    if (have.has(step.id)) continue;
    // a manifest with duplicate step ids is rejected by preflight but must still be recorded: keep keys unique
    let key = step.id;
    if (used.has(key)) key = `${step.id.slice(0, 50)}-dup${i}`;
    used.add(key);
    ec.store.insertStep({
      schema_version: SCHEMA_VERSION,
      id: ec.ids.uuid(),
      drill_id: drillId,
      seq: i,
      step_key: key,
      action: step.action,
      deadline_seconds: step.deadline_seconds,
      mandatory: step.mandatory !== false,
      status: "SKIPPED",
      reason_code: reason,
      evidence_hash: null,
      started_at: null,
      finished_at: null,
      duration_ms: null
    });
  }
}

function mergeResources(a: ResourceRecord[], b: ResourceRecord[]): ResourceRecord[] {
  const byId = new Map<string, ResourceRecord>();
  for (const r of [...a, ...b]) byId.set(r.id, r);
  return [...byId.values()];
}

/** Public view of a cleanup receipt for evidence documents: no provider locators. */
export function publicCleanup(c: CleanupReceipt): unknown {
  return { ...c, resources: c.resources.map(({ kind, id, state, detail }) => ({ kind, id, locator: "", state, ...(detail ? { detail } : {}) })) };
}

async function finishCleanup(
  ec: EngineContext,
  ev: EvidenceWriter,
  drillId: string,
  provider: RunnerProvider | null,
  isolation: DrillRecord["isolation"],
  providerName: string,
  resources: ResourceRecord[],
  note: string | null,
  destroyError: string | null,
  forceUnconfirmed = false
): Promise<CleanupReceipt> {
  let audited: ResourceRecord[] = resources;
  let auditNote: string | null = null;
  if (provider && resources.length > 0) {
    try {
      audited = await provider.audit(resources);
    } catch (e) {
      auditNote = `independent audit failed: ${(e as Error).message}`;
      audited = resources.map((r) => ({ ...r, state: "unknown" as const, detail: "audit failed" }));
    }
  }
  const verified = !forceUnconfirmed && audited.every((r) => r.state === "removed");
  const notes = [note, destroyError ? `destroy error: ${destroyError}` : null, auditNote].filter((x): x is string => x !== null);
  const receipt: CleanupReceipt = {
    schema_version: SCHEMA_VERSION,
    id: ec.ids.uuid(),
    drill_id: drillId,
    seq: ec.store.nextCleanupSeq(drillId),
    provider: providerName,
    isolation,
    status: verified ? "VERIFIED" : "UNCONFIRMED",
    resources: audited,
    verified_at: ec.clock.nowIso(),
    note: notes.length > 0 ? notes.join("; ") : null
  };
  ec.store.insertCleanup(receipt);
  ev.putJson("cleanup_receipt", null, publicCleanup(receipt));
  move(ec, drillId, verified ? "CLEANUP_VERIFIED" : "CLEANUP_UNCONFIRMED", { reason: receipt.status });
  return receipt;
}

export interface ExecuteInput {
  loaded: LoadedInputs;
  /** local-sandbox runs scripts directly on this host: refused at preflight unless the caller explicitly allows it. */
  allowHostSandbox?: boolean;
  operator?: Partial<OperatorDecl>;
  signal?: AbortSignal;
}

/** The full drill lifecycle. Always attempts cleanup; harness errors are rethrown after the run is closed out. */
export async function executeDrill(ec: EngineContext, input: ExecuteInput): Promise<string> {
  const { loaded } = input;
  const m = loaded.manifest;
  // the manifest schema restricts runner.provider to the built-in providers, which are always registered
  const provider = ec.providers[m.runner.provider] as RunnerProvider;
  const isolation = provider.isolation;
  const { drill, redactor, ev } = createRun(ec, loaded, input.operator, { name: m.runner.provider, isolation });
  const id = drill.id;
  const steps = m.steps;
  let sandbox: Sandbox | null = null;
  let resources: ResourceRecord[] = [];
  let destroyError: string | null = null;
  let cleanedUp = false;

  // credentials learned while a step ran (rotation) are persisted encrypted so later writers can redact them too
  const persisted = new Set<string>(redactor.declared);
  const persistLearned = (): void => {
    const fresh = redactor.declared.filter((l) => !persisted.has(l));
    for (const l of fresh) persisted.add(l);
    ec.store.putRunSecrets(id, fresh);
  };

  const closeNoSandbox = async (reason: ReasonCode, note: string): Promise<string> => {
    insertSkipped(ec, id, steps, 0, reason);
    move(ec, id, "FAILED", { outcome: "FAILED", outcome_reason: reason, finished_at: ec.clock.nowIso(), reason: note });
    await finishCleanup(ec, ev, id, provider, isolation, m.runner.provider, [], "no resources were provisioned", null);
    return id;
  };

  try {
    move(ec, id, "PREFLIGHT");
    const preflight: PreflightReport = runPreflight(loaded, { name: m.runner.provider, isolation, ...(input.allowHostSandbox ? { allowHostSandbox: true } : {}) });
    ev.putJson("preflight_report", null, preflight);
    if (preflight.status === "REJECTED") return await closeNoSandbox("PREFLIGHT_REJECTED", "preflight rejected the drill inputs");

    const availability = await provider.probe();
    if (!availability.available) {
      return await closeNoSandbox("PROVIDER_UNAVAILABLE", availability.reason ?? "provider unavailable");
    }
    if (input.signal?.aborted) {
      insertSkipped(ec, id, steps, 0, "RUN_ABORTED");
      move(ec, id, "ABORTED", { outcome: "ABORTED", outcome_reason: "RUN_ABORTED", finished_at: ec.clock.nowIso(), reason: "aborted before start" });
      await finishCleanup(ec, ev, id, provider, isolation, provider.name, [], "no resources were provisioned", null);
      return id;
    }

    move(ec, id, "RUNNING", { started_at: ec.clock.nowIso() });
    const scripts = [...loaded.scripts.values()].filter((s) => s.bytes !== null).map((s) => ({ path: s.path, bytes: s.bytes as Buffer }));
    try {
      sandbox = await provider.provision({
        run_id: id,
        limits: { wall_seconds: m.runner.wall_seconds, max_output_bytes: m.runner.max_output_bytes ?? ec.limits.max_output_bytes, ...(m.runner.resources ? { resources: m.runner.resources } : {}) },
        env: { ...m.env },
        artifact: { entries: loaded.artifactEntries as ArtifactEntry[] }, // preflight PASS implies a valid archive
        scripts,
        synthetic: m.scenario.synthetic,
        ...(input.signal ? { signal: input.signal } : {})
      });
    } catch (e) {
      const partial = e instanceof ProvisionError ? e.resources : [];
      const note = partial.length > 0 ? "provisioning failed and left resources behind" : "provisioning failed; the provider reported no remaining resources";
      if (input.signal?.aborted) {
        insertSkipped(ec, id, steps, 0, "RUN_ABORTED");
        move(ec, id, "ABORTED", { outcome: "ABORTED", outcome_reason: "RUN_ABORTED", finished_at: ec.clock.nowIso(), reason: "aborted while provisioning" });
        await finishCleanup(ec, ev, id, provider, isolation, provider.name, partial, note, null);
        return id;
      }
      insertSkipped(ec, id, steps, 0, "PROVIDER_UNAVAILABLE");
      move(ec, id, "FAILED", { outcome: "FAILED", outcome_reason: "PROVIDER_UNAVAILABLE", finished_at: ec.clock.nowIso(), reason: `provisioning failed: ${redactor.redact((e as Error).message).text}` });
      await finishCleanup(ec, ev, id, provider, isolation, provider.name, partial, note, null);
      return id;
    }
    resources = sandbox.resources();
    ec.store.putInventory(id, provider.name, resources); // lets `cleanup` recover this run if the harness is killed mid-run
    ev.putJson("run_receipt", null, { schema_version: SCHEMA_VERSION, provider: provider.name, isolation, provider_version: availability.version ?? null, facts: sandbox.facts ?? {} });

    // wall-clock limit and external abort share one controller
    const runAbort = new AbortController();
    let wallExpired = false;
    const wallTimer = setTimeout(() => {
      wallExpired = true;
      runAbort.abort();
    }, m.runner.wall_seconds * 1000);
    const onExternalAbort = (): void => runAbort.abort();
    input.signal?.addEventListener("abort", onExternalAbort, { once: true });
    if (input.signal?.aborted) runAbort.abort();

    let outcome: "COMPLETE" | "FAILED" | "ABORTED" = "COMPLETE";
    let outcomeReason: ReasonCode = "OK";
    let stoppedAt = steps.length;
    try {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i] as ManifestStep;
        const mandatory = step.mandatory !== false;
        if (runAbort.signal.aborted) {
          outcome = "ABORTED";
          outcomeReason = wallExpired ? "RUN_TIMEOUT" : "RUN_ABORTED";
          stoppedAt = i;
          break;
        }
        const startedAt = ec.clock.nowIso();
        const t0 = ec.clock.monotonicMs();
        ec.emit({ type: "step_started", run_id: id, step_key: step.id, action: step.action, at: startedAt });
        const sc: StepCtx = {
          ec,
          sandbox,
          loaded,
          redactor,
          ev,
          step,
          deadlineAt: performance.now() + step.deadline_seconds * 1000,
          signal: runAbort.signal,
          checks: [],
          executions: [],
          pending: []
        };
        let result: StepOutcome;
        try {
          if (step.action === "install") result = await runInstall(sc, step, () => wallExpired);
          else if (step.action === "restore") result = await runRestore(sc, step, () => wallExpired);
          else if (step.action === "rotate") result = await runRotate(sc, step, () => wallExpired);
          else result = await runRecover(sc, step, () => wallExpired);
        } catch (e) {
          result = { status: "ERROR", reason_code: "HARNESS_ERROR", reason: `harness error: ${redactor.redact((e as Error).message).text}` };
        }
        for (const flush of sc.pending) flush(); // store logs now that every secret learned in this step is known
        const finishedAt = ec.clock.nowIso();
        const duration = ec.clock.monotonicMs() - t0;
        const windowIds = ec.store
          .interventions(id)
          .filter((iv) => iv.step_key === step.id || (iv.occurred_at >= startedAt && iv.occurred_at <= finishedAt))
          .map((iv) => iv.id);
        const receipt = ev.putJson("step_receipt", step.id, {
          schema_version: SCHEMA_VERSION,
          drill_id: id,
          step_key: step.id,
          action: step.action,
          status: result.status,
          reason_code: result.reason_code,
          reason: clip(result.reason, 1000),
          started_at: startedAt,
          finished_at: finishedAt,
          duration_ms: duration,
          deadline_seconds: step.deadline_seconds,
          provider: provider.name,
          isolation,
          checks: sc.checks.map((c) => ({ ...c, ...(c.expected !== undefined ? { expected: clip(c.expected, 500) } : {}), ...(c.actual !== undefined ? { actual: clip(c.actual, 500) } : {}), ...(c.detail !== undefined ? { detail: clip(c.detail, 1000) } : {}) })),
          executions: sc.executions,
          intervention_ids: windowIds
        });
        ec.store.insertStep({
          schema_version: SCHEMA_VERSION,
          id: ec.ids.uuid(),
          drill_id: id,
          seq: i,
          step_key: step.id,
          action: step.action,
          deadline_seconds: step.deadline_seconds,
          mandatory,
          status: result.status,
          reason_code: result.reason_code,
          evidence_hash: receipt.sha256,
          started_at: startedAt,
          finished_at: finishedAt,
          duration_ms: duration
        });
        ec.emit({ type: "step_finished", run_id: id, step_key: step.id, status: result.status, at: finishedAt });
        persistLearned();

        if (result.reason_code === "RUN_ABORTED" || result.reason_code === "RUN_TIMEOUT") {
          outcome = "ABORTED";
          outcomeReason = result.reason_code;
          stoppedAt = i + 1;
          break;
        }
        if (result.status !== "PASS" && mandatory) {
          outcome = "FAILED";
          outcomeReason = result.status === "TIMEOUT" ? "MANDATORY_STEP_TIMEOUT" : result.status === "ERROR" ? "MANDATORY_STEP_ERROR" : "MANDATORY_STEP_FAILED";
          stoppedAt = i + 1;
          break;
        }
      }
    } finally {
      clearTimeout(wallTimer);
      input.signal?.removeEventListener("abort", onExternalAbort);
    }
    insertSkipped(ec, id, steps, stoppedAt, outcome === "ABORTED" ? outcomeReason : "MANDATORY_STEP_FAILED");
    move(ec, id, outcome, { outcome, outcome_reason: outcomeReason, finished_at: ec.clock.nowIso(), reason: outcomeReason });

    resources = sandbox.resources(); // includes every process group started during the run
    try {
      await sandbox.destroy();
    } catch (e) {
      destroyError = redactor.redact((e as Error).message).text;
    }
    resources = mergeResources(resources, sandbox.resources()); // strays found and killed during destroy are audited too
    cleanedUp = true;
    await finishCleanup(ec, ev, id, provider, isolation, provider.name, resources, null, destroyError);
    return id;
  } catch (err) {
    // harness failure: close the run out honestly, still clean up, then surface exit code 2
    try {
      const d = ec.store.requireDrill(id);
      if (d.state === "PREFLIGHT" || d.state === "RUNNING" || d.state === "CREATED") {
        insertSkipped(ec, id, steps, 0, "HARNESS_ERROR", true);
        move(ec, id, "FAILED", { outcome: "FAILED", outcome_reason: "HARNESS_ERROR", finished_at: ec.clock.nowIso(), reason: "harness error" });
      }
      if (!cleanedUp) {
        if (sandbox) {
          try {
            resources = sandbox.resources();
            await sandbox.destroy();
            resources = mergeResources(resources, sandbox.resources());
          } catch (e) {
            destroyError = (e as Error).message;
          }
        }
        const d2 = ec.store.requireDrill(id);
        if (d2.state === "FAILED" || d2.state === "ABORTED" || d2.state === "COMPLETE") {
          await finishCleanup(ec, ev, id, provider, isolation, m.runner.provider, resources, "cleanup after harness error", destroyError);
        }
      }
    } catch {
      /* the original error is what the operator needs */
    }
    if (err instanceof HandoffCheckError) throw err;
    throw new HandoffCheckError("INTERNAL", `harness failure: ${(err as Error).message}`);
  }
}

/** True when a run still marked CREATED/PREFLIGHT/RUNNING has an owner process that is provably gone (pid + start time). */
export function ownerGone(store: Store, d: DrillRecord): boolean {
  const owner = store.owner(d.id);
  if (owner === null) return false;
  const table = psTable();
  if (table === null) return false; // cannot check: never assume the owner is dead
  return !sameProcess(owner.pid, owner.started, table);
}

/** Close out an orphaned run: its remaining steps are SKIPPED and the run is ABORTED so cleanup can proceed. */
function abortOrphan(ec: EngineContext, d: DrillRecord): void {
  const manifestEv = ec.store.evidence(d.id).find((e) => e.kind === "manifest");
  const steps = manifestEv ? ((JSON.parse(ec.store.objects.read(manifestEv.sha256).toString("utf8")) as { steps: ManifestStep[] }).steps) : [];
  insertSkipped(ec, d.id, steps, 0, "RUN_ABORTED", true);
  move(ec, d.id, "ABORTED", { outcome: "ABORTED", outcome_reason: "RUN_ABORTED", finished_at: ec.clock.nowIso(), reason: "the owner process is gone; the run was aborted by cleanup" });
}

/** Startup scan: close out and clean every orphaned run in the store. Errors are swallowed: this must never block a new run. */
export async function reapOrphans(ec: EngineContext): Promise<string[]> {
  const reaped: string[] = [];
  for (const d of ec.store.drillsInStates(["CREATED", "PREFLIGHT", "RUNNING"])) {
    if (!ownerGone(ec.store, d)) continue;
    try {
      await retryCleanup(ec, d.id);
      reaped.push(d.id);
    } catch {
      /* leave it for an explicit cleanup */
    }
  }
  return reaped;
}

/** Retry cleanup for an existing run (cleanup --run). Appends a receipt and moves the state. */
export async function retryCleanup(ec: EngineContext, drillId: string): Promise<CleanupReceipt> {
  const d = ec.store.requireDrill(drillId);
  if (d.imported) throw new HandoffCheckError("CONFLICT", `run ${drillId} was imported from a bundle: it has no local resources to clean up`);
  const unfinished = d.state === "CREATED" || d.state === "PREFLIGHT" || d.state === "RUNNING";
  if (unfinished && !ownerGone(ec.store, d)) {
    throw new HandoffCheckError("CONFLICT", `run ${drillId} is ${d.state} and its owner process is still alive (or cannot be checked); cleanup applies only after the run has ended`);
  }
  if (unfinished) abortOrphan(ec, d);
  const latest = ec.store.latestCleanup(drillId);
  if (d.state === "CLEANUP_VERIFIED" && latest) return latest;
  const provider = ec.providers[d.provider] ?? null;
  const resources = latest?.resources ?? [];
  const ev = new EvidenceWriter(ec.store, ec.clock, ec.ids, drillId, new Redactor(ec.store.runSecrets(drillId)));
  let destroyError: string | null = null;
  if (provider && resources.length > 0) {
    try {
      await provider.destroyResources(resources);
    } catch (e) {
      destroyError = (e as Error).message;
    }
  }
  if (latest === null) {
    const inventory = ec.store.latestInventory(drillId);
    if (inventory !== null) {
      // an orphaned run: clean what it provisioned (recorded right after provisioning)
      if (provider && inventory.length > 0) {
        try {
          await provider.destroyResources(inventory);
        } catch (e) {
          destroyError = (e as Error).message;
        }
      }
      return finishCleanup(ec, ev, drillId, provider, d.isolation, d.provider, inventory, "cleanup of an orphaned run from its recorded inventory", destroyError, !provider);
    }
    if (!d.started_at) {
      // the run never reached RUNNING, so nothing was provisioned
      return finishCleanup(ec, ev, drillId, provider, d.isolation, d.provider, [], "the run ended before anything was provisioned", null);
    }
    return finishCleanup(ec, ev, drillId, provider, d.isolation, d.provider, [], "no resource inventory exists for this run, so cleanup cannot be verified", null, true);
  }
  const note = provider ? "cleanup retry" : `provider ${d.provider} is not available; cleanup cannot be verified`;
  return finishCleanup(ec, ev, drillId, provider, d.isolation, d.provider, resources, note, destroyError, !provider);
}
