#!/usr/bin/env bash
# Records a PRESERVED, raw live-VM receipt: the exact command, exit code, UTC timestamps, tool versions, `limactl list` before and
# after, the full vitest JSON and console log, and the redacted report and step logs of every live run.
#
#   bash scripts/live-receipt.sh <output-dir>
#
# Needs a real limactl (never a fake: without one it exits 2 and writes nothing that could pass for evidence), a clean committed tree
# (otherwise the receipt could not name the code it tested), and runs ONE VM at a time. The repository path is replaced by <repo> and
# UUIDs are shortened to id-<8 hex> in every written file so the receipt can be committed. Exit code = the live run's exit code.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
OUT="${1:?usage: live-receipt.sh <output-dir>}"
command -v limactl >/dev/null 2>&1 || { echo "BLOCKED: limactl not found; no live receipt can be recorded (never mocked)" >&2; exit 2; }
if [ -n "$(git status --short)" ]; then echo "refusing: the working tree is not clean, so the receipt could not name the code it tested" >&2; exit 2; fi
mkdir -p "$OUT/runs"
SHA=$(git rev-parse HEAD)
stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
{
  echo "git_sha: $SHA"
  echo "node: $(node -v)"
  echo "limactl: $(limactl --version 2>&1 | head -1)"
  echo "os: $(uname -srm)"
  echo "command: HC_LIVE_VM=1 HC_LIVE_RECEIPT_DIR=<out>/runs npx vitest run tests/live/vm.spec.ts --reporter=json --outputFile=<out>/vitest-live.json"
} >"$OUT/context.txt"
limactl list >"$OUT/limactl-list-before.txt" 2>&1
echo "started: $(stamp)" >>"$OUT/context.txt"
HC_LIVE_VM=1 HC_LIVE_RECEIPT_DIR="$OUT/runs" npx vitest run tests/live/vm.spec.ts --reporter=json --outputFile="$OUT/vitest-live.json" >"$OUT/console.log" 2>&1
RC=$?
echo "finished: $(stamp)" >>"$OUT/context.txt"
echo "exit_code: $RC" >>"$OUT/context.txt"
limactl list >"$OUT/limactl-list-after.txt" 2>&1
# keep the receipt publishable: no absolute repository paths
find "$OUT" -type f -print0 | xargs -0 sed -i.bak "s#$ROOT#<repo>#g"
# the public-content scanner blocks raw UUIDs: run and evidence ids are shortened to id-<first 8 hex> (hashes and everything else are untouched)
find "$OUT" -type f -print0 | xargs -0 sed -i.bak -E 's/([0-9a-fA-F]{8})-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/id-\1/g'
find "$OUT" -name '*.bak' -delete
echo "live receipt written to $OUT (exit $RC)"
exit "$RC"
