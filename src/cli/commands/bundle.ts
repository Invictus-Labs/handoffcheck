import { resolve } from "node:path";
import * as api from "../../api.js";
import { apiContext, ensureOwnerOnlyDir, printJson, requireStoreDir, storeDirOf } from "../common.js";
import { str } from "../context.js";
import { plain } from "../format.js";
import type { Handler } from "../main.js";

export const exportCommand: Handler = async (ctx) => {
  requireStoreDir(ctx);
  const info = await api.exportBundle(apiContext(ctx), { runId: str(ctx, "run"), outPath: resolve(ctx.cwd, str(ctx, "out")) });
  if (ctx.json) printJson(ctx, info);
  else {
    ctx.stdout(
      `bundle written: ${plain(info.path)}\nsha256:  ${plain(info.bundle_sha256)}\nformat:  ${plain(info.header.format)} v${info.header.format_version}\nfiles:   ${info.header.files.length}, ${info.bytes} bytes\nroot:    ${plain(info.header.root_hash)}\n`
    );
  }
  return 0;
};

/** Import is all-or-nothing. A truncated, tampered or unsupported bundle throws (exit 2) and adds no state. */
export const importCommand: Handler = async (ctx) => {
  ensureOwnerOnlyDir(ctx, storeDirOf(ctx));
  const result = await api.importBundle(apiContext(ctx), { bundlePath: resolve(ctx.cwd, str(ctx, "bundle")) });
  if (ctx.json) printJson(ctx, result);
  else {
    ctx.stdout(
      `imported run ${plain(result.run_id)} (${result.files_imported} files)\nbundle sha256:  ${plain(result.bundle_sha256)}\nbinding digest: ${plain(result.binding_digest)}\nintegrity verified (integrity only, provenance not verified). The run is unauthenticated here: its verdict is UNKNOWN and the bundle's own verdict is display only (see: report --run ${plain(result.run_id)})\n`
    );
  }
  return 0;
};

/** Read-only check. Exit 0 when the bundle verifies, 1 when it does not (errors are listed). */
export const verifyBundleCommand: Handler = async (ctx) => {
  const v = await api.verifyBundle({ env: ctx.env }, { bundlePath: resolve(ctx.cwd, str(ctx, "bundle")) });
  if (ctx.json) printJson(ctx, v);
  else if (v.ok) {
    ctx.stdout(`bundle OK: ${v.files_checked} file(s) hash-verified${v.header ? `, run ${plain(v.header.run_id)}` : ""}\n${plain(v.note ?? "integrity only, provenance not verified")}\n`);
  } else {
    ctx.stdout(`bundle INVALID (${v.errors.length} error(s)); nothing was imported\n`);
    ctx.stdout(`${plain(v.note ?? "integrity only, provenance not verified")}\n`);
    for (const e of v.errors) ctx.stdout(`  ${plain(e.code)}: ${plain(e.message)}\n`);
  }
  return v.ok ? 0 : 1;
};
