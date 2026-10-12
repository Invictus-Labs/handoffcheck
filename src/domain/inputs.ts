import { lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { canonicalHash, sha256Hex } from "./canonical.js";
import { HandoffCheckError } from "./errors.js";
import { allScriptRefs, parseManifest, readBoundedFile } from "./manifest.js";
import type { TarError } from "../security/tar.js";
import type { ArtifactEntry, Binding, DrillManifest, InputPaths, Limits, PreflightFinding } from "./types.js";
import { hasSymlinkComponent, isSafeRelativePath, resolveInside } from "../security/paths.js";
import { inflateIfGzip, readTar } from "../security/tar.js";

export interface LoadedScript {
  path: string;
  bytes: Buffer | null;
  sha256: string | null;
  problem: PreflightFinding | null;
}

export interface LoadedInputs {
  manifest: DrillManifest;
  manifestDir: string;
  scripts: Map<string, LoadedScript>;
  artifactDigest: string;
  artifactSize: number;
  /** Parsed artifact tree, or null with `artifactProblem` set when the archive failed validation. */
  artifactEntries: ArtifactEntry[] | null;
  artifactProblem: PreflightFinding | null;
  runbookHash: string;
  runbookText: string;
  binding: Binding;
}

function loadScripts(manifest: DrillManifest, manifestDir: string, limits: Limits): Map<string, LoadedScript> {
  const scripts = new Map<string, LoadedScript>();
  manifest.steps.forEach((step, i) => {
    for (const { role, ref } of allScriptRefs(step)) {
      if (scripts.has(ref.path)) continue;
      const location = `/steps/${i}/${role}`;
      const entry: LoadedScript = { path: ref.path, bytes: null, sha256: null, problem: null };
      scripts.set(ref.path, entry);
      if (!isSafeRelativePath(ref.path) || resolveInside(manifestDir, ref.path) === null || hasSymlinkComponent(manifestDir, ref.path)) {
        entry.problem = { code: "SCRIPT_PATH_UNSAFE", severity: "reject", location, message: "script path is unsafe (absolute, parent traversal or symlink)" };
        continue;
      }
      const full = resolve(manifestDir, ref.path);
      try {
        const st = lstatSync(full);
        if (!st.isFile()) throw new Error("not a file");
        if (st.size > limits.max_script_bytes) {
          entry.problem = { code: "SCRIPT_PATH_UNSAFE", severity: "reject", location, message: `script exceeds ${limits.max_script_bytes} bytes` };
          continue;
        }
        entry.bytes = readFileSync(full);
        entry.sha256 = sha256Hex(entry.bytes);
      } catch {
        entry.problem = { code: "SCRIPT_MISSING", severity: "reject", location, message: `script ${ref.path} does not exist or is not a regular file` };
        continue;
      }
      if (ref.sha256 !== undefined && ref.sha256 !== entry.sha256) {
        entry.problem = { code: "SCRIPT_HASH_MISMATCH", severity: "reject", location, message: `script ${ref.path} does not match its pinned sha256` };
      }
    }
  });
  return scripts;
}

export function computeBinding(manifest: DrillManifest, scripts: Map<string, LoadedScript>, artifactDigest: string, runbookHash: string): Binding {
  const scriptHashes: Record<string, string> = {};
  for (const [path, s] of scripts) scriptHashes[path] = s.sha256 ?? "missing";
  const manifest_digest = canonicalHash({ manifest, scripts: scriptHashes });
  const scenario_version = manifest.scenario.version;
  const binding_digest = canonicalHash({ artifact_digest: artifactDigest, runbook_hash: runbookHash, scenario_version, manifest_digest });
  return { artifact_digest: artifactDigest, runbook_hash: runbookHash, scenario_version, manifest_digest, binding_digest };
}

/**
 * Read and validate the three drill inputs. Unreadable inputs, oversize files and schema-invalid manifests throw
 * (harness error, exit 2). Policy problems (unsafe scripts, bad archives) are returned as findings for preflight.
 */
export function loadInputs(paths: InputPaths, limits: Limits): LoadedInputs {
  const manifestBytes = readBoundedFile(paths.manifestPath, limits.max_metadata_bytes, "manifest");
  const manifest = parseManifest(manifestBytes.toString("utf8"), limits.max_metadata_bytes);
  if (manifest.steps.length > limits.max_steps) {
    throw new HandoffCheckError("PAYLOAD_TOO_LARGE", `manifest has ${manifest.steps.length} steps, over the limit of ${limits.max_steps}`);
  }
  const manifestDir = dirname(resolve(paths.manifestPath));
  const runbookBytes = readBoundedFile(paths.runbookPath, limits.max_metadata_bytes, "runbook");
  const artifactBytes = readBoundedFile(paths.artifactPath, limits.max_blob_bytes, "artifact");
  const scripts = loadScripts(manifest, manifestDir, limits);

  const artifactDigest = sha256Hex(artifactBytes);
  const runbookHash = sha256Hex(runbookBytes);

  let artifactEntries: ArtifactEntry[] | null = null;
  let artifactProblem: PreflightFinding | null = null;
  try {
    const tar = inflateIfGzip(artifactBytes, limits.max_blob_bytes);
    artifactEntries = readTar(tar, { maxEntries: limits.max_files, maxTotalBytes: limits.max_blob_bytes, symlinks: "in-root", strictTrailing: false });
  } catch (err) {
    // readTar/inflate throw TarError; any other parser failure is treated the same way: the artifact is rejected
    artifactProblem = {
      code: (err as TarError).code === "LIMIT" ? "ARTIFACT_LIMIT" : "ARTIFACT_UNSAFE",
      severity: "reject",
      location: "artifact",
      message: `artifact archive rejected: ${(err as Error).message}`
    };
  }

  return {
    manifest,
    manifestDir,
    scripts,
    artifactDigest,
    artifactSize: artifactBytes.length,
    artifactEntries,
    artifactProblem,
    runbookHash,
    runbookText: runbookBytes.toString("utf8"),
    binding: computeBinding(manifest, scripts, artifactDigest, runbookHash)
  };
}
