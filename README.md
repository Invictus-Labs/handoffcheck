# HandoffCheck

Prove another operator can run what you delivered.

HandoffCheck runs a reproducible **handoff drill** against a release artifact, a runbook and an explicit
manifest of execution scripts. It provisions a disposable sandbox, runs `install`, `restore`, `rotate`
and `recover` steps against deadlines, verifies each result itself, destroys the sandbox, independently
verifies the cleanup and keeps append-only, redacted, content-addressed evidence that you can export as
a versioned bundle and read on another machine. The report is a single static HTML file (no JavaScript).

It measures whether a particular artifact plus runbook is operable by someone other than the builder.
It does not certify production readiness in general, it does not run customer production recovery and
it does not replace your functional tests or your runbook.

- License: MIT. Self-hosted, no license server, no account, no telemetry, no outbound network from the core.
- Runtime: Node.js 22.13 or newer (the QA gate ran on 24.21; a test pass also ran on 25.8; 22.x was not available to test). One runtime dependency (`yaml`). Persistence is the
  built-in `node:sqlite`.
- Interface: a command line tool. It opens **no listening port**. Any URL you see in a demo script or
  runbook uses `localhost`, which means this machine only (the loopback interface).

## Read this first: what the results mean

Uncertainty is never success. Unknown, stale, partial, blocked and unconfirmed states all exit non-zero.

| Verdict | Meaning | Exit |
| --- | --- | --- |
| `INDEPENDENT_PASS` | A human operator who is not the builder passed every mandatory step, with no intervention, on VM isolation, and cleanup was verified | 0 |
| `REHEARSAL` | Everything passed, but the operator was automated, or the isolation was `none` (the synthetic `local-sandbox` provider). Useful for rehearsing, never independent evidence | 0 |
| `ASSISTED` | Something passed, but an intervention was recorded or the operator was AI-assisted. Not independent, even if every step passed | 1 |
| `FAIL` | A mandatory step failed or timed out, preflight rejected the inputs, cleanup is `CLEANUP_UNCONFIRMED`, or the run was aborted | 1 |
| `UNKNOWN` | Partial or stale: fewer steps than planned, no cleanup receipt yet, the inputs changed since the run (`STALE_BINDING`), or the run was **imported from a bundle** (`IMPORT_UNAUTHENTICATED`: hashes prove integrity, not provenance, so no accepting verdict is derived locally) | 1 |
| `BLOCKED` | A required provider is missing (for example `limactl`). Reported explicitly, never faked | 1 |

Exit codes of `run`: `0` every mandatory step and the cleanup check passed and the verdict is
`INDEPENDENT_PASS` or `REHEARSAL`; `1` unsatisfied; `2` harness failure (bad input, oversized manifest, schema
violation, unknown run, corrupt bundle on import, internal error). Errors with `--json` use
`{"error":{"code","message","request_id"}}`.

Two acceptance criteria are **human receipts** that no tool can supply: the independent human drill
(AC-08) and a fresh operator following this documentation (AC-12). `docs/HUMAN-DRILL.md` is the
procedure and `docs/qa/AC-MATRIX.md` records their status as `PENDING_HUMAN_RECEIPT` until a person
files a receipt. A green automated gate does not make the matrix pass.

## Install

Requirements: Node.js 22.13 or newer and npm. For the VM runner you also need `limactl` (Lima); without
it the VM provider reports `BLOCKED` and nothing else is affected.

```sh
git clone <repository-url> handoffcheck
cd handoffcheck
npm ci
npm run build
node dist/src/cli.js --version
```

Optional: `npm link` makes the `handoffcheck` command available. Every example below can be run as
`node dist/src/cli.js <args>`. To check an install end to end, run the synthetic smoke procedure below.

## Quick start: the offline demo

```sh
node dist/src/cli.js demo --output ./hc-demo
```

The demo runs a built-in synthetic drill with the `local-sandbox` provider: no network, no accounts, no
telemetry. Every receipt is labelled `isolation: none` and the verdict is `REHEARSAL`. Open
`hc-demo/reports/<run id>/report.html` in a browser (it makes no external requests).

## Running a drill

```sh
node dist/src/cli.js preflight --manifest drill.yaml --artifact release.tar --runbook RUNBOOK.md
node dist/src/cli.js run       --manifest drill.yaml --artifact release.tar --runbook RUNBOOK.md --output evidence/   # add --allow-host-sandbox for a local-sandbox rehearsal
node dist/src/cli.js record-intervention --run <run id> --reason "what help was needed" --output evidence/
node dist/src/cli.js report    --run <run id> --output evidence/          # json + html under evidence/reports/
node dist/src/cli.js export    --run <run id> --out bundle.hcb --output evidence/
node dist/src/cli.js verify-bundle --bundle bundle.hcb
node dist/src/cli.js import    --bundle bundle.hcb --output other-evidence/
node dist/src/cli.js cleanup   --run <run id> --output evidence/
```

The operator is recorded as `automated` unless you say otherwise, because a command line cannot prove a human is
present. A human claim is explicit and needs both identities, for example
`run ... --operator-kind human --operator-ref <who> --builder-ref <who built the release>`. Even then an independent
pass also needs VM isolation, no intervention and a builder different from the operator; otherwise the result is a
`REHEARSAL`. The attribution is a local identity record, not a third-party attestation.

Inputs, all explicit and hashed into the drill binding: a release **artifact** (a tar or tar.gz), a
**runbook** (Markdown) and a **manifest** (`drill.yaml`) that names every script. Scripts are versioned
inputs next to the manifest; HandoffCheck never generates shell from runbook prose. Editing the
artifact, the runbook, the scenario version, the manifest or any script gives a new binding digest and
invalidates earlier results. The command reference is `docs/CLI.md`; the design is `docs/DESIGN.md`.
A worked example lives in `fixtures/drill/` (manifest, scripts and runbook) with its release in
`fixtures/release/`.

## Upgrade

1. Make sure no drill is running, then back up the evidence store (see Backup).
2. `git pull`, then `npm ci && npm run build`, then `node dist/src/cli.js --version`.
3. Run the synthetic smoke procedure below. It uses a fresh store, so it also proves the new build
   works before it touches your real evidence.
4. Read one existing run with `report --run <id> --output evidence/` to confirm the store opens. A store
   that is **newer** than the code fails with `STORE_SCHEMA_UNSUPPORTED` (exit 2) instead of being
   modified: install the newer version or restore the backup. Schema changes are expand/contract; there
   is no automatic downgrade, so rollback means restoring the pre-upgrade backup.

## Backup

The evidence store (`--output`, default `./evidence`) holds `handoffcheck.sqlite` (plus `-wal`/`-shm`
files while in use), `objects/` (content-addressed redacted evidence), `.staging/` (in-flight writes; copy it too, it is
empty when nothing is running), `identity.key` (local HMAC key
for intervention attributions), `reports/` and `adapters/`.

Cold copy (nothing running): stop all `handoffcheck` processes, then copy the whole directory and keep
it owner-only.

```sh
cp -Rp evidence evidence-backup-$(date -u +%Y%m%dT%H%M%SZ)
chmod -R go-rwx evidence-backup-*
```

Portable per-run copy (works without the store and without the key): export a bundle and verify it.

```sh
node dist/src/cli.js export --run <run id> --out run.hcb --output evidence/
node dist/src/cli.js verify-bundle --bundle run.hcb
```

A backup restored later cannot undo anything that happened outside the store; HandoffCheck only holds
its own evidence. Evidence is retained 90 days by default (`retention_days` in the manifest). **Nothing deletes
evidence automatically**: after the retention date runs stay until you purge them with `purge` (below).

### Retention and purge

```sh
node dist/src/cli.js purge --dry-run --output evidence/                  # list runs past their retention date; deletes nothing
node dist/src/cli.js purge --output evidence/                           # delete them and their orphaned evidence blobs
node dist/src/cli.js purge --older-than-days 30 --output evidence/      # or every run created more than 30 days ago
```

`purge` is the only command that deletes evidence; history is append-only otherwise. Export a bundle first if you
need to keep a run.

## Restore

1. Restore a cold copy: `cp -Rp evidence-backup-<stamp> evidence` into an empty location, keeping
   owner-only permissions. Then `node dist/src/cli.js report --run <run id> --output evidence/`.
2. Or read a bundle in a clean installation: `verify-bundle`, then `import --bundle run.hcb --output
   new-evidence/`. Import is atomic: a truncated, tampered, oversized or unsupported bundle fails with
   exit 2 and adds no state. Importing a run that already exists is a conflict, not a merge.
3. Compare: the imported report shows the same binding digest, step evidence hashes and evidence
   sha256 list as the original. The imported run's own verdict is `UNKNOWN` (reason `IMPORT_UNAUTHENTICATED`, exit 1):
   a bundle proves its contents were not damaged, not who produced them. The verdict recorded inside the bundle is
   shown only as a display-only, unauthenticated claim.

## Failure diagnosis

| Symptom | What it means | Next step |
| --- | --- | --- |
| Exit 2, `SCHEMA_INVALID` / `BAD_REQUEST` | The manifest or an argument is malformed | Fix the field named in the message; run `preflight` first |
| Exit 2, `PAYLOAD_TOO_LARGE` | The manifest (metadata) is over the 25 MB limit | Shrink the manifest; the limit is enforced before any processing |
| Exit 1, `PREFLIGHT_REJECTED` with finding `ARTIFACT_LIMIT` | The artifact is over the 1,000 file or 250 MB blob limit | Shrink the artifact; the archive is rejected before extraction and nothing runs |
| Exit 1, `PREFLIGHT_REJECTED` | A production-credential pattern, undeclared network destination, unsafe path or archive entry was found | Read the findings (they never echo the secret); remove it. Planted fakes must carry the `HCFAKE` marker |
| Verdict `BLOCKED`, `PROVIDER_UNAVAILABLE` | `limactl` is missing or its version probe failed | Install Lima, or use `local-sandbox` for a synthetic rehearsal. The VM criterion stays `BLOCKED` until a real VM run exists |
| Step `FAIL` with a `RESTORE_*` reason | Counts, data hashes or blob hashes differ from the manifest expectations | Compare the check lines in the report (expected versus actual) |
| `ROTATION_OLD_ACCEPTED` / `ROTATION_NEW_REJECTED` / `ROTATION_PROBE_ERROR` | The old credential still works, the new one is refused, or the probe crashed | Rotation is unproven; unknown never passes |
| `RECOVERY_FAULT_NOT_OBSERVED` / `RECOVERY_NOT_RESTORED` / `RECOVERY_TOO_SLOW` | The seeded failure did not happen, was not repaired, or took longer than the bound | Fix the drill scripts or the recovery steps |
| `CLEANUP_UNCONFIRMED` | A resource may be leaked or could not be checked | `cleanup --run <id>`; for a VM, list and delete the instance with `limactl`. Exit stays 1 until verified |
| Verdict `UNKNOWN` / `STALE_BINDING` | The inputs changed since the run, or the run did not finish | Start a new drill for the new inputs |
| Verdict `ASSISTED` | An intervention was recorded after or during the run | This cannot be undone; record interventions honestly |
| Verdict `UNKNOWN` with `IMPORT_UNAUTHENTICATED` | The run came from an imported bundle | Expected: re-run the drill locally, or have the originating installation attest it; a bundle alone never becomes an accepting result |
| Verdict `REHEARSAL` with `OPERATOR_INDEPENDENCE_UNPROVEN` | A human operator was claimed without a builder identity | Pass `--builder-ref`; independence cannot be shown without it |

Set `HANDOFFCHECK_DEBUG=1` to get a redacted detail line for internal errors. More in `docs/RUNBOOK.md`
and `docs/OPERATIONS.md`.

## Synthetic smoke procedure

This is the check a fresh operator runs after install or upgrade. It needs only this repository, Node and
a shell, and writes into the current directory. Run it from an empty directory and set `HC_REPO` to the
checkout path. It uses the synthetic fixture only (planted fake credentials, no network).

```sh smoke
set -eu
hc() { node "$HC_REPO/dist/src/cli.js" "$@"; }
hc --version
# 1. built-in offline demo (exit 0, REHEARSAL, isolation none)
hc demo --output ./smoke-demo
# 2. the fixture drill: build the deterministic artifact, then run it
node "$HC_REPO/scripts/build-fixture-release.mjs" ./release.tar
# the fixture uses the local-sandbox provider (no isolation): running it on this host needs the explicit opt-in flag
hc preflight --manifest "$HC_REPO/fixtures/drill/drill.yaml" --artifact ./release.tar --runbook "$HC_REPO/fixtures/drill/RUNBOOK.md" --allow-host-sandbox
hc run --manifest "$HC_REPO/fixtures/drill/drill.yaml" --artifact ./release.tar --runbook "$HC_REPO/fixtures/drill/RUNBOOK.md" --output ./smoke-evidence --allow-host-sandbox --json > ./run.json
RUN=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("run.json","utf8")).run_id)')
# 3. report, export, verify and re-read the bundle in a clean store
hc report --run "$RUN" --output ./smoke-evidence
hc export --run "$RUN" --out ./smoke.hcb --output ./smoke-evidence
hc verify-bundle --bundle ./smoke.hcb
hc import --bundle ./smoke.hcb --output ./smoke-clean-store
# an imported run is UNKNOWN by design: the bundle proves integrity, not provenance, so this report exits 1
if hc report --run "$RUN" --output ./smoke-clean-store; then echo "unexpected: an imported run must not be accepted" >&2; exit 1; fi
echo "smoke ok: run $RUN"
```

Expected: every command exits 0 except the final `report` on the imported store, which must exit 1 (the script
checks this): the imported run shows verdict `UNKNOWN` (`IMPORT_UNAUTHENTICATED`) with the bundle's own verdict
as a display-only claim. `smoke-evidence/reports/<run id>/report.html` shows four PASS steps, cleanup VERIFIED and
the verdict `REHEARSAL` with an `isolation: none` warning. A passing smoke proves the
tool works on this machine; it is **not** the independent human drill (see `docs/HUMAN-DRILL.md`).

## Honest limits

- Running release code is execution of untrusted input. **A container is not an isolation boundary.** The
  supported isolation is a dedicated disposable Linux VM (`lima` provider). Egress from that VM is **not
  enforced** (see below): never treat it as a network sandbox. The `Dockerfile` in this repository is a
  demo/documentation image only.
- The `lima` provider drives a real Lima VM (`limactl start --plain`, Alpine template, no host mounts). Egress is
  **not enforced** (reported as `PARTIAL`, best effort), and every report says so. At provision time the guest
  default routes are removed and checked, and workloads then run as an unprivileged guest user without `sudo`
  that cannot add routes back (also checked). That is a speed bump, not a firewall: the host gateway address stays
  reachable (blocking it breaks the control channel) and a guest privilege escalation would undo the route removal.
  Do not run scripts you do not trust on the strength of it. A live drill on this provider needs `limactl`, network access to fetch the guest image, and a guest with
  the interpreters your scripts use (the Alpine guest has `sh` but no Node: `fixtures/drill-sh` is the POSIX-sh
  fixture). Without `limactl` every VM run is `BLOCKED`. Live evidence is recorded in `docs/qa/QA-RECEIPT.md`.
- `local-sandbox` is synthetic only: a temporary directory plus a scrubbed-environment subprocess with
  time and file-size limits. It runs the manifest scripts **directly on this host**, cannot enforce egress and is
  labelled `isolation: none`; it can never satisfy a VM-isolation criterion and never produces
  `INDEPENDENT_PASS`. Because it executes code on your machine, `run` and `preflight` refuse it unless you pass
  `--allow-host-sandbox` (a warning is printed on stderr when you do); only use it for scripts you wrote and
  trust. The built-in `demo` runs only its embedded synthetic scenario and needs no flag.
- Network-destination checks are static detection of explicit inputs (URLs, host:port, IP literals, common
  tool arguments), not a network sandbox. Production-credential detection is pattern based.
- An intervention record is a local identity attribution (an HMAC under a local key), not a third-party
  attestation. A human drill can be biased by prior knowledge of the service.
- Not built: multi-user authorization, a daemon or HTTP API, hosted operation. CLI products trust the local
  operating-system user. Demand for this workflow is a product hypothesis, not validated.

## Develop and verify

```sh
bash scripts/verify-quality.sh        # typecheck, build, tests + coverage >= 90%, negative controls,
                                      # report smoke, matrix lint, license audit, secret scan, sanitize
```

There is no remote CI (GitHub Actions is not used): run the gate locally before every push. The AC to
test mapping is `docs/qa/AC-MATRIX.md`; dependency licenses are in `docs/DEPENDENCY-LICENSES.md`.
