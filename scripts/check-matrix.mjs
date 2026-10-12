#!/usr/bin/env node
// Lints docs/qa/AC-MATRIX.md so the matrix cannot overclaim.
//  - exactly AC-01..AC-12, each once, status in the allowed vocabulary
//  - every `file :: test name` id must point at an existing spec containing that test name
//  - Automated column: PASS requires at least one test id; AC-08 and AC-12 can never be PASS (human receipts)
//  - Live VM column: PASS | BLOCKED | n/a (a live PASS can never be claimed for AC-08/AC-12 by an agent either)
//  - prints a verdict; --strict exits 3 unless every row is PASS (AC-08/AC-12 make that impossible
//    until a human receipt exists, by design)
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATUSES = new Set(["PASS", "FAIL", "NOT RUN", "PARTIAL", "PENDING_HUMAN_RECEIPT", "PLANNED"]);
const LIVE = new Set(["PASS", "PARTIAL", "BLOCKED", "n/a"]);
const HUMAN = new Set(["AC-08", "AC-12"]);
const text = readFileSync(resolve(ROOT, "docs", "qa", "AC-MATRIX.md"), "utf8");
const problems = [];
const rows = new Map();

for (const line of text.split("\n")) {
  const cells = line.split("|").map((c) => c.trim());
  const id = cells[1];
  if (!id || !/^AC-\d\d$/.test(id)) continue;
  if (rows.has(id)) problems.push(`${id}: duplicated row`);
  const status = cells[4] ?? "";
  const live = cells[5] ?? "";
  const ids = [...(cells[3] ?? "").matchAll(/`([^`]+? :: [^`]+?)`/g)].map((m) => m[1]);
  rows.set(id, { status, live, ids });
}

for (let i = 1; i <= 12; i++) {
  const id = `AC-${String(i).padStart(2, "0")}`;
  const row = rows.get(id);
  if (!row) {
    problems.push(`${id}: missing row`);
    continue;
  }
  if (!STATUSES.has(row.status)) problems.push(`${id}: status "${row.status}" not in vocabulary`);
  if (!LIVE.has(row.live)) problems.push(`${id}: live VM status "${row.live}" not in vocabulary`);
  if (HUMAN.has(id) && row.live === "PASS") problems.push(`${id}: human receipt criterion may not be a live PASS recorded by an agent`);
  if (HUMAN.has(id) && row.status === "PASS") problems.push(`${id}: human receipt criterion may not be PASS`);
  if (row.status === "PASS" && row.ids.length === 0) problems.push(`${id}: PASS without a test id`);
  for (const tid of row.ids) {
    const [file, name] = tid.split(" :: ");
    const path = resolve(ROOT, file ?? "");
    if (!existsSync(path)) {
      problems.push(`${id}: ${file} does not exist`);
      continue;
    }
    if (!readFileSync(path, "utf8").includes(name ?? "\u0000")) problems.push(`${id}: no test named "${name}" in ${file}`);
  }
}

const counts = {};
for (const { status, live } of rows.values()) {
  counts[status] = (counts[status] ?? 0) + 1;
  if (live !== "n/a") counts[`live:${live}`] = (counts[`live:${live}`] ?? 0) + 1;
}
const allPass = [...rows.values()].length === 12 && [...rows.values()].every((r) => r.status === "PASS" && (r.live === "PASS" || r.live === "n/a"));
process.stdout.write(`matrix rows: ${JSON.stringify(counts)}\n`);
process.stdout.write(allPass && problems.length === 0 ? "MATRIX_VERDICT=PASSED\n" : "MATRIX_VERDICT=INCOMPLETE (not every required cell is PASS; do not claim the matrix passed)\n");
if (problems.length) {
  for (const p of problems) process.stderr.write(`matrix lint: ${p}\n`);
  process.exit(1);
}
if (process.argv.includes("--strict") && !allPass) process.exit(3);
