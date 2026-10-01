import { readFileSync, statSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { HandoffCheckError } from "./errors.js";
import { assertValid } from "./schema.js";
import { STEP_ACTIONS } from "./types.js";
import type { DrillManifest, ManifestStep, PreflightFinding, ScriptRef } from "./types.js";
import { isSafeRelativePath } from "../security/paths.js";

const FORBIDDEN_ENV = new Set(["PATH", "HOME", "TMPDIR", "LC_ALL", "LANG", "IFS", "SHELL", "ENV", "BASH_ENV", "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "SHELLOPTS", "BASHOPTS", "PS4", "PROMPT_COMMAND", "CDPATH", "GLOBIGNORE"]);

export function readBoundedFile(path: string, maxBytes: number, what: string): Buffer {
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new HandoffCheckError("BAD_REQUEST", `${what} is not a regular file`);
    size = st.size;
  } catch (err) {
    if (err instanceof HandoffCheckError) throw err;
    throw new HandoffCheckError("BAD_REQUEST", `${what} cannot be read: ${String((err as NodeJS.ErrnoException).code)}`);
  }
  if (size > maxBytes) throw new HandoffCheckError("PAYLOAD_TOO_LARGE", `${what} is ${size} bytes, over the ${maxBytes} byte limit`);
  try {
    return readFileSync(path);
  } catch (err) {
    throw new HandoffCheckError("BAD_REQUEST", `${what} cannot be read: ${String((err as NodeJS.ErrnoException).code)}`);
  }
}

/** Parse YAML (or JSON) with alias/size limits, validate against the manifest schema. Throws SCHEMA_INVALID/PAYLOAD_TOO_LARGE. */
export function parseManifest(text: string, maxBytes: number): DrillManifest {
  if (Buffer.byteLength(text) > maxBytes) throw new HandoffCheckError("PAYLOAD_TOO_LARGE", `manifest exceeds ${maxBytes} bytes`);
  let doc: unknown;
  try {
    doc = parseYaml(text, { maxAliasCount: 20, uniqueKeys: true, schema: "core", merge: false });
  } catch (err) {
    throw new HandoffCheckError("SCHEMA_INVALID", `manifest is not valid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new HandoffCheckError("SCHEMA_INVALID", "manifest must be a mapping");
  }
  assertValid("drill-manifest.schema.json", doc, "manifest");
  return doc as DrillManifest;
}

export function allScriptRefs(step: ManifestStep): { role: string; ref: ScriptRef }[] {
  switch (step.action) {
    case "install":
      return [
        { role: "script", ref: step.script },
        { role: "probe", ref: step.probe }
      ];
    case "restore":
      return [
        { role: "script", ref: step.script },
        { role: "measure", ref: step.measure }
      ];
    case "rotate":
      return [
        { role: "script", ref: step.script },
        { role: "probe", ref: step.probe }
      ];
    case "recover":
      return [
        { role: "seed_fault", ref: step.seed_fault },
        { role: "probe", ref: step.probe },
        { role: "script", ref: step.script }
      ];
  }
}

/** Cross-field rules JSON Schema cannot express. Findings are rejections (code MANIFEST_SEMANTICS or ENV_UNSAFE). */
export function validateManifestSemantics(m: DrillManifest): PreflightFinding[] {
  const out: PreflightFinding[] = [];
  const reject = (location: string, message: string, code: PreflightFinding["code"] = "MANIFEST_SEMANTICS"): void => {
    out.push({ code, severity: "reject", location, message });
  };
  const ids = new Set<string>();
  m.steps.forEach((step, i) => {
    const loc = `/steps/${i}`;
    if (ids.has(step.id)) reject(loc, `duplicate step id "${step.id}"`);
    ids.add(step.id);
    for (const { role, ref } of allScriptRefs(step)) {
      if (!isSafeRelativePath(ref.path)) {
        out.push({ code: "SCRIPT_PATH_UNSAFE", severity: "reject", location: `${loc}/${role}`, message: "script path must be a relative path inside the manifest directory" });
      }
    }
    if (step.action === "restore") {
      const hashes = Object.keys(step.expect.data_hashes ?? {}).length + (step.expect.blobs?.length ?? 0);
      if (hashes === 0) reject(`${loc}/expect`, "restore needs at least one expected data hash or blob hash in addition to record counts");
      for (const [j, b] of (step.expect.blobs ?? []).entries()) {
        if (!isSafeRelativePath(b.path)) reject(`${loc}/expect/blobs/${j}`, "blob path must be a safe sandbox-relative path");
      }
    }
    if (step.action === "rotate") {
      for (const key of ["old_file", "new_file"] as const) {
        if (!isSafeRelativePath(step.credentials[key])) reject(`${loc}/credentials/${key}`, "credential file path must be a safe sandbox-relative path");
      }
      if (step.credentials.old_file === step.credentials.new_file) reject(`${loc}/credentials`, "old_file and new_file must differ");
    }
    if (step.action === "recover" && step.max_recovery_seconds > step.deadline_seconds) {
      reject(`${loc}/max_recovery_seconds`, "max_recovery_seconds must not exceed deadline_seconds");
    }
  });
  // an acceptable drill must require every PRD action: install, restore, rotate and recover, each mandatory
  for (const action of STEP_ACTIONS) {
    if (!m.steps.some((s) => s.action === action && s.mandatory !== false)) {
      reject("/steps", `the drill needs at least one mandatory "${action}" step (all four PRD actions must be required; extra optional steps are allowed)`);
    }
  }
  for (const key of Object.keys(m.env ?? {})) {
    if (key.startsWith("HC_") || FORBIDDEN_ENV.has(key) || key.startsWith("DYLD_") || key.startsWith("LD_")) {
      reject(`/env/${key}`, `environment variable ${key} is reserved and cannot be set by the manifest`, "ENV_UNSAFE");
    }
  }
  if (m.operator.builder_ref !== undefined && m.operator.builder_ref === "") reject("/operator/builder_ref", "builder_ref must not be empty");
  return out;
}
