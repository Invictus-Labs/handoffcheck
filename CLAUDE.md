# HandoffCheck

Prove another operator can run what you delivered: reproducible, deterministic, self-hosted handoff drills in an isolated disposable environment, with versioned evidence bundles.

## Stack
TypeScript (strict, ESM), Node >=22.13, SQLite via `node:sqlite`, vitest, static HTML report. CLI product: no listening port.

## GitHub
NEVER commit to main directly. Always feature branch (`codex/...`) -> PR -> merge. No GitHub Actions workflows, ever.

## Quality Gate
Local gate: `scripts/verify-quality.sh` (typecheck, build, tests, 90% line+branch coverage on decision/service code, secret scan, negative controls, report smoke). Review gate: code-review-swarm + qa-swarm receipts at the exact final SHA, zero P0/P1. Definition of done: `docs/DOD.md` (verbatim PRD 5/5b/5c). Territories: `docs/TEAM.md`.

## Hard rules
- Uncertainty is never success. Mocks never satisfy live criteria; unproven live criteria are BLOCKED.
- AC-08 and AC-12 are human receipts: agents record PENDING_HUMAN_RECEIPT, never PASS.
- No private paths/hosts/emails/credentials in any file. Demo URLs use `localhost`.
- Execution scripts are explicit versioned inputs; never generate shell from runbook prose.

## Index
- `docs/DOD.md`, `docs/TEAM.md`, `docs/prd/handoffcheck.md`, `docs/qa/`
