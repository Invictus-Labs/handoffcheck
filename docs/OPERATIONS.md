# HandoffCheck operations

Operational notes for whoever hosts the tool for a team. HandoffCheck is a local command line tool: no
daemon, no listening port, no multi-user authorization. It trusts the local operating-system user.

## Footprint and limits

| Item | Default | Notes |
| --- | --- | --- |
| Metadata size | 25 MiB | manifest, runbook, scripts and documents; checked from file size before reading |
| File count | 1,000 | per artifact and per bundle |
| Blob and archive cap | 250 MiB | gzip is inflated against a hard cap; override only with an explicit limit |
| Output per stream | 1 MiB | `runner.max_output_bytes` in the manifest; excess is dropped and flagged |
| Steps per drill | 50 | |
| Evidence retention | 90 days | `retention_days` in the manifest; `handoffcheck purge` (`purgeExpired` in the library) is the only deleter; `--dry-run` lists first, `--older-than-days N` overrides the retention date |

Capacity is checked before an import or export writes anything (`INSUFFICIENT_CAPACITY`, exit 2).
Performance expectation: the deterministic core is intended to handle 1,000 records within 30 seconds on
2 CPU and 4 GB, excluding provider I/O and VM setup. Treat that as an unverified target until measured in
your environment; do not quote it as an SLA.

## The evidence store

One directory per installation (`--output`, default `./evidence`), created owner-only (mode 0700; files 0600):
`handoffcheck.sqlite` (WAL mode), `objects/` content-addressed blobs, `identity.key` (random 32-byte local
HMAC key), `reports/`, `adapters/`. Keep it on local storage; do not share it between users. If the
directory already exists and is accessible to other users the CLI prints a warning; the store library then tightens it to
owner-only. Do not rely on that: create the directory yourself with the permissions you intend.

## Backup, restore, upgrade

Procedures are in `README.md` (Backup, Restore, Upgrade). Operational rules:

- Back up before every upgrade and test the restore in a scratch directory, not on top of live evidence.
- Back up `identity.key` together with the database: without it, imported or restored intervention
  signatures cannot be verified.
- Take cold copies (no running `handoffcheck` process) or use per-run bundles; do not copy a live WAL
  database file by file while a drill is running.
- Rotated backups should expire within 30 days and primary deletion should complete within 24 hours of a
  retention decision. These are proposed defaults that the production operator must approve before any
  customer data is ingested.

## Monitoring and failure signals

There is no daemon to monitor. Watch exit codes in whatever schedules the drills:

- `0` pass or rehearsal, `1` unsatisfied, `2` harness failure. Treat anything but 0 as not accepted.
- `CLEANUP_UNCONFIRMED` is an operational alert: a resource may still exist on the host. Resolve it using
  `docs/RUNBOOK.md` section 4.
- `STORE_SCHEMA_UNSUPPORTED` means the store was written by a newer version.

Logs and reports are redacted at write time: manifest `synthetic_secrets`, credentials seen during
rotation, known production-credential patterns, `HCFAKE_*` tokens, authorization header values and
`password=`/`token=` assignments are replaced with `[REDACTED:<kind>]`.

## Security posture

- Release code is untrusted input. Use the VM provider for anything real, and note that its egress control is best
  effort and **not enforced** (default routes removed, workloads run as an unprivileged guest user; the host gateway
  stays reachable). A container is not an isolation boundary; the `Dockerfile` here is for demos only.
- `local-sandbox` runs scripts directly on the host and is refused unless `--allow-host-sandbox` is given.
- Do not run drills as a privileged user. Do not put real credentials in manifests or scripts; preflight
  rejects them.
- Optional adapters (receipt export, acceptance import) are disabled by default, read and write local files
  only and never open a network connection. Enable them per command with `--enable-adapters` or
  `HANDOFFCHECK_ADAPTERS=1`.
- No telemetry exists and none can be enabled.

## Releasing

1. `bash scripts/verify-quality.sh` must print `GATE: PASS` at the exact revision you release.
2. `node scripts/license-audit.mjs` regenerates `docs/DEPENDENCY-LICENSES.md`; the gate fails if stale.
3. `docs/qa/AC-MATRIX.md` must be honest: AC-08 and AC-12 stay `PENDING_HUMAN_RECEIPT` until a person files a
   receipt (`docs/HUMAN-DRILL.md`). Any row that is NOT RUN, PARTIAL, BLOCKED or pending prevents the claim
   that the matrix passed.
4. Publishing, licensing and repository naming are owner decisions, not part of this gate.
