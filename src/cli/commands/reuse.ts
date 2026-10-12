import * as api from "../../api.js";
import { apiContext, inputPaths, printJson, requireStoreDir } from "../common.js";
import { optStr } from "../context.js";
import { plain } from "../format.js";
import type { Handler } from "../main.js";

/**
 * AC-01: is a stored result still reusable for the CURRENT inputs? Exit 0 only when the domain finds a prior
 * run with the identical binding digest (artifact, runbook, scenario version, manifest and scripts) that
 * earned an accepting verdict. A changed artifact, runbook, scenario or script invalidates earlier results
 * (reason BINDING_CHANGED, exit 1). With --run, that specific run must be the reusable one.
 * Unknown, stale and partial results are never reusable. Exit 2 is a usage or harness error.
 */
export const checkReuseCommand: Handler = async (ctx) => {
  requireStoreDir(ctx);
  const decision = await api.checkReuse(apiContext(ctx), inputPaths(ctx));
  const wanted = optStr(ctx, "run");
  const reusable = decision.reusable && (wanted === undefined || decision.run_id === wanted);
  const note =
    decision.reusable && !reusable ? `the reusable result is run ${decision.run_id ?? "(none)"}, not ${wanted}` : undefined;
  if (ctx.json) {
    printJson(ctx, { ...decision, reusable, ...(wanted ? { requested_run_id: wanted } : {}), ...(note ? { note } : {}) });
  } else {
    const lines = [
      `reuse:     ${reusable ? "REUSABLE" : "NOT REUSABLE"} (${plain(decision.reason)}${decision.verdict ? `, prior verdict ${plain(decision.verdict)}` : ""})`,
      `binding:   ${plain(decision.binding.binding_digest)}`
    ];
    if (decision.run_id) lines.push(`run:       ${plain(decision.run_id)}`);
    if (note) lines.push(`note:      ${plain(note)}`);
    if (decision.invalidated_run_ids.length > 0) {
      lines.push(`invalidated by changed inputs: ${decision.invalidated_run_ids.map((id) => plain(id)).join(", ")}`);
    }
    ctx.stdout(`${lines.join("\n")}\n`);
  }
  return reusable ? 0 : 1;
};
