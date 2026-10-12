// Synthetic "notes service" used as a HandoffCheck fixture release.
// Deterministic, offline, no dependencies. Every secret in this tree is a planted FAKE.
// State lives under NOTES_HOME (default: <release root>/state). Never talks to a network.
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.NOTES_HOME ? resolve(process.env.NOTES_HOME) : join(ROOT, "state");
const SALT = "notes-fixture-salt-v1";
const CREDENTIAL_DIR = process.env.NOTES_CREDENTIAL_DIR ? resolve(process.env.NOTES_CREDENTIAL_DIR) : null;

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const hashToken = (token) => sha256(`${SALT}:${token}`);
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const fail = (code, obj) => {
  out(obj);
  process.exit(code);
};

function readEnvFile(path) {
  const vars = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) vars[m[1]] = m[2];
  }
  return vars;
}

const readLines = (path) =>
  existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const readRecords = () => readLines(join(HOME, "records.ndjson"));
const readJobs = (name) => readLines(join(HOME, name));
const writeJobs = (name, jobs) =>
  writeFileSync(join(HOME, name), jobs.map((j) => JSON.stringify(j)).join("\n") + (jobs.length ? "\n" : ""));
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function snapshot() {
  const records = readFileSync(join(HOME, "records.ndjson"));
  const blobs = {};
  const dir = join(HOME, "blobs");
  for (const f of readdirSync(dir).sort()) blobs[f] = sha256(readFileSync(join(dir, f)));
  return { records: records.toString("utf8").split("\n").filter(Boolean).length, records_sha256: sha256(records), blobs };
}

function runWorker() {
  const lock = join(HOME, "worker.lock");
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8").trim());
    if (pidAlive(pid)) fail(4, { status: "worker_busy", pid });
    fail(5, { status: "stale_lock", reason: "previous worker died; follow recovery steps" });
  }
  writeFileSync(lock, String(process.pid));
  const queue = readJobs("queue.ndjson");
  const done = [];
  while (queue.length) {
    const job = queue[0];
    if (job.poison) {
      writeJobs("queue.ndjson", queue);
      writeJobs("done.ndjson", [...readJobs("done.ndjson"), ...done]);
      // Simulate a hard crash: the lock is intentionally left behind (stale: pid is dead after exit).
      fail(3, { status: "worker_crashed", job: job.id });
    }
    done.push(queue.shift());
  }
  writeJobs("queue.ndjson", queue);
  writeJobs("done.ndjson", [...readJobs("done.ndjson"), ...done]);
  rmSync(lock, { force: true });
  out({ status: "worker_idle", processed: done.length });
}

const commands = {
  install() {
    rmSync(HOME, { recursive: true, force: true });
    mkdirSync(join(HOME, "blobs"), { recursive: true });
    cpSync(join(ROOT, "seed", "records.ndjson"), join(HOME, "records.ndjson"));
    cpSync(join(ROOT, "seed", "jobs.ndjson"), join(HOME, "queue.ndjson"));
    cpSync(join(ROOT, "seed", "blobs"), join(HOME, "blobs"), { recursive: true });
    const token = readEnvFile(join(ROOT, "config", "service.env")).NOTES_API_TOKEN;
    if (!token) fail(2, { status: "install_failed", reason: "NOTES_API_TOKEN missing in config/service.env" });
    writeFileSync(join(HOME, "auth.json"), JSON.stringify({ generation: 1, token_sha256: [hashToken(token)] }));
    writeFileSync(join(HOME, "VERSION"), "1.0.0\n");
    if (CREDENTIAL_DIR) writeFileSync(join(CREDENTIAL_DIR, "credential.old"), token);
    out({ status: "installed", version: "1.0.0" });
  },

  health() {
    try {
      const version = readFileSync(join(HOME, "VERSION"), "utf8").trim();
      const records = readRecords();
      const auth = JSON.parse(readFileSync(join(HOME, "auth.json"), "utf8"));
      if (records.length === 0) throw new Error("no records");
      out({ status: "ok", version, records: records.length, auth_generation: auth.generation });
    } catch (e) {
      fail(1, { status: "unhealthy", reason: String(e.message) });
    }
  },

  backup(dir) {
    if (!dir) fail(2, { status: "usage", reason: "backup <dir>" });
    const target = resolve(dir);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(join(target, "blobs"), { recursive: true });
    cpSync(join(HOME, "records.ndjson"), join(target, "records.ndjson"));
    cpSync(join(HOME, "blobs"), join(target, "blobs"), { recursive: true });
    const snap = snapshot();
    writeFileSync(join(target, "backup.json"), JSON.stringify({ schema_version: 1, ...snap }, null, 2) + "\n");
    out({ status: "backed_up", records: snap.records, blobs: Object.keys(snap.blobs).length });
  },

  // Simulates data loss so a restore has something to prove.
  wipe() {
    rmSync(join(HOME, "records.ndjson"), { force: true });
    rmSync(join(HOME, "blobs"), { recursive: true, force: true });
    mkdirSync(join(HOME, "blobs"), { recursive: true });
    out({ status: "wiped" });
  },

  restore(dir) {
    if (!dir) fail(2, { status: "usage", reason: "restore <dir>" });
    const source = resolve(dir);
    if (!existsSync(join(source, "backup.json"))) fail(1, { status: "restore_failed", reason: "backup.json missing" });
    rmSync(join(HOME, "records.ndjson"), { force: true });
    rmSync(join(HOME, "blobs"), { recursive: true, force: true });
    mkdirSync(join(HOME, "blobs"), { recursive: true });
    cpSync(join(source, "records.ndjson"), join(HOME, "records.ndjson"));
    cpSync(join(source, "blobs"), join(HOME, "blobs"), { recursive: true });
    out({ status: "restored" });
  },

  // Prints what the drill harness compares against its own expectations. Never self-certifies.
  measure() {
    const records = readRecords();
    const data_hashes = {};
    for (const rec of records) data_hashes[rec.id] = sha256(JSON.stringify(rec));
    const blobs = existsSync(join(HOME, "blobs")) ? readdirSync(join(HOME, "blobs")).length : 0;
    out({ record_counts: { notes: records.length, blobs }, data_hashes });
  },

  rotate() {
    const next = readEnvFile(join(ROOT, "config", "service.env.next")).NOTES_API_TOKEN;
    if (!next) fail(2, { status: "rotate_failed", reason: "NOTES_API_TOKEN missing in config/service.env.next" });
    const auth = JSON.parse(readFileSync(join(HOME, "auth.json"), "utf8"));
    writeFileSync(join(HOME, "auth.json"), JSON.stringify({ generation: auth.generation + 1, token_sha256: [hashToken(next)] }));
    if (CREDENTIAL_DIR) writeFileSync(join(CREDENTIAL_DIR, "credential.new"), next);
    out({ status: "rotated", generation: auth.generation + 1 });
  },

  // auth-probe: HC_CREDENTIAL is the credential under test. Exit 0 accepted, 3 rejected (the drill's reject code).
  "auth-probe"() {
    const token = (process.env.HC_CREDENTIAL ?? "").trim();
    const auth = JSON.parse(readFileSync(join(HOME, "auth.json"), "utf8"));
    const ok = token !== "" && auth.token_sha256.includes(hashToken(token));
    out({ status: ok ? "accepted" : "rejected" });
    process.exit(ok ? 0 : 3);
  },

  // Seeded worker failure: the poison job crashes the worker and leaves a stale lock behind.
  worker: runWorker,

  // Documented recovery: clear a STALE lock only, dead-letter the poison job, rerun the worker.
  recover() {
    const lock = join(HOME, "worker.lock");
    if (existsSync(lock)) {
      const pid = Number(readFileSync(lock, "utf8").trim());
      if (pidAlive(pid)) fail(4, { status: "refusing", reason: "lock holder is alive" });
      rmSync(lock, { force: true });
    }
    const queue = readJobs("queue.ndjson");
    writeJobs("deadletter.ndjson", [...readJobs("deadletter.ndjson"), ...queue.filter((j) => j.poison)]);
    writeJobs("queue.ndjson", queue.filter((j) => !j.poison));
    runWorker();
  },

  // worker-probe: unhealthy only while a worker lock exists (a crashed worker leaves a stale one behind).
  "worker-probe"() {
    const pending = readJobs("queue.ndjson").length;
    const lock = existsSync(join(HOME, "worker.lock"));
    const ok = !lock;
    out({ status: ok ? "worker_healthy" : "worker_unhealthy", pending, lock });
    process.exit(ok ? 0 : 1);
  }
};

const [cmd, ...args] = process.argv.slice(2);
if (!cmd || !Object.hasOwn(commands, cmd)) fail(2, { status: "usage", commands: Object.keys(commands) });
commands[cmd](...args);
