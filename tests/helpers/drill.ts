import { chmodSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { fixedClock, sequentialIds, type ApiContext } from "../../src/api.js";
import { buildFixtureRelease, sha256Hex, type TarEntry } from "../../scripts/build-fixture-release.mjs";
import { FIXED_NOW, makeTmp } from "./tmp.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = resolve(HERE, "..", "..", "fixtures");
export const DRILL_DIR = join(FIXTURES, "drill");
export const DRILL_SH_DIR = join(FIXTURES, "drill-sh");

/** Planted FAKE credentials (carry the HCFAKE marker). Mirrors fixtures/demo.json. */
export const PLANTED = {
  oldToken: "HCFAKE_OLD_5B1E0C7A9D3F4E28",
  newToken: "HCFAKE_NEW_C8A2D6F0B4E17359"
} as const;

export type Manifest = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface PrepareOptions {
  /** Mutate the parsed manifest before it is written. */
  manifest?: (m: Manifest) => void;
  /** script file name (e.g. "install.sh") -> new content, or null to delete. */
  scripts?: Record<string, string | null>;
  /** release path (e.g. "bin/notes.mjs") -> new content, or null to drop the file. */
  release?: Record<string, string | null>;
  /** Extra tar entries appended to the artifact. */
  extra?: TarEntry[];
  runbook?: string;
  /** Use an already-built artifact buffer instead of the fixture release. */
  artifact?: Buffer;
  /** "sh": the POSIX-sh fixture (fixtures/drill-sh, provider lima) used by the live VM drill. Default "node". */
  variant?: "node" | "sh";
}

export interface DrillInputs {
  dir: string;
  manifestPath: string;
  artifactPath: string;
  runbookPath: string;
  manifest: Manifest;
  artifactSha256: string;
  runbookSha256: string;
  /** Runs the drill on this host (local-sandbox needs the explicit opt-in); `bare` is the same input without it. */
  paths: { manifestPath: string; artifactPath: string; runbookPath: string; allowHostSandbox: true };
  bare: { manifestPath: string; artifactPath: string; runbookPath: string };
}

const drillDirOf = (variant: "node" | "sh" = "node"): string => (variant === "sh" ? DRILL_SH_DIR : DRILL_DIR);

export function fixtureManifest(variant: "node" | "sh" = "node"): Manifest {
  return YAML.parse(readFileSync(join(drillDirOf(variant), "drill.yaml"), "utf8")) as Manifest;
}

export function fixtureRunbook(variant: "node" | "sh" = "node"): string {
  return readFileSync(join(drillDirOf(variant), "RUNBOOK.md"), "utf8");
}

/** Write a complete, self-contained set of drill inputs (manifest dir with scripts, artifact tar, runbook). */
export function prepareDrill(opts: PrepareOptions = {}): DrillInputs {
  const dir = makeTmp("hc-drill-");
  const scriptsDir = join(dir, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  const variant = opts.variant ?? "node";
  cpSync(join(drillDirOf(variant), "scripts"), scriptsDir, { recursive: true });
  for (const [name, content] of Object.entries(opts.scripts ?? {})) {
    const target = join(scriptsDir, name);
    if (content === null) {
      rmSync(target, { force: true });
      continue;
    }
    writeFileSync(target, content);
    chmodSync(target, 0o755);
  }
  const manifest = fixtureManifest(variant);
  opts.manifest?.(manifest);
  const manifestPath = join(dir, "drill.yaml");
  writeFileSync(manifestPath, YAML.stringify(manifest));
  const runbook = opts.runbook ?? fixtureRunbook(variant);
  const runbookPath = join(dir, "RUNBOOK.md");
  writeFileSync(runbookPath, runbook);
  const tar = opts.artifact ?? buildFixtureRelease(opts.release ?? {}, opts.extra ?? [], variant);
  const artifactPath = join(dir, "release.tar");
  writeFileSync(artifactPath, tar);
  return {
    dir,
    manifestPath,
    artifactPath,
    runbookPath,
    manifest,
    artifactSha256: sha256Hex(tar),
    runbookSha256: sha256Hex(Buffer.from(runbook, "utf8")),
    paths: { manifestPath, artifactPath, runbookPath, allowHostSandbox: true },
    bare: { manifestPath, artifactPath, runbookPath }
  };
}

/** Script content as a /bin/sh file using the standard drill prelude. */
export function sh(body: string): string {
  return [
    "#!/bin/sh",
    "set -eu",
    ': "${HC_RELEASE:?}" "${HC_STATE:?}"',
    'export NOTES_HOME="$HC_STATE/notes" NOTES_CREDENTIAL_DIR="$HC_STATE"',
    'NODE="${HC_NODE:-node}"',
    'SVC="$HC_RELEASE/bin/notes.mjs"',
    body,
    ""
  ].join("\n");
}

export function readFixtureScript(name: string): string {
  return readFileSync(join(DRILL_DIR, "scripts", name), "utf8");
}

export function readReleaseFile(rel: string): string {
  return readFileSync(join(FIXTURES, "release", rel), "utf8");
}

export function listFixtureScripts(): string[] {
  return readdirSync(join(DRILL_DIR, "scripts")).sort();
}

/** Deterministic API context: fixed UTC clock, sequential ids, an isolated store, no ambient env. */
export function makeCtx(over: Partial<ApiContext> & { storeDir?: string } = {}): ApiContext {
  const storeDir = over.storeDir ?? join(makeTmp("hc-store-"), "store");
  return {
    storeDir,
    clock: fixedClock(FIXED_NOW, 1000),
    ids: sequentialIds(0x4a),
    env: { PATH: process.env.PATH ?? "" },
    ...over
  };
}
