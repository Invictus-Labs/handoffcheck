import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HandoffCheckError } from "./errors.js";

/**
 * Minimal JSON Schema (draft 2020-12 subset) validator that executes the files in `schemas/`.
 * Supported keywords: $ref, $defs, type, enum, const, properties, required, additionalProperties, propertyNames,
 * items, minItems, maxItems, minProperties, maxProperties, minLength, maxLength, pattern, minimum, maximum, oneOf.
 * Anything else in a schema is annotation only. No dependency, no network, no remote $ref.
 */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
interface SchemaObject {
  [k: string]: unknown;
}

export interface SchemaIssue {
  path: string;
  message: string;
}

const MAX_ISSUES = 25;
let registry: Map<string, SchemaObject> | null = null;
const regexCache = new Map<string, RegExp>();

export function schemasDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "schemas");
    if (existsSync(join(candidate, "common.schema.json"))) return candidate;
    dir = dirname(dir);
  }
  throw new HandoffCheckError("INTERNAL", "schemas directory not found next to the installed package");
}

function load(): Map<string, SchemaObject> {
  if (registry) return registry;
  const dir = schemasDir();
  const map = new Map<string, SchemaObject>();
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".schema.json"))) {
    map.set(name, JSON.parse(readFileSync(join(dir, name), "utf8")) as SchemaObject);
  }
  registry = map;
  return map;
}

export function listSchemaNames(): string[] {
  return [...load().keys()].sort();
}

function resolveRef(ref: string, currentDoc: string): { doc: string; schema: SchemaObject } {
  const hashIdx = ref.indexOf("#");
  const file = hashIdx === -1 ? ref : ref.slice(0, hashIdx);
  const pointer = hashIdx === -1 ? "" : ref.slice(hashIdx + 1);
  const doc = file === "" ? currentDoc : file;
  const root = load().get(doc);
  if (!root) throw new HandoffCheckError("INTERNAL", `schema reference to unknown document ${doc}`);
  let node: unknown = root;
  if (pointer !== "" && pointer !== "/") {
    for (const raw of pointer.split("/").slice(1)) {
      const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
      node = (node as Record<string, unknown> | undefined)?.[key];
      if (node === undefined) throw new HandoffCheckError("INTERNAL", `unresolvable schema pointer ${ref}`);
    }
  }
  return { doc, schema: node as SchemaObject };
}

function regex(pattern: string): RegExp {
  let re = regexCache.get(pattern);
  if (!re) {
    re = new RegExp(pattern, "u");
    regexCache.set(pattern, re);
  }
  return re;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function typeMatches(value: unknown, wanted: string): boolean {
  const actual = typeOf(value);
  return actual === wanted; // schemas use integer/string/boolean/object/array/null only
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function check(schema: SchemaObject, value: unknown, doc: string, path: string, out: SchemaIssue[]): void {
  if (out.length >= MAX_ISSUES) return;
  const add = (message: string): void => {
    if (out.length < MAX_ISSUES) out.push({ path: path === "" ? "/" : path, message });
  };

  if (typeof schema["$ref"] === "string") {
    const target = resolveRef(schema["$ref"], doc);
    check(target.schema, value, target.doc, path, out);
  }
  if ("const" in schema && !deepEqual(schema["const"], value)) {
    add(`must equal ${JSON.stringify(schema["const"])}`);
    return;
  }
  if (Array.isArray(schema["enum"]) && !schema["enum"].some((e) => deepEqual(e, value))) {
    add(`must be one of ${schema["enum"].map((e) => JSON.stringify(e)).join(", ")}`);
    return;
  }
  if (schema["type"] !== undefined) {
    const types = Array.isArray(schema["type"]) ? (schema["type"] as string[]) : [schema["type"] as string];
    if (!types.some((t) => typeMatches(value, t))) {
      add(`must be ${types.join(" or ")} (got ${typeOf(value)})`);
      return;
    }
  }

  if (typeof value === "string") {
    if (typeof schema["minLength"] === "number" && [...value].length < schema["minLength"]) add(`must be at least ${schema["minLength"]} characters`);
    if (typeof schema["maxLength"] === "number" && [...value].length > schema["maxLength"]) add(`must be at most ${schema["maxLength"]} characters`);
    if (typeof schema["pattern"] === "string" && !regex(schema["pattern"]).test(value)) add(`does not match the required format`);
  }
  if (typeof value === "number") {
    if (typeof schema["minimum"] === "number" && value < schema["minimum"]) add(`must be >= ${schema["minimum"]}`);
    if (typeof schema["maximum"] === "number" && value > schema["maximum"]) add(`must be <= ${schema["maximum"]}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema["minItems"] === "number" && value.length < schema["minItems"]) add(`must have at least ${schema["minItems"]} items`);
    if (typeof schema["maxItems"] === "number" && value.length > schema["maxItems"]) add(`must have at most ${schema["maxItems"]} items`);
    if (schema["items"] && typeof schema["items"] === "object") {
      for (let i = 0; i < value.length; i++) check(schema["items"] as SchemaObject, value[i], doc, `${path}/${i}`, out);
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (typeof schema["minProperties"] === "number" && keys.length < schema["minProperties"]) add(`must have at least ${schema["minProperties"]} properties`);
    if (typeof schema["maxProperties"] === "number" && keys.length > schema["maxProperties"]) add(`must have at most ${schema["maxProperties"]} properties`);
    if (Array.isArray(schema["required"])) {
      for (const key of schema["required"] as string[]) if (!(key in obj)) add(`missing required property "${key}"`);
    }
    const props = (schema["properties"] ?? {}) as Record<string, SchemaObject>;
    const names = schema["propertyNames"] as SchemaObject | undefined;
    for (const key of keys) {
      if (names && typeof names["pattern"] === "string" && !regex(names["pattern"]).test(key)) {
        add(`property name "${key}" does not match the required format`);
      }
      const sub = props[key];
      if (sub) {
        check(sub, obj[key], doc, `${path}/${key}`, out);
      } else if (schema["additionalProperties"] === false) {
        add(`unknown property "${key}"`);
      } else if (schema["additionalProperties"] && typeof schema["additionalProperties"] === "object") {
        check(schema["additionalProperties"] as SchemaObject, obj[key], doc, `${path}/${key}`, out);
      }
    }
  }
  if (Array.isArray(schema["oneOf"])) {
    const branches = schema["oneOf"] as SchemaObject[];
    const results = branches.map((b) => {
      const issues: SchemaIssue[] = [];
      check(b, value, doc, path, issues);
      return { branch: b, issues };
    });
    const passing = results.filter((r) => r.issues.length === 0).length;
    if (passing === 0) {
      const matched = results.find((r) => discriminatorMatches(r.branch, value, doc));
      if (matched) {
        for (const issue of matched.issues) if (out.length < MAX_ISSUES) out.push(issue);
      } else {
        add("does not match any allowed shape");
      }
    } else if (passing > 1) {
      add("matches more than one allowed shape");
    }
  }
}

/** True when a branch's `const` properties (e.g. `action: "install"`) match the instance: used for readable oneOf errors. */
function discriminatorMatches(branch: SchemaObject, value: unknown, doc: string): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  let target = branch;
  let targetDoc = doc;
  if (typeof branch["$ref"] === "string") {
    const r = resolveRef(branch["$ref"], doc);
    target = r.schema;
    targetDoc = r.doc;
  }
  void targetDoc;
  const props = (target["properties"] ?? {}) as Record<string, SchemaObject>;
  const consts = Object.entries(props).filter(([, s]) => "const" in s);
  if (consts.length === 0) return false;
  return consts.every(([k, s]) => deepEqual(s["const"], (value as Record<string, unknown>)[k]));
}

/** Validate `data` against a schema file (`ref` like "drill-manifest.schema.json" or "step.schema.json#/$defs/step_receipt"). */
export function validateAgainst(ref: string, data: unknown): SchemaIssue[] {
  const { doc, schema } = resolveRef(ref, ref.split("#")[0] as string);
  const issues: SchemaIssue[] = [];
  check(schema, data as Json, doc, "", issues);
  return issues;
}

export function formatIssues(issues: SchemaIssue[]): string {
  return issues.map((i) => `${i.path}: ${i.message}`).join("; ");
}

/** Validate against an in-memory schema object (used by tests to exercise validator keywords). */
export function validateSchemaObject(schema: SchemaObject, data: unknown, doc = "common.schema.json"): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  check(schema, data as Json, doc, "", issues);
  return issues;
}

/** Throw SCHEMA_INVALID (422) when `data` violates the schema. */
export function assertValid(ref: string, data: unknown, what: string): void {
  const issues = validateAgainst(ref, data);
  if (issues.length > 0) {
    throw new HandoffCheckError("SCHEMA_INVALID", `${what} is invalid: ${formatIssues(issues)}`, issues);
  }
}
