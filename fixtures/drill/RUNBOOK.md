# Synthetic notes service: operator runbook (fixture v1)

This runbook belongs to the synthetic fixture release shipped with HandoffCheck. It describes a tiny
file-backed service. Nothing here is real: every credential is a planted fake and no network is used.
HandoffCheck hashes this file; editing it invalidates previous drill results (a new drill is required).

All commands run from the unpacked release root after this one-time setup:

```sh
mkdir -p state
export NOTES_HOME="$PWD/state/notes" NOTES_CREDENTIAL_DIR="$PWD/state"
```

`NOTES_HOME` is the service state directory; `NOTES_CREDENTIAL_DIR` is where the install and rotate steps
leave the old and new credential files for you to test with. Every command prints one JSON line and exits 0
on success. The drill harness runs the equivalent steps from the explicit scripts next to `drill.yaml`; it
never reads this prose to decide what to execute.

## 1. Install and verify health (deadline: 60 seconds)

1. `node bin/notes.mjs install` creates the state directory from the seed data (12 records, 3 blobs,
   a job queue and one API token read from `config/service.env`) and writes that token to
   `state/credential.old`.
2. `node bin/notes.mjs health` must print `"status":"ok"` with `"records":12`. Anything else means the
   install is not healthy: stop and diagnose before continuing.

## 2. Restore from the shipped synthetic backup (deadline: 60 seconds)

1. To rehearse data loss, `node bin/notes.mjs wipe` removes the live records and blobs.
2. `node bin/notes.mjs restore backup` restores them from the `backup/` directory in the release.
3. `node bin/notes.mjs measure` prints record counts and one hash per record. Compare against the
   expectation: 12 records, 3 blobs, and the four selected record hashes and three blob hashes in
   `drill.yaml`. A service that merely starts, or `health` alone, is not evidence of a restore.

## 3. Rotate the API credential (deadline: 60 seconds)

1. `node bin/notes.mjs rotate` replaces the stored token with the one in `config/service.env.next` and
   writes it to `state/credential.new`.
2. Prove both directions: `HC_CREDENTIAL="$(cat state/credential.old)" node bin/notes.mjs auth-probe`
   must exit 3 (old token rejected); `HC_CREDENTIAL="$(cat state/credential.new)" node bin/notes.mjs
   auth-probe` must exit 0 (new token accepted). If the old token is still accepted, the rotation
   failed: stop and report it.

## 4. Recover the stalled worker (deadline: 60 seconds, recovery must finish within 30)

The seeded failure: one job in the queue is poisoned and crashes the worker, leaving a stale lock.

1. `node bin/notes.mjs worker` runs the worker until it crashes (`"status":"worker_crashed"`).
2. `node bin/notes.mjs worker-probe` now reports `worker_unhealthy`; running the worker again reports
   `stale_lock`. Do not delete files by hand.
3. `node bin/notes.mjs recover` clears the stale lock only if its owner process is dead, moves the
   poison job to the dead-letter file and finishes the remaining jobs.
4. `node bin/notes.mjs worker-probe` must print `worker_healthy`.

## 5. Failure diagnosis

- `install` fails: confirm `config/service.env` holds `NOTES_API_TOKEN`.
- `health` says `unhealthy`: re-run `install`; the state directory is rebuilt from scratch.
- `measure` shows fewer records or different hashes: the backup is incomplete or damaged; compare
  `backup/backup.json` with the files next to it.
- `recover` says `refusing`: a live worker still holds the lock; wait for it to finish.

Record every time you needed help from the builder. Any help makes the result assisted, not independent.
