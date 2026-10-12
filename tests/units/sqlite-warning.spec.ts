// The node:sqlite loader drops exactly one warning (the SQLite ExperimentalWarning that Node 22.x prints on import)
// and nothing else, and always restores the process warning emitter (src/store/sqlite.ts).
import { describe, expect, it } from "vitest";
import { DatabaseSync, isSqliteExperimentalWarning, withoutSqliteWarning } from "../../src/store/sqlite.js";

describe("sqlite experimental warning filter", () => {
  it("recognises only the SQLite ExperimentalWarning, whether the type is passed as a string or an options object", () => {
    expect(isSqliteExperimentalWarning("SQLite is an experimental feature and might change at any time", ["ExperimentalWarning"])).toBe(true);
    expect(isSqliteExperimentalWarning("sqlite is experimental", [{ type: "ExperimentalWarning" }])).toBe(true);
    expect(isSqliteExperimentalWarning(Object.assign(new Error("SQLite is an experimental feature"), {}), ["ExperimentalWarning"])).toBe(true);
    // negative control: nothing else is swallowed
    expect(isSqliteExperimentalWarning("SQLite is an experimental feature", ["DeprecationWarning"])).toBe(false);
    expect(isSqliteExperimentalWarning("Fetch is an experimental feature", ["ExperimentalWarning"])).toBe(false);
    expect(isSqliteExperimentalWarning("SQLite is an experimental feature", [])).toBe(false);
    expect(isSqliteExperimentalWarning("SQLite is an experimental feature", [{}])).toBe(false);
    expect(isSqliteExperimentalWarning(new Error("unrelated"), [undefined])).toBe(false);
  });

  it("drops only the SQLite warning while the importer runs, forwards every other warning, and restores the emitter even when the import fails", async () => {
    const seen: string[] = [];
    const original = process.emitWarning;
    process.emitWarning = ((w: string | Error) => void seen.push(typeof w === "string" ? w : w.message)) as typeof process.emitWarning;
    try {
      const value = await withoutSqliteWarning(async () => {
        process.emitWarning("SQLite is an experimental feature", "ExperimentalWarning");
        process.emitWarning("Something else is experimental", "ExperimentalWarning");
        process.emitWarning("a deprecation", "DeprecationWarning");
        return 42;
      });
      expect(value).toBe(42);
      expect(seen).toEqual(["Something else is experimental", "a deprecation"]);
      const patchedAfter = process.emitWarning;
      await expect(withoutSqliteWarning(async () => { throw new Error("import failed"); })).rejects.toThrow("import failed");
      expect(process.emitWarning).toBe(patchedAfter); // restored to what it was before the call, not left patched
    } finally {
      process.emitWarning = original;
    }
  });

  it("exposes a working in-memory database class", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (x INTEGER) STRICT");
    db.prepare("INSERT INTO t VALUES (?)").run(7);
    expect((db.prepare("SELECT x FROM t").get() as { x: number }).x).toBe(7);
    db.close();
  });
});
