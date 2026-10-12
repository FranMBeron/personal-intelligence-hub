#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <previous-40-character-git-sha>" >&2
  exit 64
fi
release_sha=$1
case "$release_sha" in *[!0-9a-f]*|'') exit 64 ;; esac
if [ "${#release_sha}" -ne 40 ]; then exit 64; fi

pih_root=${PIH_ROOT:-/srv/personal-intelligence-hub}
compose_project=${PIH_COMPOSE_PROJECT:-personal-intelligence-hub}
release_directory="$pih_root/releases/$release_sha"
release_environment="$pih_root/config/releases/$release_sha.compose.env"
compose_file="$release_directory/infrastructure/docker/compose.production.yaml"
release_manifest="$release_directory/release-manifest.json"

for required_file in "$release_environment" "$compose_file" "$release_manifest"; do
  [ -f "$required_file" ] || { echo "Rollback input is missing: $required_file" >&2; exit 1; }
done
if [ "$(jq -r '.gitSha' "$release_manifest")" != "$release_sha" ]; then
  echo "Rollback manifest does not match the requested release." >&2
  exit 1
fi

docker compose \
  --project-name "$compose_project" \
  --env-file "$release_environment" \
  --file "$compose_file" \
  up --detach --wait --remove-orphans

web_port=$(awk -F= '$1 == "PIH_WEB_PORT" { value=$2 } END { print value }' \
  "$release_environment")
web_port=${web_port:-3000}
curl --fail --silent --show-error --max-time 10 \
  "http://127.0.0.1:$web_port/health" > /dev/null

current_temporary="$pih_root/.rollback-current.$release_sha.$$"
environment_link_temporary="$pih_root/config/.rollback-compose.$release_sha.$$"
ln -s "$release_directory" "$current_temporary"
ln -s "$release_environment" "$environment_link_temporary"
mv -Tf "$current_temporary" "$pih_root/current"
mv -Tf "$environment_link_temporary" "$pih_root/config/current-compose.env"

echo "Rolled application images back to $release_sha. Database state was not changed."
