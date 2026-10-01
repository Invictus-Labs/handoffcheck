import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { InputPaths } from "../domain/types.js";
import { writeTar } from "../security/tar.js";

/**
 * Self-contained synthetic scenario for `handoffcheck demo` (AC-09): a tiny heartbeat worker, a synthetic backup, a
 * rotating fake credential and a seeded worker failure. It opens no sockets at all, so it also completes with all
 * outbound and loopback networking denied. No accounts, no telemetry. Everything is planted fake data (HCFAKE markers) and every receipt is labelled isolation=none.
 */

const SERVICE = `import fs from "node:fs";
const state = process.env.HC_STATE;
const beat = () => fs.writeFileSync(state + "/heartbeat", String(Date.now()));
beat();
setInterval(beat, 200);
`;

const RECORDS = JSON.stringify([
  { id: 1, name: "alpha" },
  { id: 2, name: "beta" },
  { id: 3, name: "gamma" }
]);

function blob(): Buffer {
  const b = Buffer.alloc(4096);
  for (let i = 0; i < b.length; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
}

const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

const START = `rm -f "$HC_STATE/heartbeat"
"$HC_NODE" "$HC_RELEASE/worker.mjs" > "$HC_STATE/worker.log" 2>&1 &
echo $! > "$HC_STATE/worker.pid"
`;

const SCRIPTS: Record<string, string> = {
  "install.sh": `#!/bin/sh
set -eu
mkdir -p "$HC_STATE"
printf 'HCFAKE_DEMO_KEY_ONE_0001' > "$HC_STATE/credential.current"
cp "$HC_STATE/credential.current" "$HC_STATE/active-credential"
${START}echo "worker started"
`,
  "probe.mjs": `import fs from "node:fs";
const state = process.env.HC_STATE;
try {
  const pid = Number(fs.readFileSync(state + "/worker.pid", "utf8").trim());
  process.kill(pid, 0);
  const age = Date.now() - Number(fs.readFileSync(state + "/heartbeat", "utf8"));
  process.exit(age < 1500 ? 0 : 1);
} catch { process.exit(1); }
`,
  "restore.sh": `#!/bin/sh
set -eu
cp "$HC_RELEASE/data/backup/records.json" "$HC_STATE/records.json"
cp "$HC_RELEASE/data/backup/blob.bin" "$HC_STATE/blob.bin"
echo "restored synthetic backup"
`,
  "measure.mjs": `import fs from "node:fs";
import crypto from "node:crypto";
const raw = fs.readFileSync(process.env.HC_STATE + "/records.json");
const records = JSON.parse(raw.toString("utf8"));
process.stdout.write(JSON.stringify({
  record_counts: { records: records.length },
  data_hashes: { records: crypto.createHash("sha256").update(raw).digest("hex") }
}));
`,
  "rotate.sh": `#!/bin/sh
set -eu
printf 'HCFAKE_DEMO_KEY_TWO_0002' > "$HC_STATE/credential.rotated"
cp "$HC_STATE/credential.rotated" "$HC_STATE/active-credential"
echo "rotated credential to $(cat "$HC_STATE/credential.rotated")"
`,
  "rotate-probe.mjs": `import fs from "node:fs";
const state = process.env.HC_STATE;
try {
  process.kill(Number(fs.readFileSync(state + "/worker.pid", "utf8").trim()), 0);
  const active = fs.readFileSync(state + "/active-credential", "utf8").trim();
  process.exit(active !== "" && process.env.HC_CREDENTIAL === active ? 0 : 3);
} catch { process.exit(1); }
`,
  "seed-fault.sh": `#!/bin/sh
set -eu
kill "$(cat "$HC_STATE/worker.pid")"
sleep 1
echo "worker killed"
`,
  "recover.sh": `#!/bin/sh
set -eu
${START}echo "worker restarted"
`
};

const RUNBOOK = `# Demo runbook (synthetic)

1. Install: start the demo worker (no sockets) and wait for its health probe.
2. Restore: restore the synthetic backup and verify record counts and data/blob hashes.
3. Rotate: rotate the synthetic credential; the old one must fail and the new one must work.
4. Recover: a seeded worker failure is recovered by restarting the worker within the bound.
`;

function manifest(recordsHash: string, blobHash: string): string {
  return `schema_version: 1
scenario:
  id: demo-synthetic
  version: "1.0.0"
  title: Offline synthetic handoff drill
  synthetic: true
operator:
  kind: automated
  ref: demo-harness
runner:
  provider: local-sandbox
  wall_seconds: 180
network:
  allow: []
synthetic_secrets:
  - HCFAKE_DEMO_KEY_ONE_0001
  - HCFAKE_DEMO_KEY_TWO_0002
steps:
  - id: install
    action: install
    deadline_seconds: 60
    script: { path: scripts/install.sh }
    probe: { path: scripts/probe.mjs, interpreter: node }
  - id: restore
    action: restore
    deadline_seconds: 60
    script: { path: scripts/restore.sh }
    measure: { path: scripts/measure.mjs, interpreter: node }
    expect:
      record_counts: { records: 3 }
      data_hashes: { records: "${recordsHash}" }
      blobs:
        - { path: state/blob.bin, sha256: "${blobHash}" }
  - id: rotate
    action: rotate
    deadline_seconds: 60
    script: { path: scripts/rotate.sh }
    credentials: { old_file: state/credential.current, new_file: state/credential.rotated }
    probe: { path: scripts/rotate-probe.mjs, interpreter: node }
  - id: recover
    action: recover
    deadline_seconds: 90
    seed_fault: { path: scripts/seed-fault.sh }
    probe: { path: scripts/probe.mjs, interpreter: node }
    script: { path: scripts/recover.sh }
    max_recovery_seconds: 45
`;
}

/** Write the demo artifact, runbook, scripts and manifest into `dir` and return their paths. */
export function buildDemoInputs(dir: string): InputPaths {
  mkdirSync(join(dir, "scripts"), { recursive: true });
  for (const [name, body] of Object.entries(SCRIPTS)) {
    const p = join(dir, "scripts", name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body, { mode: 0o600 });
    chmodSync(p, 0o600);
  }
  const blobBytes = blob();
  const tar = writeTar([
    { path: "worker.mjs", data: Buffer.from(SERVICE) },
    { path: "data", type: "directory" },
    { path: "data/backup", type: "directory" },
    { path: "data/backup/records.json", data: Buffer.from(RECORDS) },
    { path: "data/backup/blob.bin", data: blobBytes }
  ]);
  const artifactPath = join(dir, "release.tar");
  const runbookPath = join(dir, "RUNBOOK.md");
  const manifestPath = join(dir, "drill.yaml");
  writeFileSync(artifactPath, tar);
  writeFileSync(runbookPath, RUNBOOK);
  writeFileSync(manifestPath, manifest(sha(RECORDS), sha(blobBytes)));
  return { manifestPath, artifactPath, runbookPath };
}
