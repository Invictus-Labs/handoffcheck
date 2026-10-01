import * as api from "../../api.js";
import { apiContext, ensureOwnerOnlyDir, storeDirOf } from "../common.js";
import { optStr } from "../context.js";
import { plain } from "../format.js";
import type { Handler } from "../main.js";
import { finishRun, withAbortSignals } from "./run.js";

/** Offline synthetic drill end to end: local-sandbox, isolation none, labelled, no network and no accounts. */
export const demoCommand: Handler = async (ctx) => {
  // The default store for the demo is a fresh sibling directory so the demo never mixes with real evidence.
  if (optStr(ctx, "output") === undefined) ctx.parsed.values.output = "handoffcheck-demo";
  ensureOwnerOnlyDir(ctx, storeDirOf(ctx));
  const result = await withAbortSignals(ctx, (signal) =>
    api.demo(
      apiContext(ctx, {
        onEvent: (e) => {
          if (e.type === "state") ctx.stderr(`[state] ${plain(e.state)}\n`);
          if (e.type === "step_finished") ctx.stderr(`[step ] ${plain(e.step_key)} ${plain(e.status)}\n`);
        }
      }),
      { signal }
    )
  );
  return finishRun(ctx, result);
};
