import type { ReportData, Verdict } from "../../src/api.js";

const D = "a".repeat(64);

/** A complete, synthetic ReportData for renderer tests. Everything is a fixed synthetic value. */
export function sampleReport(over: Partial<ReportData> = {}, verdict: Verdict = "REHEARSAL"): ReportData {
  return {
    schema_version: 1,
    generated_at: "2026-01-01T00:00:00.000Z",
    run: {
      id: "run-sample-0001",
      workspace_id: "workspace-sample-0001",
      scenario: { id: "notes-service-handoff", version: "1.0.0" },
      state: "CLEANUP_VERIFIED",
      outcome: "COMPLETE",
      provider: "local-sandbox",
      isolation: "none",
      labels: ["isolation=none: synthetic local sandbox"],
      created_at: "2026-01-01T00:00:00.000Z",
      started_at: "2026-01-01T00:00:01.000Z",
      finished_at: "2026-01-01T00:00:09.000Z",
      imported: false,
      fault_injected: false
    },
    binding: { artifact_digest: D, runbook_hash: D, scenario_version: "1.0.0", manifest_digest: D, binding_digest: D },
    operator: { kind: "automated", ref: "qa-harness", builder_ref: "fixture-builder" },
    verdict: {
      verdict,
      steps_and_cleanup_pass: verdict === "REHEARSAL" || verdict === "INDEPENDENT_PASS",
      independent: verdict === "INDEPENDENT_PASS",
      exit_code: verdict === "REHEARSAL" || verdict === "INDEPENDENT_PASS" ? 0 : 1,
      reasons: [{ code: "ISOLATION_NONE", message: "isolation none cannot satisfy a VM-isolation criterion" }],
      human_receipt: "PENDING_HUMAN_RECEIPT",
      binding_check: "NOT_CHECKED"
    },
    preflight: {
      schema_version: 1,
      status: "PASS",
      provider: "local-sandbox",
      isolation: "none",
      findings: [],
      checked: { manifest: true, scripts: 9, artifact_entries: 20, runbook: true }
    },
    steps: [
      {
        step_key: "install",
        action: "install",
        mandatory: true,
        status: "PASS",
        reason_code: "OK",
        deadline_seconds: 60,
        started_at: "2026-01-01T00:00:01.000Z",
        finished_at: "2026-01-01T00:00:02.000Z",
        duration_ms: 1000,
        evidence_hash: D,
        checks: [{ name: "health probe", status: "PASS", expected: "exit 0", actual: "exit 0" }],
        intervention_ids: []
      }
    ],
    interventions: [],
    evidence: [{ id: "e1", kind: "step_receipt", step_key: "install", sha256: D, media_type: "application/json", size_bytes: 10, redacted: true }],
    cleanup: { status: "VERIFIED", verified_at: "2026-01-01T00:00:10.000Z", resources: [{ kind: "directory", id: "sandbox-dir", state: "removed" }], note: null },
    state_history: [{ seq: 1, from_state: null, to_state: "CREATED", reason: null, at: "2026-01-01T00:00:00.000Z" }],
    ...over
  };
}
