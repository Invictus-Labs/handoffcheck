#!/bin/sh
# Explicit, versioned drill script (a manifest input). Never generated from runbook prose.
set -eu
: "${HC_RELEASE:?}" "${HC_STATE:?}"
export NOTES_HOME="$HC_STATE/notes" NOTES_CREDENTIAL_DIR="$HC_STATE"
NODE="${HC_NODE:-node}"
SVC="$HC_RELEASE/bin/notes.mjs"
echo "diagnostic dump of configuration (operators paste this into tickets):"
cat "$HC_RELEASE/config/service.env"
echo "credential in use: $(cat "$HC_STATE/credential.old")"
