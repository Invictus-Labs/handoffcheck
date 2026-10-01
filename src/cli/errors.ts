import { randomUUID } from "node:crypto";

/**
 * Exit codes (PRD "Interface contract"):
 *   0  every mandatory step and the cleanup check PASS
 *   1  unsatisfied (a step failed, ASSISTED, or CLEANUP_UNCONFIRMED)
 *   2  harness failure (bad usage, unreadable input, internal error)
 */
export const EXIT_OK = 0;
export const EXIT_UNSATISFIED = 1;
export const EXIT_HARNESS = 2;

export type ExitCode = 0 | 1 | 2;

/** Error codes emitted in `{error:{code,message,request_id}}`; identical to the domain ErrorCode set (schemas/error.schema.json). */
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

export class CliError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly exitCode: ExitCode = EXIT_HARNESS
  ) {
    super(message);
    this.name = "CliError";
  }
}

export interface ErrorBody {
  error: { code: string; message: string; request_id: string };
}

export function newRequestId(): string {
  return `req_${randomUUID()}`;
}

export function errorBody(code: string, message: string, requestId: string = newRequestId()): ErrorBody {
  return { error: { code, message, request_id: requestId } };
}
