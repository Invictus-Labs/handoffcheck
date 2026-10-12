import { createHash } from "node:crypto";
import { HandoffCheckError } from "./errors.js";

/**
 * Canonical JSON: RFC 8785 (JCS) for the JSON subset HandoffCheck produces.
 *  - object keys sorted by UTF-16 code unit order, no insignificant whitespace, UTF-8 output;
 *  - numbers use the ECMAScript shortest round-trip form (what JSON.stringify emits); -0 becomes 0;
 *  - NaN, Infinity, undefined, functions, symbols and bigint are rejected (they have no JSON form);
 *  - object properties whose value is `undefined` are omitted like JSON.stringify, array holes are rejected.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, "$");
}

export function canonicalBytes(value: unknown): Uint8Array {
  return Buffer.from(canonicalJson(value), "utf8");
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

function fail(path: string, what: string): never {
  throw new HandoffCheckError("BAD_REQUEST", `value at ${path} cannot be canonically encoded: ${what}`);
}

function encode(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) return fail(path, "non-finite number");
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "object":
      break;
    default:
      return fail(path, typeof value);
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) return fail(`${path}[${i}]`, "array hole");
      parts.push(encode(value[i], `${path}[${i}]`));
    }
    return `[${parts.join(",")}]`;
  }
  if (value instanceof Uint8Array) return fail(path, "binary data (encode as hex first)");
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return fail(path, "non-plain object");
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${encode(obj[k], `${path}.${k}`)}`).join(",")}}`;
}
