#!/usr/bin/env bash
# HandoffCheck local quality gate. There is no remote CI (GitHub Actions is banned): run this before every push.
#
#   bash scripts/verify-quality.sh            run every check, exit 1 if any fails (2 if a required tool is missing)
#   HC_STRICT=1 bash scripts/verify-quality.sh  additionally exit 3 unless EVERY matrix row is PASS
#                                              (AC-08/AC-12 are human receipts, so strict stays red until they exist)
#   HC_GATE_ONLY=selftest bash scripts/verify-quality.sh   run only the gate self-test (seeded failures must turn it red)
#
# Runtime: uses `node` from PATH. It must be >= 22.13 and provide a working node:sqlite, or the gate exits 2 immediately.
#
# Unknown is never success: a missing scanner or an empty negative-control set is a failure, not a skip.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
TMP="${TMPDIR:-/tmp}/handoffcheck-gate.$$"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

FAILS=()
STEPS=()
GATE_BASE_DIR="$ROOT"
note() { printf '\n== %s\n' "$*"; }
run_step() { # run_step <name> <command...>
  local name="$1"; shift
  local start end rc
  note "$name"
  start=$(date -u +%s)
  "$@"
  rc=$?
  end=$(date -u +%s)
  STEPS+=("$(printf '%-34s exit=%s  %ss' "$name" "$rc" "$((end - start))")")
  if [ "$rc" -ne 0 ]; then FAILS+=("$name (exit $rc)"); fi
  return 0
}
need() { command -v "$1" >/dev/null 2>&1 || { echo "required tool missing: $1" >&2; return 1; }; }

# The supported runtime is a precondition, not a test: fail clearly and early instead of producing misleading green or red.
check_runtime() {
  command -v node >/dev/null 2>&1 || { echo "node not found on PATH (need >= 22.13)" >&2; return 1; }
  local v major minor
  v=$(node -p 'process.versions.node' 2>/dev/null) || { echo "node on PATH does not run" >&2; return 1; }
  major=${v%%.*}; minor=${v#*.}; minor=${minor%%.*}
  if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 13 ]; }; then
    echo "unsupported runtime: node $v (need >= 22.13). Put a supported node first on PATH and re-run." >&2
    return 1
  fi
  node -e 'const { DatabaseSync } = require("node:sqlite"); const d = new DatabaseSync(":memory:"); d.exec("create table t(x)"); d.close();' >/dev/null 2>&1 \
    || { echo "unsupported runtime: node $v has no working node:sqlite" >&2; return 1; }
  echo "runtime ok: node $v with node:sqlite"
}

no_gha() {
  if [ -e .github/workflows ]; then echo ".github/workflows exists: GitHub Actions is banned" >&2; return 1; fi
  echo "no GitHub Actions workflows"
}

secret_scan() {
  need sec-scan || return 1
  sec-scan "$ROOT"
  local rc=$?
  # exit 0 clean, 1 warnings (reported above, not fatal), >=2 failure
  if [ "$rc" -eq 1 ]; then echo "sec-scan reported warnings (see above); not fatal"; return 0; fi
  return "$rc"
}

# Tracked files plus untracked-but-not-ignored files: what a commit could contain.
public_files() { { git ls-files; git ls-files --others --exclude-standard; } | sort -u | while IFS= read -r f; do [ -f "$f" ] && printf '%s\n' "$f"; done; }

sanitize_public() {
  need sanitize-content || return 1
  local list="$TMP/public-files.txt"
  public_files >"$list"
  [ -s "$list" ] || { echo "no files to scan: vacuous run is a failure" >&2; return 1; }
  # sanitize-content takes paths as arguments; xargs batches them. Non-zero from any batch fails the step.
  tr '\n' '\0' <"$list" | xargs -0 sanitize-content --scope public
}

# One test run produces the JSON report that the count checks below read, so the suite is not executed three times.
TESTS_JSON="$TMP/tests.json"
run_tests() {
  npx vitest run --coverage --coverage.reportOnFailure=true --reporter=default --reporter=json --outputFile.json="$TESTS_JSON"
}

# Require at least N tests whose full title (describe path + title) matches PATTERN, all passed, none failed or skipped.
# Optional FILE_REGEX limits the match to test files whose path matches it.
count_tests() { # count_tests <label> <min> <regex> [file-regex]
  local label="$1" min="$2" pattern="$3" fileRe="${4:-.}"
  if [ ! -s "$TESTS_JSON" ]; then echo "$label: no test report (the test step did not produce one)" >&2; return 1; fi
  node - "$TESTS_JSON" "$min" "$pattern" "$label" "$fileRe" <<'NODE'
const [file, min, pattern, label, fileRe] = process.argv.slice(2);
const report = JSON.parse(require("node:fs").readFileSync(file, "utf8"));
const re = new RegExp(pattern, "i");
const fre = new RegExp(fileRe);
let matched = 0, passed = 0, failed = 0, skipped = 0;
for (const f of report.testResults) {
  if (!fre.test(f.name)) continue;
  for (const t of f.assertionResults) {
    if (!re.test(`${t.ancestorTitles.join(" ")} ${t.title}`)) continue;
    matched++;
    if (t.status === "passed") passed++; else if (t.status === "failed") failed++; else skipped++;
  }
}
console.log(`${label}: matched=${matched} passed=${passed} failed=${failed} skipped=${skipped} (required >= ${min} passed, none failed or skipped)`);
process.exit(failed === 0 && skipped === 0 && passed >= Number(min) ? 0 : 1);
NODE
}

# Fails on files that must never ship (secrets, stores, tests, scratch) or when the CLI entry is missing.
package_hygiene_check() { # package_hygiene_check <npm pack --json output>
  node - "$1" <<'NODE'
const pack = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"))[0];
const bad = pack.files.map((f) => f.path).filter((p) => /(^|\/)(\.env(\..*)?|[^/]*\.sqlite|[^/]*\.pem|[^/]*\.key)$/.test(p) || /^(tests|\.tmp|evidence|coverage|node_modules)\//.test(p));
console.log(`package files: ${pack.files.length}`);
if (bad.length) { console.error(`unexpected files in package: ${bad.join(", ")}`); process.exit(1); }
if (!pack.files.some((f) => f.path === "dist/src/cli.js")) { console.error("dist/src/cli.js missing from package (run build first)"); process.exit(1); }
NODE
}

package_hygiene() {
  local list="$TMP/pack.json"
  npm pack --dry-run --json >"$list" 2>"$TMP/pack.err" || { cat "$TMP/pack.err" >&2; return 1; }
  package_hygiene_check "$list"
}

dist_cli_runs() {
  local out
  out=$(node dist/src/cli.js --help 2>&1) || { echo "$out" >&2; return 1; }
  echo "$out" | head -5
}


# Gate self-test: every way the gate can go red is exercised with a SEEDED failure, so a gate that cannot fail is itself a failure.
selftest() {
  local d="$TMP/selftest" rc bad=0
  mkdir -p "$d"
  expect_red() { # expect_red <label> <command...>: the command MUST exit non-zero
    local label="$1"; shift
    if "$@" >/dev/null 2>&1; then echo "SELFTEST FAIL: $label did not turn red" >&2; bad=1; else echo "selftest ok: $label turns red"; fi
  }
  expect_green() {
    local label="$1"; shift
    if "$@" >/dev/null 2>&1; then echo "selftest ok: $label stays green"; else echo "SELFTEST FAIL: $label should be green" >&2; bad=1; fi
  }
  local ok='{"testResults":[{"name":"x.spec.ts","assertionResults":[{"ancestorTitles":["a"],"title":"negative control one","status":"passed"},{"ancestorTitles":["a"],"title":"negative control two","status":"passed"}]}]}'
  printf '%s' "$ok" >"$d/ok.json"
  node -e 'const f=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const w=(n,m)=>{const c=JSON.parse(JSON.stringify(f)); m(c.testResults[0].assertionResults); require("fs").writeFileSync(process.argv[2]+"/"+n+".json", JSON.stringify(c));};
    w("failed",(a)=>{a[1].status="failed";}); w("skipped",(a)=>{a[1].status="pending";}); w("few",(a)=>{a.pop();}); w("none",(a)=>{a.length=0;}); w("renamed",(a)=>{a[0].title="x";a[1].title="y";});' "$d/ok.json" "$d"
  expect_green "count_tests on an all-passing report" env TESTS_JSON="$d/ok.json" bash -c "$(declare -f count_tests); count_tests nc 2 'negative control'"
  for seeded in failed skipped few none renamed; do
    expect_red "count_tests with a seeded '$seeded' report" env TESTS_JSON="$d/$seeded.json" bash -c "$(declare -f count_tests); count_tests nc 2 'negative control'"
  done
  expect_red "count_tests with no report at all" env TESTS_JSON="$d/missing.json" bash -c "$(declare -f count_tests); count_tests nc 1 'negative control'"
  # run_step must record a failing step and the gate must then be red
  expect_red "run_step on a failing command" bash -c "$(declare -f note run_step); FAILS=(); STEPS=(); run_step seeded false >/dev/null; [ \${#FAILS[@]} -eq 0 ]"
  expect_green "run_step on a passing command" bash -c "$(declare -f note run_step); FAILS=(); STEPS=(); run_step fine true >/dev/null; [ \${#FAILS[@]} -eq 0 ]"
  # a runtime that is too old, or that has no node:sqlite, is refused
  mkdir -p "$d/oldnode"
  printf '#!/bin/sh\ncase "$*" in *versions.node*) echo 20.11.0 ;; *) exit 0 ;; esac\n' >"$d/oldnode/node"; chmod +x "$d/oldnode/node"
  expect_red "an unsupported node (20.x) on PATH" env PATH="$d/oldnode:$PATH" bash -c "$(declare -f check_runtime); check_runtime"
  expect_green "the node on PATH" bash -c "$(declare -f check_runtime); check_runtime"
  # a seeded stray file in a package listing is caught by the hygiene regex
  printf '[{"files":[{"path":"dist/src/cli.js"},{"path":"evidence/handoffcheck.sqlite"}]}]' >"$d/pack-bad.json"
  printf '[{"files":[{"path":"dist/src/cli.js"},{"path":"README.md"}]}]' >"$d/pack-good.json"
  expect_red "package hygiene with a seeded sqlite file" bash -c "$(declare -f package_hygiene_check); package_hygiene_check '$d/pack-bad.json'"
  expect_green "package hygiene with a clean listing" bash -c "$(declare -f package_hygiene_check); package_hygiene_check '$d/pack-good.json'"
  # the secret scanner and the sanitizer must catch seeded content (built from fragments so this file stays clean)
  mkdir -p "$d/seed-sec" "$d/seed-pii"
  printf 'token=%s%s\n' "ghp_" "0123456789abcdefghijklmnopqrstuvwxyzAB" >"$d/seed-sec/config.txt"
  printf 'see %s%s\n' "/Users/" "$(id -un)/Documents/x" >"$d/seed-pii/notes.md"
  need sec-scan >/dev/null 2>&1 && expect_red "sec-scan on a seeded credential-shaped literal" sec-scan "$d/seed-sec"
  need sanitize-content >/dev/null 2>&1 && expect_red "sanitize-content on a seeded personal path" sanitize-content --scope public "$d/seed-pii/notes.md"
  need sec-scan >/dev/null 2>&1 || { echo "SELFTEST FAIL: sec-scan missing" >&2; bad=1; }
  need sanitize-content >/dev/null 2>&1 || { echo "SELFTEST FAIL: sanitize-content missing" >&2; bad=1; }
  # a vacuous scan (no files) is a failure, never a pass
  expect_red "sanitize-content on an empty path list (vacuous)" sanitize-content --scope public "$d/does-not-exist"
  rc=$bad
  [ "$rc" -eq 0 ] && echo "selftest: all seeded failures were detected"
  return "$rc"
}

# Refuse an unsupported runtime before doing anything else (exit 2: environment problem, not a product failure).
check_runtime || { echo "GATE: ABORTED (runtime precondition failed)" >&2; exit 2; }

if [ "${HC_GATE_ONLY:-}" = "selftest" ]; then
  run_step "runtime check" check_runtime
  run_step "gate self-test" selftest
  note "SUMMARY"; printf '%s\n' "${STEPS[@]}"
  if [ "${#FAILS[@]}" -ne 0 ]; then printf '\nGATE SELFTEST: FAIL\n'; printf '  failed: %s\n' "${FAILS[@]}"; exit 1; fi
  printf '\nGATE SELFTEST: PASS\n'; exit 0
fi

run_step "runtime check"                check_runtime
run_step "gate self-test (seeded failures)" selftest
run_step "no GitHub Actions"            no_gha
run_step "typecheck"                    npm run --silent typecheck
run_step "build"                        npm run --silent build
run_step "mark dist current for tests"  touch dist/.hc-build-stamp  # tests/helpers/cli.ts ensureBuilt(): one build per gate
run_step "packaged CLI starts"          dist_cli_runs
run_step "tests + coverage (>=90%)"     run_tests
run_step "negative controls (>=12)"     count_tests negative-controls 12 "negative control"
run_step "report smoke (browser+parse)" count_tests report-smoke 6 "report smoke" "tests/e2e/smoke.spec.ts"
live_vm() {
  # Live VM drills run against a REAL Lima instance and take minutes. Opt in with HC_LIVE_VM=1. Otherwise they are
  # reported as BLOCKED/not run (never mocked, never counted as passing) and the matrix keeps its live column BLOCKED.
  if [ "${HC_LIVE_VM:-0}" != "1" ]; then echo "live VM drills: NOT RUN (set HC_LIVE_VM=1 with a real limactl); live criteria stay BLOCKED"; return 0; fi
  need limactl || return 1
  npx vitest run tests/live/vm.spec.ts --reporter=json --outputFile="$TMP/live.json" >"$TMP/live.log" 2>&1
  TESTS_JSON="$TMP/live.json" count_tests live-vm 6 "live VM" "tests/live/vm.spec.ts"
}

run_step "AC matrix lint"               node scripts/check-matrix.mjs
run_step "live VM drills (opt-in)"      live_vm
run_step "license audit current"        node scripts/license-audit.mjs --check
run_step "package hygiene"              package_hygiene
run_step "secret scan (sec-scan)"       secret_scan
run_step "sanitize-content --scope public" sanitize_public

note "SUMMARY"
printf '%s\n' "${STEPS[@]}"
node scripts/check-matrix.mjs 2>/dev/null | tail -1
echo "environment: node $(node -v), $(uname -s) $(uname -m); limactl: $(command -v limactl >/dev/null 2>&1 && echo "present ($(limactl --version 2>/dev/null | head -1))" || echo ABSENT - live VM criteria are BLOCKED, never mocked); HC_LIVE_VM=${HC_LIVE_VM:-0}"
if [ "${#FAILS[@]}" -ne 0 ]; then
  printf '\nGATE: FAIL\n'; printf '  failed: %s\n' "${FAILS[@]}"
  for f in "${FAILS[@]}"; do case "$f" in *"exit 127"*) exit 2 ;; esac; done
  exit 1
fi
printf '\nGATE: PASS (all automated checks). Matrix claim is separate: see MATRIX_VERDICT above.\n'
if [ "${HC_STRICT:-0}" = "1" ]; then node scripts/check-matrix.mjs --strict >/dev/null 2>&1 || { echo "STRICT: matrix has non-PASS rows"; exit 3; }; fi
exit 0
