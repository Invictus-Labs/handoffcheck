import { randomUUID } from "node:crypto";
import type { Clock, IdGenerator } from "./types.js";

const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** Real UTC wall clock. */
export function systemClock(): Clock {
  return {
    nowIso: () => new Date().toISOString(),
    monotonicMs: () => Math.round(performance.now())
  };
}

/**
 * Deterministic clock for tests: every `nowIso()` / `monotonicMs()` call advances by `stepMs`
 * (default 1000) from `startIso`. Never goes backwards.
 */
export function fixedClock(startIso: string, stepMs = 1000): Clock {
  if (!UTC_RE.test(startIso)) throw new Error(`fixedClock requires a UTC ISO timestamp, got ${startIso}`);
  const start = Date.parse(startIso);
  let ticks = 0;
  return {
    nowIso: () => new Date(start + stepMs * ticks++).toISOString(),
    monotonicMs: () => stepMs * ticks++
  };
}

/** Deterministic RFC 4122-shaped (v4 layout) ids: a fixed prefix plus a zero-padded hex counter. */
export function sequentialIds(prefix = 0): IdGenerator {
  let n = 0;
  const p = (prefix & 0xffff).toString(16).padStart(4, "0");
  return {
    uuid: () => {
      n += 1;
      return `00000000-${p}-4000-8000-${n.toString(16).padStart(12, "0")}`;
    }
  };
}

export function randomIds(): IdGenerator {
  return { uuid: () => randomUUID() };
}
