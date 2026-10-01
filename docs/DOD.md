# HandoffCheck — Definition of Done (verbatim from the PRD)

The text below is copied byte-for-byte from PRD sections 5, 5b and 5c (docs/prd/handoffcheck.md). It is the contract: no agent may reword, shrink or re-author it. Status cells in 5b are updated only by the QA owner when a real test node id exists.

---

## 5. Acceptance Criteria

- [ ] **AC-01** — Bind drill to artifact digest, runbook hash and scenario version; modified inputs invalidate reuse of old results.
- [ ] **AC-02** — Preflight rejects production credentials and undeclared network destinations; run untrusted workloads only in a dedicated disposable VM with resource limits.
- [ ] **AC-03** — Install from supplied instructions in a fresh environment and verify the declared health probe within the scenario deadline.
- [ ] **AC-04** — Restore a synthetic backup and compare record counts plus selected data and blob hashes; a process merely starting does not pass restore.
- [ ] **AC-05** — Rotate a synthetic credential and prove the old credential fails while the new credential succeeds.
- [ ] **AC-06** — Recover a bounded seeded worker failure with documented steps; record timing and every builder intervention.
- [ ] **AC-07** — Timeout or abort triggers cleanup; leaked resources yield CLEANUP_UNCONFIRMED and a failing exit code.
- [ ] **AC-08** — An independent human drill records who performed the work and whether help was needed; an AI-assisted rehearsal is labeled assisted and cannot satisfy the independent criterion.
- [ ] **AC-09** — A synthetic demo works without paid accounts or mandatory telemetry; an outbound-denied test completes the deterministic local core. Live connector operations fail explicitly when disconnected.
- [ ] **AC-10** — Validate size and schema before processing; planted secret tokens never appear in logs or exported reports; malicious HTML renders as text.
- [ ] **AC-11** — Export a versioned evidence bundle and restore/read it in a clean installation with matching hashes; truncated or unsupported exports fail without partial accepted state.
- [ ] **AC-12** — Release documentation includes installation, upgrade, backup, restore and failure diagnosis; a fresh operator can execute the synthetic smoke procedure.

## 5b. Test Strategy

**SEC · 04c — Test Strategy & DoD**

**12 mapped ACs / 12 total ACs. All tests are PLANNED; none is claimed to pass.**

| AC | Level | Proven by — planned behavior | Execution | Status |
| --- | --- | --- | --- | --- |
| AC-01 | Unit + integration / E2E | `tests/handoffcheck.spec.ts :: <input binding>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |
| AC-02 | Unit + integration / E2E | `tests/handoffcheck.spec.ts :: <sandbox boundary>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |
| AC-03 | Unit + integration / E2E | `tests/handoffcheck.spec.ts :: <fresh install>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |
| AC-04 | Unit + integration / E2E | `tests/handoffcheck.spec.ts :: <data restoration>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |
| AC-05 | Unit + integration / E2E | `tests/handoffcheck.spec.ts :: <rotation negative control>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |
| AC-06 | Unit + integration / E2E | `tests/handoffcheck.spec.ts :: <recovery and intervention>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |
| AC-07 | Unit + integration / E2E | `tests/handoffcheck.spec.ts :: <abort cleanup>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |
| AC-08 | Human + E2E | Non-builder follows supplied runbook in a fresh sandbox; record all assistance, step outcomes and cleanup receipt (§9 independent drill). | Human receipt + harness | PLANNED |
| AC-09 | Unit + integration / E2E | `tests/handoffcheck.spec.ts :: <offline demo>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |
| AC-10 | Unit + integration / E2E | `tests/handoffcheck.spec.ts :: <redaction and hostile input>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |
| AC-11 | Unit + integration / E2E | `tests/handoffcheck.spec.ts :: <portability and corruption>` — assert the criterion, including its failure boundary. | Automated; live sandbox gated | PLANNED |
| AC-12 | Human + E2E | Non-builder follows supplied runbook in a fresh sandbox; record all assistance, step outcomes and cleanup receipt (§9 independent drill). | Human receipt + harness | PLANNED |

### Flow and failure coverage

| User-facing flow | Happy path | Sad path / boundary |
| --- | --- | --- |
| input binding | Bind drill to artifact digest, runbook hash and scenario version; modified inputs invalidate reuse of old results. | Inject the rejected/uncertain condition in this criterion; assert no accepted result or unauthorized state change. |
| sandbox boundary | Preflight rejects production credentials and undeclared network destinations; run untrusted workloads only in a dedicated disposable VM with resource limits. | Inject the rejected/uncertain condition in this criterion; assert no accepted result or unauthorized state change. |
| fresh install | Install from supplied instructions in a fresh environment and verify the declared health probe within the scenario deadline. | Inject the rejected/uncertain condition in this criterion; assert no accepted result or unauthorized state change. |
| data restoration | Restore a synthetic backup and compare record counts plus selected data and blob hashes; a process merely starting does not pass restore. | Inject the rejected/uncertain condition in this criterion; assert no accepted result or unauthorized state change. |
| rotation negative control | Rotate a synthetic credential and prove the old credential fails while the new credential succeeds. | Inject the rejected/uncertain condition in this criterion; assert no accepted result or unauthorized state change. |
| recovery and intervention | Recover a bounded seeded worker failure with documented steps; record timing and every builder intervention. | Inject the rejected/uncertain condition in this criterion; assert no accepted result or unauthorized state change. |
| abort cleanup | Timeout or abort triggers cleanup; leaked resources yield CLEANUP_UNCONFIRMED and a failing exit code. | Inject the rejected/uncertain condition in this criterion; assert no accepted result or unauthorized state change. |
| independent operator protocol | An independent human drill records who performed the work and whether help was needed; an AI-assisted rehearsal is labeled assisted and cannot satisfy the independent criterion. | Inject the rejected/uncertain condition in this criterion; assert no accepted result or unauthorized state change. |

### Fixtures and runners
Use deterministic UTC clocks, synthetic IDs and planted fake secrets. Default tests cannot access customer accounts. Unit tests cover decision rules and state boundaries. Integration tests exercise real persistence and adapters against controlled fixtures; browser tests exercise API-backed UI rather than route mocks. For a CLI, E2E invokes the packaged executable in a fresh temporary directory and checks exit codes plus report contents. Add a static-report browser smoke for escaping, readable tables and empty/error states.

Each service module requires meaningful normal, invalid and boundary cases; each API router requires success, authorization and conflict tests. Each implemented page receives an E2E smoke and render tests for loading, empty and failure. Target at least 90% branch/line coverage of new decision and service code, with exclusions documented. Coverage is supporting evidence, not a substitute for the matrix.

Live adapters need opt-in sandbox tests pinned to provider/version and sanitized evidence. If credentials or a supported provider are absent, mark BLOCKED; mock success does not satisfy a live criterion. A seeded mandatory failure must turn the release verdict red. QA reconciles planned behavior labels to real test IDs in the implementation PR.

The final receipt records every repository SHA, dirty-tree status, environment, command, exit code, run time, fixture version, artifact hashes, skipped tests and unresolved findings. Any required NOT RUN, PARTIAL or BLOCKED row prevents a claim that the matrix passed.


## 5c. Definition of Done

Reference the canonical **CLAUDE.md → Quality Gate Standard (ALL repos)** at implementation time; resolve its actual workspace path in the build handoff and follow the current local/swarm runner policy. Do not introduce a competing universal gate in this PRD.

Feature-specific release conditions: every numbered acceptance criterion has current evidence; live criteria have live sandbox receipts; independent review of the final tested revision has zero P0/P1; seeded negative controls fail as intended; documentation explains unknown/partial states. Running release code is execution of untrusted input. A container alone is not an adequate isolation promise; the VM runner and egress policy are required. Human trials can be biased by prior knowledge.

This document is a requirements draft, not an implementation or release receipt.
