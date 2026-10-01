import { existsSync, mkdirSync, readFileSync, renameSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { canonicalBytes, sha256Hex } from "../domain/canonical.js";
import { HandoffCheckError } from "../domain/errors.js";
import { assertValid, formatIssues, validateAgainst } from "../domain/schema.js";
import { BUNDLE_FORMAT, BUNDLE_FORMAT_VERSION, SCHEMA_VERSION } from "../domain/types.js";
import type {
  BundleErrorCode,
  BundleFileEntry,
  BundleHeader,
  BundleInfo,
  BundleVerification,
  CleanupReceipt,
  Clock,
  DrillRecord,
  EvidenceRecord,
  ImportResult,
  InterventionRecord,
  Limits,
  StateTransition,
  StepRecord,
  VerdictResult
} from "../domain/types.js";
import { TarError, readTar, writeTar } from "../security/tar.js";
import type { Store } from "../store/store.js";

const OBJECT_PATH = /^objects\/[0-9a-f]{64}$/;

export interface RunExport {
  schema_version: typeof SCHEMA_VERSION;
  exported_at: string;
  drill: DrillRecord;
  state_history: StateTransition[];
  steps: StepRecord[];
  interventions: InterventionRecord[];
  evidence: EvidenceRecord[];
  cleanup_receipts: CleanupReceipt[];
  verdict: VerdictResult;
}

export function rootHash(files: readonly BundleFileEntry[]): string {
  const lines = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f) => `${f.path}:${f.sha256}`);
  return sha256Hex(lines.join("\n"));
}

function stripLocators(c: CleanupReceipt): CleanupReceipt {
  return { ...c, resources: c.resources.map((r) => ({ ...r, locator: "" })) };
}

/** Fail before writing when the target volume cannot hold `bytes` (plus 10% and 1 MiB). `statfs` is injectable for tests. */
export function requireCapacity(dir: string, bytes: number, statfs: (path: string) => { bavail: number | bigint; bsize: number | bigint } = statfsSync): void {
  let probe = resolve(dir);
  while (!existsSync(probe)) probe = dirname(probe);
  let free: number | null = null;
  try {
    const fs = statfs(probe);
    free = Number(fs.bavail) * Number(fs.bsize);
  } catch {
    /* statfs unsupported here: do not block */
  }
  if (free !== null && free < bytes * 1.1 + 1024 * 1024) {
    throw new HandoffCheckError("INSUFFICIENT_CAPACITY", `not enough free disk space: need about ${bytes} bytes, have ${free}`);
  }
}

/** Largest acceptable bundle file: blobs + metadata + tar header and padding overhead for every allowed entry. */
export function maxBundleBytes(limits: Limits): number {
  return limits.max_blob_bytes + limits.max_metadata_bytes + (limits.max_files + 2) * 1024;
}

/** Export one run as a single-file versioned bundle. Never overwrites an existing file. */
export function exportRunBundle(opts: {
  store: Store;
  clock: Clock;
  producerVersion: string;
  runId: string;
  outPath: string;
  verdict: VerdictResult;
  limits: Limits;
}): BundleInfo {
  const { store } = opts;
  const out = resolve(opts.outPath);
  if (existsSync(out)) throw new HandoffCheckError("CONFLICT", "the output path already exists; refusing to overwrite an evidence bundle");
  const drill = store.requireDrill(opts.runId);
  const evidence = store.evidence(opts.runId);
  const now = opts.clock.nowIso();
  const run: RunExport = {
    schema_version: SCHEMA_VERSION,
    exported_at: now,
    drill,
    state_history: store.history(opts.runId),
    steps: store.steps(opts.runId),
    interventions: store.interventions(opts.runId),
    evidence,
    cleanup_receipts: store.cleanups(opts.runId).map(stripLocators),
    verdict: opts.verdict
  };
  const runBytes = canonicalBytes(run);
  const objects = new Map<string, Buffer>();
  for (const e of evidence) if (!objects.has(e.sha256)) objects.set(e.sha256, store.objects.read(e.sha256));
  const files: BundleFileEntry[] = [{ path: "run.json", sha256: sha256Hex(runBytes), size_bytes: runBytes.length }];
  let blobBytes = 0;
  for (const [sha, data] of [...objects].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    files.push({ path: `objects/${sha}`, sha256: sha, size_bytes: data.length });
    blobBytes += data.length;
  }
  if (files.length + 1 > opts.limits.max_files) throw new HandoffCheckError("PAYLOAD_TOO_LARGE", `bundle would contain ${files.length + 1} files, over the limit of ${opts.limits.max_files}`);
  if (blobBytes > opts.limits.max_blob_bytes) throw new HandoffCheckError("PAYLOAD_TOO_LARGE", `bundle blobs total ${blobBytes} bytes, over the limit of ${opts.limits.max_blob_bytes}`);
  const header: BundleHeader = {
    format: BUNDLE_FORMAT,
    format_version: BUNDLE_FORMAT_VERSION,
    schema_version: SCHEMA_VERSION,
    created_at: now,
    producer: { name: "handoffcheck", version: opts.producerVersion },
    run_id: opts.runId,
    binding_digest: drill.binding_digest,
    files,
    root_hash: rootHash(files),
    metadata_bytes: runBytes.length,
    blob_bytes: blobBytes
  };
  const headerBytes = canonicalBytes(header);
  const tar = writeTar([
    { path: "bundle.json", data: headerBytes },
    { path: "run.json", data: runBytes },
    ...[...objects].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([sha, data]) => ({ path: `objects/${sha}`, data }))
  ]);
  requireCapacity(dirname(out), tar.length);
  mkdirSync(dirname(out), { recursive: true });
  const partial = `${out}.partial`;
  try {
    writeFileSync(partial, tar, { mode: 0o600, flag: "wx" }); // exclusive: never write through a pre-existing file or symlink
  } catch {
    throw new HandoffCheckError("CONFLICT", "a partial export file already exists next to the output path; remove it and retry");
  }
  renameSync(partial, out);
  return { path: out, bundle_sha256: sha256Hex(tar), header, bytes: tar.length };
}

type Err = { code: BundleErrorCode; message: string };

interface Parsed {
  header: BundleHeader | null;
  run: RunExport | null;
  objects: Map<string, Buffer>;
  errors: Err[];
  filesChecked: number;
}

function mapTar(err: TarError): Err {
  const code: BundleErrorCode = err.code === "TRUNCATED" ? "TRUNCATED" : err.code === "LIMIT" ? "LIMIT_EXCEEDED" : err.code === "UNSAFE" ? "UNSAFE_ENTRY" : "BAD_FORMAT";
  return { code, message: err.message };
}

/** Parse and fully verify a bundle in memory. Collects errors; never writes anything. */
export function parseBundle(buf: Buffer, limits: Limits): Parsed {
  const parsed: Parsed = { header: null, run: null, objects: new Map(), errors: [], filesChecked: 0 };
  const err = (code: BundleErrorCode, message: string): void => {
    parsed.errors.push({ code, message });
  };
  if (buf.length === 0) {
    err("BAD_FORMAT", "bundle file is empty");
    return parsed;
  }
  if (buf.length > maxBundleBytes(limits)) {
    err("LIMIT_EXCEEDED", "bundle file is larger than the allowed bundle size");
    return parsed;
  }
  let entries;
  try {
    entries = readTar(buf, { maxEntries: limits.max_files, maxTotalBytes: limits.max_blob_bytes + limits.max_metadata_bytes, symlinks: "none", strictTrailing: true });
  } catch (e) {
    const m = mapTar(e as TarError); // readTar only throws TarError; anything else maps to BAD_FORMAT
    err(m.code, m.message);
    return parsed;
  }
  const data = new Map<string, Buffer>();
  for (const e of entries) {
    if (e.type !== "file" || !(e.path === "bundle.json" || e.path === "run.json" || OBJECT_PATH.test(e.path))) {
      err("EXTRA_FILE", `unexpected bundle entry ${JSON.stringify(e.path.slice(0, 80))}`);
      continue;
    }
    data.set(e.path, Buffer.from(e.data as Uint8Array)); // file entries always carry data
  }
  if (parsed.errors.length > 0) return parsed;
  if (entries[0]?.path !== "bundle.json") {
    err("BAD_FORMAT", "bundle.json must be the first entry");
    return parsed;
  }

  let headerDoc: unknown;
  try {
    headerDoc = JSON.parse((data.get("bundle.json") as Buffer).toString("utf8"));
  } catch {
    err("BAD_FORMAT", "bundle.json is not valid JSON");
    return parsed;
  }
  const hd = headerDoc as Record<string, unknown>;
  if (hd === null || typeof hd !== "object" || hd["format"] !== BUNDLE_FORMAT) {
    err("BAD_FORMAT", "this is not a HandoffCheck evidence bundle");
    return parsed;
  }
  if (hd["format_version"] !== BUNDLE_FORMAT_VERSION || hd["schema_version"] !== SCHEMA_VERSION) {
    err("UNSUPPORTED_VERSION", `unsupported bundle version (format_version ${String(hd["format_version"])}, schema_version ${String(hd["schema_version"])}); this build reads format_version ${BUNDLE_FORMAT_VERSION}`);
    return parsed;
  }
  const hIssues = validateAgainst("evidence-bundle.schema.json", headerDoc);
  if (hIssues.length > 0) {
    err("SCHEMA_INVALID", `bundle header is invalid: ${formatIssues(hIssues)}`);
    return parsed;
  }
  const header = headerDoc as BundleHeader;
  parsed.header = header;

  const listed = new Map(header.files.map((f) => [f.path, f]));
  if (listed.size !== header.files.length) err("BAD_FORMAT", "bundle header lists a file twice");
  for (const f of header.files) {
    // content addressing: an object lives at objects/<its own sha256>, never at a different digest's path
    if (f.path.startsWith("objects/") && f.path !== `objects/${f.sha256}`) err("HASH_MISMATCH", `${f.path} is not stored under its own sha256`);
    const content = data.get(f.path);
    if (!content) {
      err("MISSING_FILE", `bundle is missing ${f.path}`);
      continue;
    }
    parsed.filesChecked += 1;
    if (content.length !== f.size_bytes || sha256Hex(content) !== f.sha256) err("HASH_MISMATCH", `${f.path} does not match its recorded size or sha256`);
  }
  for (const path of data.keys()) if (path !== "bundle.json" && !listed.has(path)) err("EXTRA_FILE", `bundle contains unlisted file ${path}`);
  if (rootHash(header.files) !== header.root_hash) err("ROOT_HASH_MISMATCH", "bundle root hash does not match its file list");
  const metaBytes = (data.get("bundle.json")?.length ?? 0) + (data.get("run.json")?.length ?? 0);
  const blobBytes = header.files.filter((f) => f.path.startsWith("objects/")).reduce((n, f) => n + f.size_bytes, 0);
  if (metaBytes > limits.max_metadata_bytes) err("LIMIT_EXCEEDED", "bundle metadata exceeds the metadata limit");
  if (blobBytes > limits.max_blob_bytes) err("LIMIT_EXCEEDED", "bundle blobs exceed the blob limit");
  if (parsed.errors.length > 0) return parsed;
  if (header.blob_bytes !== blobBytes) err("BAD_FORMAT", "bundle header blob_bytes does not match its files");

  let runDoc: unknown;
  try {
    runDoc = JSON.parse((data.get("run.json") as Buffer).toString("utf8"));
  } catch {
    err("BAD_FORMAT", "run.json is not valid JSON");
    return parsed;
  }
  const rIssues = validateAgainst("evidence-bundle.schema.json#/$defs/run_export", runDoc);
  if (rIssues.length > 0) {
    err("SCHEMA_INVALID", `run.json is invalid: ${formatIssues(rIssues)}`);
    return parsed;
  }
  const run = runDoc as RunExport;
  parsed.run = run;
  if (run.drill.id !== header.run_id || run.drill.binding_digest !== header.binding_digest) err("BAD_FORMAT", "run.json does not match the bundle header");
  const owned = (id: string): boolean => id === run.drill.id;
  if (![...run.steps, ...run.interventions, ...run.evidence, ...run.cleanup_receipts].every((r) => owned(r.drill_id))) err("BAD_FORMAT", "run.json contains records for another run");
  const referenced = new Set<string>();
  for (const e of run.evidence) {
    referenced.add(e.sha256);
    const obj = data.get(`objects/${e.sha256}`);
    if (!obj) err("MISSING_FILE", `evidence ${e.id} references a blob that is not in the bundle`);
    else if (obj.length !== e.size_bytes) err("HASH_MISMATCH", `evidence ${e.id} size does not match its blob`);
  }
  for (const s of run.steps) {
    if (s.evidence_hash !== null) {
      referenced.add(s.evidence_hash);
      const receiptBytes = data.get(`objects/${s.evidence_hash}`);
      if (!receiptBytes) {
        err("MISSING_FILE", `step ${s.step_key} references a receipt that is not in the bundle`);
        continue;
      }
      // the step record must agree with the receipt it points at (a forged status cannot hide behind a valid hash)
      let receipt: Record<string, unknown> | null = null;
      try {
        receipt = JSON.parse(receiptBytes.toString("utf8")) as Record<string, unknown>;
      } catch {
        receipt = null;
      }
      const agrees =
        receipt !== null &&
        receipt["drill_id"] === s.drill_id &&
        receipt["step_key"] === s.step_key &&
        receipt["action"] === s.action &&
        receipt["status"] === s.status &&
        receipt["reason_code"] === s.reason_code;
      if (!agrees) err("BAD_FORMAT", `step ${s.step_key} does not match its stored step receipt`);
    }
  }
  for (const f of header.files) if (f.path.startsWith("objects/") && !referenced.has(f.path.slice(8))) err("EXTRA_FILE", `blob ${f.path.slice(8, 20)} is not referenced by any evidence record`);
  for (const [path, content] of data) if (path.startsWith("objects/")) parsed.objects.set(path.slice(8), content);
  return parsed;
}

export function verifyBundleFile(path: string, limits: Limits): BundleVerification {
  let buf: Buffer;
  try {
    const st = statSync(path);
    if (st.isFile() && st.size === 0) return { ok: false, header: null, files_checked: 0, errors: [{ code: "BAD_FORMAT", message: "bundle file is empty" }] };
    if (!st.isFile()) return { ok: false, header: null, files_checked: 0, errors: [{ code: "BAD_FORMAT", message: "bundle path is not a regular file" }] };
    if (st.size > maxBundleBytes(limits)) {
      return { ok: false, header: null, files_checked: 0, errors: [{ code: "LIMIT_EXCEEDED", message: "bundle file is larger than the allowed bundle size" }] };
    }
    buf = readFileSync(path);
  } catch {
    return { ok: false, header: null, files_checked: 0, errors: [{ code: "MISSING_FILE", message: "bundle file cannot be read" }] };
  }
  const p = parseBundle(buf, limits);
  return { ok: p.errors.length === 0, header: p.header, files_checked: p.filesChecked, errors: p.errors };
}

function throwFor(errors: Err[]): never {
  const first = errors[0] as Err;
  const code = errors.some((e) => e.code === "UNSUPPORTED_VERSION") ? "UNSUPPORTED_VERSION" : errors.some((e) => e.code === "LIMIT_EXCEEDED") ? "PAYLOAD_TOO_LARGE" : "BUNDLE_CORRUPT";
  throw new HandoffCheckError(code, `bundle rejected, nothing was imported: ${first.message}${errors.length > 1 ? ` (+${errors.length - 1} more problems)` : ""}`, errors);
}

/** Atomic all-or-nothing import: everything is verified first, then rows commit in one transaction. */
export function importBundleFile(store: Store, path: string, limits: Limits, nowIso: () => string): ImportResult {
  let buf: Buffer;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new HandoffCheckError("BAD_REQUEST", "bundle path is not a regular file");
    if (st.size > maxBundleBytes(limits)) throw new HandoffCheckError("PAYLOAD_TOO_LARGE", "bundle file is larger than the allowed bundle size");
    buf = readFileSync(path);
  } catch (e) {
    if (e instanceof HandoffCheckError) throw e;
    throw new HandoffCheckError("BAD_REQUEST", "bundle file cannot be read");
  }
  const parsed = parseBundle(buf, limits);
  if (parsed.errors.length > 0) throwFor(parsed.errors);
  const header = parsed.header as BundleHeader;
  const run = parsed.run as RunExport;
  if (store.getDrill(run.drill.id)) throw new HandoffCheckError("CONFLICT", `run ${run.drill.id} already exists in this store; nothing was imported`);
  requireCapacity(store.dir, header.blob_bytes + header.metadata_bytes);
  // defense in depth: re-validate every record shape before touching the store
  assertValid("drill.schema.json", run.drill, "imported drill");

  const created: string[] = [];
  try {
    store.tx(() => {
      store.insertDrill({ ...run.drill, imported: true });
      for (const t of run.state_history) {
        store.db
          .prepare("INSERT INTO state_transitions (drill_id, seq, from_state, to_state, reason, at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(run.drill.id, t.seq, t.from_state, t.to_state, t.reason, t.at);
      }
      for (const [sha, data] of parsed.objects) {
        if (store.objects.put(data).created) created.push(sha);
      }
      for (const e of run.evidence) store.insertEvidence(e);
      for (const s of run.steps) store.insertStep(s);
      for (const i of run.interventions) store.insertIntervention(i);
      for (const c of run.cleanup_receipts) store.insertCleanup(c);
      // the bundle's own verdict is an unauthenticated claim: kept for display only
      store.insertImportClaim(run.drill.id, run.verdict, sha256Hex(buf), nowIso());
    });
  } catch (e) {
    for (const sha of created) store.objects.remove(sha);
    throw new HandoffCheckError("CONFLICT", `bundle conflicts with existing records; nothing was imported (${(e as Error).message.slice(0, 120)})`);
  }
  return { run_id: run.drill.id, files_imported: header.files.length + 1, bundle_sha256: sha256Hex(buf), binding_digest: header.binding_digest };
}
