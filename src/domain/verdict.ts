import { normalizeRef } from "./refs.js";
import type { AcceptanceInput, ReasonCode, RunState, Verdict, VerdictReason, VerdictResult } from "./types.js";

/** The four PRD actions: an accepting drill needs a passing mandatory step for each. */
const REQUIRED_ACTIONS = ["install", "restore", "rotate", "recover"] as const;
const PRE_CLEANUP: readonly RunState[] = ["CREATED", "PREFLIGHT", "RUNNING"];

function result(verdict: Verdict, reasons: VerdictReason[], input: AcceptanceInput, independent = false): VerdictResult {
  const passes = verdict === "INDEPENDENT_PASS" || verdict === "REHEARSAL";
  return {
    verdict,
    steps_and_cleanup_pass: passes,
    independent,
    exit_code: passes ? 0 : 1,
    reasons,
    human_receipt: independent ? "HARNESS_RECORDED" : "PENDING_HUMAN_RECEIPT",
    binding_check: input.binding_check
  };
}

function r(code: ReasonCode, message: string): VerdictReason {
  return { code, message };
}

/**
 * The acceptance decision (PRD "Acceptance decision" diagram): completion and acceptance are separate and
 * uncertainty never becomes success. Pure; evaluated at read time so late interventions still count.
 * First matching rule wins; see docs/DESIGN.md section 6.
 */
export function evaluateAcceptance(input: AcceptanceInput): VerdictResult {
  if (input.evidence_verified === false) {
    return result("UNKNOWN", [r("EVIDENCE_UNVERIFIABLE", "stored evidence is missing or fails its sha256 check: the result cannot be trusted")], input);
  }
  if (input.imported === true) {
    return result("UNKNOWN", [r("IMPORT_UNAUTHENTICATED", "imported from a bundle: hashes prove integrity, not provenance, so no accepting verdict is derived locally; see claimed_verdict (display only)")], input);
  }
  if (input.provider_blocked) {
    return result("BLOCKED", [r("PROVIDER_UNAVAILABLE", "the runner provider is unavailable; nothing was executed and nothing is accepted")], input);
  }
  if (input.preflight_rejected) {
    return result("FAIL", [r("PREFLIGHT_REJECTED", "preflight rejected the drill inputs; no workload was executed")], input);
  }
  if (input.binding_check === "MISMATCH") {
    return result("UNKNOWN", [r("STALE_BINDING", "the artifact, runbook, scenario version or manifest changed since this result: it cannot be reused")], input);
  }
  if (PRE_CLEANUP.includes(input.state)) {
    return result("UNKNOWN", [r("RUN_NOT_FINISHED", `the run is still ${input.state}; no result exists yet`)], input);
  }
  if (input.outcome === "ABORTED") {
    return input.outcome_reason === "RUN_TIMEOUT"
      ? result("FAIL", [r("RUN_TIMEOUT", "the run exceeded its wall-clock limit and was aborted")], input)
      : result("FAIL", [r("RUN_ABORTED", "the run was aborted before completion")], input);
  }

  const mandatory = input.steps.filter((s) => s.mandatory);
  const failing = mandatory.filter((s) => s.status === "FAIL" || s.status === "TIMEOUT" || s.status === "ERROR");
  const reasons: VerdictReason[] = [];
  if (failing.length > 0) {
    const timedOut = failing.some((s) => s.status === "TIMEOUT");
    const errored = failing.some((s) => s.status === "ERROR");
    reasons.push(
      r(timedOut ? "MANDATORY_STEP_TIMEOUT" : errored ? "MANDATORY_STEP_ERROR" : "MANDATORY_STEP_FAILED", `${failing.length} mandatory step(s) did not pass`)
    );
  }
  if (mandatory.length === 0) {
    reasons.push(r("NO_MANDATORY_STEPS", "the drill has no mandatory step, so nothing was required to pass: that can never be an accepting result"));
  }
  const withActions = input.steps.filter((s) => s.action !== undefined);
  if (withActions.length === input.steps.length && input.steps.length > 0) {
    const passed = new Set(mandatory.filter((s) => s.status === "PASS").map((s) => s.action));
    const missing = REQUIRED_ACTIONS.filter((a) => !passed.has(a));
    if (missing.length > 0 && failing.length === 0) {
      reasons.push(r("REQUIRED_ACTION_NOT_PASSED", `no passing mandatory step for: ${missing.join(", ")}`));
    }
  }
  const notRun = mandatory.filter((s) => s.status === "SKIPPED").length + Math.max(0, input.planned_steps - input.steps.length);
  if (notRun > 0) reasons.push(r("MANDATORY_STEP_NOT_RUN", `${notRun} planned step(s) did not run: a partial drill never passes`));
  if (input.cleanup === "UNCONFIRMED") reasons.push(r("CLEANUP_UNCONFIRMED", "cleanup could not be confirmed: resources may have leaked"));
  if (input.cleanup === null) reasons.push(r("CLEANUP_MISSING", "no cleanup receipt exists for this run"));

  // a run that ended FAILED (harness error, ...) or carries any outcome reason other than OK is never accepting, even when
  // every recorded step passed and cleanup verified
  const badOutcome = input.outcome === "FAILED" || (input.outcome_reason !== undefined && input.outcome_reason !== null && input.outcome_reason !== "OK");
  if (badOutcome && failing.length === 0) {
    const code = input.outcome_reason && input.outcome_reason !== "OK" ? input.outcome_reason : "HARNESS_ERROR";
    reasons.push(r(code, `the run ended ${input.outcome ?? "without an outcome"} (${code}): it cannot be accepted`));
  }

  if (reasons.length > 0) {
    const definite = failing.length > 0 || input.cleanup === "UNCONFIRMED" || badOutcome;
    return result(definite ? "FAIL" : "UNKNOWN", reasons, input);
  }

  // every mandatory step and cleanup passed
  if (input.interventions > 0) {
    return result("ASSISTED", [r("INTERVENTION_RECORDED", `${input.interventions} intervention(s) recorded: the drill was assisted, never independent`)], input);
  }
  if (input.operator.kind === "ai_assisted") {
    return result("ASSISTED", [r("OPERATOR_NOT_HUMAN", "AI-assisted rehearsal: labelled assisted, it cannot satisfy the independent criterion")], input);
  }
  const rehearsal: VerdictReason[] = [];
  const optionalFailed = input.steps.filter((s) => !s.mandatory && (s.status === "FAIL" || s.status === "TIMEOUT" || s.status === "ERROR")).length;
  if (optionalFailed > 0) {
    rehearsal.push(r("OPTIONAL_STEP_FAILED", `${optionalFailed} optional step(s) failed: the result is flagged and can never be an independent pass`));
  }
  const ref = normalizeRef(input.operator.ref);
  const builder = normalizeRef(input.operator.builder_ref);
  if (input.operator.kind === "automated") rehearsal.push(r("OPERATOR_NOT_HUMAN", "automated harness run: a rehearsal, not an independent human drill"));
  if (input.isolation !== "vm") rehearsal.push(r("ISOLATION_NONE", "isolation=none: this run can never satisfy a VM-isolation criterion"));
  if (input.operator.kind === "human") {
    if (builder === "" || ref === "") rehearsal.push(r("OPERATOR_INDEPENDENCE_UNPROVEN", "no operator or builder identity was recorded, so the operator cannot be shown to differ from the builder"));
    else if (builder === ref) rehearsal.push(r("OPERATOR_IS_BUILDER", "the operator is the builder: not independent"));
  }
  if (rehearsal.length > 0) return result("REHEARSAL", rehearsal, input);
  return result(
    "INDEPENDENT_PASS",
    [r("OK", "operator-attested by the local identity as a human distinct from the builder (not third-party attestation); VM isolation, no interventions, all mandatory steps and cleanup passed. AC-08 additionally needs a human receipt")],
    input,
    true
  );
}
