import * as api from "../../api.js";
import { inputPaths, printJson } from "../common.js";
import { flag } from "../context.js";
import { plain } from "../format.js";
import type { Handler } from "../main.js";

/** Exit 0 when preflight passes, 1 when it rejects (rejection is a result, not a harness failure). No run is created. */
export const preflightCommand: Handler = async (ctx) => {
  const report = await api.preflight({ env: ctx.env }, { ...inputPaths(ctx), allowHostSandbox: flag(ctx, "allow-host-sandbox") });
  if (ctx.json) {
    printJson(ctx, report);
  } else {
    const lines = [`preflight: ${plain(report.status)} (provider ${plain(report.provider)}, isolation ${plain(report.isolation)})`];
    for (const f of report.findings) lines.push(`  ${plain(f.severity).padEnd(6)} ${plain(f.code)} at ${plain(f.location)}: ${plain(f.message)}`);
    if (report.findings.length === 0) lines.push("  no findings");
    ctx.stdout(`${lines.join("\n")}\n`);
  }
  return report.status === "PASS" ? 0 : 1;
};
