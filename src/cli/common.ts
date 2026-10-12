import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as api from "../api.js";
import type { ApiContext, InputPaths, ReportData } from "../api.js";
import { readAcceptance } from "../adapters/index.js";
import { renderHtml, renderJson, type ReportView } from "../report/index.js";
import { CliError, newRequestId } from "./errors.js";
import { flag, optStr, str, type Context } from "./context.js";

/** Names of sub-directories this CLI creates inside the evidence store (reports, adapter ledger). */
export const REPORTS_DIR = "reports";
export const ADAPTERS_DIR = "adapters";

export function storeDirOf(ctx: Context): string {
  return resolve(ctx.cwd, optStr(ctx, "output") ?? "evidence");
}

/** Create a directory owner-only (0700). An existing directory is left as it is but flagged if it is group/world accessible. */
export function ensureOwnerOnlyDir(ctx: Context, dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    return;
  }
  if (!statSync(dir).isDirectory()) throw new CliError("BAD_REQUEST", `${dir} exists and is not a directory`);
  if ((statSync(dir).mode & 0o077) !== 0) {
    ctx.stderr(`warning: evidence directory ${dir} is accessible to other users; chmod 700 it to keep evidence private\n`);
  }
}

/** For commands that read an existing store: never create one as a side effect of a typo. */
export function requireStoreDir(ctx: Context): string {
  const dir = storeDirOf(ctx);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new CliError("NOT_FOUND", `evidence store not found: ${optStr(ctx, "output") ?? "evidence"} (pass --output <dir>)`);
  }
  ensureOwnerOnlyDir(ctx, dir);
  return dir;
}

export function apiContext(ctx: Context, extra: Partial<ApiContext> = {}): ApiContext {
  return { storeDir: storeDirOf(ctx), env: ctx.env, requestId: newRequestId(), ...extra };
}

/** Require an existing regular file; resolves relative to the invocation directory. */
export function inputFile(ctx: Context, name: string): string {
  const path = resolve(ctx.cwd, str(ctx, name));
  let info;
  try {
    info = statSync(path);
  } catch {
    throw new CliError("NOT_FOUND", `--${name}: file not found: ${str(ctx, name)}`);
  }
  if (!info.isFile()) throw new CliError("BAD_REQUEST", `--${name}: not a regular file: ${str(ctx, name)}`);
  return path;
}

export function inputPaths(ctx: Context): InputPaths {
  return { manifestPath: inputFile(ctx, "manifest"), artifactPath: inputFile(ctx, "artifact"), runbookPath: inputFile(ctx, "runbook") };
}

/** Write a file owner-only via temp + rename so a reader never sees a half-written report. */
export function writePrivateFile(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best effort: the temp file may never have been created */
    }
    throw new CliError("BAD_REQUEST", `cannot write ${path}: ${(err as NodeJS.ErrnoException).code ?? "io error"}`);
  }
}

export function printJson(ctx: Context, value: unknown): void {
  ctx.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

export function acceptanceNotices(storeDir: string, runId: string): string[] {
  const dir = join(storeDir, ADAPTERS_DIR);
  if (!existsSync(join(dir, "ledger.json"))) return [];
  try {
    const a = readAcceptance(dir, runId);
    if (!a) return [];
    return [
      `Imported acceptance (adapter, local file): ${a.state} (sender claimed ${a.claimed}). ${a.reason}. This notice never changes the drill verdict, exit code or cleanup status.`
    ];
  } catch {
    return ["Adapter state could not be read; imported acceptance is treated as unknown."];
  }
}

/** Grows with everything that can change a receipt: steps, interventions, evidence and state transitions. */
export function receiptRevision(data: ReportData): number {
  return data.steps.length + data.interventions.length + data.evidence.length + data.state_history.length;
}

export async function buildView(
  ctx: Context,
  apiCtx: ApiContext,
  runId: string,
  currentInputs?: InputPaths
): Promise<{ view: ReportView; data: ReportData }> {
  const data = await api.getReport(apiCtx, currentInputs ? { runId, currentInputs } : { runId });
  const view: ReportView = {
    generated_at: data.generated_at,
    tool_version: ctx.version,
    error: null,
    data,
    notices: acceptanceNotices(apiCtx.storeDir, runId)
  };
  return { view, data };
}

export interface WrittenReports {
  html?: string;
  json?: string;
}

/** Render and write the report files for a run under <store>/reports/<run>/. */
export function writeReports(
  view: ReportView,
  storeDir: string,
  runId: string,
  format: "json" | "html" | "both",
  dir: string = join(storeDir, REPORTS_DIR, runId)
): WrittenReports {
  const out: WrittenReports = {};
  if (format === "html" || format === "both") {
    out.html = join(dir, "report.html");
    writePrivateFile(out.html, renderHtml(view));
  }
  if (format === "json" || format === "both") {
    out.json = join(dir, "report.json");
    writePrivateFile(out.json, renderJson(view));
  }
  return out;
}

export { flag };
