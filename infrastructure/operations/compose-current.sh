#!/bin/sh
set -eu

pih_root=${PIH_ROOT:-/srv/personal-intelligence-hub}
compose_project=${PIH_COMPOSE_PROJECT:-personal-intelligence-hub}
compose_file="$pih_root/current/infrastructure/docker/compose.production.yaml"
compose_environment="$pih_root/config/current-compose.env"

if [ ! -f "$compose_file" ] || [ ! -f "$compose_environment" ]; then
  echo "Current release or Compose environment is missing." >&2
  exit 1
fi

exec docker compose \
  --project-name "$compose_project" \
  --env-file "$compose_environment" \
  --file "$compose_file" \
  "$@"
