import type { Store } from "../store/store.js";
import { evaluateAcceptance } from "./verdict.js";
import { SCHEMA_VERSION } from "./types.js";
import type {
  Binding,
  BindingCheck,
  Clock,
  DrillRecord,
  PreflightReport,
  ReportData,
  StepReport,
  VerdictResult
} from "./types.js";

function readJson<T>(store: Store, sha: string): T | null {
  try {
    return JSON.parse(store.objects.read(sha).toString("utf8")) as T;
  } catch {
    return null;
  }
}

export function bindingOf(d: DrillRecord): Binding {
  return {
    artifact_digest: d.artifact_digest,
    runbook_hash: d.runbook_hash,
    scenario_version: d.scenario_version,
    manifest_digest: d.manifest_digest,
    binding_digest: d.binding_digest
  };
}

/** Derive the verdict from stored facts at read time, so late interventions and changed inputs are always reflected. */
export function deriveVerdict(store: Store, d: DrillRecord, bindingCheck: BindingCheck): VerdictResult {
  const steps = store.steps(d.id);
  const cleanup = store.latestCleanup(d.id);
  return evaluateAcceptance({
    state: d.state,
    outcome: d.outcome,
    outcome_reason: d.outcome_reason,
    provider_blocked: d.outcome_reason === "PROVIDER_UNAVAILABLE",
    preflight_rejected: d.outcome_reason === "PREFLIGHT_REJECTED",
    binding_check: bindingCheck,
    imported: d.imported,
    evidence_verified: store.evidenceProblems(d.id).length === 0,
    steps: steps.map((s) => ({ mandatory: s.mandatory, status: s.status, action: s.action })),
    planned_steps: d.planned_steps || steps.length, // 0 only for records written before the count existed
    cleanup: cleanup?.status ?? null,
    operator: { kind: d.operator_kind, ref: d.operator_ref, ...(d.builder_ref !== null ? { builder_ref: d.builder_ref } : {}) },
    isolation: d.isolation,
    interventions: store.interventions(d.id).length
  });
}

export function labelsFor(d: DrillRecord, v: VerdictResult, facts: Record<string, string> = {}, cleanupDetails: string[] = []): string[] {
  const labels: string[] = [];
  if (facts["egress"]) labels.push(`egress: ${facts["egress"]}`);
  const partialScan = cleanupDetails.find((x) => x.startsWith("process_scan: PARTIAL"));
  if (partialScan) labels.push(partialScan.split(";")[0] as string);
  if (d.isolation === "none") labels.push("isolation=none: host-local synthetic sandbox, not a VM; it can never satisfy a VM-isolation criterion");
  if (d.operator_kind === "ai_assisted") labels.push("AI-assisted rehearsal: labelled ASSISTED, not independent");
  if (d.operator_kind === "automated") labels.push("automated rehearsal: harness-driven, not an independent human drill");
  if (d.imported) labels.push("imported from an evidence bundle: integrity verified, provenance NOT authenticated; the effective verdict is UNKNOWN and the bundle's own verdict is shown only as claimed_verdict");
  if (d.fault_injected) labels.push("fault injected: negative-control run (test only)");
  if (v.verdict === "BLOCKED") labels.push("BLOCKED: the required runner is unavailable; nothing was executed and nothing is accepted");
  if (v.verdict === "UNKNOWN") labels.push("UNKNOWN: uncertain or partial results never count as success");
  labels.push(v.human_receipt === "PENDING_HUMAN_RECEIPT" ? "AC-08 human receipt: PENDING_HUMAN_RECEIPT" : "AC-08 harness record present; the human receipt itself is still a human artifact");
  return labels;
}

function runFacts(store: Store, evidence: { kind: string; sha256: string }[]): Record<string, string> {
  const rr = evidence.find((e) => e.kind === "run_receipt");
  const doc = rr ? readJson<{ facts?: Record<string, string> }>(store, rr.sha256) : null;
  return doc?.facts ?? {};
}

export function buildReport(store: Store, clock: Clock, drillId: string, bindingCheck: BindingCheck): ReportData {
  const d = store.requireDrill(drillId);
  const verdict = deriveVerdict(store, d, bindingCheck);
  const interventions = store.interventions(drillId);
  const evidence = store.evidence(drillId);
  const preflightEv = evidence.find((e) => e.kind === "preflight_report");
  const preflight = preflightEv ? readJson<PreflightReport>(store, preflightEv.sha256) : null;
  const cleanup = store.latestCleanup(drillId);

  const steps: StepReport[] = store.steps(drillId).map((s) => {
    const receipt = s.evidence_hash ? readJson<{ checks?: StepReport["checks"] }>(store, s.evidence_hash) : null;
    return {
      step_key: s.step_key,
      action: s.action,
      mandatory: s.mandatory,
      status: s.status,
      reason_code: s.reason_code,
      deadline_seconds: s.deadline_seconds,
      started_at: s.started_at,
      finished_at: s.finished_at,
      duration_ms: s.duration_ms,
      evidence_hash: s.evidence_hash,
      checks: receipt?.checks ?? [],
      intervention_ids: interventions
        .filter((i) => i.step_key === s.step_key || (s.started_at !== null && s.finished_at !== null && i.occurred_at >= s.started_at && i.occurred_at <= s.finished_at))
        .map((i) => i.id)
    };
  });

  return {
    schema_version: SCHEMA_VERSION,
    generated_at: clock.nowIso(),
    run: {
      id: d.id,
      workspace_id: d.workspace_id,
      scenario: { id: d.scenario_id, version: d.scenario_version },
      state: d.state,
      outcome: d.outcome,
      provider: d.provider,
      isolation: d.isolation,
      labels: labelsFor(d, verdict, runFacts(store, evidence), (cleanup?.resources ?? []).map((r) => r.detail ?? "")),
      created_at: d.created_at,
      started_at: d.started_at,
      finished_at: d.finished_at,
      imported: d.imported,
      fault_injected: d.fault_injected
    },
    binding: bindingOf(d),
    operator: { kind: d.operator_kind, ref: d.operator_ref, ...(d.builder_ref !== null ? { builder_ref: d.builder_ref } : {}) },
    verdict,
    claimed_verdict: d.imported ? store.importClaim(d.id) : null,
    preflight,
    steps,
    interventions: interventions.map((i) => ({ id: i.id, actor_ref: i.actor_ref, reason: i.reason, occurred_at: i.occurred_at, step_key: i.step_key })),
    evidence: evidence.map((e) => ({ id: e.id, kind: e.kind, step_key: e.step_key, sha256: e.sha256, media_type: e.media_type, size_bytes: e.size_bytes, redacted: e.redacted })),
    cleanup: {
      status: cleanup?.status ?? "MISSING",
      verified_at: cleanup?.verified_at ?? null,
      resources: (cleanup?.resources ?? []).map((r) => ({ kind: r.kind, id: r.id, state: r.state, ...(r.detail ? { detail: r.detail } : {}) })),
      note: cleanup?.note ?? null
    },
    state_history: store.history(drillId)
  };
}
