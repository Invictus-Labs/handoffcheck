// Unit tests for the pure domain code: canonical JSON, the state machine, manifest parsing and semantics.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalBytes, canonicalHash, canonicalJson, sha256Hex } from "../../src/domain/canonical.js";
import { HandoffCheckError, exitCodeForError, toErrorBody } from "../../src/domain/errors.js";
import { allScriptRefs, parseManifest, readBoundedFile, validateManifestSemantics } from "../../src/domain/manifest.js";
import { fixedClock, randomIds, sequentialIds, systemClock } from "../../src/domain/runtime.js";
import { assertTransition, canTransition, nextStates } from "../../src/domain/state.js";
import { RUN_STATES, type DrillManifest, type RunState } from "../../src/domain/types.js";
import YAML from "yaml";
import { fixtureManifest } from "../helpers/drill.js";
import { makeTmp, registerTmpCleanup } from "../helpers/tmp.js";

registerTmpCleanup();

describe("canonical JSON", () => {
  it("sorts keys by UTF-16 code unit, drops whitespace and omits undefined properties", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"], c: undefined })).toBe('{"a":[true,null,"x"],"b":1}');
    const keys = ["\u20ac", "\r", "\ufb33", "1", "\ud83d\ude00", "\u0080", "\u00f6"];
    const obj = Object.fromEntries(keys.map((k) => [k, 0]));
    const sorted = ["\r", "1", "\u0080", "\u00f6", "\u20ac", "\ud83d\ude00", "\ufb33"];
    expect(canonicalJson(obj)).toBe(`{${sorted.map((k) => `${JSON.stringify(k)}:0`).join(",")}}`);
  });

  it("uses the shortest ES number form and normalises negative zero", () => {
    expect(canonicalJson([1e21, 0.000001, 1.5, -0, 100, 4.35])).toBe("[1e+21,0.000001,1.5,0,100,4.35]");
  });

  it("negative control: values with no canonical JSON form are rejected", () => {
    const sparse: unknown[] = [];
    sparse[1] = 1;
    class Weird {}
    for (const bad of [NaN, Infinity, -Infinity, undefined, () => 1, Symbol("s"), 10n, new Uint8Array(2), sparse, new Weird(), new Date()]) {
      expect(() => canonicalJson(bad), String(bad)).toThrowError(HandoffCheckError);
    }
  });

  it("hashes are stable, order-independent and sensitive to a one-character change", () => {
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }));
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(Buffer.from(canonicalBytes({ a: "é" })).toString("utf8")).toBe('{"a":"é"}');
    expect(canonicalJson(Object.create(null, { k: { value: 1, enumerable: true } }))).toBe('{"k":1}');
  });
});

describe("state machine", () => {
  const legal: [RunState, RunState][] = [
    ["CREATED", "PREFLIGHT"], ["CREATED", "FAILED"], ["CREATED", "ABORTED"],
    ["PREFLIGHT", "RUNNING"], ["PREFLIGHT", "FAILED"], ["PREFLIGHT", "ABORTED"],
    ["RUNNING", "COMPLETE"], ["RUNNING", "FAILED"], ["RUNNING", "ABORTED"],
    ["COMPLETE", "CLEANUP_VERIFIED"], ["COMPLETE", "CLEANUP_UNCONFIRMED"],
    ["FAILED", "CLEANUP_VERIFIED"], ["FAILED", "CLEANUP_UNCONFIRMED"],
    ["ABORTED", "CLEANUP_VERIFIED"], ["ABORTED", "CLEANUP_UNCONFIRMED"],
    ["CLEANUP_UNCONFIRMED", "CLEANUP_VERIFIED"], ["CLEANUP_UNCONFIRMED", "CLEANUP_UNCONFIRMED"]
  ];

  it("allows exactly the documented transitions and nothing else", () => {
    const allowed = new Set(legal.map(([a, b]) => `${a}>${b}`));
    for (const from of RUN_STATES) {
      for (const to of RUN_STATES) {
        expect(canTransition(from, to), `${from}>${to}`).toBe(allowed.has(`${from}>${to}`));
      }
    }
    expect(nextStates("CLEANUP_VERIFIED")).toEqual([]);
  });

  it("negative control: an illegal transition throws CONFLICT", () => {
    expect(() => assertTransition("CLEANUP_VERIFIED", "RUNNING")).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
    expect(() => assertTransition("COMPLETE", "RUNNING")).toThrow();
    expect(() => assertTransition("CREATED", "PREFLIGHT")).not.toThrow();
  });
});

describe("errors and runtime helpers", () => {
  it("maps every error code to its documented status and the exact body shape", () => {
    const table: Record<string, number> = {
      BAD_REQUEST: 400, NOT_FOUND: 404, CONFLICT: 409, PAYLOAD_TOO_LARGE: 413, SCHEMA_INVALID: 422, POLICY_REJECTED: 422,
      UNSUPPORTED_VERSION: 422, BUNDLE_CORRUPT: 422, PROVIDER_UNAVAILABLE: 503, CONNECTOR_DISCONNECTED: 503,
      INSUFFICIENT_CAPACITY: 507, STORE_SCHEMA_UNSUPPORTED: 503, INTERNAL: 500
    };
    for (const [code, status] of Object.entries(table)) {
      const err = new HandoffCheckError(code as never, "m", { d: 1 });
      expect(err.status).toBe(status);
      expect(toErrorBody(err, "req_1")).toEqual({ error: { code, message: "m", request_id: "req_1" } });
      expect(exitCodeForError(err)).toBe(2);
    }
    expect(toErrorBody(new Error("boom"), "r")).toEqual({ error: { code: "INTERNAL", message: "unexpected error: boom", request_id: "r" } });
    expect(toErrorBody("str", "r").error.message).toContain("str");
  });

  it("fixed clocks and sequential ids are deterministic; the system clock is UTC ISO", () => {
    const a = fixedClock("2026-01-01T00:00:00.000Z", 500);
    expect([a.nowIso(), a.nowIso()]).toEqual(["2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.500Z"]);
    expect(a.monotonicMs()).toBe(1000);
    expect(() => fixedClock("yesterday")).toThrow();
    const ids = sequentialIds(7);
    expect(ids.uuid()).toBe(["00000000", "0007", "4000", "8000", "000000000001"].join("-"));
    expect(ids.uuid()).toBe(["00000000", "0007", "4000", "8000", "000000000002"].join("-"));
    expect(randomIds().uuid()).toMatch(/^[0-9a-f-]{36}$/);
    expect(systemClock().nowIso()).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(systemClock().monotonicMs()).toBeGreaterThanOrEqual(0);
  });
});

describe("manifest parsing and semantics", () => {
  const yaml = (m: unknown) => YAML.stringify(m);

  it("parses the fixture manifest and exposes every script reference", () => {
    const m = parseManifest(yaml(fixtureManifest()), 1 << 20);
    expect(m.steps.map((s) => s.action)).toEqual(["install", "restore", "rotate", "recover"]);
    expect(m.steps.flatMap((s) => allScriptRefs(s).map((r) => r.role))).toEqual(["script", "probe", "script", "measure", "script", "probe", "seed_fault", "probe", "script"]);
    expect(validateManifestSemantics(m)).toEqual([]);
  });

  it("negative control: oversize, non-mapping, malformed and schema-invalid manifests are rejected", () => {
    expect(() => parseManifest("x".repeat(100), 10)).toThrowError(expect.objectContaining({ code: "PAYLOAD_TOO_LARGE" }));
    for (const text of ["- a\n- b\n", "just a string", "", "a: [unclosed", "a: 1\na: 2\n"]) {
      expect(() => parseManifest(text, 1 << 20), JSON.stringify(text)).toThrowError(expect.objectContaining({ code: "SCHEMA_INVALID" }));
    }
    const bad = fixtureManifest();
    bad.surprise = 1;
    expect(() => parseManifest(yaml(bad), 1 << 20)).toThrowError(expect.objectContaining({ code: "SCHEMA_INVALID" }));
  });

  it("negative control: cross-field rules reject what the schema cannot express", () => {
    const semantic = (mutate: (m: DrillManifest) => void): string[] => {
      const m = parseManifest(yaml(fixtureManifest()), 1 << 20);
      mutate(m);
      return validateManifestSemantics(m).map((f) => f.code);
    };
    expect(semantic((m) => void (m.steps[1]!.id = m.steps[0]!.id))).toContain("MANIFEST_SEMANTICS");
    expect(semantic((m) => void ((m.steps[0] as { script: { path: string } }).script.path = "../x.sh"))).toContain("SCRIPT_PATH_UNSAFE");
    expect(semantic((m) => { const e = (m.steps[1] as { expect: { data_hashes?: object; blobs?: object } }).expect; delete e.data_hashes; delete e.blobs; })).toContain("MANIFEST_SEMANTICS");
    expect(semantic((m) => void ((m.steps[1] as { expect: { blobs: { path: string }[] } }).expect.blobs[0]!.path = "../x"))).toContain("MANIFEST_SEMANTICS");
    expect(semantic((m) => void ((m.steps[2] as { credentials: { new_file: string } }).credentials.new_file = "state/credential.old"))).toContain("MANIFEST_SEMANTICS");
    expect(semantic((m) => void ((m.steps[2] as { credentials: { old_file: string } }).credentials.old_file = "/etc/passwd"))).toContain("MANIFEST_SEMANTICS");
    expect(semantic((m) => void ((m.steps[3] as { max_recovery_seconds: number }).max_recovery_seconds = 999))).toContain("MANIFEST_SEMANTICS");
    for (const key of ["HC_RUN_ID", "PATH", "HOME", "NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"]) {
      expect(semantic((m) => void (m.env = { [key]: "x" })), key).toContain("ENV_UNSAFE");
    }
    expect(semantic((m) => void (m.operator.builder_ref = ""))).toContain("MANIFEST_SEMANTICS");
  });

  it("reads files within the bound and reports unreadable, non-file and oversized inputs", () => {
    const dir = makeTmp("hc-manifest-");
    const file = join(dir, "m.yaml");
    writeFileSync(file, "abc");
    expect(readBoundedFile(file, 10, "manifest").toString()).toBe("abc");
    expect(() => readBoundedFile(file, 2, "manifest")).toThrowError(expect.objectContaining({ code: "PAYLOAD_TOO_LARGE" }));
    expect(() => readBoundedFile(dir, 10, "manifest")).toThrowError(expect.objectContaining({ code: "BAD_REQUEST" }));
    expect(() => readBoundedFile(join(dir, "missing"), 10, "manifest")).toThrowError(expect.objectContaining({ code: "BAD_REQUEST" }));
  });
});
