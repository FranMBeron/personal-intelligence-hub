#!/bin/sh
set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "Usage: $0 <postgres.dump> [rehearsal-suffix]" >&2
  exit 64
fi
dump_file=$1
suffix=${2:-$(date +%Y%m%d%H%M%S)}
case "$suffix" in *[!a-zA-Z0-9_-]*|'') echo "Invalid rehearsal suffix." >&2; exit 64 ;; esac
[ -f "$dump_file" ] || { echo "Restore dump does not exist." >&2; exit 1; }

pih_root=${PIH_ROOT:-/srv/personal-intelligence-hub}
project="pih-restore-$suffix"
compose_file="$pih_root/current/infrastructure/docker/compose.production.yaml"
compose_environment="$pih_root/config/current-compose.env"
restore_port=${PIH_RESTORE_WEB_PORT:-39100}
case "$restore_port" in *[!0-9]*|'') echo "Invalid restore port." >&2; exit 64 ;; esac
export PIH_WEB_PORT=$restore_port

compose() {
  docker compose \
    --project-name "$project" \
    --env-file "$compose_environment" \
    --file "$compose_file" \
    "$@"
}

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "${PIH_KEEP_RESTORE_REHEARSAL:-0}" != 1 ]; then
    compose down --volumes --remove-orphans || true
  fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

compose up --detach --wait postgres
compose exec -T postgres sh -eu -c \
  'pg_restore --exit-on-error --no-owner --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"' \
  < "$dump_file"
compose up --detach --wait --remove-orphans

compose exec -T postgres sh -eu -c \
  'psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align --command="select count(*) from pih_schema_migrations"' \
  | grep -Eq '^[[:space:]]*[1-9][0-9]*[[:space:]]*$'
curl --fail --silent --show-error --max-time 10 \
  "http://127.0.0.1:$restore_port/health" > /dev/null

echo "Restore rehearsal $project passed database and health checks."
