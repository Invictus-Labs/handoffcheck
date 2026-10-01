#!/usr/bin/env bash
# Local quality gate (placeholder owned by QA; replaced by the full gate).
# There is no remote CI: run this before every push.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run typecheck
npm run build
npm run test:coverage
