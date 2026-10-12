import { HandoffCheckError } from "./errors.js";
import type { RunState } from "./types.js";

const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  CREATED: ["PREFLIGHT", "FAILED", "ABORTED"],
  PREFLIGHT: ["RUNNING", "FAILED", "ABORTED"],
  RUNNING: ["COMPLETE", "FAILED", "ABORTED"],
  COMPLETE: ["CLEANUP_VERIFIED", "CLEANUP_UNCONFIRMED"],
  FAILED: ["CLEANUP_VERIFIED", "CLEANUP_UNCONFIRMED"],
  ABORTED: ["CLEANUP_VERIFIED", "CLEANUP_UNCONFIRMED"],
  CLEANUP_VERIFIED: [],
  CLEANUP_UNCONFIRMED: ["CLEANUP_VERIFIED", "CLEANUP_UNCONFIRMED"]
};

export function canTransition(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) {
    throw new HandoffCheckError("CONFLICT", `illegal state transition ${from} -> ${to}`);
  }
}

export function nextStates(from: RunState): readonly RunState[] {
  return TRANSITIONS[from];
}
