#!/bin/sh
set -eu

secret_pattern='(-----BEGIN ([A-Z ]+ )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|(TOKEN|SECRET|PASSWORD|API_KEY)[[:space:]]*=[[:space:]]*[^<[:space:]][^[:space:]]*)'

check_paths() {
  paths=$1
  context=$2
  for path in $paths; do
    case "$path" in
      *.env|*.pem|*.key|*credentials*|*private-vault*|*hermes-profile*|*backup.tar*)
        echo "Disallowed secret/private file in $context: $path" >&2
        exit 1
        ;;
    esac
  done
}

check_matches() {
  matches=$1
  context=$2
  unsafe=$(printf '%s\n' "$matches" | grep -Eiv '(fictional|placeholder|example\.test)' || true)
  if [ -n "$unsafe" ]; then
    printf '%s\n' "$unsafe" >&2
    echo "Potential secret material found in $context." >&2
    exit 1
  fi
}

tracked_files=$(git ls-files)
check_paths "$tracked_files" "the tracked tree"

matches=$(git grep -nE \
  "$secret_pattern" \
  -- ':!pnpm-lock.yaml' ':!*.example' || true)
check_matches "$matches" "the tracked tree"

echo "No tracked secret material detected."

if [ "${1:-}" = "--history" ]; then
  for revision in $(git rev-list --all); do
    short_revision=$(git rev-parse --short "$revision")
    historical_files=$(git ls-tree -r --name-only "$revision")
    check_paths "$historical_files" "Git revision $short_revision"
    historical_matches=$(git grep -nE \
      "$secret_pattern" "$revision" -- \
      ':!pnpm-lock.yaml' ':!*.example' || true)
    check_matches "$historical_matches" "Git revision $short_revision"
  done
  echo "No secret material detected in complete Git history."
elif [ "$#" -gt 0 ]; then
  echo "Usage: $0 [--history]" >&2
  exit 2
fi
