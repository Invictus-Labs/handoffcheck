import { readFileSync, statSync } from "node:fs";
import {
  AdapterError,
  MAX_BATCH_ENVELOPES,
  MAX_ENVELOPE_BYTES,
  canonicalEnvelope,
  sha256Hex,
  validateEnvelope,
  type AdapterErrorCode,
  type Envelope
} from "./envelope.js";
import { loadLedger, saveLedger, type AcceptanceRecord, type AcceptanceState, type Ledger } from "./ledger.js";
import { assertEnabled } from "./gate.js";

const ACCEPTANCE_PREFIX = "acceptance.";
const CLAIMABLE: readonly AcceptanceState[] = ["accepted", "rejected", "unknown", "partial", "stale"];
const SHA_REF = /^sha256:([0-9a-f]{64})$/;

export type ImportStatus = "applied" | "duplicate" | "stale" | "rejected";

export interface ImportResult {
  event_id: string | null;
  status: ImportStatus;
  /** Present for rejected events. */
  code?: AdapterErrorCode;
  reason: string;
  resource_id?: string;
  effective_state?: AcceptanceState;
}

export interface ImportAcceptanceInput {
  enabled: boolean;
  stateDir: string;
  /** Path to a JSON file holding one envelope or an array of envelopes (delivery is at-least-once). */
  file: string;
  /**
   * The run's OWN current state, read from the evidence store by the caller. An "accepted" claim is only
   * honoured when this says the run's verdict is accepting and unchanged since the receipt was exported.
   * Undefined means the run cannot be read: the claim is downgraded to unknown.
   */
  runState?: (resourceId: string) => RunState | undefined;
}

export interface RunState {
  /** The run's effective verdict as the harness computes it now (never a sender's claim). */
  verdict: string;
  /** True only for a verdict that counts as an accepted independent result. */
  accepting: boolean;
  /** Revision of the run now, computed the same way as when the receipt was exported. */
  revision: number;
}

export interface ImportAcceptanceOutput {
  results: ImportResult[];
  applied: number;
  duplicates: number;
  stale: number;
  rejected: number;
}

/**
 * Decide the effective acceptance state. A sender's "accepted" is honoured only when ALL of these hold:
 *   1. a receipt for this run was exported here and the acceptance answers that exact receipt (correlation_id);
 *   2. evidence_ref is a sha256 pin equal to the digest of the report we exported (file: refs are not hash-pinned,
 *      so they never verify anything);
 *   3. the run has not changed since that receipt (same revision); and
 *   4. the run's OWN verdict is accepting. A failed, ASSISTED, REHEARSAL, UNKNOWN or imported run is never accepted,
 *      whatever the sender says.
 * Anything else is downgraded with the reason stated. Nothing here claims a check that did not happen.
 */
function effectiveAcceptance(claimed: AcceptanceState, envelope: Envelope, ledger: Ledger, runState: RunState | undefined): AcceptanceRecord {
  const base = { claimed, event_id: envelope.event_id, revision: envelope.revision, run_verdict: runState?.verdict ?? null };
  if (claimed !== "accepted") return { ...base, state: claimed, reason: `sender reported ${claimed}` };
  const head = ledger.exports[envelope.resource_id];
  if (!head) return { ...base, state: "unknown", reason: "no receipt for this run was exported here; cannot confirm what was accepted" };
  if (envelope.correlation_id !== head.event_id) {
    return { ...base, state: "stale", reason: "acceptance does not answer the newest exported receipt (correlation_id mismatch)" };
  }
  const pin = SHA_REF.exec(envelope.evidence_ref);
  if (!pin) return { ...base, state: "unknown", reason: "evidence_ref is not a sha256 pin; nothing was verified" };
  if (pin[1] !== head.report_sha256) {
    return { ...base, state: "unknown", reason: "evidence digest does not match the report exported for this receipt" };
  }
  if (!runState) return { ...base, state: "unknown", reason: "the run's own verdict could not be read; the accepted claim is not honoured" };
  if (runState.revision !== head.revision) {
    return { ...base, state: "stale", reason: "the run changed after this receipt was exported; export a new receipt" };
  }
  if (!runState.accepting) {
    return { ...base, state: "unknown", reason: `the run's own verdict is ${runState.verdict}, which is not an accepting verdict; the accepted claim is not honoured` };
  }
  return { ...base, state: "accepted", reason: "accepted claim matches the exported report digest and the run's own verdict is accepting" };
}

function applyOne(raw: unknown, runState: (resourceId: string) => RunState | undefined, ledger: Ledger): ImportResult {
  let envelope: Envelope;
  try {
    envelope = validateEnvelope(raw);
  } catch (err) {
    const e = err as AdapterError;
    const id = raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).event_id === "string" ? String((raw as Record<string, unknown>).event_id) : null;
    return { event_id: id, status: "rejected", code: e.code ?? "SCHEMA_INVALID", reason: e.message };
  }

  if (!envelope.event_type.startsWith(ACCEPTANCE_PREFIX)) {
    return { event_id: envelope.event_id, status: "rejected", code: "SCHEMA_INVALID", reason: `event_type must start with ${ACCEPTANCE_PREFIX}` };
  }
  const claimed = envelope.event_type.slice(ACCEPTANCE_PREFIX.length) as AcceptanceState;
  if (!CLAIMABLE.includes(claimed)) {
    return { event_id: envelope.event_id, status: "rejected", code: "SCHEMA_INVALID", reason: `unsupported acceptance event_type ${envelope.event_type}` };
  }

  // At-least-once delivery: the same event_id with the same bytes is a no-op; different bytes is a conflict.
  const payloadHash = sha256Hex(canonicalEnvelope(envelope));
  const seen = ledger.seen[envelope.event_id];
  if (seen) {
    if (seen.payload_sha256 === payloadHash) {
      return { event_id: envelope.event_id, status: "duplicate", reason: "event_id already processed", resource_id: envelope.resource_id };
    }
    return { event_id: envelope.event_id, status: "rejected", code: "CONFLICT", reason: "event_id was already received with a different payload" };
  }

  // Ordering: only a strictly newer revision of a stream may change state; old events never rewind it.
  const streamKey = `${envelope.source}/${envelope.resource_id}`;
  const head = ledger.streams[streamKey];
  if (head && envelope.revision <= head.revision) {
    ledger.seen[envelope.event_id] = { payload_sha256: payloadHash, disposition: "stale" };
    return {
      event_id: envelope.event_id,
      status: "stale",
      reason: `revision ${envelope.revision} is not newer than applied revision ${head.revision}; state unchanged`,
      resource_id: envelope.resource_id,
      };
  }

  const record = effectiveAcceptance(claimed, envelope, ledger, claimed === "accepted" ? runState(envelope.resource_id) : undefined);
  ledger.seen[envelope.event_id] = { payload_sha256: payloadHash, disposition: "applied" };
  ledger.streams[streamKey] = { revision: envelope.revision, event_id: envelope.event_id };
  ledger.acceptance[envelope.resource_id] = record;
  return {
    event_id: envelope.event_id,
    status: "applied",
    reason: record.reason,
    resource_id: envelope.resource_id,
    effective_state: record.state,
  };
}

/** ProofGate-style acceptance import from a local file. Disabled by default; never touches the network. */
export function importAcceptance(input: ImportAcceptanceInput): ImportAcceptanceOutput {
  assertEnabled(input.enabled);
  let text: string;
  try {
    const size = statSync(input.file).size;
    if (size > MAX_ENVELOPE_BYTES * MAX_BATCH_ENVELOPES) {
      throw new AdapterError("PAYLOAD_TOO_LARGE", "acceptance file exceeds the size limit");
    }
    text = readFileSync(input.file, "utf8");
  } catch (err) {
    if (err instanceof AdapterError) throw err;
    throw new AdapterError("BAD_REQUEST", `cannot read acceptance file: ${(err as NodeJS.ErrnoException).code ?? "error"}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AdapterError("SCHEMA_INVALID", "acceptance file is not valid JSON");
  }
  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  if (items.length === 0) throw new AdapterError("SCHEMA_INVALID", "acceptance file holds no envelopes");
  if (items.length > MAX_BATCH_ENVELOPES) throw new AdapterError("PAYLOAD_TOO_LARGE", `more than ${MAX_BATCH_ENVELOPES} envelopes in one file`);

  const ledger = loadLedger(input.stateDir);
  const results = items.map((item) => applyOne(item, input.runState ?? (() => undefined), ledger));
  // One atomic ledger write for the whole batch; a crash before this leaves the previous state intact.
  saveLedger(input.stateDir, ledger);
  const count = (s: ImportStatus): number => results.filter((r) => r.status === s).length;
  return { results, applied: count("applied"), duplicates: count("duplicate"), stale: count("stale"), rejected: count("rejected") };
}

/** Effective acceptance for a run, or undefined if nothing was imported. Used for report notices only. */
export function readAcceptance(stateDir: string, runId: string): AcceptanceRecord | undefined {
  return loadLedger(stateDir).acceptance[runId];
}
