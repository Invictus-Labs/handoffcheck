#!/bin/sh
# Explicit, versioned drill script (a manifest input). Never generated from runbook prose.
set -eu
: "${HC_RELEASE:?}" "${HC_STATE:?}"
export NOTES_HOME="$HC_STATE/notes" NOTES_CREDENTIAL_DIR="$HC_STATE"
NODE="${HC_NODE:-node}"
SVC="$HC_RELEASE/bin/notes.mjs"
"$NODE" "$SVC" worker || true
