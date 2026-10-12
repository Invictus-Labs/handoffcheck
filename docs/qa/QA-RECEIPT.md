# HandoffCheck QA receipt (owner: hc-qa)

Independent QA of HandoffCheck against `docs/DOD.md` (PRD 5, 5b, 5c), re-run after the independent code review of
`9ea21de` (CHANGES_REQUESTED: 1 P0, 6 P1). The QA role did not write the product code (`src/**`) and did not edit it.
Every status below was produced by running the commands listed here; nothing is estimated. This is a QA receipt, not a
release approval: the independent review gate (zero P0/P1 at the exact final SHA) is separate and not performed here.

## Verdict in one paragraph

**DONE_WITH_CONCERNS. The matrix cannot be claimed as passed.** The full local gate passed on a clean committed tree at
the tested SHA below, with the live VM step on a real Lima 2.2.0 guest (6 of 6 live tests). Every review finding that has a
fix on the integration branches has a regression test that is green here and that failed on the old revision (see the
findings table). Rows that are not PASS, and why: AC-08 and AC-12 are `PENDING_HUMAN_RECEIPT` (a person who is not the
builder has to do the drill in `docs/HUMAN-DRILL.md`; no agent may mark them PASS); AC-02's live column is `PARTIAL`
because VM egress is **not enforced** (best-effort route removal plus an unprivileged workload user; the host gateway stays
reachable); the `Dockerfile` build is NOT RUN (the Docker server was unhealthy in the earlier session and was not retried).

## Revisions under test

| Item | Value |
| --- | --- |
| Tested SHA (QA branch `codex/handoffcheck-fix1-qa`; the gate ran on a clean committed tree) | `b6c2badfae73faed4ac3892586a1594089b830c1` |
| Domain fix branch `codex/handoffcheck-fix1` merged in | `4e916e6` (contains `eda6383`, `230b29e`, `a33dc4f`) |
| CLI fix branch `codex/handoffcheck-fix1-cli` merged in | `597dc7d` |
| Base | `codex/handoffcheck-mvp` `9ecacb0` via the fix1 merge |
| Commits after the tested SHA | docs and the receipt script only (`docs/qa/**`, `scripts/live-receipt.sh` post-processing of UUIDs); no `src/**` or test changes |
| Dirty tree at the gate run | clean (`git status --short` empty; the `node_modules` symlink is excluded locally) |
| Fixture version | `1.0.0` (`fixtures/demo.json`) |

## Environment

- macOS arm64, 14 cores. Node v26.8.1 (first on `PATH`; the gate refuses a node older than 22.13 or without `node:sqlite`, exit 2).
  **Node 22 was not run by hc-qa at this SHA.** The product declares `>=22.13`; earlier suites were green on Node 24 and 25.
- Playwright 1.63.0 with Chromium (static report browser smoke). limactl 2.2.0 (real Lima, vz, Alpine template) for the live step.
- Docker server unhealthy earlier (HTTP 500): `Dockerfile` not built. `sanitize-content` and `sec-scan` are user-local tools.

## Commands, exit codes and run times

1. `bash scripts/verify-quality.sh` at the tested SHA, clean committed tree, exit **0** (`GATE: PASS (all automated checks)`):
   runtime check, gate self-test, no GitHub Actions, typecheck, build, packaged CLI, tests + coverage (70 s), 327 negative controls,
   6 of 6 report smoke, matrix lint (MATRIX_VERDICT=INCOMPLETE by design), license audit, package hygiene, sec-scan, sanitize-content: all exit 0.
2. `bash scripts/live-receipt.sh <dir>` at the same SHA, exit **0**: real Lima 2.2.0, started 2026-10-01T05:23:18Z, finished 05:29:43Z,
   6 passed, 0 failed, 0 skipped, `limactl list` empty before and after. Raw outputs preserved in `docs/qa/live/2026-10-01-b6c2bad/`.
   (An earlier `HC_LIVE_VM=1 bash scripts/verify-quality.sh` at `c8140db`, exit 0, 550 passed and 6 of 6 live, covered the same code; it is
   superseded by the preserved receipt, which is the record the live rows rest on.)

## Results

- Test files: 22 passed (22). Tests: 550 passed, 0 failed, 6 skipped (the live tests, skipped with a `BLOCKED:` note in the default gate and run in the live receipt).
- Coverage (v8, `src/**` excluding `src/cli.ts`, floor 90 lines and 90 branches): branches 91.55%, lines 97.17%.
- Negative controls: 327 matched, all passed. Decision table: 29 rows, each asserting the exact verdict, ordered reason codes and exit code (P2-7).
- Regression suites for the review: `tests/units/review-fix1.spec.ts`, `tests/units/review-fix1-cli.spec.ts`, `tests/units/gate.spec.ts`. Run against the old revision `9ea21de` (first-round selection) 43 of them failed; the 31 that passed there are positive controls and behaviors that were already correct.
- Gate self-test: seeded failed, skipped, missing and too-few test reports, a failing step, a node 20 on `PATH`, a stray `.sqlite` in the package listing, a seeded credential-shaped literal, a seeded personal path and a vacuous scan each turn the gate red; clean inputs stay green (`HC_GATE_ONLY=selftest bash scripts/verify-quality.sh`).

## Review findings (independent review of `9ea21de`) and their regression tests

| Item | Finding | Regression test (file :: title fragment) | Status here |
| --- | --- | --- | --- |
| P0-1 | all steps optional and failing exited 0 | `review-fix1.spec.ts :: every step optional and every script failing is rejected by preflight` and per-action rejections; decision-table rows; `engine-edges.spec.ts :: P0-1 corrected rule` (optional failure caps at REHEARSAL) | green; the two tests that locked the old behavior were updated, not deleted |
| P1-1 | FAILED outcome / planned count ignored | `review-fix1.spec.ts :: a run recorded FAILED (HARNESS_ERROR)`, `a recorded step that vanished from the store` | green |
| P1-2 | declared secret leaked via interventions (AC-10) | `review-fix1.spec.ts :: P1-2` section (declared, learned-in-rotation, step output, store/bundle scan) | green |
| P1-3 | lexical symlink check, chain escapes the root | `review-fix1.spec.ts :: P1-3` section (chain, two hops, cycle, malformed, positive controls, bundle) | green |
| P1-4 | egress claim overstated | `lima.spec.ts :: P1-4` (unprivileged `sudo -n -u hcrun`, NOT ENFORCED label, fault cases `user` and `sudo`); live: `the workload runs unprivileged` | green; live PASS on a real VM; egress itself stays PARTIAL |
| P1-5 | adapter acceptance "accepted" without verification | `adapters.spec.ts :: acceptance import` (digest pin, run verdict, revision, nonce, null-prototype ledger) and `review-fix1-cli.spec.ts :: P1-5 through the CLI` | green |
| P1-6 | host execution gated only by a self-declared flag | `review-fix1.spec.ts :: P1-6`, `review-fix1-cli.spec.ts :: P1-6 through the CLI`, `cli-commands.spec.ts :: preflight` | green |
| P2-1 | bundle blob path not bound to its hash | `review-fix1.spec.ts :: P2-1` | green |
| P2-2 | REHEARSAL reusable | `handoffcheck.spec.ts :: ... a REHEARSAL on this host is never reusable (P2-2)`, reusable only for INDEPENDENT_PASS; CLI `check-reuse` | green |
| P2-3 | identity compare not normalized | decision-table rows, `review-fix1.spec.ts :: P2-3`, CLI up-front refusal | green |
| P2-4 | no purge | `review-fix1.spec.ts :: P2-4`, `review-fix1-cli.spec.ts :: P2-4 through the CLI` | green |
| P2-5 | README deny-all wording | README, RUNBOOK, OPERATIONS reworded: egress is best effort and NOT ENFORCED; doc tests green | fixed (docs) |
| P2-6 | QA receipt missing, matrix unreconciled | this file, `AC-MATRIX.md`, live receipt reconciled to real runs | fixed (docs) |
| P2-7 | weak decision-table controls | all 29 rows assert exact verdict, ordered codes and exit code | fixed |
| P2-8 | Lima 1 MiB output cap | the restore step of every live run reads blobs through the sized reader (live PASS); no dedicated large-blob test | covered indirectly |
| P2-9 | e2e flake (dist rebuilt in `beforeAll`) | `tests/helpers/cli.ts :: ensureBuilt`: one build per source state under a lock and stamp; the gate builds once and stamps | fixed |
| P3 | no positive control for the static no-network scan; `.partial` not exclusive; PEM marker; socket heuristics; null-prototype ledger | `handoffcheck.spec.ts :: positive control: the static no-network pattern ...`, `review-fix1.spec.ts :: P3` | green |
| P1 (domain) | rotation credential printed by the rotate script leaked with no synthetic_secrets | `review-fix1.spec.ts :: a rotation credential printed by the rotate script is redacted ...` (store, bundle, later intervention) | green |
| (domain) | terminal escapes in output; step status forged in a bundle; orphaned RUNNING run | `review-fix1.spec.ts :: terminal escape sequences ...`, `... a bundle whose step record says PASS ...`, `review-fix1-cli.spec.ts :: cleanup refuses while the owner is alive ...` and `a later run in the same store reaps ...` | green |
| (indep-QA) | README: oversize artifact is PREFLIGHT_REJECTED/ARTIFACT_LIMIT, not PAYLOAD_TOO_LARGE; purge and retention undocumented; backup list lacks `.staging/`; fixture builder silent under a symlinked TMPDIR; stale D2 note; smoke afterAll hook timeout | README corrected, `build-fixture-release.mjs` compares real paths (test `scripts/build-fixture-release.mjs writes the artifact when started through a symlinked directory`), hook timeout raised, no D2 note remains | fixed |
| (indep-QA) | live receipt was self-reported and its bytes not preserved | `scripts/live-receipt.sh` and `docs/qa/live/2026-10-01-b6c2bad/` (raw outputs, hostile-script control logs) | fixed |
| (found by QA) | owner start time compared as `ps lstart` text in the caller's TZ: a live run looked dead from another TZ | `review-fix1-cli.spec.ts :: a cleanup invoked with a different TZ ...` | fixed by hc-domain (`4e916e6`), test green |

## Per-criterion grading (DOD 5b, by behavior)

| AC | Criterion (short) | Automated (local-sandbox, isolation none) | Live VM (real Lima) | Grade |
| --- | --- | --- | --- | --- |
| AC-01 | drill bound to artifact digest, runbook hash, scenario version | PASS | n/a | PASS |
| AC-02 | preflight rejects credentials and undeclared destinations; untrusted work only in a disposable VM with limits | PASS | PARTIAL | PARTIAL (egress not enforced) |
| AC-03 | install and health probe within the deadline | PASS | PASS | PASS |
| AC-04 | restore compared by counts, data hashes and blob hashes | PASS | PASS | PASS |
| AC-05 | rotation: old fails, new succeeds | PASS | PASS | PASS |
| AC-06 | bounded seeded failure recovered; timing and interventions recorded | PASS | PASS | PASS |
| AC-07 | timeout/abort cleanup; leaks give CLEANUP_UNCONFIRMED and a failing exit | PASS | PASS | PASS |
| AC-08 | independent human drill records who and whether help was needed | PENDING_HUMAN_RECEIPT | BLOCKED | PENDING_HUMAN_RECEIPT |
| AC-09 | offline demo, no accounts or telemetry; connectors fail explicitly | PASS | n/a | PASS |
| AC-10 | size/schema validated first; secrets never leak; hostile HTML is text | PASS | n/a | PASS |
| AC-11 | versioned bundle round trip; corrupt or unsupported fails with no partial state | PASS | n/a | PASS |
| AC-12 | release docs and a fresh operator can run the smoke | PENDING_HUMAN_RECEIPT | n/a | PENDING_HUMAN_RECEIPT |

DOD 5c feature-specific release conditions, graded:

| Condition | Grade | Evidence |
| --- | --- | --- |
| every numbered acceptance criterion has current evidence | PARTIAL | ten criteria have green automated evidence at the tested SHA; AC-08 and AC-12 are `PENDING_HUMAN_RECEIPT` |
| live criteria have live sandbox receipts | PARTIAL | real Lima receipts for AC-03 to AC-07 and the AC-02 execution parts at the tested SHA (`docs/qa/live/2026-10-01-b6c2bad/README.md`); AC-02 egress PARTIAL; AC-08 needs a human on a VM |
| independent review of the final tested revision has zero P0/P1 | NOT RUN here | separate gate; the P0 and the P1s of the previous review have fixes and regression tests, a re-review is pending |
| seeded negative controls fail as intended | PASS | 323 tests titled "negative control", all green, plus the gate's own self-test |
| documentation explains unknown/partial states | PASS | README verdict table, honest limits, RUNBOOK, OPERATIONS; AC-12 documentation tests |
| a container alone is not presented as isolation | PASS | `Dockerfile` header, README honest limits and the doc test |

## Skipped, blocked and not-run items

| Item | Status | Why |
| --- | --- | --- |
| `tests/live/vm.spec.ts` (6 tests) | skipped without `HC_LIVE_VM=1` (reported `BLOCKED:`), **run live and green** at the tested SHA | needs a real `limactl`, network for the guest image and about 7 minutes |
| `Dockerfile` build and run | **NOT RUN** | the Docker server was unhealthy (HTTP 500) when tried; not retried for this revision. Documentation/demo only, never the isolation boundary |
| Independent human drill (AC-08) | **PENDING_HUMAN_RECEIPT** | needs a person who is not the builder: `docs/HUMAN-DRILL.md` |
| Fresh human operator documentation run (AC-12) | **PENDING_HUMAN_RECEIPT** | same; the in-repo README smoke and its e2e test are supplemental only |
| Egress inside the VM | **NOT ENFORCED** (reported PARTIAL, best effort) | default routes removed and verified, workload user unprivileged and verified to be unable to re-add them; host gateway reachable; a guest privilege escalation undoes the route removal |
| Node 22 run of the suite | NOT RUN by hc-qa | the gate used Node 26.8.1; earlier green on 24 and 25 |
| Windows, Linux hosts, other VM images | not tested | only macOS arm64 and the Alpine Lima template were available |

## Open items (not blocking this receipt, or owner decisions)

| Id | Sev | Finding |
| --- | --- | --- |
| O1 | P2 (limit) | VM egress is not enforced (above). The PRD's "egress policy is required" is only partly met on this provider |
| O2 | P3 | Preflight network and credential detection is static and heuristic. Not detected (probed): package-manager installs (`pip install`, `apt-get install`), destinations held in shell variables (`curl $host`), `require("net").connect(...)` written through an intermediate call. Socket idioms `/dev/tcp`, python `socket`, and `net.connect({host})` are detected. The live egress test builds its URL at run time on purpose |
| O3 | P3 (docs) | `docs/CLI.md` says an existing store directory readable by others is "not changed"; the library tightens it to owner-only. The sentence should be corrected |
| O4 | P3 | `package.json` `files` now lists `fixtures`; `scripts/` is still not packaged, so the smoke procedure needs a repository checkout (README says so) |
| O5 | info | `sec-scan` WARN for the documentation-range address `192.0.2.1` in `src/runner/lima.ts` (intentional, RFC 5737) |
| O6 | P3 | The bundle chain-symlink regression test passes on the old revision too: the old bundle reader already refused any symlink entry, so that case is a control, not a discriminator. The artifact path (preflight) is the discriminating test |
| O7 | P3 | P2-8 (Lima output cap) has no dedicated test |

## Honest limits of this receipt

- One run per command on one host. Timing-sensitive tests (deadlines of 1 to 3 seconds) were green; they could be flaky on a heavily loaded machine.
- Coverage is supporting evidence, not a substitute for the matrix. Exclusion: `src/cli.ts` (entry shim, exercised by the packaged-CLI E2E tests).
- `INDEPENDENT_PASS` can only come from a human, non-builder operator on VM isolation. Automated tests that reach it use a fake `limactl` (protocol evidence, never live evidence) or a decision-table unit test; they are not human receipts.
- The live VM evidence is a single guest image (Alpine template on Lima 2.2.0, vz) on one macOS host, with a scripted (`automated`) operator.
