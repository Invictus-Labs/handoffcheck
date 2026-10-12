# HandoffCheck CLI

`handoffcheck` is a local command-line tool. It opens no listening port, makes no outbound network connection and sends no telemetry. It trusts the local operating-system user.

```text
handoffcheck <command> [options]
handoffcheck --help | -h        handoffcheck <command> --help
handoffcheck --version | -v
```

Build and run from a checkout (Node 22.13 or newer):

```text
npm ci
npm run build
node dist/src/cli.js --version
```

The installed binary is `handoffcheck` (`package.json` `bin`). Every example below can be run as `node dist/src/cli.js <args>`.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Every mandatory step and the cleanup check PASS (or, for non-verdict commands, the operation succeeded) |
| 1 | Unsatisfied: a mandatory step failed or timed out, the run is ASSISTED, cleanup is CLEANUP_UNCONFIRMED, preflight rejected (this includes an artifact over the size or file-count limits, `ARTIFACT_LIMIT` finding, and a host-sandbox run without `--allow-host-sandbox`), a bundle did not verify |
| 2 | Harness failure: bad usage, an unreadable or oversized manifest (`PAYLOAD_TOO_LARGE`, over 25 MB), an unknown run id, a corrupt or unsupported bundle on import, an unsafe host-sandbox request, internal error |

Uncertainty is never success: unknown, stale, partial and unverified states exit 1 or 2, never 0.

## Output modes and errors

Human text goes to stdout (progress lines go to stderr). With `--json`, stdout carries exactly one JSON document: the result, or on failure the error body. A one-line human message is always also written to stderr.

```json
{"error":{"code":"NOT_FOUND","message":"--manifest: file not found: drill.yaml","request_id":"req_..."}}
```

`code` is one of `BAD_REQUEST`, `NOT_FOUND`, `CONFLICT`, `PAYLOAD_TOO_LARGE`, `SCHEMA_INVALID`, `POLICY_REJECTED`, `UNSUPPORTED_VERSION`, `BUNDLE_CORRUPT`, `PROVIDER_UNAVAILABLE`, `CONNECTOR_DISCONNECTED`, `INSUFFICIENT_CAPACITY`, `STORE_SCHEMA_UNSUPPORTED`, `INTERNAL` (`schemas/error.schema.json`). Messages never contain secrets; internal errors show a generic message unless `HANDOFFCHECK_DEBUG=1`.

## The evidence store (`--output`)

Every command that reads or writes runs takes `--output <dir>` (alias `--store`), default `./evidence`. The directory is created owner-only (mode 0700); report and receipt files are written 0600. An existing directory that is readable by other users produces a warning and is not changed. Besides the library's own files, the CLI writes two sub-directories there:

| Path | Content |
| --- | --- |
| `reports/<run id>/report.html`, `report.json` | The static reports for the run |
| `adapters/ledger.json` | Dedupe ledger for the optional adapters |

## Commands

### `run`

```text
handoffcheck run --manifest drill.yaml --artifact release.tar --runbook RUNBOOK.md --output evidence/ [--allow-host-sandbox] [--operator-kind human|ai_assisted|automated --operator-ref <who> --builder-ref <builder>] [--json]
```

Binds the drill to the artifact digest, runbook hash and scenario version, runs preflight, provisions the runner declared in the manifest, executes the manifest's explicit scripts, destroys the sandbox and verifies cleanup. Cleanup is always attempted and verified, including after a timeout or Ctrl-C (SIGINT and SIGTERM abort the drill, then cleanup runs). Writes `reports/<run id>/report.html` and `report.json` and prints the verdict. **Host sandbox opt-in.** The `local-sandbox` provider (isolation `none`) executes the manifest's scripts directly on this host, with no VM and no filesystem or network confinement. It is refused by default: without `--allow-host-sandbox` the run ends as a normal preflight rejection (verdict FAIL, reason `PREFLIGHT_REJECTED`, finding `HOST_SANDBOX_NOT_ALLOWED`, exit 1, nothing executed). With the flag the run proceeds and a warning is printed to stderr. Only use it for scripts you wrote and trust. The built-in `demo` is exempt. The VM provider (`lima`) needs no flag.

The operator is `automated` unless you say otherwise: a non-interactive CLI cannot prove a human is present. `--operator-kind human` is an explicit claim and requires both `--operator-ref` (also accepted as `--operator`) and `--builder-ref`, and the two must be different identities once normalised the way the domain does (Unicode NFKC, trimmed, lower-cased); otherwise the command exits 2. A manifest cannot assert a human operator for itself. An independent pass additionally needs VM isolation, no intervention, and a builder that differs from the operator; a human with no or equal builder is a `REHEARSAL`. The attribution is operator-attested by the local identity, not third-party attestation, and AC-08 additionally needs a human receipt.

Exit 0 only if every mandatory step and cleanup PASS and the verdict is a pass. 1 for FAIL, ASSISTED, UNKNOWN, BLOCKED, CLEANUP_UNCONFIRMED or a rejected preflight. 2 for harness failures (bad input, unreadable manifest, schema or size violations).

Verdicts: `INDEPENDENT_PASS` (a human operator who is not the builder, no intervention, VM isolation, cleanup verified), `ASSISTED` (any intervention was recorded), `REHEARSAL` (passed, but the operator was AI-assisted or automated, or isolation was `none`), `FAIL`, `UNKNOWN` (partial or stale), `BLOCKED` (for example `limactl` is absent: reported explicitly, never faked). A passing result still carries `PENDING_HUMAN_RECEIPT`: the independent-operator criterion needs a human receipt that no tool can supply.

### `record-intervention`

```text
handoffcheck record-intervention --run <id> --reason "<why help was needed>" [--actor <ref>] [--output evidence/] [--json]
```

Appends an intervention to the run, even after it finished. The reason is redacted before storage. `--actor` defaults to the fixed label `local` (bundles carry this value, so no OS user name is used unless you pass one); the record is a local identity attribution, not a third-party attestation. Exit 0 when recorded. The command prints the new verdict, which becomes `ASSISTED` regardless of later results.

### `report`

```text
handoffcheck report --run <id> [--format json|html|both] [--out <file|dir|->] [--manifest drill.yaml --artifact release.tar --runbook RUNBOOK.md] [--output evidence/] [--json]
```

Default format is `both`, written to `<store>/reports/<run id>/`. With `--format json` or `html`, `--out` is a file path, or `-` for stdout. With `both`, `--out` is a directory. The exit code is the run's verdict exit code (0 pass, 1 otherwise), so a script that gates on `report` cannot mistake a failed or ASSISTED run for success.

Give all three of `--manifest`, `--artifact` and `--runbook` (never only some) to re-check the run's binding against the **current** inputs: if any of them (or a referenced script, or the scenario version) changed since the drill, the verdict is `UNKNOWN` with reason `STALE_BINDING`, the binding check reads `MISMATCH`, and the exit code is 1. Without them the binding check is `NOT_CHECKED`.

With `--json`, stdout is the JSON report itself (files are still written as requested). The JSON report is exactly the `ReportData` document validated by `schemas/report.schema.json`. The HTML report is described below.

### `preflight`

```text
handoffcheck preflight --manifest drill.yaml --artifact release.tar --runbook RUNBOOK.md [--allow-host-sandbox] [--json]
```

Checks the manifest, scripts, artifact and runbook without creating a run or executing anything: production-credential patterns, undeclared network destinations, unsafe paths and symlinks, archive and size limits, resource limits, synthetic-only scenarios. Exit 0 on PASS, 1 on REJECTED (findings are listed, never containing the matched secret).

### `check-reuse`

```text
handoffcheck check-reuse --manifest drill.yaml --artifact release.tar --runbook RUNBOOK.md [--run <id>] [--output evidence/] [--json]
```

AC-01: may a stored result be reused for the **current** inputs? A result is bound to the artifact digest, runbook hash, scenario version, manifest and every referenced script. Exit 0 only when a prior run with the identical binding exists and earned an accepting verdict (a rehearsal, an ASSISTED, failed or unknown run is not reusable: reason `PRIOR_NOT_ACCEPTED`). Changing the artifact, runbook, scenario version, manifest or any script invalidates earlier results: reason `BINDING_CHANGED`, the invalidated run ids are listed, exit 1. No prior run is `NO_PRIOR_RUN`, exit 1. With `--run`, that specific run must be the reusable result. Exit 2 for usage or harness errors (unreadable inputs, unknown store).

### `purge`

```text
handoffcheck purge [--older-than-days N] [--dry-run] [--output evidence/] [--json]
```

Deletes runs whose retention has expired (`retain_until`, 90 days from creation by default and set per manifest by `retention_days`), or with `--older-than-days N` (integer 0 to 999999) runs created more than N days ago. `--dry-run` deletes nothing and lists what would be purged. This is the only command that deletes evidence; history is otherwise append-only. Prints the purged run ids (`--json`: `{purged, dry_run}`).

### `export`, `import`, `verify-bundle`

```text
handoffcheck export --run <id> --out bundle.hcb [--output evidence/]
handoffcheck verify-bundle --bundle bundle.hcb [--json]
handoffcheck import --bundle bundle.hcb [--output evidence/]
```

`export` writes a versioned evidence bundle (it will not overwrite an existing path). `verify-bundle` is read-only and exits 0 if schema, limits and every hash verify, 1 otherwise (errors are listed). A pass means **integrity only**: the output (and the `note` field with `--json`) says `integrity only, provenance not verified`, because hashes prove the bytes are unchanged, not who produced them. `import` is atomic and exits 0 when integrity verifies, but an imported run is unauthenticated: `report` shows its effective verdict as `UNKNOWN` (reason `IMPORT_UNAUTHENTICATED`, exit 1) and the bundle's own verdict only as `claimed by the bundle, unauthenticated, display only`. `import` is atomic: a truncated, tampered, oversized or unsupported bundle fails with exit 2 and adds no state. Default limits: 25 MB metadata, 1,000 files, 250 MB blobs.

### `demo`

```text
handoffcheck demo [--output handoffcheck-demo/] [--json]
```

Runs the synthetic drill end to end with the `local-sandbox` provider: no network, no accounts, no telemetry. Every receipt is labelled `isolation: none`; the verdict is a `REHEARSAL` and can never satisfy a VM-isolation or independent-operator criterion. Exit 0 when all steps and cleanup pass. Writes the same reports as `run`.

### `cleanup`

```text
handoffcheck cleanup --run <id> [--output evidence/] [--json]
```

Retries and re-verifies cleanup for an existing run (including an orphaned run whose harness was killed: it becomes `ABORTED`, then `CLEANUP_*`). While the run's owner process is alive, or cannot be checked, cleanup refuses with exit 2 `CONFLICT` and says the run is still active and appends a new cleanup receipt. Exit 0 only when the receipt is VERIFIED; leaked or unknown resources keep exit 1 and the run stays CLEANUP_UNCONFIRMED.

### `adapter export-receipt`, `adapter import-acceptance`

Optional, disabled by default, local files only. See [ADAPTERS.md](ADAPTERS.md).

```text
handoffcheck adapter export-receipt --run <id> --out receipts/ --enable-adapters
handoffcheck adapter import-acceptance --file acceptance.json --enable-adapters
```

## The static HTML report

`reports/<run id>/report.html` is one self-contained file: inline CSS, no JavaScript, no external requests (a `Content-Security-Policy` meta tag forbids everything except inline style). It adapts to light and dark schemes and prints cleanly. Sections:

- a verdict banner with the exit code and, when applicable, `PENDING_HUMAN_RECEIPT`;
- run summary: scenario, state, outcome, provider, isolation (`isolation: none` is a conspicuous warning), operator kind, artifact, runbook, manifest and binding digests, imported/fault-injected flags;
- verdict reasons, preflight findings, steps with deadlines and durations, per-step checks (expected versus actual), interventions, evidence (sha256, media type, size, redacted), cleanup resources and state history.

Every dynamic value is HTML-escaped (and control characters are made visible), so malicious HTML in any field renders as text. Empty, error and unknown states are explicit: an empty table says what is missing, a missing cleanup receipt reads `MISSING`, an unrecognised status reads `UNKNOWN (<raw text>)`, and nothing unknown is shown as a pass.

## No network, no telemetry

The CLI never opens a socket. The only external process the product can start is a runner provider you select in the manifest (`limactl` for the VM provider). If a provider is absent the run is reported `BLOCKED`.
