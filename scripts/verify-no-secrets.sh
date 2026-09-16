#!/bin/sh
set -eu

tracked_files=$(git ls-files)
for path in $tracked_files; do
  case "$path" in
    *.env|*.pem|*.key|*credentials*|*private-vault*|*hermes-profile*|*backup.tar*)
      echo "Disallowed tracked secret/private file: $path" >&2
      exit 1
      ;;
  esac
done

matches=$(git grep -nE \
  '(-----BEGIN ([A-Z ]+ )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|(TOKEN|SECRET|PASSWORD|API_KEY)[[:space:]]*=[[:space:]]*[^<[:space:]][^[:space:]]*)' \
  -- ':!pnpm-lock.yaml' ':!*.test.ts' ':!*.example' || true)
unsafe=$(printf '%s\n' "$matches" | grep -Eiv '(fictional|placeholder|example\.test)' || true)
if [ -n "$unsafe" ]; then
  printf '%s\n' "$unsafe" >&2
  echo "Potential secret material found." >&2
  exit 1
fi

echo "No tracked secret material detected."
