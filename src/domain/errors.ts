import type { ErrorBody, ErrorCode } from "./types.js";

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  SCHEMA_INVALID: 422,
  POLICY_REJECTED: 422,
  UNSUPPORTED_VERSION: 422,
  BUNDLE_CORRUPT: 422,
  PROVIDER_UNAVAILABLE: 503,
  CONNECTOR_DISCONNECTED: 503,
  INSUFFICIENT_CAPACITY: 507,
  STORE_SCHEMA_UNSUPPORTED: 503,
  INTERNAL: 500
};

/** Harness/usage error. Maps to CLI exit code 2 and the `{error:{code,message,request_id}}` body. */
export class HandoffCheckError extends Error {
  readonly code: ErrorCode;
  /** HTTP-style status from the PRD error table (for the JSON error shape and docs). */
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "HandoffCheckError";
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export function toErrorBody(err: unknown, requestId: string): ErrorBody {
  if (err instanceof HandoffCheckError) {
    return { error: { code: err.code, message: err.message, request_id: requestId } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { error: { code: "INTERNAL", message: `unexpected error: ${message}`, request_id: requestId } };
}

/** Every thrown error is a harness failure: exit code 2. Results (including rejections) use exit code 1. */
export function exitCodeForError(_err: unknown): 2 {
  return 2;
}

/**
 * Live connector operations fail explicitly when disconnected. Adapters call this before any operation that
 * would need a remote service; the deterministic core never calls it.
 */
export function requireConnector(name: string, connected: boolean): void {
  if (!connected) {
    throw new HandoffCheckError("CONNECTOR_DISCONNECTED", `connector "${name}" is disconnected; live operations are not attempted`);
  }
}
