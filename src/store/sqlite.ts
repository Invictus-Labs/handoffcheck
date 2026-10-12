/**
 * node:sqlite loader. The module is still flagged experimental on some supported Node versions (22.x) and prints a
 * warning on import; we load it dynamically so we can drop exactly that one warning (no native dependency is added).
 */
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

/** True for the ExperimentalWarning that `node:sqlite` emits on import. */
export function isSqliteExperimentalWarning(warning: string | Error, rest: readonly unknown[]): boolean {
  const first = rest[0];
  const type = typeof first === "string" ? first : (first as { type?: string } | undefined)?.type;
  const text = typeof warning === "string" ? warning : warning.message;
  return type === "ExperimentalWarning" && /sqlite/i.test(text);
}

/** Run `importer` while dropping only the SQLite experimental warning; the original emitter is always restored. */
export async function withoutSqliteWarning<T>(importer: () => Promise<T>): Promise<T> {
  const original = process.emitWarning;
  process.emitWarning = function patched(warning: string | Error, ...rest: unknown[]): void {
    if (isSqliteExperimentalWarning(warning, rest)) return;
    (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    return await importer();
  } finally {
    process.emitWarning = original;
  }
}

const sqlite = await withoutSqliteWarning(() => import("node:sqlite"));

export const DatabaseSync = sqlite.DatabaseSync;
export type Database = DatabaseSyncType;
