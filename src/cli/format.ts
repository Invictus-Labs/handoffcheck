import type { RunResult, ReportData } from "../api.js";
import type { WrittenReports } from "./common.js";

/** Strip control characters so hostile text from a manifest or intervention cannot drive the terminal. */
export function plain(value: unknown): string {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "?");
}

const VERDICT_NOTE: Record<string, string> = {
  INDEPENDENT_PASS: "all mandatory steps and cleanup succeeded with no help; the human drill receipt is a separate document",
  ASSISTED: "help was recorded or the operator was AI-assisted; labelled rehearsal, not a handoff result",
  REHEARSAL: "steps and cleanup succeeded, but this is a rehearsal, not an independent handoff result: the operator was automated, was not shown to differ from the builder, isolation was not a VM, or an optional step failed (flagged, never an independent pass)",
  FAIL: "a mandatory step or the cleanup check did not succeed",
  BLOCKED: "a required provider is unavailable; nothing was faked",
  UNKNOWN: "outcome is partial, stale or undetermined; unknown is never success"
};

export function formatRunResult(result: RunResult, reports?: WrittenReports): string {
  const lines: string[] = [];
  lines.push(`run ${plain(result.run_id)}`);
  lines.push(`state:     ${plain(result.state)}${result.outcome ? ` (outcome ${plain(result.outcome)})` : ""}`);
  lines.push(`verdict:   ${plain(result.verdict.verdict)} - ${VERDICT_NOTE[result.verdict.verdict] ?? "see reasons"}`);
  lines.push(`provider:  ${plain(result.provider)} (isolation: ${plain(result.isolation)})`);
  if (result.isolation === "none") lines.push("           isolation none: synthetic local sandbox, cannot satisfy a VM-isolation criterion");
  lines.push(`binding:   ${plain(result.binding.binding_digest)}`);
  if (result.preflight) lines.push(`preflight: ${plain(result.preflight.status)}`);
  for (const f of result.preflight?.status === "REJECTED" ? result.preflight.findings : []) {
    lines.push(`  ${plain(f.severity)} ${plain(f.code)} at ${plain(f.location)}: ${plain(f.message)}`);
    if (f.code === "HOST_SANDBOX_NOT_ALLOWED") lines.push("  hint: scripts run directly on this host with the local-sandbox provider; pass --allow-host-sandbox only for scripts you trust");
  }
  if (result.steps.length > 0) {
    lines.push("steps:");
    for (const s of result.steps) lines.push(`  ${plain(s.step_key).padEnd(24)} ${plain(s.action).padEnd(8)} ${plain(s.status).padEnd(8)} ${plain(s.reason_code)}`);
  } else {
    lines.push("steps:     none ran");
  }
  lines.push(`cleanup:   ${plain(result.cleanup.status)} (${result.cleanup.resources} resource(s), ${result.cleanup.leaked} leaked)`);
  for (const r of result.verdict.reasons) lines.push(`reason:    ${plain(r.code)}: ${plain(r.message)}`);
  if (result.verdict.human_receipt === "PENDING_HUMAN_RECEIPT") lines.push("receipt:   PENDING_HUMAN_RECEIPT (a human drill receipt is still required)");
  if (reports?.html) lines.push(`report:    ${reports.html}`);
  if (reports?.json) lines.push(`           ${reports.json}`);
  lines.push(`exit code: ${result.exit_code}`);
  return `${lines.join("\n")}\n`;
}

export function formatReportSummary(data: ReportData, reports: WrittenReports): string {
  const lines = [
    `run ${plain(data.run.id)}`,
    `verdict:   ${plain(data.verdict.verdict)} (exit code ${data.verdict.exit_code})`,
    `state:     ${plain(data.run.state)}`,
    `cleanup:   ${plain(data.cleanup.status)}`,
    `steps:     ${data.steps.length}, interventions: ${data.interventions.length}, evidence: ${data.evidence.length}`
  ];
  if (data.claimed_verdict) lines.push(`claimed:    ${plain(data.claimed_verdict.verdict)} (claimed by the imported bundle; unauthenticated, display only)`);
  if (reports.html) lines.push(`html:      ${reports.html}`);
  if (reports.json) lines.push(`json:      ${reports.json}`);
  return `${lines.join("\n")}\n`;
}
