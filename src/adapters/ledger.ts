import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AdapterError } from "./envelope.js";

/**
 * Local adapter state: which event ids were seen (dedupe), the newest revision applied per
 * stream (ordering), the latest receipt exported per resource, and the effective acceptance
 * state per resource. One small JSON file, written atomically, owner-only.
 */

export const LEDGER_VERSION = 1 as const;
export const LEDGER_FILE = "ledger.json";
const MAX_LEDGER_BYTES = 25 * 1024 * 1024;

export type AcceptanceState = "accepted" | "rejected" | "unknown" | "partial" | "stale";

export interface SeenEvent {
  payload_sha256: string;
  disposition: "applied" | "stale";
}

export interface StreamHead {
  revision: number;
  event_id: string;
}

export interface ExportHead {
  event_id: string;
  revision: number;
  /** sha256 of the exact redacted report this receipt points at; an acceptance must name this digest. */
  report_sha256: string;
}

export interface AcceptanceRecord {
  state: AcceptanceState;
  /** What the sender claimed before local checks downgraded it. */
  claimed: string;
  /** The run's own verdict when the claim was evaluated (never the sender's). */
  run_verdict: string | null;
  event_id: string;
  revision: number;
  reason: string;
}

export interface Ledger {
  ledger_version: typeof LEDGER_VERSION;
  /** Random per-store secret mixed into receipt event ids so they cannot be derived by a third party. */
  receipt_nonce?: string;
  /** All four maps have a null prototype: an id such as "constructor" is an ordinary key. */
  seen: Record<string, SeenEvent>;
  streams: Record<string, StreamHead>;
  exports: Record<string, ExportHead>;
  acceptance: Record<string, AcceptanceRecord>;
}

/** A map that does not inherit from Object.prototype, so keys like "constructor" or "toString" are plain data. */
export function dict<T>(source?: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, source ?? {});
}

export function emptyLedger(): Ledger {
  return { ledger_version: LEDGER_VERSION, seen: dict(), streams: dict(), exports: dict(), acceptance: dict() };
}

/** Create a directory owner-only; any filesystem failure becomes a BAD_REQUEST adapter error, never a raw crash. */
export function ensurePrivateDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  } catch (err) {
    throw new AdapterError("BAD_REQUEST", `cannot create directory ${dir}: ${(err as NodeJS.ErrnoException).code ?? "io error"}`);
  }
}

export function loadLedger(stateDir: string): Ledger {
  const path = join(stateDir, LEDGER_FILE);
  if (!existsSync(path)) return emptyLedger();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new AdapterError("BAD_REQUEST", `cannot read adapter ledger: ${(err as NodeJS.ErrnoException).code ?? "io error"}`);
  }
  if (text.length > MAX_LEDGER_BYTES) throw new AdapterError("PAYLOAD_TOO_LARGE", "adapter ledger exceeds size limit");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AdapterError("INTERNAL", "adapter ledger is corrupt (not valid JSON); refusing to continue");
  }
  const p = parsed as Partial<Ledger> | null;
  if (!p || p.ledger_version !== LEDGER_VERSION || !p.seen || !p.streams || !p.exports || !p.acceptance) {
    throw new AdapterError("INTERNAL", "adapter ledger has an unsupported shape; refusing to continue");
  }
  const ledger: Ledger = {
    ledger_version: LEDGER_VERSION,
    seen: dict(p.seen),
    streams: dict(p.streams),
    exports: dict(p.exports),
    acceptance: dict(p.acceptance)
  };
  if (typeof p.receipt_nonce === "string") ledger.receipt_nonce = p.receipt_nonce;
  return ledger;
}

/** Atomic replace: write a temp file next to the target, then rename over it. */
export function saveLedger(stateDir: string, ledger: Ledger): void {
  ensurePrivateDir(stateDir);
  const path = join(stateDir, LEDGER_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    throw new AdapterError("BAD_REQUEST", `cannot write adapter ledger: ${(err as NodeJS.ErrnoException).code ?? "io error"}`);
  }
}
