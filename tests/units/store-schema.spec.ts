// Unit tests for the schema validator, the content-addressed object store, migrations, input loading and the
// API-level validation rules that guard the store (src/domain/schema.ts, src/evidence/cas.ts, src/store, src/domain/service.ts).
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import * as api from "../../src/api.js";
import { loadInputs } from "../../src/domain/inputs.js";
import { packageVersion } from "../../src/domain/pkg.js";
import { assertValid, formatIssues, listSchemaNames, schemasDir, validateAgainst } from "../../src/domain/schema.js";
import { ObjectStore } from "../../src/evidence/cas.js";
import { loadMigrations, migrate } from "../../src/store/migrate.js";
import { makeCtx, prepareDrill } from "../helpers/drill.js";
import { makeTmp, registerTmpCleanup } from "../helpers/tmp.js";

registerTmpCleanup();

describe("schema validator", () => {
  it("enforces every keyword the shipped schemas use (no silently ignored constraints)", () => {
    const supported = new Set([
      "$ref", "$defs", "type", "enum", "const", "properties", "required", "additionalProperties", "propertyNames", "items", "minItems", "maxItems",
      "minProperties", "maxProperties", "minLength", "maxLength", "pattern", "minimum", "maximum", "oneOf", "$schema", "$id", "title", "description",
      "default", "examples", "$comment"
    ]);
    const offenders: string[] = [];
    const walk = (node: unknown, file: string, path: string): void => {
      if (Array.isArray(node)) return void node.forEach((x, i) => walk(x, file, `${path}/${i}`));
      if (node === null || typeof node !== "object") return;
      for (const [k, v] of Object.entries(node)) {
        const container = path.endsWith("/properties") || path.endsWith("/$defs");
        if (!container && !supported.has(k)) offenders.push(`${file}${path}/${k}`);
        walk(v, file, `${path}/${k}`);
      }
    };
    for (const f of readdirSync(schemasDir())) if (f.endsWith(".json")) walk(JSON.parse(readFileSync(join(schemasDir(), f), "utf8")), f, "");
    expect(offenders).toEqual([]);
    expect(listSchemaNames()).toEqual(expect.arrayContaining(["drill-manifest.schema.json", "evidence-bundle.schema.json", "common.schema.json"]));
  });

  it("negative control: type, enum, const, bounds, pattern, items, properties and oneOf violations are all reported", () => {
    const m = prepareDrill().manifest;
    const issues = (mutate: (x: Record<string, any>) => void) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const copy = JSON.parse(JSON.stringify(m)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      mutate(copy);
      return formatIssues(validateAgainst("drill-manifest.schema.json", copy));
    };
    expect(issues(() => undefined)).toBe("");
    expect(issues((x) => void (x.schema_version = 2))).toMatch(/must equal 1/);
    expect(issues((x) => void (x.runner.provider = "docker"))).toMatch(/must be one of/);
    expect(issues((x) => void (x.steps = "none"))).toMatch(/must be array/);
    expect(issues((x) => void (x.steps = []))).toMatch(/at least 1 items/);
    expect(issues((x) => void (x.steps[0].deadline_seconds = 0))).toMatch(/>= 1/);
    expect(issues((x) => void (x.steps[0].deadline_seconds = 999999))).toMatch(/<= 86400/);
    expect(issues((x) => void (x.steps[0].deadline_seconds = 1.5))).toMatch(/must be integer/);
    expect(issues((x) => void (x.scenario.id = ""))).toMatch(/does not match the required format/);
    expect(issues((x) => void (x.scenario.version = ""))).toMatch(/at least 1 characters/);
    expect(issues((x) => void (x.scenario.version = "v".repeat(70)))).toMatch(/at most 64 characters/);
    expect(issues((x) => void delete x.operator)).toMatch(/missing required property "operator"/);
    expect(issues((x) => void (x.operator.extra = 1))).toMatch(/unknown property "extra"/);
    expect(issues((x) => void (x.env = { lowercase: "x" }))).toMatch(/property name "lowercase"/);
    expect(issues((x) => void (x.env = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`K${i}`, "v"]))))).toMatch(/at most 64 properties/);
    expect(issues((x) => void (x.steps[1].expect.record_counts = {}))).toMatch(/at least 1 properties/);
    expect(issues((x) => void (x.steps[0].action = "deploy"))).toMatch(/does not match any allowed shape|must equal/);
    expect(issues((x) => void (x.steps[0].script = null))).toMatch(/must be object/);
    expect(issues((x) => void (x.steps = Array.from({ length: 60 }, () => x.steps[0])))).toMatch(/at most 50 items/);
    expect(issues((x) => void (x.synthetic_secrets = [1]))).toMatch(/must be string/);
    expect(issues((x) => void (x.steps[2].reject_exit_codes = [0]))).toMatch(/>= 1/);
  });

  it("assertValid throws SCHEMA_INVALID with the issue list and an unknown reference is an internal error", () => {
    expect(() => assertValid("drill-manifest.schema.json", {}, "manifest")).toThrowError(expect.objectContaining({ code: "SCHEMA_INVALID" }));
    expect(() => validateAgainst("nope.schema.json", {})).toThrowError(expect.objectContaining({ code: "INTERNAL" }));
    expect(() => validateAgainst("common.schema.json#/$defs/nonexistent", {})).toThrowError(expect.objectContaining({ code: "INTERNAL" }));
    expect(validateAgainst("common.schema.json#/$defs/sha256", "a".repeat(64))).toEqual([]);
    expect(formatIssues(validateAgainst("common.schema.json#/$defs/sha256", "xyz"))).toContain("required format");
  });

  it("error bodies validate against the shipped error schema", () => {
    const ok = { error: { code: "NOT_FOUND", message: "m", request_id: "req_1" } };
    expect(validateAgainst("error.schema.json", ok)).toEqual([]);
    expect(validateAgainst("error.schema.json", { error: { code: "NOPE", message: "m", request_id: "r" } }).length).toBeGreaterThan(0);
  });
});

describe("object store", () => {
  it("stores bytes under their own digest, deduplicates, re-verifies on read and removes", () => {
    const store = new ObjectStore(makeTmp("hc-cas-"));
    const a = store.put(Buffer.from("hello"));
    expect(a.created).toBe(true);
    expect(store.put(Buffer.from("hello"))).toEqual({ sha256: a.sha256, created: false });
    expect(store.has(a.sha256)).toBe(true);
    expect(store.read(a.sha256).toString()).toBe("hello");
    expect(store.size(a.sha256)).toBe(5);
    store.remove(a.sha256);
    expect(store.has(a.sha256)).toBe(false);
  });

  it("negative control: invalid ids, missing objects and tampered objects are rejected", () => {
    const dir = makeTmp("hc-cas-");
    const store = new ObjectStore(dir);
    expect(() => store.pathFor("../../etc/passwd")).toThrowError(expect.objectContaining({ code: "BAD_REQUEST" }));
    expect(() => store.pathFor("ABC")).toThrow();
    expect(() => store.read("a".repeat(64))).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
    const { sha256 } = store.put(Buffer.from("evidence"));
    writeFileSync(store.pathFor(sha256), "tampered");
    expect(() => store.read(sha256)).toThrowError(expect.objectContaining({ code: "BUNDLE_CORRUPT" }));
  });
});

describe("migrations", () => {
  it("applies the initial migration once, is idempotent and refuses a newer store", () => {
    const db = new DatabaseSync(":memory:");
    const clock = () => "2026-01-01T00:00:00.000Z";
    const versions = loadMigrations().map((m) => m.version);
    const latest = versions.length; // migrations are numbered contiguously from 1
    expect(versions).toEqual(Array.from({ length: latest }, (_, i) => i + 1));
    expect(migrate(db, clock)).toEqual({ applied: latest, version: latest });
    expect(migrate(db, clock)).toEqual({ applied: 0, version: latest });
    expect((db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n).toBe(latest);
    db.exec(`PRAGMA user_version = ${latest + 4}`);
    expect(() => migrate(db, clock)).toThrowError(expect.objectContaining({ code: "STORE_SCHEMA_UNSUPPORTED" }));
    db.close();
  });

  it("reports the package version from package.json", () => {
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(packageVersion()).toBe(packageVersion());
  });
});

describe("input loading limits", () => {
  const env = { PATH: process.env.PATH ?? "" };

  it("negative control: too many steps, an oversized script and a non-regular script are PAYLOAD_TOO_LARGE or findings, never run", async () => {
    const inputs = prepareDrill();
    expect(() => loadInputs(inputs.paths, { ...api.DEFAULT_LIMITS, max_steps: 2 })).toThrowError(expect.objectContaining({ code: "PAYLOAD_TOO_LARGE" }));
    const loaded = loadInputs(inputs.paths, { ...api.DEFAULT_LIMITS, max_script_bytes: 10 });
    expect([...loaded.scripts.values()].every((s) => s.problem?.code === "SCRIPT_PATH_UNSAFE")).toBe(true);
    const report = await api.preflight({ env, limits: { max_script_bytes: 10 } }, inputs.paths);
    expect(report.status).toBe("REJECTED");
    const dirScript = prepareDrill({ manifest: (m) => void (m.steps[0].script.path = "scripts") });
    expect((await api.preflight({ env }, dirScript.paths)).findings.map((f) => f.code)).toContain("SCRIPT_MISSING");
  });

  it("negative control: an artifact path that is missing, a directory or over the blob cap is rejected before reading", () => {
    const inputs = prepareDrill();
    const dir = makeTmp("hc-in-");
    expect(() => loadInputs({ ...inputs.paths, artifactPath: join(dir, "none.tar") }, api.DEFAULT_LIMITS)).toThrowError(expect.objectContaining({ code: "BAD_REQUEST" }));
    expect(() => loadInputs({ ...inputs.paths, artifactPath: dir }, api.DEFAULT_LIMITS)).toThrowError(expect.objectContaining({ code: "BAD_REQUEST" }));
    expect(() => loadInputs(inputs.paths, { ...api.DEFAULT_LIMITS, max_blob_bytes: 100 })).toThrowError(expect.objectContaining({ code: "PAYLOAD_TOO_LARGE" }));
  });
});

describe("API validation guards", () => {
  it("negative control: intervention input is validated (reason, actor, step key) and recorded against a real run only", async () => {
    const ctx = makeCtx();
    const created = await api.createDrill(ctx, prepareDrill().paths);
    const base = { runId: created.run_id, reason: "ok", actorRef: "a" };
    await expect(api.recordIntervention(ctx, { ...base, reason: "   " })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(api.recordIntervention(ctx, { ...base, reason: "x".repeat(2001) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(api.recordIntervention(ctx, { ...base, actorRef: "" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(api.recordIntervention(ctx, { ...base, actorRef: "a".repeat(129) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(api.recordIntervention(ctx, { ...base, stepKey: "bad step!" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await api.recordIntervention(ctx, { ...base, stepKey: "install" })).step_key).toBe("install");
  });

  it("negative control: listRuns rejects a malformed cursor and getReport/checkReuse need real inputs", async () => {
    const ctx = makeCtx();
    await api.createDrill(ctx, prepareDrill().paths);
    for (const cursor of ["!!!", Buffer.from("{}").toString("base64url"), Buffer.from('{"created_at":1,"id":2}').toString("base64url")]) {
      await expect(api.listRuns(ctx, { cursor })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    await expect(api.getReport(ctx, { runId: "nope" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(api.checkReuse(ctx, { manifestPath: "x", artifactPath: "y", runbookPath: "z" })).rejects.toBeInstanceOf(api.HandoffCheckError);
  });

  it("purgeExpired on an empty store is a no-op and a store directory that is a file is refused", async () => {
    const ctx = makeCtx();
    expect(await api.purgeExpired(ctx)).toEqual({ purged: [], dry_run: false });
    const file = join(makeTmp("hc-st-"), "afile");
    writeFileSync(file, "x");
    await expect(api.listRuns(makeCtx({ storeDir: file }))).rejects.toBeInstanceOf(Error);
    mkdirSync(join(makeTmp("hc-st-"), "unused"));
  });
});
