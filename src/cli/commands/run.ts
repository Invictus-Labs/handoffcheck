import * as api from "../../api.js";
import type { RunEvent, RunResult } from "../../api.js";
import { apiContext, buildView, ensureOwnerOnlyDir, inputPaths, printJson, storeDirOf, writeReports } from "../common.js";
import { flag, optStr, type Context } from "../context.js";
import { CliError } from "../errors.js";
import type { ExitCode } from "../errors.js";
import { formatRunResult, plain } from "../format.js";
import type { Handler } from "../main.js";

export function progressLine(e: RunEvent): string {
  switch (e.type) {
    case "state":
      return `[state] ${plain(e.state)}`;
    case "step_started":
      return `[step ] ${plain(e.step_key)} (${plain(e.action)}) started`;
    case "step_finished":
      return `[step ] ${plain(e.step_key)} ${plain(e.status)}`;
    case "intervention":
      return `[help ] intervention ${plain(e.id)} recorded`;
  }
}

/** Run `fn` with an AbortSignal tied to SIGINT/SIGTERM so an interrupted drill still cleans up and verifies. */
export async function withAbortSignals<T>(ctx: Context, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const onSignal = (name: string) => () => {
    ctx.stderr(`received ${name}; aborting the drill and verifying cleanup\n`);
    controller.abort();
  };
  const sigint = onSignal("SIGINT");
  const sigterm = onSignal("SIGTERM");
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);
  try {
    return await fn(controller.signal);
  } finally {
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
  }
}

/** Finish a run/demo: write the static reports, then print the result in the requested mode. */
export async function finishRun(ctx: Context, result: RunResult): Promise<ExitCode> {
  const storeDir = storeDirOf(ctx);
  const actx = apiContext(ctx);
  for (const w of result.warnings ?? []) ctx.stderr(`warning: ${plain(w)}\n`);
  const { view } = await buildView(ctx, actx, result.run_id);
  const reports = writeReports(view, storeDir, result.run_id, "both");
  if (ctx.json) {
    printJson(ctx, { ...result, reports });
  } else {
    ctx.stdout(formatRunResult(result, reports));
  }
  return result.exit_code;
}

/**
 * Operator declaration for a run. A non-interactive CLI cannot prove a human is at the keyboard, so the
 * default is "automated". A human claim must be explicit and carry both the operator and the builder
 * identity; it is an operator-attested local identity, never third-party attestation.
 */
export function operatorOverride(ctx: Context): { kind: "human" | "ai_assisted" | "automated"; ref?: string; builder_ref?: string } {
  const kind = (optStr(ctx, "operator-kind") ?? "automated") as "human" | "ai_assisted" | "automated";
  // Identity refs are compared by the domain after trim + NFKC + lowercase; send them already trimmed and NFKC-normalised
  // (case is kept for display) so " Alice " and "alice" are one identity everywhere, and reject refs blank after trimming.
  const clean = (name: string): string | undefined => {
    const raw = optStr(ctx, name);
    if (raw === undefined) return undefined;
    const trimmed = raw.normalize("NFKC").trim();
    if (trimmed.length === 0) throw new CliError("BAD_REQUEST", `run: --${name} must not be blank`);
    return trimmed;
  };
  const ref = clean("operator-ref");
  const builder = clean("builder-ref");
  if (kind === "human" && (!ref || !builder)) {
    throw new CliError("BAD_REQUEST", "run: --operator-kind human requires both --operator-ref and --builder-ref");
  }
  // Same normalisation as the domain (NFKC, trim, lowercase): an operator who is the builder cannot claim a human drill.
  const fold = (v: string): string => v.normalize("NFKC").trim().toLowerCase();
  if (kind === "human" && ref && builder && fold(ref) === fold(builder)) {
    throw new CliError("BAD_REQUEST", "run: --operator-ref and --builder-ref are the same identity; the operator cannot be the builder");
  }
  return { kind, ...(ref ? { ref } : {}), ...(builder ? { builder_ref: builder } : {}) };
}

export const runCommand: Handler = async (ctx) => {
  const operator = operatorOverride(ctx);
  const input = inputPaths(ctx);
  const storeDir = storeDirOf(ctx);
  ensureOwnerOnlyDir(ctx, storeDir);
  const result = await withAbortSignals(ctx, (signal) =>
    api.run(
      apiContext(ctx, {
        onEvent: (e) => {
          const line = progressLine(e);
          if (line) ctx.stderr(`${line}\n`);
        }
      }),
      { ...input, operator, signal, allowHostSandbox: flag(ctx, "allow-host-sandbox") }
    )
  );
  return finishRun(ctx, result);
};
