# Human drill receipt (AC-08 / AC-12)

Status of this file: DRAFT until every field is filled and a reviewer who is not the builder has checked it.
Procedure: `docs/HUMAN-DRILL.md`. Use system-clock UTC times (`date -u +%Y-%m-%dT%H:%M:%SZ`), not estimates.

## Who
- Operator handle:
- Operator role / relationship to the builder:
- Builder handle:
- Recorder handle:
- Prior knowledge of the service, runbook or tool (be specific):
- Was the operator observed? Was any AI assistant used? (yes/no, details):

## What
- Repository revision (40 characters):
- `git status --short` empty? (yes/no):
- Artifact sha256:
- Runbook sha256:
- Binding digest (from the report):
- Run id(s):
- Environment: OS and architecture / Node version / provider (`lima` or `local-sandbox`) / `limactl --version` or absent:

## Timing (UTC)
| Phase | Start | End | Outcome | Help needed |
| --- | --- | --- | --- | --- |
| Install (README) | | | | |
| Smoke (README, `sh smoke`) | | | | |
| Runbook section 1 install | | | | |
| Runbook section 2 restore | | | | |
| Runbook section 3 rotate | | | | |
| Runbook section 4 recover | | | | |
| Harness drill (`run`) | | | | |
| Cleanup and host check | | | | |
- Total elapsed:

## Smoke exit codes (AC-12)
| Command (README `sh smoke` block, in order) | Exit code |
| --- | --- |
| | |

## Help received (AC-08)
Helped at all? (yes/no): ___   Count: ___ (must equal the interventions in the report)
| Time (UTC) | Who helped | What was asked | What was answered | Step |
| --- | --- | --- | --- | --- |
| | | | | |

## Step outcomes (from the report)
| Step | Status | Reason code |
| --- | --- | --- |
| install | | |
| restore | | |
| rotate | | |
| recover | | |
- Verdict line, verbatim:
- Exit code of `run`:

## Cleanup receipt
- Report cleanup status and resources:
- `limactl list` after the run:
- `ps` check after the run:
- Anything left behind and how it was removed:

## Documentation findings (AC-12)
| Section | What was unclear, wrong or missing | Fixed in |
| --- | --- | --- |
| | | |

## Attestation
- Operator: "I performed these steps myself." (handle, date)
- Recorder: "This log is complete and accurate." (handle, date)
- Exported bundle sha256 / location:

## Reviewer (not the builder)
- Reviewer handle, date, outcome per `docs/HUMAN-DRILL.md` section 5 (PASS / PARTIAL / BLOCKED / pending):
