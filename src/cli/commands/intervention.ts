import * as api from "../../api.js";
import { apiContext, requireStoreDir, printJson } from "../common.js";
import { optStr, str } from "../context.js";
import { CliError } from "../errors.js";
import { plain } from "../format.js";
import type { Handler } from "../main.js";

/**
 * Append an intervention. Attribution is the local identity: it is a local record, not a
 * third-party attestation. Recording succeeds with exit 0; the new verdict is shown so the
 * operator sees it become ASSISTED.
 */
export const interventionCommand: Handler = async (ctx) => {
  const reason = str(ctx, "reason").trim();
  if (reason.length === 0) throw new CliError("BAD_REQUEST", "record-intervention: --reason must not be blank");
  const runId = str(ctx, "run");
  const actorRef = optStr(ctx, "actor") ?? "local";
  requireStoreDir(ctx);
  const actx = apiContext(ctx);
  const record = await api.recordIntervention(actx, { runId, reason, actorRef });
  const report = await api.getReport(actx, { runId });
  if (ctx.json) {
    printJson(ctx, { intervention: record, verdict: report.verdict.verdict, exit_code: report.verdict.exit_code });
  } else {
    ctx.stdout(
      `intervention ${plain(record.id)} recorded for run ${plain(runId)} by ${plain(record.actor_ref)}\n` +
        `verdict is now ${plain(report.verdict.verdict)} (any intervention stops a run counting as an unaided handoff; a run that otherwise succeeded becomes ASSISTED)\n` +
        "note: attribution is a local identity record, not third-party attestation\n"
    );
  }
  return 0;
};
