import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import * as api from "../../api.js";
import { adaptersEnabled, assertEnabled, exportReceipt, importAcceptance, AdapterError, type RunState } from "../../adapters/index.js";
import { renderJson } from "../../report/index.js";
import { ADAPTERS_DIR, apiContext, buildView, flag, printJson, receiptRevision, requireStoreDir, storeDirOf } from "../common.js";
import { str } from "../context.js";
import { CliError, type ExitCode } from "../errors.js";
import { plain } from "../format.js";
import type { Handler } from "../main.js";

/** Map an adapter failure onto the shared error shape (codes already match the domain ErrorCode set). */
function asCliError(err: unknown): never {
  if (err instanceof AdapterError) throw new CliError(err.code, err.message);
  throw err;
}

/** Deterministic per revision: the newest recorded event time, so re-exporting an unchanged run gives identical bytes. */
function latestEventTime(a: string[], b: string[], fallback: string): string {
  const all = [...a, ...b].sort();
  return all[all.length - 1] ?? fallback;
}

/** resource_ids named by an acceptance file; unreadable or malformed files are left for importAcceptance to reject. */
async function resourcesIn(file: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const ids = new Set<string>();
    for (const item of items) {
      const id = item && typeof item === "object" ? (item as Record<string, unknown>).resource_id : undefined;
      if (typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) ids.add(id);
    }
    return [...ids];
  } catch {
    return [];
  }
}

export const adapterCommand: Handler = async (ctx) => {
  const enabled = adaptersEnabled(flag(ctx, "enable-adapters"), ctx.env);
  const storeDir = storeDirOf(ctx);
  const stateDir = join(storeDir, ADAPTERS_DIR);

  try {
    if (ctx.parsed.subcommand === "export-receipt") {
      // Check the gate before touching the store or the run so a disabled adapter has no side effects.
      assertEnabled(enabled);
      requireStoreDir(ctx);
      const runId = str(ctx, "run");
      const actx = apiContext(ctx);
      const { view, data } = await buildView(ctx, actx, runId);
      const revision = receiptRevision(data);
      const occurredAt = latestEventTime(data.state_history.map((h) => h.at), data.interventions.map((i) => i.occurred_at), data.generated_at);
      // The receipt report is pinned to the run's own newest event time so the same revision always yields the same bytes.
      // An imported run's own claimed verdict is display-only and never exported: the receipt carries the effective verdict.
      const { claimed_verdict: _claimed, ...exportable } = data;
      const receiptView = { ...view, generated_at: occurredAt, data: { ...exportable, generated_at: occurredAt } };
      const result = exportReceipt({
        enabled,
        stateDir,
        outDir: resolve(ctx.cwd, str(ctx, "out")),
        runId,
        revision,
        reportJson: renderJson(receiptView),
        occurredAt
      });
      if (ctx.json) printJson(ctx, { envelope: result.envelope, envelope_path: result.envelopePath, report_path: result.reportPath });
      else {
        ctx.stdout(
          `receipt envelope: ${plain(result.envelopePath)}\nreport:           ${plain(result.reportPath)}\nevent_id:         ${plain(result.envelope.event_id)} (revision ${result.envelope.revision})\nlocal files only; nothing was sent anywhere\n`
        );
      }
      return 0;
    }

    // import-acceptance
    assertEnabled(enabled);
    requireStoreDir(ctx);
    const actx = apiContext(ctx);
    // The run's own verdict decides whether an "accepted" claim is honoured; the sender's claim never does.
    const resolved = new Map<string, RunState | undefined>();
    const runState = (resourceId: string): RunState | undefined => resolved.get(resourceId);
    const resources = await resourcesIn(resolve(ctx.cwd, str(ctx, "file")));
    for (const id of resources) {
      try {
        const data = await api.getReport(actx, { runId: id });
        resolved.set(id, { verdict: data.verdict.verdict, accepting: data.verdict.verdict === "INDEPENDENT_PASS", revision: receiptRevision(data) });
      } catch {
        resolved.set(id, undefined);
      }
    }
    const out = importAcceptance({ enabled, stateDir, file: resolve(ctx.cwd, str(ctx, "file")), runState });
    if (ctx.json) printJson(ctx, out);
    else {
      const lines = [`applied ${out.applied}, duplicate ${out.duplicates}, stale ${out.stale}, rejected ${out.rejected}`];
      for (const r of out.results) {
        lines.push(
          `  ${plain(r.event_id ?? "(no event_id)")} ${r.status}${r.code ? ` ${r.code}` : ""}${r.effective_state ? ` -> ${r.effective_state}` : ""}: ${plain(r.reason)}`
        );
      }
      ctx.stdout(`${lines.join("\n")}\n`);
    }
    const exit: ExitCode = out.rejected > 0 ? 1 : 0;
    return exit;
  } catch (err) {
    return asCliError(err);
  }
};
