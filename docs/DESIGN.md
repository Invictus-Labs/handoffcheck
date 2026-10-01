# HandoffCheck design (domain contract, frozen)

Owner: `hc-domain`. Territory: `src/domain/**`, `src/store/**`, `src/evidence/**`, `src/runner/**`, `src/security/**`, `src/api.ts`, `schemas/**`, `migrations/**`. Contract changes after the freeze go through the coordinator. The definition of done is `docs/DOD.md`.

HandoffCheck runs a reproducible drill: given a release artifact, a runbook and an explicit manifest of execution scripts, it provisions a disposable sandbox, runs `install`, `restore`, `rotate` and `recover` steps against deadlines, verifies each result itself, destroys the sandbox, independently verifies the cleanup, and stores append-only, content-addressed, redacted evidence that can be exported as a versioned bundle and read in a clean installation.

Hard rules that shape everything below: uncertainty never becomes success (unknown, stale, partial, unconfirmed and blocked states never pass); scripts are explicit versioned manifest inputs and shell is never generated from runbook prose; the deterministic core makes no outbound network call and has no telemetry; AC-08 and AC-12 are human receipts and are never marked PASS by an agent.

## 1. Library API (`src/api.ts`)

The CLI calls only `src/api.ts`. Every function takes an `ApiContext` (`storeDir`, optional injectable `clock`, `ids`, `providers`, `env`, `limits`, `onEvent`, `requestId`).

| Function | Purpose | Result / error |
| --- | --- | --- |
| `createDrill(ctx, input)` | validate, bind, preflight, persist a run in `CREATED` | `{run_id, binding, preflight}` |
| `preflight(ctx, paths)` | preflight only, no store writes, no execution | `PreflightReport` (`REJECTED` is data) |
| `run(ctx, input)` | full drill with guaranteed cleanup attempt | `RunResult` (`exit_code` 0/1); throws on harness errors |
| `recordIntervention(ctx, {runId, reason, actorRef, stepKey?})` | append an intervention | `InterventionRecord`; verdict becomes `ASSISTED` |
| `getReport(ctx, {runId, currentInputs?})` | `ReportData` for JSON/HTML | verdict re-derived at read time |
| `checkReuse(ctx, paths)` | may a prior accepted result be reused? | `ReuseDecision` |
| `cleanup(ctx, {runId})` | retry/verify cleanup (appends a receipt) | `{state, receipt, exit_code}` |
| `exportBundle(ctx, {runId, outPath})` | versioned single-file evidence bundle | `BundleInfo`; `CONFLICT` if `outPath` exists |
| `verifyBundle(ctx, {bundlePath})` | read-only hash/limit/schema verification | `BundleVerification` (never throws for corruption) |
| `importBundle(ctx, {bundlePath})` | atomic import into the store | `ImportResult`; throws `BUNDLE_CORRUPT`, `UNSUPPORTED_VERSION`, `CONFLICT`, `PAYLOAD_TOO_LARGE`, `INSUFFICIENT_CAPACITY` |
| `demo(ctx)` | offline synthetic drill (local-sandbox, isolation none, labelled REHEARSAL) | `RunResult` |
| `purgeExpired(ctx)` | retention purge | `{purged}` |
| `listRuns(ctx, {limit, cursor})` | cursor pagination, max 100 | runs + `next_cursor` |

Library helpers re-exported: `canonicalJson`, `sha256Hex`, `fixedClock`, `systemClock`, `sequentialIds`, `randomIds`, `HandoffCheckError`, `toErrorBody`, `requireConnector`.

### Exit-code mapping (contract with hc-cli and hc-qa)

| Exit | Meaning | Examples |
| --- | --- | --- |
| 0 | every mandatory step AND cleanup PASS, and the verdict is `INDEPENDENT_PASS` or `REHEARSAL` | demo; clean automated drill; clean human drill |
| 1 | unsatisfied: verdict `ASSISTED`, `FAIL`, `UNKNOWN` or `BLOCKED`; also `CLEANUP_UNCONFIRMED`, preflight rejection, stale binding; `verify-bundle` with `ok:false`; `cleanup` that stays `CLEANUP_UNCONFIRMED` | seeded mandatory failure; leaked resource; limactl missing (`BLOCKED`) |
| 2 | harness/usage failure: a `HandoffCheckError` was thrown | invalid manifest (422), oversize input (413), missing input file (400), unknown run (404), corrupt or unsupported bundle on `import` (422), store newer than code, internal error |

Error body, when an error object is emitted: `{error:{code,message,request_id}}` (`schemas/error.schema.json`). Codes: `BAD_REQUEST` 400, `NOT_FOUND` 404, `CONFLICT` 409, `PAYLOAD_TOO_LARGE` 413, `SCHEMA_INVALID` 422, `POLICY_REJECTED` 422, `UNSUPPORTED_VERSION` 422, `BUNDLE_CORRUPT` 422, `PROVIDER_UNAVAILABLE` 503, `CONNECTOR_DISCONNECTED` 503, `INSUFFICIENT_CAPACITY` 507, `STORE_SCHEMA_UNSUPPORTED` 503, `INTERNAL` 500. The status is carried on `HandoffCheckError.status`; there is no HTTP server.

## 2. Drill binding (AC-01)

```
artifact_digest  = sha256(artifact bytes)
runbook_hash     = sha256(runbook bytes)
scenario_version = manifest.scenario.version
manifest_digest  = sha256(canonical-json({manifest, scripts:{<path>: sha256(script bytes)}}))
binding_digest   = sha256(canonical-json({artifact_digest, runbook_hash, scenario_version, manifest_digest}))
```

Any change to the artifact, runbook, scenario version, manifest or any referenced script changes `binding_digest`. A result is reusable only when `checkReuse` finds a prior run with the identical `binding_digest` whose verdict is `INDEPENDENT_PASS`; rehearsals, assisted runs and imported runs are never reusable. Prior runs of the same scenario with a different digest are returned as `invalidated_run_ids`. `getReport({currentInputs})` recomputes the binding; a mismatch yields verdict `UNKNOWN` with reason `STALE_BINDING` (stale never passes). Artifact/runbook changes require a new drill.

## 3. State machine

```
CREATED -> PREFLIGHT -> RUNNING -> COMPLETE | FAILED | ABORTED -> CLEANUP_VERIFIED | CLEANUP_UNCONFIRMED
```

Allowed transitions (anything else throws): `CREATED->PREFLIGHT|FAILED|ABORTED`, `PREFLIGHT->RUNNING|FAILED|ABORTED`, `RUNNING->COMPLETE|FAILED|ABORTED`, `COMPLETE|FAILED|ABORTED->CLEANUP_VERIFIED|CLEANUP_UNCONFIRMED`, `CLEANUP_UNCONFIRMED->CLEANUP_VERIFIED|CLEANUP_UNCONFIRMED` (cleanup retry). `CLEANUP_VERIFIED` is terminal. `drills.outcome` keeps `COMPLETE|FAILED|ABORTED` after the state moves on; `outcome_reason` carries a reason code. Every transition is appended to `state_transitions`.

- `COMPLETE`: all steps executed and every mandatory step PASS. A completed run can still fail acceptance (assisted, cleanup unconfirmed, stale binding).
- `FAILED`: a step failed/timed out/errored, preflight rejected, provider unavailable or provisioning failed (`outcome_reason PROVIDER_UNAVAILABLE`, verdict `BLOCKED`), or a harness error occurred. Remaining steps are recorded `SKIPPED`.
- `ABORTED`: abort signal or run wall-clock limit (`RUN_ABORTED` / `RUN_TIMEOUT`). The sandbox is killed first.
- A harness killed mid-run leaves the drill `RUNNING`. The drill records its owner (pid and process start time) and, right after provisioning, an inventory of what it created (`run_inventory`, local only). `cleanup --run <id>` (and a startup scan at the beginning of every new `run`) treats a run whose owner is provably gone as orphaned: the remaining steps are recorded `SKIPPED`, the run becomes `ABORTED` (verdict `FAIL`, `RUN_ABORTED`), and cleanup runs from the recorded inventory (an orphan that never reached `RUNNING` provisioned nothing and gets an empty `VERIFIED` receipt; a `RUNNING` orphan with no inventory is `UNCONFIRMED`). While the owner is alive, or cannot be checked, `cleanup` still refuses with `CONFLICT`.
- Cleanup is attempted in a `finally` for every path that provisioned anything and is verified after every run (including timeout, abort and harness error). A run that provisioned nothing records a `VERIFIED` receipt with zero resources and a note saying so.

## 4. Steps (AC-03..AC-06)

All steps carry `deadline_seconds` and `mandatory` (default true). The first mandatory failure skips the remaining steps; a failed non-mandatory step does not skip later steps but is never invisible: the verdict carries `OPTIONAL_STEP_FAILED` and is capped at `REHEARSAL` (never `INDEPENDENT_PASS`). Every execution is bounded by the remaining step deadline and the run wall clock; on timeout the whole process group is killed (SIGTERM, 2 s grace, SIGKILL). No blind retries: a retry is a new drill.

Sandbox layout (paths in the manifest that say "sandbox-relative" are relative to `$HC_SANDBOX`):

```
$HC_SANDBOX/release/   extracted, validated artifact; scripts run with this as cwd
$HC_SANDBOX/scripts/   manifest scripts, staged read-only, relative paths preserved
$HC_SANDBOX/state/     writable scratch (backups, credentials, markers)
$HC_SANDBOX/home/ tmp/
```

Script environment: scrubbed. Only `PATH` (`/usr/local/bin:/usr/bin:/bin` plus the directory of the running Node binary for `local-sandbox`), `HOME`, `TMPDIR`, `LC_ALL=C`, `HC_RUN_ID`, `HC_STEP`, `HC_SANDBOX`, `HC_RELEASE`, `HC_STATE`, `HC_ISOLATION`, `HC_NODE` (local-sandbox only) and the manifest `env` entries. The parent environment is never inherited. Interpreters: `sh` (default), `bash`, `node`.

| Action | Procedure (the harness verifies, scripts never self-certify) | Failure reason codes |
| --- | --- | --- |
| `install` | run `script`, then poll `probe` (default every 500 ms) until exit 0; the whole step must finish within `deadline_seconds` | `SCRIPT_FAILED`, `SCRIPT_TIMEOUT`, `HEALTH_PROBE_FAILED` |
| `restore` | run `script`; run the separate `measure` script which prints `{"record_counts":{...},"data_hashes":{...}}` on stdout; compare every expected record count and data hash; independently hash each `expect.blobs[]` file read from the sandbox. A restore script that merely exits 0 never passes: a missing/invalid measure output fails. At least one expected count and at least one expected hash (data or blob) are required (preflight rejects otherwise) | `RESTORE_MEASURE_MISSING`, `RESTORE_COUNT_MISMATCH`, `RESTORE_HASH_MISMATCH`, `RESTORE_BLOB_MISMATCH` |
| `rotate` | read `credentials.old_file` before the script and `credentials.new_file` after it; old and new must differ; run `probe` with `HC_CREDENTIAL=<old>`: it must exit with a code in `reject_exit_codes` (default `[3]`); run it with the new credential: it must exit 0. Any other exit code is `ROTATION_PROBE_ERROR` (unknown never passes). Credentials are registered with the redactor and never stored | `ROTATION_NOT_ROTATED`, `ROTATION_OLD_ACCEPTED`, `ROTATION_NEW_REJECTED`, `ROTATION_PROBE_ERROR` |
| `recover` | run `seed_fault`; `probe` must now FAIL (fault observed); run the recovery `script` and time it; `probe` must now pass; recovery time must be `<= max_recovery_seconds`. Start/end/duration are recorded and every intervention recorded during the step window is linked on the receipt | `RECOVERY_FAULT_NOT_OBSERVED`, `RECOVERY_NOT_RESTORED`, `RECOVERY_TOO_SLOW` |

Each step stores a `step_receipt` evidence document (canonical JSON, `schemas/step.schema.json#/$defs/step_receipt`) whose sha256 is `steps.evidence_hash`, plus a redacted `step_log` per execution stream.

## 5. Preflight (AC-02)

Runs before anything executes; any `reject` finding means no sandbox is provisioned, the run ends `FAILED` (reason `PREFLIGHT_REJECTED`), nothing is accepted, exit code 1.

- Production-credential patterns scanned in the manifest (all strings), script contents, runbook text and artifact text entries (first 1 MiB each): AWS access key ids (`AKIA`/`ASIA`), private key blocks, GitHub tokens, Slack tokens, Stripe live keys, Google API keys, OpenAI/Anthropic-style `sk-` keys, npm tokens, JWT-shaped bearer tokens, and connection strings with an embedded password to a non-loopback host. A match is allowed only when it contains the synthetic marker `HCFAKE` (planted fake secrets). Findings never echo the match.
- Network destinations: URLs, `host:port` pairs, IPv4 literals and the arguments of common network tools in the manifest and scripts must be loopback (`localhost`, `127.0.0.0/8`, `::1`) or listed in `network.allow`; otherwise `UNDECLARED_NETWORK_DESTINATION`. This is static, heuristic detection of explicit inputs (URLs, tool arguments, IPv4 literals, `/dev/tcp/HOST/PORT`, python `socket.create_connection((HOST, PORT))`/`connect`, node `net.connect`/`tls.connect`); a script can still build an address at runtime, which is why enforcement belongs to the VM, not to this scan. `lima` rejects any non-loopback `network.allow` entry (MVP policy: no allowlisted external destinations) and removes the guest default routes at provision time (section 7). Egress is NOT ENFORCED by any provider: the lima guest state is best-effort and reported as such. `local-sandbox` cannot enforce egress (documented, labelled isolation none, synthetic only).
- Script safety: every script path exists, is a regular file inside the manifest directory (no `..`, no absolute path, no symlink component), is at most 1 MiB, and matches its optional `sha256` pin.
- Provider rules: `local-sandbox` requires `scenario.synthetic: true`; `lima` requires declared `runner.resources` (cpus, memory, disk) and a wall-clock limit.
- Artifact: tar or tar.gz validated before extraction (section 8).
- Manifest semantics: every PRD action (`install`, `restore`, `rotate`, `recover`) must appear as at least one mandatory step (extra optional steps are allowed; a drill with no or only optional steps is rejected), unique step ids, restore expectations, rotate credential paths inside the sandbox, `max_recovery_seconds <= deadline_seconds`, `env` values free of credential patterns.

## 6. Verdict model (AC-08 plumbing, acceptance decision)

`evaluateAcceptance(AcceptanceInput) -> VerdictResult` is a pure function (`src/domain/verdict.ts`) evaluated at read time from the store, so an intervention recorded after completion still turns the verdict `ASSISTED`. First match wins:

00. the run was imported from a bundle -> `UNKNOWN` (`IMPORT_UNAUTHENTICATED`). Hashes and the root hash prove integrity, not provenance (there is no signing-key infrastructure), so an imported run never gets an accepting verdict locally. The verdict recorded inside the bundle is stored append-only in `import_claims` (migration 002) and shown only as `claimed_verdict`, clearly labelled display-only; `import` itself still succeeds (exit 0) when integrity verifies. Imported runs are never reusable (`checkReuse`) and must never be exported to an adapter as accepted.
0. stored evidence missing or failing its sha256 (`evidence_verified: false`, additive input) -> `UNKNOWN` (`EVIDENCE_UNVERIFIABLE`): tampered or truncated evidence can never pass
1. provider unavailable -> `BLOCKED` (`PROVIDER_UNAVAILABLE`)
2. preflight rejected -> `FAIL` (`PREFLIGHT_REJECTED`)
3. binding check `MISMATCH` -> `UNKNOWN` (`STALE_BINDING`)
4. run state before cleanup, or no cleanup receipt -> `UNKNOWN` (`RUN_NOT_FINISHED` / `CLEANUP_MISSING`)
4b. no mandatory step in the run -> `UNKNOWN` (`NO_MANDATORY_STEPS`), and when every step carries its action, a missing passing mandatory step for any of the four PRD actions -> `UNKNOWN` (`REQUIRED_ACTION_NOT_PASSED`): nothing required to pass can never be accepting
5. outcome `ABORTED` -> `FAIL` (`RUN_ABORTED` or `RUN_TIMEOUT`)
6. any mandatory step `FAIL`/`TIMEOUT`/`ERROR` -> `FAIL`; any mandatory step missing or `SKIPPED`, or fewer recorded steps than planned -> `UNKNOWN`/`FAIL` as `MANDATORY_STEP_NOT_RUN` (partial never passes)
6b. outcome `FAILED`, or any `outcome_reason` other than `OK`, with no failing step to explain it (for example `HARNESS_ERROR`) -> `FAIL` with that reason, even when every recorded step passed and cleanup verified. `planned_steps` is stored on the drill at creation (migration 003, immutable) and compared with the recorded steps, so a run with fewer recorded steps than planned is never complete
7. cleanup `UNCONFIRMED` -> `FAIL` (`CLEANUP_UNCONFIRMED`)
8. all mandatory steps and cleanup PASS, then:
   - any intervention -> `ASSISTED` (`INTERVENTION_RECORDED`), never independent
   - operator kind `ai_assisted` -> `ASSISTED` (`OPERATOR_NOT_HUMAN`): an AI-assisted rehearsal is labelled and cannot satisfy the independent criterion
   - any failed optional step -> at most `REHEARSAL` (`OPTIONAL_STEP_FAILED`)
   - operator kind `automated`, or isolation `none`, or operator equals builder -> `REHEARSAL` (`OPERATOR_NOT_HUMAN` / `ISOLATION_NONE` / `OPERATOR_IS_BUILDER`)
   - operator kind `human`, isolation `vm`, no interventions, a non-empty `builder_ref` that differs from the operator `ref` -> `INDEPENDENT_PASS`. A `human` operator with a missing or empty `builder_ref` is `REHEARSAL` (`OPERATOR_INDEPENDENCE_UNPROVEN`); with `builder_ref == ref` it is `REHEARSAL` (`OPERATOR_IS_BUILDER`)

The operator kind is `automated` unless the invoker sets it explicitly: a manifest may declare `automated` or `ai_assisted` but can never assert `human` for itself (it is capped to `automated`); `human` must come from `RunInput.operator.kind` together with the operator and builder identities. Identity references are compared after Unicode NFKC normalization, trimming and case-folding (`normalizeRef`); a reference that normalizes empty is no reference. The operator identity is a self-declaration recorded by the local identity (`operator-attested by the local identity, not third-party attestation`); `INDEPENDENT_PASS` therefore means only that the harness saw a human-declared operator distinct from the declared builder on a VM with no interventions. AC-08 additionally needs a human receipt. Callers (CLI, agents, CI) must default the operator kind to `automated` and use `human` only when explicitly told, together with the operator and builder identities (CLI flags `--operator-kind human --operator-ref <who> --builder-ref <builder>`).

`exit_code` is 0 only for `INDEPENDENT_PASS` and `REHEARSAL`. `independent` is true only for `INDEPENDENT_PASS`. `human_receipt` is `PENDING_HUMAN_RECEIPT` for every verdict except `INDEPENDENT_PASS`, and even then records only `HARNESS_RECORDED`: the human drill receipt (AC-08, AC-12) is a separate human artifact and agents never mark it PASS. The independent verdict is a local attribution (`actor_ref` plus an HMAC under a local store key), not a third-party attestation.

## 7. Runner providers

```ts
interface RunnerProvider {
  name; isolation: "vm" | "none";
  probe(): Promise<{available; reason?; version?}>;     // unavailable => BLOCKED, never success
  provision(req): Promise<Sandbox>;                     // exec / readFile / resources / destroy
  audit(resources): Promise<ResourceRecord[]>;          // independent post-destroy check
  destroyResources(resources): Promise<void>;           // used by `cleanup --run`
}
```

`local-sandbox` (isolation `none`) executes the manifest scripts directly on this host. It is refused at preflight (`HOST_SANDBOX_NOT_ALLOWED`, run `FAIL`, exit 1) unless the caller passes `allowHostSandbox: true` (CLI `--allow-host-sandbox`); the built-in `demo()` is exempt, and an allowed run returns `RunResult.warnings` that the caller must print to stderr: host temp directory (mode 0700) plus scrubbed-environment subprocess in its own process group, wall-clock timeout, `ulimit -t/-f` CPU and file-size limits, capped output. It is synthetic only (refuses `synthetic: false`), every receipt and report label says `isolation=none`, and it can never satisfy a VM-isolation criterion. Cleanup kills the process groups and marker-tagged strays, removes the directory, then `audit` independently checks that the directory is gone, tracked process groups are dead, and a process scan finds no process belonging to the sandbox. The scan prefers the `HC_SANDBOX_ID` environment marker (`/proc/<pid>/environ`, else `ps eww`) and falls back to a `pgrep -f` match on the sandbox directory name when `ps` cannot run (restricted macOS sandboxes); the method used is recorded on the receipt. If no method is available, that resource is `unknown` and the receipt is `CLEANUP_UNCONFIRMED`. Beyond the process-group and marker checks, every available method is combined: `pgrep -f` on the sandbox directory name, `lsof +D` for open files and working directories under the sandbox directory (taken before the directory is removed), and descendants recorded by pid and start time while scripts run (a `ps` poll every 250 ms). Strays found are killed at destroy time and listed as `process` resources that the audit re-checks, so a daemon that survives (or that the `leak-process` fault leaves running) is `CLEANUP_UNCONFIRMED`. macOS hides the environment of SIP-protected binaries such as `/bin/sleep`, which is why the environment marker alone is not trusted. Known limit, always recorded as `process_scan: PARTIAL` on the cleanup receipt and as a report label: a daemon that left the sandbox directory, closed its files, scrubbed its environment and started after the last poll cannot be detected by any host-side scan. local-sandbox is isolation none and is never the isolation boundary; the lima provider destroys the whole VM. POSIX hosts only (Windows reports the provider unavailable).

`lima` (isolation `vm`): drives Lima 2.x (`limactl`). Verified recipe: `limactl start --name hc-<run>-<rand> --tty=false --plain --timeout 10m [--vm-type vz on macOS] --cpus N --memory GiB --disk GiB template:alpine` (override with `HANDOFFCHECK_LIMA_TEMPLATE`, `HANDOFFCHECK_LIMA_VMTYPE`), `limactl copy -r` to stage the extracted artifact and scripts under `/tmp/hcsbx` in the guest, `limactl shell` to execute (guest-side `timeout -k` plus a host-side kill), `limactl delete --force` to destroy. `--plain` means no host mounts and no port forwards. Resource limits come from `runner.resources`. Detection: `limactl` found (`HANDOFFCHECK_LIMACTL` or PATH) and `limactl --version` succeeds, else `probe()` reports unavailable and the run is `BLOCKED` (never simulated); a provisioning failure is also `BLOCKED` and any half-created VM is audited (a leftover is `CLEANUP_UNCONFIRMED`). The cleanup audit checks both `limactl list --quiet` and the instance directory under the Lima home.

Egress is NOT ENFORCED (reported PARTIAL, best-effort), honestly: Lima's usernet gives the guest outbound NAT and the alpine template has no firewall tool. At provision time the provider removes all guest default routes and checks it (no default route remains and `ip route get` to a documentation-range address fails). The workload then runs as an unprivileged guest user `hcrun` without sudo (created at provision; the provider verifies that it is not root, that `sudo` is unavailable to it and that it cannot change routes), so a hostile script cannot simply `sudo ip route add default`. This is not a firewall: the host-gateway address cannot be blocked (blackholing it breaks the control channel; verified: `limactl shell` hangs), so reachability of host services through the gateway is NOT_ENFORCED, and a guest privilege escalation would undo the route removal. The run receipt (`run_receipt` evidence, `facts.egress` and `facts.workload_user`) and a report label state exactly this; if the routes cannot be removed and verified, or the workload user cannot be set up and verified, the provider refuses to run. The AC-02 egress part must never be claimed enforced. Live hostile-script control (Lima 2.2.0, alpine): a script run as `hcrun` (uid 1000) saw `sudo` denied, `ip route add default` denied (with and without sudo) and a connect to a documentation-range address fail. File reads (restore blobs) use an output cap sized to the file, so blobs larger than 1 MiB verify correctly (3 MiB blob verified live). The alpine guest has no `node`, `bash` or `curl`: manifest scripts for the lima provider must be POSIX `sh` (busybox) unless a template with those tools is supplied.

Live receipt (macOS arm64, Lima 2.2.0, vz, template:alpine, 2 CPU / 2 GiB / 5 GiB): a four-step sh-only drill (install, restore with blob hash, rotate, recover) passed with cleanup VERIFIED in about 90 s, `limactl list` empty afterwards and no instance directory left; an abort while provisioning left no instance; with the leak fault the instance stayed and the run was `CLEANUP_UNCONFIRMED` until `cleanup --run` removed it. Node 22/24 and Linux/qemu hosts were not exercised.

Test fault injection (negative controls only): when `ctx.env.HANDOFFCHECK_TEST_FAULT=leak-resource` the built-in providers (local-sandbox and lima) skip removing their resources (directory / VM); `HANDOFFCHECK_TEST_FAULT=leak-process` makes local-sandbox leave its processes running (including strays) so the audit must report them; the run is labelled `fault_injected: true`, the audit finds the leak, the receipt is `UNCONFIRMED`, the state is `CLEANUP_UNCONFIRMED` and exit is 1. Tests may also inject their own `ProviderRegistry`. `cleanup --run` refuses imported runs (they own no local resources). The offline `demo` uses heartbeat files and opens no sockets, so it also completes with all networking denied.

## 8. Limits and hostile input (AC-10, AC-11)

Defaults (`DEFAULT_LIMITS`, overridable only by explicit `ctx.limits`): 25 MiB metadata, 1,000 files, 250 MiB blobs/archives, 1 MiB per output stream, 50 steps, 1 MiB per script. Size and schema are validated before processing: file sizes are checked from `stat` before reading, tar headers are checked for entry count and cumulative size before any extraction, gzip is inflated with a hard output cap (zip-bomb safe), and disk capacity is checked (`INSUFFICIENT_CAPACITY`) before import/export writes.

Tar (artifact and bundle): ustar and pax/GNU long-name records only. Rejected: absolute paths, `..` segments, NUL bytes, over-long names, duplicate names, hard links, device/fifo entries, and symlinks whose target is absolute or whose chain resolves outside the extraction root. Containment is physical: after all entries are read, every symlink target is resolved through the complete link map (`resolveLinkInside`), so chains such as `d/s1 -> ..`, `d/s2 -> ../d/s1/..` and links defined out of order are rejected, as are loops and chains deeper than 40 hops; legitimate in-root links still work (artifacts may carry them; bundles allow none). Manifest YAML is parsed with alias and size limits and unique keys. Executing anything from an imported bundle is not possible: a bundle contains documents and blobs only.

Redaction (`src/security/redact.ts`): all captured output, error messages and echoed manifest values pass through one redactor before they are stored, hashed or reported. It removes manifest `synthetic_secrets` verbatim, credentials read during rotation, every production-credential pattern, `HCFAKE_*` planted tokens, `Authorization:` header values, `password=`/`secret=`/`token=` assignments, and connection-string passwords, replacing them with `[REDACTED:<kind>]`. Script output is stored only after the step ends, so credentials learned during the step (the new rotation credential) redact every log of that step, and terminal escape sequences and non-printing control characters are removed before redaction (so a secret split by escape codes cannot slip through). Evidence `redacted` is true when the bytes passed through the redactor, with `redaction_count`. Evidence hashes are over the redacted bytes. Report strings are plain text; the report renderer HTML-escapes them (hostile HTML renders as text). Intervention reasons are redacted with the built-in patterns only (the planted-secret marker `HCFAKE` and credential shapes); free text typed by a human cannot be matched against secrets that were declared only in a manifest, so planted secrets should carry the marker.

## 9. Store and evidence (`src/store/**`, `src/evidence/**`)

Store directory (`--output`, mode 0700; files 0600): `handoffcheck.sqlite` (WAL), `objects/<aa>/<sha256>` content-addressed blobs, `identity.key` (random 32 bytes, local HMAC key), `.staging/` for atomic work. Persistence is `node:sqlite` (`DatabaseSync`); the experimental warning is suppressed at import. `migrations/001_initial.sql` is applied by a migration runner that records `schema_migrations` and `PRAGMA user_version`; a store newer than this code throws `STORE_SCHEMA_UNSUPPORTED`. Foreign keys are enforced, ids are UUIDs, timestamps are UTC ISO-8601, and every serialized document has `schema_version`.

Tables: `store_meta`, `run_inventory` (what a run provisioned, for orphan recovery; never exported), `import_claims`, `run_secrets` (declared and learned secret literals, AES-256-GCM under a key derived from the identity key, never exported, used to redact later interventions and cleanup retries), `drills`, `state_transitions`, `steps`, `interventions`, `evidence`, `cleanup_receipts`. History is append-only: triggers abort `UPDATE` and `DELETE` on every table except `drills` (state/outcome/finish projection), and retention purge is the only deleter (guarded by a `store_meta` flag). Steps are inserted once, at their final status. Cleanup retries append a new `cleanup_receipts` row (latest `seq` wins). Indexes: parent ids, `state`, `retain_until`, `binding_digest`. Retention: `retain_until = created_at + retention_days` (manifest, default 90); `purgeExpired(ctx, {olderThanDays?, dryRun?})` deletes runs past `retain_until` (or created more than N days ago when `olderThanDays` is given) and their unreferenced objects in the same call; `dryRun` deletes nothing and lists what would be purged.

Canonical JSON (all hashes): RFC 8785 for the JSON subset produced by this tool (sorted keys, no whitespace, UTF-8, ES number form; NaN/Infinity/undefined/bigint/non-plain objects/binary rejected). `canonicalJson`, `sha256Hex` are exported from `src/api.ts`.

Clock and ids: all timestamps come from `ctx.clock` and all ids from `ctx.ids` (defaults: system clock, random UUIDs). `fixedClock(startIso, stepMs)` and `sequentialIds()` make tests deterministic. Real timeouts still use wall-clock timers.

## 10. Evidence bundle (AC-11)

A bundle is one file: an uncompressed ustar archive containing, in order, `bundle.json` (the header, `schemas/evidence-bundle.schema.json`), `run.json` (`#/$defs/run_export`) and `objects/<sha256>` blobs. The header lists every file with sha256 and size and a `root_hash` over the sorted list; `format_version` is 1. Verification and import check (`verifyBundle` always adds `note: "integrity only, provenance not verified"`; each step record must agree with the step receipt it points at, and every object must be stored at `objects/<its own sha256>`): end-of-archive marker present and no trailing garbage (truncation), exact file set (no extras, no missing), per-file sha256 and size, root hash, header/run schema, evidence rows against blobs, supported `format_version` (anything else is `UNSUPPORTED_VERSION`), limits (entry count and sizes taken from tar headers before any content is read), and path safety. Import runs in one SQLite transaction after staging and verifying everything; blobs are installed content-addressed and removed again if the transaction rolls back. Failure at any point leaves no accepted state (no run, no evidence rows, no new blobs). Importing an existing run id fails with `CONFLICT`. Imported runs are flagged `imported`, their verdict is re-derived, and intervention signatures are carried but only verifiable under the originating store key.

## 11. Optional adapters (owned by hc-cli, contract here)

`schemas/adapter-envelope.schema.json`: `{schema_version:1,event_id,source,resource_id,event_type,occurred_at,revision,evidence_ref,correlation_id?}`. Local files only, disabled by default, no network, dedupe `event_id`, reject unsupported major versions, never infer current state from an old event. `requireConnector(name, connected)` throws `CONNECTOR_DISCONNECTED` for live connector operations while disconnected.

## 12. Acceptance-criteria map (which code path proves which AC)

| AC | Code path | Failure boundary |
| --- | --- | --- |
| AC-01 | `computeBinding`, `checkReuse`, `getReport({currentInputs})` | changed artifact/runbook/scenario/script gives a new digest, `BINDING_CHANGED`, `STALE_BINDING` |
| AC-02 | `runPreflight` (`src/security/preflight.ts`), providers | production credential or undeclared destination: run `FAILED`, no sandbox, exit 1; `local-sandbox` refuses non-synthetic; `lima` requires resource limits |
| AC-03 | `executeStep` install | probe never passes or exceeds deadline: `HEALTH_PROBE_FAILED`/`SCRIPT_TIMEOUT`, step `FAIL`/`TIMEOUT` |
| AC-04 | `executeStep` restore | exit-0 script without matching measure/hashes fails; count/data-hash/blob mismatches fail |
| AC-05 | `executeStep` rotate | old credential still accepted, new rejected, unchanged credentials, or probe error: step fails |
| AC-06 | `executeStep` recover, `recordIntervention` | fault not observed, not restored, too slow: fails; any intervention makes verdict `ASSISTED` |
| AC-07 | engine `finally` cleanup, `audit` | step timeout or abort still cleans up; leaked/unknown resource: `CLEANUP_UNCONFIRMED`, exit 1 |
| AC-08 | `evaluateAcceptance` | `human_receipt` stays `PENDING_HUMAN_RECEIPT`; ai_assisted/automated/isolation none/intervention never `INDEPENDENT_PASS` |
| AC-09 | `demo`, no network in core | provider/connector unavailable fails explicitly (`BLOCKED`, `CONNECTOR_DISCONNECTED`) |
| AC-10 | `parseManifest`, `redact`, archive limits | oversize/schema-invalid rejected before processing; planted secrets absent from evidence, logs and reports |
| AC-11 | `exportBundle`, `verifyBundle`, `importBundle` | truncated, tampered, unsupported-version or unsafe bundles fail with no partial state |
| AC-12 | documentation (hc-qa) | human receipt; not a domain concern |
