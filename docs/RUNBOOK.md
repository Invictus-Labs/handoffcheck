# HandoffCheck operator runbook

For the person who runs drills with HandoffCheck. It is about operating the tool itself; the runbook of
the service being drilled is a separate input (see `fixtures/drill/RUNBOOK.md` for the synthetic one).
Commands use `node dist/src/cli.js`; replace with `handoffcheck` if you ran `npm link`.

## 1. Before a drill

1. Build the exact revision you intend to rely on: `npm ci && npm run build`, then
   `node dist/src/cli.js --version`.
2. Run the synthetic smoke procedure from `README.md`. If it does not exit 0, stop: the tool is not working
   on this machine and any drill result would be unknown.
3. Prepare the three inputs and keep them unchanged for the whole drill: the artifact, the runbook, the
   manifest with its scripts. Changing any of them later makes a new drill (new binding digest).
4. `preflight` them. Exit 1 means the inputs were rejected; the findings explain why and never echo a
   secret. Fix the inputs, do not weaken the check. Real credentials never belong in a drill: use planted
   fakes carrying the marker `HCFAKE`.
5. Choose the provider. Use `lima` for anything you want to count as isolated; it needs `limactl`. Use
   `local-sandbox` only for synthetic rehearsals: it runs the scripts directly on this host, so `preflight` and `run`
   refuse it unless you pass `--allow-host-sandbox` (only for scripts you wrote and trust). A VM drill needs declared
   `runner.resources`. The VM's egress control is best effort and not enforced; see `README.md`, Honest limits.
6. Decide the operator before you start: record `operator.kind` (`human`, `ai_assisted`, `automated`),
   `operator.ref` and `operator.builder_ref` in the manifest or with `--operator-kind`, `--operator-ref` and `--builder-ref`. Only a human who is
   not the builder can ever produce `INDEPENDENT_PASS`.

## 2. Running and reading a drill

```sh
node dist/src/cli.js run --manifest drill.yaml --artifact release.tar --runbook RUNBOOK.md --output evidence/   # + --allow-host-sandbox for local-sandbox
```

- Progress goes to stderr; the verdict and exit code are the result. Ctrl-C aborts: the sandbox is killed,
  the outcome is `ABORTED` and cleanup still runs and is verified.
- Open `evidence/reports/<run id>/report.html`. Read the verdict banner, the reasons, each step's
  expected versus actual checks, interventions and the cleanup resources.
- Every time the builder helps, record it immediately:
  `node dist/src/cli.js record-intervention --run <run id> --reason "<what help>" --actor <who> --output evidence/`.
  This turns the verdict into `ASSISTED` for good, by design.

## 3. When something is red, amber or unknown

| You see | Do |
| --- | --- |
| Exit 2 | The inputs or arguments are invalid. Read the one-line error, fix it, run again. Nothing was accepted |
| `PREFLIGHT_REJECTED` | Remove the credential or undeclared network destination, or declare the destination in `network.allow` (the VM provider only allows loopback in this version) |
| A step `FAIL`/`TIMEOUT` | Open the step in the report. Fix the release or the scripts, then run a **new** drill. There are no blind retries |
| `CLEANUP_UNCONFIRMED` | See section 4. The run is red until a later cleanup receipt is `VERIFIED` |
| `BLOCKED` | The VM provider is unavailable. Install Lima or accept that the live criterion is unproven. Do not switch providers to make it green |
| `UNKNOWN` | Partial or stale. Re-read the reasons; usually the inputs changed or the run did not finish |

## 4. Cleanup that did not verify

1. `node dist/src/cli.js cleanup --run <run id> --output evidence/`. This retries removal and appends a new
   receipt. Exit 0 only when the receipt is `VERIFIED`.
2. If it stays unconfirmed for a VM run, find the leaked instance yourself: `limactl list`, then
   `limactl delete --force <name>` for the instance named `hc-<first 8 characters of the run id>-<6 hex digits>`
   (the cleanup receipt in the report names it). Run `cleanup` again so the
   receipt records the independent check.
3. For `local-sandbox`, remove the temporary directory named in the report and stop any process listed.
4. Never mark a run clean by editing the store. History is append-only.

## 5. Sharing and keeping evidence

- Share a run with `export --run <id> --out run.hcb`; the recipient runs `verify-bundle` and `import`.
- Reports and bundles contain redacted evidence only, but treat them as internal: scenario names and operator
  references appear in them.
- Retention defaults to 90 days (`retention_days`). Backup and restore are described in `README.md`.

## 6. What this tool will not tell you

A passing drill means these scripted steps worked once for this operator in this sandbox. It does not prove
production readiness, other failure modes, or that a different operator would pass. State the sample size
whenever you quote a result.
