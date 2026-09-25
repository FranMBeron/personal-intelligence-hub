#!/bin/sh
set -eu

mode=check
if [ "${1:-}" = "--repair" ]; then
  mode=repair
elif [ "$#" -gt 0 ]; then
  echo "Usage: $0 [--repair]" >&2
  exit 64
fi

restic_bin=${RESTIC_BIN:-restic}
lock_timeout=${RESTIC_STALE_LOCK_SECONDS:-21600}
current_host=${RESTIC_HOSTNAME:-$(hostname)}
current_time=${RESTIC_NOW_EPOCH:-$(date +%s)}
locks_file=$(mktemp)
lock_rows=$(mktemp)
trap 'rm -f "$locks_file" "$lock_rows"' EXIT HUP INT TERM

"$restic_bin" list locks --json > "$locks_file"
lock_count=$(jq 'length' "$locks_file")
if [ "$lock_count" -eq 0 ]; then
  exit 0
fi

jq -r '.[] | [.hostname, ((.pid // 0) | tostring), .time] | @tsv' \
  "$locks_file" > "$lock_rows"

unsafe_lock=0
proven_orphans=0
tab=$(printf '\t')
while IFS="$tab" read -r lock_host lock_pid lock_time; do
  case "$lock_pid" in
    ''|*[!0-9]*|0)
      unsafe_lock=1
      continue
      ;;
  esac
  if [ "$lock_host" != "$current_host" ]; then
    unsafe_lock=1
    continue
  fi
  if kill -0 "$lock_pid" 2>/dev/null; then
    unsafe_lock=1
    continue
  fi
  if ! lock_epoch=$(date -d "$lock_time" +%s 2>/dev/null); then
    unsafe_lock=1
    continue
  fi
  lock_age=$((current_time - lock_epoch))
  if [ "$lock_age" -lt "$lock_timeout" ]; then
    unsafe_lock=1
    continue
  fi
  proven_orphans=$((proven_orphans + 1))
done < "$lock_rows"

if [ "$unsafe_lock" -ne 0 ] || [ "$proven_orphans" -ne "$lock_count" ]; then
  echo "Restic has an active, recent, remote, or malformed lock; refusing unlock." >&2
  exit 2
fi

if [ "$mode" = check ]; then
  echo "Restic has $proven_orphans proven old local orphan lock(s)." >&2
  exit 3
fi

"$restic_bin" unlock
"$restic_bin" list locks --json > "$locks_file"
if [ "$(jq 'length' "$locks_file")" -ne 0 ]; then
  echo "Restic still has locks after the guarded unlock." >&2
  exit 2
fi

echo "Removed $proven_orphans proven old local orphan lock(s)."
