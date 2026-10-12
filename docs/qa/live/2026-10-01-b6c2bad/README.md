# Preserved live VM receipt, tested revision b6c2badfae73faed4ac3892586a1594089b830c1

Produced by `bash scripts/live-receipt.sh <dir>` on a clean committed tree (the script refuses a dirty tree and a missing `limactl`).
Everything here is raw output of that one run, post-processed only as the script documents: the repository path is replaced by `<repo>`
and UUIDs are shortened to `id-<first 8 hex>` (the public-content scanner blocks raw UUIDs). Hashes, timestamps, exit codes and text are untouched.

| File | Content |
| --- | --- |
| `context.txt` | git SHA, node, limactl and OS versions, the exact command, start and finish UTC time, exit code (0) |
| `limactl-list-before.txt`, `limactl-list-after.txt` | `limactl list` before and after: no instance either time |
| `vitest-live.json`, `console.log` | the full vitest JSON result and console log: 6 passed, 0 failed, 0 skipped |
| `runs/<name>/report.json` | the redacted report of each live run (clean drill, unprivileged workload, seeded failing recovery, run-time egress block, leaked VM, abort) |
| `runs/<name>/step-log-*.txt` | every stored (redacted) step log of that run; the hostile-script control is `runs/unprivileged-workload/` |

Reading the hostile-script control: the install script's stdout in `runs/unprivileged-workload/` shows `hcrun`, uid `1000`, `SUDO_DENIED`,
`ROUTE_ADD_SUDO_DENIED`, `ROUTE_ADD_DIRECT_DENIED` and `PUBLIC_CONNECT_FAILED`, with none of `SUDO_OK`, `ROUTE_ADDED`, `PUBLIC_CONNECT_OK`
(the live test asserts exactly this). Egress remains NOT ENFORCED: this shows the unprivileged workload cannot undo the route removal, not
that nothing can; the host gateway stays reachable. The operator in these runs is a script (`automated`), so verdicts are REHEARSAL.
