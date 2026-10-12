import { createHash } from "node:crypto";

/**
 * Versioned adapter envelope (PRD "Ecosystem adapter boundary").
 *
 *   { schema_version: 1, event_id, source, resource_id, event_type, occurred_at,
 *     revision, evidence_ref, correlation_id? }
 *
 * The envelope is pure data. Nothing in it is ever executed, fetched or resolved over a
 * network: `evidence_ref` is either `sha256:<hex>` or a safe relative local path
 * (`file:<path>`), never a URL.
 */

export const ENVELOPE_SCHEMA_VERSION = 1 as const;
export const SUPPORTED_MAJOR = 1;
export const MAX_ENVELOPE_BYTES = 64 * 1024;
export const MAX_BATCH_ENVELOPES = 1000;

export interface Envelope {
  schema_version: 1;
  event_id: string;
  source: string;
  resource_id: string;
  event_type: string;
  occurred_at: string;
  revision: number;
  evidence_ref: string;
  correlation_id?: string;
}

/**
 * Adapter errors use the domain ErrorCode set (schemas/error.schema.json) so the CLI can emit them unchanged:
 *   CONNECTOR_DISCONNECTED  adapters are disabled (not opted in)
 *   SCHEMA_INVALID          malformed envelope or file
 *   UNSUPPORTED_VERSION     schema_version major is not supported
 *   PAYLOAD_TOO_LARGE       envelope, file or ledger over its limit
 *   CONFLICT                same event_id seen with a different payload
 *   POLICY_REJECTED         unsafe evidence_ref (URL, absolute path, parent segment)
 *   BAD_REQUEST             unreadable input file
 *   INTERNAL                corrupt local ledger
 */
export type AdapterErrorCode =
  | "CONNECTOR_DISCONNECTED"
  | "SCHEMA_INVALID"
  | "UNSUPPORTED_VERSION"
  | "PAYLOAD_TOO_LARGE"
  | "CONFLICT"
  | "POLICY_REJECTED"
  | "BAD_REQUEST"
  | "INTERNAL";

export class AdapterError extends Error {
  constructor(
    readonly code: AdapterErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const SOURCE_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const EVENT_TYPE_RE = /^[a-z][a-z0-9_.]{0,63}$/;
const MAX_REF = 512;
const SHA_REF_RE = /^sha256:[0-9a-f]{64}$/;
const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const KNOWN_FIELDS = new Set([
  "schema_version",
  "event_id",
  "source",
  "resource_id",
  "event_type",
  "occurred_at",
  "revision",
  "evidence_ref",
  "correlation_id"
]);

export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 255) return false;
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) return false;
  if (path.includes("\\") || path.includes("\0")) return false;
  return path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

export function validateEvidenceRef(ref: unknown): string {
  if (typeof ref !== "string" || ref.length > MAX_REF) throw new AdapterError("SCHEMA_INVALID", "evidence_ref must be a string of at most 512 characters");
  if (SHA_REF_RE.test(ref)) return ref;
  if (ref.startsWith("file:") && isSafeRelativePath(ref.slice(5))) return ref;
  throw new AdapterError(
    "POLICY_REJECTED",
    "evidence_ref must be sha256:<64 hex> or file:<safe relative path>; URLs and absolute or parent paths are rejected"
  );
}

/** Validate an untrusted value as an envelope. Unknown extra fields are rejected (the shipped schema is closed); nothing in an envelope is ever executed. */
export function validateEnvelope(input: unknown): Envelope {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new AdapterError("SCHEMA_INVALID", "envelope must be a JSON object");
  }
  const raw = input as Record<string, unknown>;

  const version = raw.schema_version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    throw new AdapterError("SCHEMA_INVALID", "schema_version is missing or not an integer");
  }
  if (version !== SUPPORTED_MAJOR) {
    throw new AdapterError("UNSUPPORTED_VERSION", `unsupported schema_version ${version}; this build supports ${SUPPORTED_MAJOR}`);
  }
  const extra = unknownFields(raw);
  if (extra.length > 0) throw new AdapterError("SCHEMA_INVALID", `unknown field(s): ${extra.slice(0, 5).join(", ")}`);

  const str = (key: string, re: RegExp): string => {
    const v = raw[key];
    if (typeof v !== "string" || !re.test(v)) throw new AdapterError("SCHEMA_INVALID", `${key} is missing or malformed`);
    return v;
  };

  const occurred = str("occurred_at", UTC_RE);
  if (Number.isNaN(Date.parse(occurred))) throw new AdapterError("SCHEMA_INVALID", "occurred_at is not a valid UTC timestamp");

  const revision = raw.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    throw new AdapterError("SCHEMA_INVALID", "revision must be a non-negative integer");
  }

  const envelope: Envelope = {
    schema_version: ENVELOPE_SCHEMA_VERSION,
    event_id: str("event_id", ID_RE),
    source: str("source", SOURCE_RE),
    resource_id: str("resource_id", ID_RE),
    event_type: str("event_type", EVENT_TYPE_RE),
    occurred_at: occurred,
    revision,
    evidence_ref: validateEvidenceRef(raw.evidence_ref)
  };
  if (raw.correlation_id !== undefined) envelope.correlation_id = str("correlation_id", ID_RE);
  return envelope;
}

/** Names of fields present on the input that this schema version does not define. */
export function unknownFields(input: unknown): string[] {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return [];
  return Object.keys(input as Record<string, unknown>).filter((k) => !KNOWN_FIELDS.has(k));
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Event id for a receipt: stable for the same store, resource and revision (so consumers dedupe a re-export),
 * but mixed with a random per-store nonce so it cannot be computed by someone who has not seen the receipt.
 */
export function deriveEventId(source: string, resourceId: string, eventType: string, revision: number, nonce = ""): string {
  return `${source}-${sha256Hex(`${nonce}\n${source}\n${resourceId}\n${eventType}\n${revision}`).slice(0, 32)}`;
}

/** Canonical bytes of an envelope (sorted keys, no whitespace) used for dedupe payload comparison. */
export function canonicalEnvelope(envelope: Envelope): string {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(envelope).sort()) out[key] = (envelope as unknown as Record<string, unknown>)[key];
  return JSON.stringify(out);
}
