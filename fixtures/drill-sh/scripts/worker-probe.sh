#!/bin/sh
# Explicit, versioned drill script (a manifest input). Pure POSIX sh: runs on a minimal guest.
set -eu
: "${HC_RELEASE:?}" "${HC_STATE:?}"
export NOTES_HOME="$HC_STATE/notes" NOTES_CREDENTIAL_DIR="$HC_STATE"
SVC="$HC_RELEASE/bin/notes.sh"
sh "$SVC" worker-probe
