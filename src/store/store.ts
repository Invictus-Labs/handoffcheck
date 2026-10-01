import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { join } from "node:path";
import { canonicalJson } from "../domain/canonical.js";
import { HandoffCheckError } from "../domain/errors.js";
import { assertTransition } from "../domain/state.js";
import { SCHEMA_VERSION } from "../domain/types.js";
import type {
  CleanupReceipt,
  DrillRecord,
  EvidenceRecord,
  InterventionRecord,
  ResourceRecord,
  RunOutcome,
  RunState,
  StateTransition,
  StepRecord,
  VerdictResult
} from "../domain/types.js";
import { ObjectStore } from "../evidence/cas.js";
import { migrate } from "./migrate.js";
import { DatabaseSync } from "./sqlite.js";
import type { Database } from "./sqlite.js";

type Row = Record<string, unknown>;

function bool(v: unknown): boolean {
  return v === 1 || v === true;
}

function toDrill(r: Row): DrillRecord {
  return {
    schema_version: SCHEMA_VERSION,
    id: r["id"] as string,
    workspace_id: r["workspace_id"] as string,
    scenario_id: r["scenario_id"] as string,
    scenario_version: r["scenario_version"] as string,
    artifact_digest: r["artifact_digest"] as string,
    runbook_hash: r["runbook_hash"] as string,
    manifest_digest: r["manifest_digest"] as string,
    binding_digest: r["binding_digest"] as string,
    operator_ref: r["operator_ref"] as string,
    operator_kind: r["operator_kind"] as DrillRecord["operator_kind"],
    builder_ref: (r["builder_ref"] as string | null) ?? null,
    provider: r["provider"] as string,
    isolation: r["isolation"] as DrillRecord["isolation"],
    state: r["state"] as RunState,
    outcome: (r["outcome"] as RunOutcome | null) ?? null,
    outcome_reason: (r["outcome_reason"] as DrillRecord["outcome_reason"]) ?? null,
    created_at: r["created_at"] as string,
    started_at: (r["started_at"] as string | null) ?? null,
    finished_at: (r["finished_at"] as string | null) ?? null,
    retain_until: r["retain_until"] as string,
    imported: bool(r["imported"]),
    fault_injected: bool(r["fault_injected"]),
    planned_steps: (r["planned_steps"] as number | null) ?? 0
  };
}

function toStep(r: Row): StepRecord {
  return {
    schema_version: SCHEMA_VERSION,
    id: r["id"] as string,
    drill_id: r["drill_id"] as string,
    seq: r["seq"] as number,
    step_key: r["step_key"] as string,
    action: r["action"] as StepRecord["action"],
    deadline_seconds: r["deadline_seconds"] as number,
    mandatory: bool(r["mandatory"]),
    status: r["status"] as StepRecord["status"],
    reason_code: r["reason_code"] as StepRecord["reason_code"],
    evidence_hash: (r["evidence_hash"] as string | null) ?? null,
    started_at: (r["started_at"] as string | null) ?? null,
    finished_at: (r["finished_at"] as string | null) ?? null,
    duration_ms: (r["duration_ms"] as number | null) ?? null
  };
}

function toIntervention(r: Row): InterventionRecord {
  return {
    schema_version: SCHEMA_VERSION,
    id: r["id"] as string,
    drill_id: r["drill_id"] as string,
    actor_ref: r["actor_ref"] as string,
    reason: r["reason"] as string,
    occurred_at: r["occurred_at"] as string,
    step_key: (r["step_key"] as string | null) ?? null,
    signature: r["signature"] as string,
    attestation: "local-identity-unsigned-by-third-party"
  };
}

function toEvidence(r: Row): EvidenceRecord {
  return {
    schema_version: SCHEMA_VERSION,
    id: r["id"] as string,
    drill_id: r["drill_id"] as string,
    step_key: (r["step_key"] as string | null) ?? null,
    kind: r["kind"] as EvidenceRecord["kind"],
    sha256: r["sha256"] as string,
    media_type: r["media_type"] as string,
    size_bytes: r["size_bytes"] as number,
    redacted: bool(r["redacted"]),
    redaction_count: r["redaction_count"] as number,
    created_at: r["created_at"] as string
  };
}

function toCleanup(r: Row): CleanupReceipt {
  return {
    schema_version: SCHEMA_VERSION,
    id: r["id"] as string,
    drill_id: r["drill_id"] as string,
    seq: r["seq"] as number,
    provider: r["provider"] as string,
    isolation: r["isolation"] as CleanupReceipt["isolation"],
    status: r["status"] as CleanupReceipt["status"],
    resources: JSON.parse(r["resources"] as string) as ResourceRecord[],
    verified_at: r["verified_at"] as string,
    note: (r["note"] as string | null) ?? null
  };
}

export interface StoreOptions {
  nowIso: () => string;
  newId: () => string;
}

/** SQLite metadata store plus content-addressed objects under one owner-only directory. */
export class Store {
  readonly dir: string;
  readonly db: Database;
  readonly objects: ObjectStore;
  readonly workspaceId: string;
  private readonly identityKey: Buffer;

  private constructor(dir: string, db: Database, objects: ObjectStore, workspaceId: string, key: Buffer) {
    this.dir = dir;
    this.db = db;
    this.objects = objects;
    this.workspaceId = workspaceId;
    this.identityKey = key;
  }

  static open(dir: string, opts: StoreOptions): Store {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* directory owned by someone else: leave as is, writes will fail loudly */
    }
    const db = new DatabaseSync(join(dir, "handoffcheck.sqlite"));
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    migrate(db, opts.nowIso);
    for (const f of ["handoffcheck.sqlite", "handoffcheck.sqlite-wal", "handoffcheck.sqlite-shm"]) {
      try {
        chmodSync(join(dir, f), 0o600);
      } catch {
        /* sidecar may not exist yet */
      }
    }

    let ws = (db.prepare("SELECT v FROM store_meta WHERE k = 'workspace_id'").get() as { v: string } | undefined)?.v;
    if (!ws) {
      ws = opts.newId();
      db.prepare("INSERT INTO store_meta (k, v) VALUES ('workspace_id', ?)").run(ws);
    }
    const keyPath = join(dir, "identity.key");
    try {
      writeFileSync(keyPath, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
    } catch {
      /* already exists (reopen or a concurrent open created it first); any other failure surfaces in the read below */
    }
    const key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "hex");
    return new Store(dir, db, new ObjectStore(dir), ws, key);
  }

  close(): void {
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      /* best effort */
    }
    this.db.close();
  }

  /** Run `fn` in one IMMEDIATE transaction; any throw rolls everything back. */
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** HMAC-SHA256 of canonical JSON under the local identity key (local tamper evidence only). */
  sign(doc: unknown): string {
    return createHmac("sha256", this.identityKey).update(canonicalJson(doc)).digest("hex");
  }

  /* ------------------------------------------------------------- drills */

  insertDrill(d: DrillRecord): void {
    this.db
      .prepare(
        `INSERT INTO drills (id, workspace_id, schema_version, scenario_id, scenario_version, artifact_digest, runbook_hash,
          manifest_digest, binding_digest, operator_ref, operator_kind, builder_ref, provider, isolation, state, outcome,
          outcome_reason, created_at, started_at, finished_at, retain_until, imported, fault_injected, planned_steps)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        d.id, d.workspace_id, d.schema_version, d.scenario_id, d.scenario_version, d.artifact_digest, d.runbook_hash,
        d.manifest_digest, d.binding_digest, d.operator_ref, d.operator_kind, d.builder_ref, d.provider, d.isolation, d.state,
        d.outcome, d.outcome_reason, d.created_at, d.started_at, d.finished_at, d.retain_until, d.imported ? 1 : 0, d.fault_injected ? 1 : 0, d.planned_steps ?? 0
      );
  }

  getDrill(id: string): DrillRecord | null {
    const row = this.db.prepare("SELECT * FROM drills WHERE id = ?").get(id) as Row | undefined;
    return row ? toDrill(row) : null;
  }

  requireDrill(id: string): DrillRecord {
    const d = this.getDrill(id);
    if (!d) throw new HandoffCheckError("NOT_FOUND", `run ${id} was not found in this store`);
    return d;
  }

  /** Move the lifecycle projection forward and append the transition. Illegal transitions throw. */
  transition(
    id: string,
    to: RunState,
    at: string,
    patch: { outcome?: RunOutcome; outcome_reason?: DrillRecord["outcome_reason"]; started_at?: string; finished_at?: string; reason?: string } = {}
  ): DrillRecord {
    const d = this.requireDrill(id);
    assertTransition(d.state, to);
    const next = this.nextSeq("state_transitions", id);
    this.tx(() => {
      this.db
        .prepare("INSERT INTO state_transitions (drill_id, seq, from_state, to_state, reason, at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, next, d.state, to, patch.reason ?? null, at);
      this.db
        .prepare("UPDATE drills SET state = ?, outcome = ?, outcome_reason = ?, started_at = ?, finished_at = ? WHERE id = ?")
        .run(to, patch.outcome ?? d.outcome, patch.outcome_reason ?? d.outcome_reason, patch.started_at ?? d.started_at, patch.finished_at ?? d.finished_at, id);
    });
    return this.requireDrill(id);
  }

  /** Record the initial CREATED transition. */
  recordCreated(id: string, at: string): void {
    this.db.prepare("INSERT INTO state_transitions (drill_id, seq, from_state, to_state, reason, at) VALUES (?, 0, NULL, 'CREATED', NULL, ?)").run(id, at);
  }

  private nextSeq(table: "state_transitions" | "cleanup_receipts" | "steps", drillId: string): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM ${table} WHERE drill_id = ?`).get(drillId) as { n: number };
    return row.n;
  }

  history(id: string): StateTransition[] {
    return (this.db.prepare("SELECT seq, from_state, to_state, reason, at FROM state_transitions WHERE drill_id = ? ORDER BY seq").all(id) as Row[]).map((r) => ({
      seq: r["seq"] as number,
      from_state: (r["from_state"] as RunState | null) ?? null,
      to_state: r["to_state"] as RunState,
      reason: (r["reason"] as string | null) ?? null,
      at: r["at"] as string
    }));
  }

  listDrills(limit: number, afterCreatedId?: { created_at: string; id: string }): DrillRecord[] {
    const rows = afterCreatedId
      ? this.db
          .prepare("SELECT * FROM drills WHERE (created_at, id) > (?, ?) ORDER BY created_at, id LIMIT ?")
          .all(afterCreatedId.created_at, afterCreatedId.id, limit)
      : this.db.prepare("SELECT * FROM drills ORDER BY created_at, id LIMIT ?").all(limit);
    return (rows as Row[]).map(toDrill);
  }

  drillsForScenario(scenarioId: string): DrillRecord[] {
    return (this.db.prepare("SELECT * FROM drills WHERE scenario_id = ? ORDER BY created_at DESC, id DESC").all(scenarioId) as Row[]).map(toDrill);
  }

  drillIdsCreatedBefore(iso: string): string[] {
    return (this.db.prepare("SELECT id FROM drills WHERE created_at <= ?").all(iso) as Row[]).map((r) => r["id"] as string);
  }

  expiredDrillIds(nowIso: string): string[] {
    return (this.db.prepare("SELECT id FROM drills WHERE retain_until < ?").all(nowIso) as Row[]).map((r) => r["id"] as string);
  }

  /* -------------------------------------------------------------- steps */

  insertStep(s: StepRecord): void {
    this.db
      .prepare(
        `INSERT INTO steps (id, drill_id, schema_version, seq, step_key, action, deadline_seconds, mandatory, status, reason_code,
          evidence_hash, started_at, finished_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(s.id, s.drill_id, s.schema_version, s.seq, s.step_key, s.action, s.deadline_seconds, s.mandatory ? 1 : 0, s.status, s.reason_code, s.evidence_hash, s.started_at, s.finished_at, s.duration_ms);
  }

  steps(drillId: string): StepRecord[] {
    return (this.db.prepare("SELECT * FROM steps WHERE drill_id = ? ORDER BY seq").all(drillId) as Row[]).map(toStep);
  }

  /* ------------------------------------------------------ interventions */

  insertIntervention(i: InterventionRecord): void {
    this.db
      .prepare(
        `INSERT INTO interventions (id, drill_id, schema_version, actor_ref, reason, occurred_at, step_key, signature, attestation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(i.id, i.drill_id, i.schema_version, i.actor_ref, i.reason, i.occurred_at, i.step_key, i.signature, i.attestation);
  }

  interventions(drillId: string): InterventionRecord[] {
    return (this.db.prepare("SELECT * FROM interventions WHERE drill_id = ? ORDER BY occurred_at, id").all(drillId) as Row[]).map(toIntervention);
  }

  /* ----------------------------------------------------------- evidence */

  insertEvidence(e: EvidenceRecord): void {
    this.db
      .prepare(
        `INSERT INTO evidence (id, drill_id, schema_version, step_key, kind, sha256, media_type, size_bytes, redacted, redaction_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(e.id, e.drill_id, e.schema_version, e.step_key, e.kind, e.sha256, e.media_type, e.size_bytes, e.redacted ? 1 : 0, e.redaction_count, e.created_at);
  }

  evidence(drillId: string): EvidenceRecord[] {
    return (this.db.prepare("SELECT * FROM evidence WHERE drill_id = ? ORDER BY created_at, id").all(drillId) as Row[]).map(toEvidence);
  }

  /** Evidence rows whose object is missing, resized or fails its sha256 (tamper / corruption detection). */
  evidenceProblems(drillId: string): { id: string; problem: string }[] {
    const bad: { id: string; problem: string }[] = [];
    for (const e of this.evidence(drillId)) {
      try {
        this.objects.read(e.sha256); // verifies existence and sha256; sizes are verified at import
      } catch (err) {
        bad.push({ id: e.id, problem: (err as Error).message.slice(0, 100) });
      }
    }
    return bad;
  }

  /** True when any evidence row (any run) still references the object. */
  objectReferenced(sha: string): boolean {
    return (this.db.prepare("SELECT 1 AS x FROM evidence WHERE sha256 = ? LIMIT 1").get(sha) as Row | undefined) !== undefined;
  }

  /* ----------------------------------------------------------- cleanup */

  insertCleanup(c: CleanupReceipt): void {
    this.db
      .prepare(
        `INSERT INTO cleanup_receipts (id, drill_id, schema_version, seq, provider, isolation, status, resources, verified_at, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(c.id, c.drill_id, c.schema_version, c.seq, c.provider, c.isolation, c.status, JSON.stringify(c.resources), c.verified_at, c.note);
  }

  nextCleanupSeq(drillId: string): number {
    return this.nextSeq("cleanup_receipts", drillId);
  }

  cleanups(drillId: string): CleanupReceipt[] {
    return (this.db.prepare("SELECT * FROM cleanup_receipts WHERE drill_id = ? ORDER BY seq").all(drillId) as Row[]).map(toCleanup);
  }

  latestCleanup(drillId: string): CleanupReceipt | null {
    const all = this.cleanups(drillId);
    return all[all.length - 1] ?? null;
  }

  /* ---------------------------------------------------- orphan recovery */

  setOwner(drillId: string, pid: number, started: string): void {
    this.db.prepare("UPDATE drills SET owner_pid = ?, owner_started = ? WHERE id = ?").run(pid, started, drillId);
  }

  owner(drillId: string): { pid: number; started: string } | null {
    const row = this.db.prepare("SELECT owner_pid, owner_started FROM drills WHERE id = ?").get(drillId) as Row | undefined;
    const pid = row?.["owner_pid"];
    return typeof pid === "number" ? { pid, started: (row?.["owner_started"] as string | null) ?? "" } : null;
  }

  putInventory(drillId: string, provider: string, resources: readonly ResourceRecord[]): void {
    const seq = (this.db.prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM run_inventory WHERE drill_id = ?").get(drillId) as { n: number }).n;
    this.db.prepare("INSERT INTO run_inventory (drill_id, seq, provider, resources) VALUES (?, ?, ?, ?)").run(drillId, seq, provider, JSON.stringify(resources));
  }

  latestInventory(drillId: string): ResourceRecord[] | null {
    const row = this.db.prepare("SELECT resources FROM run_inventory WHERE drill_id = ? ORDER BY seq DESC LIMIT 1").get(drillId) as Row | undefined;
    return row ? (JSON.parse(row["resources"] as string) as ResourceRecord[]) : null;
  }

  drillsInStates(states: readonly RunState[]): DrillRecord[] {
    const marks = states.map(() => "?").join(", ");
    return (this.db.prepare(`SELECT * FROM drills WHERE state IN (${marks}) ORDER BY created_at, id`).all(...states) as Row[]).map(toDrill);
  }

  /* --------------------------------------------------------- run secrets */

  private secretsKey(): Buffer {
    return createHmac("sha256", this.identityKey).update("handoffcheck run-secrets v1").digest();
  }

  /**
   * Persist secret literals (declared synthetic secrets, credentials learned during rotation) encrypted at rest so later
   * writers can redact them. Never exported in bundles; the plaintext never touches sqlite.
   */
  putRunSecrets(drillId: string, literals: readonly string[]): void {
    if (literals.length === 0) return;
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.secretsKey(), nonce);
    const body = Buffer.concat([cipher.update(JSON.stringify(literals), "utf8"), cipher.final(), cipher.getAuthTag()]);
    const seq = (this.db.prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM run_secrets WHERE drill_id = ?").get(drillId) as { n: number }).n;
    this.db.prepare("INSERT INTO run_secrets (drill_id, seq, nonce, ciphertext) VALUES (?, ?, ?, ?)").run(drillId, seq, nonce.toString("hex"), body.toString("hex"));
  }

  /** All secret literals recorded for the run (empty for imported runs, which carry none). */
  runSecrets(drillId: string): string[] {
    const out: string[] = [];
    for (const row of this.db.prepare("SELECT nonce, ciphertext FROM run_secrets WHERE drill_id = ? ORDER BY seq").all(drillId) as Row[]) {
      const raw = Buffer.from(row["ciphertext"] as string, "hex");
      const decipher = createDecipheriv("aes-256-gcm", this.secretsKey(), Buffer.from(row["nonce"] as string, "hex"));
      decipher.setAuthTag(raw.subarray(raw.length - 16));
      const text = Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString("utf8");
      out.push(...(JSON.parse(text) as string[]));
    }
    return out;
  }

  /* ------------------------------------------------------ import claims */

  insertImportClaim(drillId: string, claimed: VerdictResult, bundleSha256: string, at: string): void {
    this.db
      .prepare("INSERT INTO import_claims (drill_id, claimed_verdict, claimed_json, bundle_sha256, imported_at) VALUES (?, ?, ?, ?, ?)")
      .run(drillId, claimed.verdict, JSON.stringify(claimed), bundleSha256, at);
  }

  importClaim(drillId: string): VerdictResult | null {
    const row = this.db.prepare("SELECT claimed_json FROM import_claims WHERE drill_id = ?").get(drillId) as Row | undefined;
    return row ? (JSON.parse(row["claimed_json"] as string) as VerdictResult) : null;
  }

  /* ---------------------------------------------------------- retention */

  /** Retention purge: the only code path allowed to delete history. Returns orphaned object digests. */
  purgeDrills(ids: string[]): string[] {
    if (ids.length === 0) return [];
    const shas = new Set<string>();
    this.tx(() => {
      this.db.prepare("INSERT OR REPLACE INTO store_meta (k, v) VALUES ('purge_mode', '1')").run();
      try {
        for (const id of ids) {
          for (const e of this.evidence(id)) shas.add(e.sha256);
          for (const t of ["run_inventory", "run_secrets", "import_claims", "cleanup_receipts", "evidence", "interventions", "steps", "state_transitions"]) {
            this.db.prepare(`DELETE FROM ${t} WHERE drill_id = ?`).run(id);
          }
          this.db.prepare("DELETE FROM drills WHERE id = ?").run(id);
        }
      } finally {
        this.db.prepare("DELETE FROM store_meta WHERE k = 'purge_mode'").run();
      }
    });
    return [...shas].filter((s) => !this.objectReferenced(s));
  }
}
