import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AdapterError,
  ENVELOPE_SCHEMA_VERSION,
  deriveEventId,
  sha256Hex,
  validateEnvelope,
  type Envelope
} from "./envelope.js";
import { ensurePrivateDir, loadLedger, saveLedger } from "./ledger.js";
import { assertEnabled } from "./gate.js";

export const RECEIPT_SOURCE = "handoffcheck";
export const RECEIPT_EVENT_TYPE = "receipt.exported";

export interface ExportReceiptInput {
  /** Must be true; adapters are disabled by default. */
  enabled: boolean;
  /** Directory where adapter state (dedupe ledger) lives. */
  stateDir: string;
  /** Directory the receipt files are written to (created owner-only). */
  outDir: string;
  runId: string;
  /** Monotonic revision of the run's evidence (grows whenever evidence, steps or interventions change). */
  revision: number;
  /** Redacted JSON report body. Its sha256 becomes the envelope evidence_ref. */
  reportJson: string;
  occurredAt: string;
}

export interface ExportReceiptResult {
  envelope: Envelope;
  envelopePath: string;
  reportPath: string;
}

/**
 * RunProof-style receipt export: two local files, no network.
 *   <out>/<sha256>.json                        the redacted JSON report (content-addressed)
 *   <out>/receipt-<run>-r<revision>.envelope.json   the versioned envelope pointing at it
 */
export function exportReceipt(input: ExportReceiptInput): ExportReceiptResult {
  assertEnabled(input.enabled);
  const ledger = loadLedger(input.stateDir);
  ledger.receipt_nonce ??= randomBytes(16).toString("hex");
  const digest = sha256Hex(input.reportJson);
  const envelope = validateEnvelope({
    schema_version: ENVELOPE_SCHEMA_VERSION,
    event_id: deriveEventId(RECEIPT_SOURCE, input.runId, RECEIPT_EVENT_TYPE, input.revision, ledger.receipt_nonce),
    source: RECEIPT_SOURCE,
    resource_id: input.runId,
    event_type: RECEIPT_EVENT_TYPE,
    occurred_at: input.occurredAt,
    revision: input.revision,
    evidence_ref: `sha256:${digest}`
  });

  const reportPath = join(input.outDir, `${digest}.json`);
  const envelopePath = join(input.outDir, `receipt-${input.runId}-r${input.revision}.envelope.json`);
  ensurePrivateDir(input.outDir);
  try {
    writeFileSync(reportPath, input.reportJson, { mode: 0o600 });
    writeFileSync(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    throw new AdapterError("BAD_REQUEST", `could not write receipt files: ${(err as NodeJS.ErrnoException).code ?? "io error"}`);
  }

  // Remember the newest receipt per run, with the digest of the exact report it points at, so a later
  // acceptance can be bound to it. The nonce is persisted even when this is not the newest revision.
  const head = ledger.exports[input.runId];
  if (!head || head.revision <= input.revision) {
    ledger.exports[input.runId] = { event_id: envelope.event_id, revision: input.revision, report_sha256: digest };
  }
  saveLedger(input.stateDir, ledger);
  return { envelope, envelopePath, reportPath };
}
