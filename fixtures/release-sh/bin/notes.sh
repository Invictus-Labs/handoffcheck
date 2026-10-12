#!/bin/sh
# Synthetic "notes service" in POSIX sh only (no Node): runs on a minimal Alpine/busybox guest for the live VM drill.
# Same behaviour and seed data as fixtures/release (Node). Every secret is a planted FAKE. Never touches a network.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
HOME_DIR="${NOTES_HOME:-$ROOT/state}"

sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi; }
tokhash() { printf '%s' "notes-fixture-salt-v1:$1" | sha; }
env_get() { sed -n "s/^$2=//p" "$1" | head -n 1; }
lines() { if [ -f "$1" ]; then wc -l < "$1" | tr -d ' '; else echo 0; fi; }
say() { printf '%s\n' "$1"; }

run_worker() {
  lock="$HOME_DIR/worker.lock"
  if [ -f "$lock" ]; then
    pid=$(cat "$lock")
    if kill -0 "$pid" 2>/dev/null; then say '{"status":"worker_busy"}'; exit 4; fi
    say '{"status":"stale_lock","reason":"previous worker died; follow recovery steps"}'
    exit 5
  fi
  echo "$$" > "$lock"
  : > "$HOME_DIR/queue.new"
  processed=0
  crashed=0
  while IFS= read -r line || [ -n "$line" ]; do
    if [ "$crashed" -eq 1 ]; then printf '%s\n' "$line" >> "$HOME_DIR/queue.new"; continue; fi
    case "$line" in
      *'"poison":true'*) crashed=1; printf '%s\n' "$line" >> "$HOME_DIR/queue.new" ;;
      *) processed=$((processed + 1)); printf '%s\n' "$line" >> "$HOME_DIR/done.ndjson" ;;
    esac
  done < "$HOME_DIR/queue.ndjson"
  mv "$HOME_DIR/queue.new" "$HOME_DIR/queue.ndjson"
  if [ "$crashed" -eq 1 ]; then say '{"status":"worker_crashed"}'; exit 3; fi
  rm -f "$lock"
  say "{\"status\":\"worker_idle\",\"processed\":$processed}"
}

cmd="${1:-}"
[ $# -gt 0 ] && shift
case "$cmd" in
  install)
    rm -rf "$HOME_DIR"
    mkdir -p "$HOME_DIR/blobs"
    cp "$ROOT/seed/records.ndjson" "$HOME_DIR/records.ndjson"
    cp "$ROOT/seed/jobs.ndjson" "$HOME_DIR/queue.ndjson"
    cp "$ROOT"/seed/blobs/* "$HOME_DIR/blobs/"
    token=$(env_get "$ROOT/config/service.env" NOTES_API_TOKEN)
    if [ -z "$token" ]; then say '{"status":"install_failed","reason":"NOTES_API_TOKEN missing"}'; exit 2; fi
    tokhash "$token" > "$HOME_DIR/auth.hashes"
    echo 1 > "$HOME_DIR/auth.generation"
    echo "1.0.0" > "$HOME_DIR/VERSION"
    if [ -n "${NOTES_CREDENTIAL_DIR:-}" ]; then printf '%s' "$token" > "$NOTES_CREDENTIAL_DIR/credential.old"; fi
    say '{"status":"installed","version":"1.0.0"}'
    ;;
  health)
    if [ -f "$HOME_DIR/VERSION" ] && [ -f "$HOME_DIR/auth.hashes" ] && [ "$(lines "$HOME_DIR/records.ndjson")" -gt 0 ]; then
      say "{\"status\":\"ok\",\"records\":$(lines "$HOME_DIR/records.ndjson")}"
    else
      say '{"status":"unhealthy"}'
      exit 1
    fi
    ;;
  wipe)
    rm -f "$HOME_DIR/records.ndjson"
    rm -rf "$HOME_DIR/blobs"
    mkdir -p "$HOME_DIR/blobs"
    say '{"status":"wiped"}'
    ;;
  restore)
    src="${1:?restore <dir>}"
    [ -f "$src/backup.json" ] || { say '{"status":"restore_failed","reason":"backup.json missing"}'; exit 1; }
    rm -f "$HOME_DIR/records.ndjson"
    rm -rf "$HOME_DIR/blobs"
    mkdir -p "$HOME_DIR/blobs"
    cp "$src/records.ndjson" "$HOME_DIR/records.ndjson"
    cp "$src"/blobs/* "$HOME_DIR/blobs/"
    say '{"status":"restored"}'
    ;;
  measure)
    # what the harness compares against its own expectations; never self-certifies
    printf '{"record_counts":{"notes":%s,"blobs":%s},"data_hashes":{' "$(lines "$HOME_DIR/records.ndjson")" "$(ls "$HOME_DIR/blobs" | wc -l | tr -d ' ')"
    first=1
    while IFS= read -r line || [ -n "$line" ]; do
      id=$(printf '%s' "$line" | sed 's/.*"id":"\([^"]*\)".*/\1/')
      [ "$first" -eq 1 ] || printf ','
      first=0
      printf '"%s":"%s"' "$id" "$(printf '%s' "$line" | sha)"
    done < "$HOME_DIR/records.ndjson"
    printf '}}\n'
    ;;
  rotate)
    next=$(env_get "$ROOT/config/service.env.next" NOTES_API_TOKEN)
    if [ -z "$next" ]; then say '{"status":"rotate_failed"}'; exit 2; fi
    tokhash "$next" > "$HOME_DIR/auth.hashes"
    gen=$(cat "$HOME_DIR/auth.generation")
    echo $((gen + 1)) > "$HOME_DIR/auth.generation"
    if [ -n "${NOTES_CREDENTIAL_DIR:-}" ]; then printf '%s' "$next" > "$NOTES_CREDENTIAL_DIR/credential.new"; fi
    say "{\"status\":\"rotated\",\"generation\":$((gen + 1))}"
    ;;
  auth-probe)
    # HC_CREDENTIAL is the credential under test: exit 0 accepted, 3 rejected
    tok="${HC_CREDENTIAL:-}"
    if [ -n "$tok" ] && [ "$(tokhash "$tok")" = "$(cat "$HOME_DIR/auth.hashes")" ]; then say '{"status":"accepted"}'; exit 0; fi
    say '{"status":"rejected"}'
    exit 3
    ;;
  worker)
    run_worker
    ;;
  recover)
    lock="$HOME_DIR/worker.lock"
    if [ -f "$lock" ]; then
      pid=$(cat "$lock")
      if kill -0 "$pid" 2>/dev/null; then say '{"status":"refusing","reason":"lock holder is alive"}'; exit 4; fi
      rm -f "$lock"
    fi
    grep '"poison":true' "$HOME_DIR/queue.ndjson" >> "$HOME_DIR/deadletter.ndjson" || true
    grep -v '"poison":true' "$HOME_DIR/queue.ndjson" > "$HOME_DIR/queue.tmp" || true
    mv "$HOME_DIR/queue.tmp" "$HOME_DIR/queue.ndjson"
    run_worker
    ;;
  worker-probe)
    # unhealthy only while a worker lock exists (a crashed worker leaves a stale one behind)
    if [ -f "$HOME_DIR/worker.lock" ]; then say '{"status":"worker_unhealthy"}'; exit 1; fi
    say '{"status":"worker_healthy"}'
    ;;
  *)
    say '{"status":"usage"}'
    exit 2
    ;;
esac
