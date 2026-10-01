import * as api from "../../api.js";
import { HandoffCheckError } from "../../api.js";
import { CliError } from "../errors.js";
import { apiContext, requireStoreDir, printJson } from "../common.js";
import { str } from "../context.js";
import { plain } from "../format.js";
import type { Handler } from "../main.js";

/** Retry and verify cleanup. Exit 0 only when the new receipt is VERIFIED; leaked resources keep exit 1. */
export const cleanupCommand: Handler = async (ctx) => {
  requireStoreDir(ctx);
  let result;
  try {
    result = await api.cleanup(apiContext(ctx), { runId: str(ctx, "run") });
  } catch (err) {
    if (err instanceof HandoffCheckError && err.code === "CONFLICT") {
      throw new CliError("CONFLICT", `${err.message} The run is still active, or its owner process cannot be checked; retry cleanup after the run has ended.`);
    }
    throw err;
  }
  if (ctx.json) printJson(ctx, result);
  else {
    const lines = [
      `run ${plain(result.run_id)} state: ${plain(result.state)}`,
      `cleanup: ${plain(result.receipt.status)} (${result.receipt.resources.length} resource(s))`
    ];
    for (const r of result.receipt.resources) lines.push(`  ${plain(r.kind).padEnd(14)} ${plain(r.id)} ${plain(r.state)}${r.detail ? ` - ${plain(r.detail)}` : ""}`);
    if (result.receipt.status !== "VERIFIED") lines.push("cleanup is not verified: leaked or unknown resources keep the run failing");
    ctx.stdout(`${lines.join("\n")}\n`);
  }
  return result.exit_code;
};
