# Independent human drill (AC-08) and fresh-operator smoke (AC-12)

AC-08 and AC-12 are **human receipts**. No tool, script or AI agent can satisfy them, and an agent run of
this procedure is only labelled supplemental evidence. Until a person files a receipt, both rows stay
`PENDING_HUMAN_RECEIPT` in `docs/qa/AC-MATRIX.md`.

- **AC-08**: an independent human drill records who performed the work and whether help was needed.
- **AC-12**: a fresh operator, using only the release documentation, executes the synthetic smoke procedure.

The two can be done in one sitting by the same person. Budget 45 minutes (30 for the drill, the rest for
the notes).

## 1. Who may do this

The **operator** must be someone who did not write, review or previously run this service, this runbook or
HandoffCheck, and who has not read the source. Prior knowledge biases the result: write down anything they
already knew (section 6).

A separate **recorder** (a third person if possible; otherwise the operator keeps the log) writes down time and
help. The **builder** may be present but may only answer when the operator asks, and **every** answer is an
intervention. The builder must not hint, point at the screen, retype commands or read errors aloud.

## 2. What the builder prepares in advance (and nothing else)

- A checkout of the repository at a recorded revision: `git rev-parse HEAD` (40 characters) goes into the receipt.
- A clean machine or account for the operator: macOS or Linux, Node.js 22.13 or newer, git. For the VM drill,
  Lima (`limactl`, tested with 2.2.0; the default Alpine guest has `sh` but no Node, so the VM drill uses the
  POSIX-sh fixture `fixtures/drill-sh`). If `limactl` is not available the VM drill
  cannot happen: the receipt must say `BLOCKED` for the isolation part and must not substitute
  `local-sandbox`.
- The drill inputs from `fixtures/drill-sh` and `fixtures/release-sh` (the operator builds the artifact themselves in step 4).
- A blank copy of `docs/qa/receipts/TEMPLATE.md`.

Do not demonstrate the tool first. Do not pre-run anything on the operator's machine.

## 3. The procedure (give the operator exactly this page, the repository `README.md`, and nothing else)

Work in an empty directory, with `HC_REPO` set to the checkout and an `hc` shell function as the command:

```sh
export HC_REPO=/path/to/handoffcheck-checkout   # your checkout
hc() { node "$HC_REPO/dist/src/cli.js" "$@"; }
```

Time every step with the system clock, not a guess: `date -u +%Y-%m-%dT%H:%M:%SZ`.

1. **Start.** Record the start time, the operator identity (a stable handle, see section 6), the revision and
   the environment: `node --version`, `uname -sm`, and `limactl --version` (or "absent").
2. **Install (AC-12).** Follow `README.md` "Install" inside the checkout: `npm ci`, `npm run build`, then
   `hc --version`. Record time and any problem.
3. **Smoke (AC-12).** In a new empty sub-directory `smoke/` of your working directory, with `HC_REPO` set to the
   checkout path, run the commands in the README block marked `sh smoke` one at a time. Record the exit code of each. Every command must exit 0, except that the final `report` on the imported store must exit 1 (the script checks it). Note
   every place where the documentation was unclear, wrong or incomplete, and every time the operator had to
   look outside the README.
4. **Read the runbook (AC-08).** The operator reads `fixtures/drill-sh/RUNBOOK.md` once, then performs the
   four runbook sections by hand in a scratch directory: unpack the artifact
   (`node "$HC_REPO/scripts/build-fixture-release.mjs" release-sh.tar --variant sh && mkdir rel && tar -xf release-sh.tar -C rel`),
   then run the `sh bin/notes.sh ...` commands in the order the runbook gives, from inside `rel/`. Record per section:
   start and end time, outcome (done, failed, gave up), and any help.
5. **Drill (AC-08).** Run the harness with the operator's identity, on the VM provider when available:

   ```sh
   cp -R "$HC_REPO/fixtures/drill-sh" ./human-drill
   # runner.provider is already lima and resources are declared. Do not switch it to local-sandbox for the independent drill.
   # The operator is claimed on the command line (the manifest default is automated):
   hc preflight --manifest ./human-drill/drill.yaml --artifact release-sh.tar --runbook ./human-drill/RUNBOOK.md
   hc run --manifest ./human-drill/drill.yaml --artifact release-sh.tar --runbook ./human-drill/RUNBOOK.md --output ./human-evidence \
      --operator-kind human --operator-ref <operator handle> --builder-ref <builder handle>
   ```

   Exit 0 is only possible for `INDEPENDENT_PASS`/`REHEARSAL`. With `local-sandbox` the best possible verdict is
   `REHEARSAL` (isolation none): that is **not** an independent pass and the receipt must say so.
6. **Record every intervention immediately,** when it happens, not afterwards:

   ```sh
   hc record-intervention --run <run id> --actor <who helped> --reason "<what was asked and answered>" --output ./human-evidence
   ```

   Any intervention makes the verdict `ASSISTED` permanently. That is the correct outcome; do not avoid it.
7. **Cleanup.** The run prints a cleanup status; open the report to see the resources.
   `hc report --run <run id> --output ./human-evidence`, then check the host yourself:
   `limactl list` (no instance for this run) and `ps` (no stray `limactl` or sandbox process). If the cleanup is
   `CLEANUP_UNCONFIRMED` run `hc cleanup --run <run id> --output ./human-evidence` and record it.
8. **Export.** `hc export --run <run id> --out ./human-drill.hcb --output ./human-evidence`
   then `hc verify-bundle --bundle ./human-drill.hcb`. Keep the bundle, the printed bundle
   sha256 and `human-evidence/reports/<run id>/report.html`.
9. **Stop.** Record the end time and total elapsed time.

## 4. What must be recorded (the receipt)

Copy `docs/qa/receipts/TEMPLATE.md` and fill every field. Missing fields mean the receipt is incomplete and
the row stays pending.

- **Identity**: the operator handle (a stable pseudonym is fine; do not put an email or home path in a public
  repository), their role, and their relationship to the builder. The recorder's handle.
- **Revision**: the 40-character commit, dirty-tree status (`git status --short` must be empty), artifact
  sha256, runbook sha256, binding digest from the report, run id(s).
- **Environment**: OS, Node version, provider, `limactl` version or "absent".
- **Timing**: system-clock UTC start and end per phase and per runbook section, total elapsed.
- **Help received**: yes or no. For each instance: time, who, what was asked, what was answered, which step.
  The count must equal the number of `record-intervention` entries in the report.
- **Step outcomes**: install, restore, rotate, recover each PASS/FAIL/TIMEOUT with the report's reason code,
  plus the verbatim verdict line and exit code.
- **Cleanup receipt**: the report's cleanup status and resource list, and the outputs of `limactl list` and `ps`
  after the run.
- **Documentation findings (AC-12)**: every unclear or missing instruction, with the README or runbook section.
- **Prior knowledge and bias**: what the operator knew beforehand; whether they were observed.
- **Attestation**: a sentence by the operator that they performed the steps themselves, and by the recorder that
  the log is complete. This is a local attribution, not a third-party attestation.

## 5. How to file the receipt

1. Save the filled receipt as `docs/qa/receipts/AC-08-<UTC date>-<operator handle>.md` and attach the exported
   bundle and report (or their sha256 values and a storage location the maintainers can reach).
2. Open a pull request that adds only the receipt files. The author must be the operator or recorder, not the
   builder.
3. A reviewer who is not the builder checks the receipt against section 4. Only then may the maintainers change
   AC-08 and/or AC-12 in `docs/qa/AC-MATRIX.md`, citing the receipt path. Use these outcomes:

| Receipt shows | AC-08 status |
| --- | --- |
| Human non-builder operator, VM isolation, no help, cleanup verified, `INDEPENDENT_PASS` | PASS (human receipt) |
| Human operator but help was needed (`ASSISTED`) | PARTIAL: identity and help are recorded, but the independent criterion is not met |
| `local-sandbox` only (`REHEARSAL`, isolation none) or `limactl` absent | BLOCKED for the isolation part; not a PASS |
| Operator was the builder, AI-assisted or automated | not a human drill; stays PENDING_HUMAN_RECEIPT |

AC-12 is PASS only if every smoke command exited 0 for a person who used only the documentation, and the
documentation findings were either empty or fixed and re-run by the same or another fresh operator.

## 6. Rules that protect the result

- Say before starting what the operator already knows. A repeat run by the same person is not independent.
- Never edit the manifest, scripts or runbook during the drill. A change is a new drill with a new binding.
- Do not let anyone use an AI assistant during the drill; if one was used, the operator kind is `ai_assisted`
  and the result is `ASSISTED`.
- Report failures as they are. A failed or assisted drill with an honest receipt is more useful than a
  clean-looking one, and a sample of one is not evidence of anything general.
