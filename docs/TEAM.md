# Build team and exclusive file territories

All builders, reviewers and QA run Claude Sonnet 5.5 at HIGH effort. Territories are hard boundaries: if you need a change in a file you do not own, message the owner (via the coordinator) with the exact change; do not edit it.

The definition of done is `docs/DOD.md` (PRD sections 5, 5b, 5c, verbatim). The PRD allocates `src/cli.ts` to the backend owner; the build order of this repository gives the CLI to the CLI/UI/integration builder, and the backend owner exposes a library API instead (`src/api.ts`).

| Role (agent name) | Exclusive territory |
| --- | --- |
| Domain / backend builder (`hc-domain`) | `src/domain/**`, `src/store/**`, `src/evidence/**`, `src/runner/**`, `src/security/**`, `src/api.ts`, `schemas/**`, `migrations/**`, `docs/DESIGN.md` |
| CLI / UI / integration builder (`hc-cli`) | `src/cli.ts`, `src/cli/**`, `src/report/**`, `src/adapters/**`, `templates/**`, `docs/CLI.md`, `docs/ADAPTERS.md` |
| Independent QA (`hc-qa`) | `tests/**`, `fixtures/**`, `scripts/**`, `README.md`, `Dockerfile`, `docs/qa/**`, `docs/RUNBOOK.md`, `docs/HUMAN-DRILL.md`, `docs/DEPENDENCY-LICENSES.md`, `docs/OPERATIONS.md` |
| Coordinator (session owner) | `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `LICENSE`, `CLAUDE.md`, `lessons.md`, `docs/TEAM.md`, `docs/DOD.md`, `docs/prd/**` |

## Contract order
1. `hc-domain` freezes `schemas/*.json`, `src/domain/types.ts` and `src/api.ts` first and messages `hc-cli` and `hc-qa` when frozen. Changes after freeze go through the coordinator.
2. `hc-cli` consumes `src/api.ts`; it never imports `src/store/**` or `src/runner/**` internals.
3. `hc-qa` writes tests against the packaged CLI and the library API, never by editing source. Defects go to the owning builder.
4. New dependencies and shared-config changes are requested from the coordinator.

## Rules every agent follows
- Stage explicit paths only (never `git add -A` / `git add .`); commit to the working branch only; do not push, open PRs or merge.
- No GitHub Actions. No telemetry. No outbound network from the deterministic core.
- Public-content hygiene: no personal paths, private hosts/IPs, emails or credentials; use `localhost` and synthetic IDs, fixed UTC clocks, planted fake secrets.
- Uncertainty never becomes success: unknown, stale, partial, deferred states never pass a gate.
- AC-08 and AC-12 need human receipts: no agent may mark them PASS. Record `PENDING_HUMAN_RECEIPT`.
- Report DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT with exact commands, exit codes and full 40-char SHAs.
