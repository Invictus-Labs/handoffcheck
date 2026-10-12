import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HandoffCheckError } from "../domain/errors.js";
import type { Database } from "./sqlite.js";

export function migrationsDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "migrations");
    if (existsSync(join(candidate, "001_initial.sql"))) return candidate;
    dir = dirname(dir);
  }
  throw new HandoffCheckError("INTERNAL", "migrations directory not found next to the installed package");
}

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export function loadMigrations(): Migration[] {
  const dir = migrationsDir();
  return readdirSync(dir)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort()
    .map((f) => ({ version: parseInt(f.slice(0, 3), 10), name: f, sql: readFileSync(join(dir, f), "utf8") }));
}

/** Apply pending migrations, each in its own transaction. Refuses a store written by newer code. */
export function migrate(db: Database, nowIso: () => string): { applied: number; version: number } {
  const migrations = loadMigrations();
  const latest = migrations.reduce((max, m) => Math.max(max, m.version), 0);
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (current > latest) {
    throw new HandoffCheckError("STORE_SCHEMA_UNSUPPORTED", `store schema version ${current} is newer than this build supports (${latest}); upgrade handoffcheck or restore a matching backup`);
  }
  let applied = 0;
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT");
  for (const m of migrations) {
    if (m.version <= current) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(m.version, m.name, nowIso());
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec("COMMIT");
      applied += 1;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return { applied, version: latest };
}
