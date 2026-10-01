import * as api from "../../api.js";
import { apiContext, printJson, requireStoreDir } from "../common.js";
import { flag, optStr } from "../context.js";
import { plain } from "../format.js";
import type { Handler } from "../main.js";

/**
 * Retention purge: deletes runs past their retain_until, or created more than N days ago with
 * --older-than-days. --dry-run deletes nothing and lists what would go. This is the only command that deletes
 * evidence; history is append-only otherwise. Exit 0 on success.
 */
export const purgeCommand: Handler = async (ctx) => {
  requireStoreDir(ctx);
  const days = optStr(ctx, "older-than-days");
  const result = await api.purgeExpired(apiContext(ctx), {
    ...(days !== undefined ? { olderThanDays: Number(days) } : {}),
    dryRun: flag(ctx, "dry-run")
  });
  if (ctx.json) {
    printJson(ctx, result);
  } else {
    const verb = result.dry_run ? "would purge" : "purged";
    const lines = [`${verb} ${result.purged.length} run(s)${result.dry_run ? " (dry run: nothing was deleted)" : ""}`];
    for (const id of result.purged) lines.push(`  ${plain(id)}`);
    ctx.stdout(`${lines.join("\n")}\n`);
  }
  return 0;
};
