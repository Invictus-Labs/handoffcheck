import { resolve } from "node:path";
import { buildView, inputPaths, requireStoreDir, writePrivateFile, writeReports } from "../common.js";
import { optStr, str } from "../context.js";
import { CliError } from "../errors.js";
import { formatReportSummary } from "../format.js";
import type { Handler } from "../main.js";
import { renderHtml, renderJson } from "../../report/index.js";
import { apiContext } from "../common.js";

/**
 * `report` exit code is the verdict's: 0 only when every mandatory step and cleanup PASS, 1 otherwise.
 * Asking for a report of a failed or ASSISTED run therefore never looks like success to a script.
 */
export const reportCommand: Handler = async (ctx) => {
  const runId = str(ctx, "run");
  const format = (optStr(ctx, "format") ?? "both") as "json" | "html" | "both";
  const out = optStr(ctx, "out");
  const storeDir = requireStoreDir(ctx);
  // With all three inputs the binding is re-checked: changed inputs make the verdict UNKNOWN (STALE_BINDING), exit 1.
  const current = optStr(ctx, "manifest") !== undefined ? inputPaths(ctx) : undefined;
  const { view, data } = await buildView(ctx, apiContext(ctx), runId, current);

  if (out === "-") {
    if (format === "both") throw new CliError("BAD_REQUEST", "report: --out - needs --format json or --format html");
    ctx.stdout(format === "json" ? renderJson(view) : renderHtml(view));
    return data.verdict.exit_code;
  }

  let written;
  if (out === undefined) {
    written = writeReports(view, storeDir, runId, format);
  } else if (format === "both") {
    written = writeReports(view, storeDir, runId, "both", resolve(ctx.cwd, out));
  } else {
    const path = resolve(ctx.cwd, out);
    writePrivateFile(path, format === "json" ? renderJson(view) : renderHtml(view));
    written = format === "json" ? { json: path } : { html: path };
  }
  // --json prints the report document itself (schemas/report.schema.json); files are still written as requested.
  if (ctx.json) ctx.stdout(renderJson(view));
  else ctx.stdout(formatReportSummary(data, written));
  return data.verdict.exit_code;
};
