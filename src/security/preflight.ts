import type { LoadedInputs } from "../domain/inputs.js";
import { validateManifestSemantics } from "../domain/manifest.js";
import { SCHEMA_VERSION } from "../domain/types.js";
import type { Isolation, PreflightFinding, PreflightReport } from "../domain/types.js";
import { findCredentials, findDestinations, isDestinationAllowed, isLoopbackHost } from "./patterns.js";

const ARTIFACT_SCAN_FILE_BYTES = 1024 * 1024;
const ARTIFACT_SCAN_TOTAL_BYTES = 64 * 1024 * 1024;

function manifestStrings(value: unknown, path: string, skip: (p: string) => boolean, out: { path: string; text: string }[]): void {
  if (skip(path)) return;
  if (typeof value === "string") out.push({ path, text: value });
  else if (Array.isArray(value)) value.forEach((v, i) => manifestStrings(v, `${path}/${i}`, skip, out));
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) manifestStrings(v, `${path}/${k}`, skip, out);
  }
}

function looksText(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

/**
 * AC-02 preflight. Pure and offline: scans the manifest, referenced scripts, runbook and artifact text for production
 * credential patterns and undeclared network destinations, and enforces provider rules. Findings never echo secrets.
 */
export function runPreflight(inputs: LoadedInputs, provider: { name: string; isolation: Isolation; allowHostSandbox?: boolean }, scanTotalBytes = ARTIFACT_SCAN_TOTAL_BYTES): PreflightReport {
  const findings: PreflightFinding[] = [];
  const m = inputs.manifest;
  const reject = (f: Omit<PreflightFinding, "severity">): void => {
    findings.push({ ...f, severity: "reject" });
  };

  findings.push(...validateManifestSemantics(m));
  for (const s of inputs.scripts.values()) if (s.problem) findings.push(s.problem);
  if (inputs.artifactProblem) findings.push(inputs.artifactProblem);

  // provider rules
  if (provider.isolation === "none" && provider.allowHostSandbox !== true) {
    reject({
      code: "HOST_SANDBOX_NOT_ALLOWED",
      location: "/runner/provider",
      message: "this provider runs manifest scripts directly on this host with no isolation; pass allowHostSandbox (CLI --allow-host-sandbox) only for scripts you wrote and trust"
    });
  }
  if (provider.name === "local-sandbox" && m.scenario.synthetic !== true) {
    reject({ code: "NOT_SYNTHETIC", location: "/scenario/synthetic", message: "local-sandbox runs synthetic scenarios only (isolation none); use the lima VM provider for untrusted workloads" });
  }
  if (provider.isolation === "vm") {
    const r = m.runner.resources;
    if (!r) reject({ code: "MISSING_RESOURCE_LIMITS", location: "/runner/resources", message: "VM runs require declared cpus, memory_mb and disk_mb limits" });
    for (const [i, dest] of m.network.allow.entries()) {
      const host = dest.replace(/:\d+$/, "");
      if (!isLoopbackHost(host)) reject({ code: "UNDECLARED_NETWORK_DESTINATION", location: `/network/allow/${i}`, message: "the VM provider enforces deny-all egress; only loopback destinations may be declared" });
    }
  }

  // credentials: all manifest strings, scripts, runbook, artifact text
  const strings: { path: string; text: string }[] = [];
  manifestStrings(m, "", () => false, strings);
  for (const { path, text } of strings) {
    for (const hit of findCredentials(text)) {
      reject({ code: "PRODUCTION_CREDENTIAL", location: `manifest${path}`, message: `production credential pattern (${hit.kind}) found in manifest`, kind: hit.kind });
    }
  }
  let scripts = 0;
  for (const s of inputs.scripts.values()) {
    if (!s.bytes) continue;
    scripts += 1;
    const text = s.bytes.toString("utf8");
    for (const hit of findCredentials(text)) {
      reject({ code: "PRODUCTION_CREDENTIAL", location: `script:${s.path}`, message: `production credential pattern (${hit.kind}) found in script`, kind: hit.kind });
    }
  }
  for (const hit of findCredentials(inputs.runbookText)) {
    reject({ code: "PRODUCTION_CREDENTIAL", location: "runbook", message: `production credential pattern (${hit.kind}) found in runbook`, kind: hit.kind });
  }
  let artifactEntries = 0;
  if (inputs.artifactEntries) {
    let scanned = 0;
    for (const e of inputs.artifactEntries) {
      artifactEntries += 1;
      if (e.type !== "file" || !e.data || e.data.length === 0) continue;
      if (scanned > scanTotalBytes) break;
      const slice = e.data.subarray(0, ARTIFACT_SCAN_FILE_BYTES);
      scanned += slice.length;
      if (!looksText(slice)) continue;
      for (const hit of findCredentials(Buffer.from(slice).toString("utf8"))) {
        reject({ code: "PRODUCTION_CREDENTIAL", location: `artifact:${e.path}`, message: `production credential pattern (${hit.kind}) found in artifact`, kind: hit.kind });
      }
    }
  }

  // network destinations: explicit execution inputs only (manifest, scripts)
  const skipAllow = (p: string): boolean => p.startsWith("/network");
  const netStrings: { path: string; text: string }[] = [];
  manifestStrings(m, "", skipAllow, netStrings);
  const seen = new Set<string>();
  const flagDest = (location: string, host: string, port: string | null): void => {
    const key = `${location}|${host}|${port ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    reject({
      code: "UNDECLARED_NETWORK_DESTINATION",
      location,
      message: `destination ${host}${port ? `:${port}` : ""} is not declared in network.allow`
    });
  };
  for (const { path, text } of netStrings) {
    for (const d of findDestinations(text)) if (!isDestinationAllowed(d, m.network.allow)) flagDest(`manifest${path}`, d.host, d.port);
  }
  for (const s of inputs.scripts.values()) {
    if (!s.bytes) continue;
    for (const d of findDestinations(s.bytes.toString("utf8"))) {
      if (!isDestinationAllowed(d, m.network.allow)) flagDest(`script:${s.path}`, d.host, d.port);
    }
  }

  const unique = new Map<string, PreflightFinding>();
  for (const f of findings) unique.set(`${f.code}|${f.severity}|${f.location}|${f.message}`, f);
  const deduped = [...unique.values()];
  return {
    schema_version: SCHEMA_VERSION,
    status: deduped.some((f) => f.severity === "reject") ? "REJECTED" : "PASS",
    provider: provider.name,
    isolation: provider.isolation,
    findings: deduped,
    checked: { manifest: true, scripts, artifact_entries: artifactEntries, runbook: true }
  };
}
