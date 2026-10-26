#!/bin/sh
set -eu
umask 077

pih_root=${PIH_ROOT:-/srv/personal-intelligence-hub}
compose_project=${PIH_COMPOSE_PROJECT:-personal-intelligence-hub}
backup_root="$pih_root/backups"
compose_file="$pih_root/current/infrastructure/docker/compose.production.yaml"
compose_environment="$pih_root/config/current-compose.env"
release_manifest="$pih_root/current/release-manifest.json"
include_file="$pih_root/config/backup-include.txt"
script_directory=$(CDPATH= cd "$(dirname "$0")" && pwd)
restic_bin=${RESTIC_BIN:-restic}

for required_file in "$compose_file" "$compose_environment" "$release_manifest"; do
  if [ ! -f "$required_file" ]; then
    echo "Required backup input is missing: $required_file" >&2
    exit 1
  fi
done
mkdir -p "$backup_root"
chmod 700 "$backup_root"

exec 9>"$backup_root/.backup.lock"
if ! flock -n 9; then
  echo "Another Personal Intelligence Hub backup is already running." >&2
  exit 75
fi

staging_directory=$(mktemp -d "$backup_root/staging.XXXXXX")
trap 'rm -rf "$staging_directory"' EXIT HUP INT TERM

compose() {
  docker compose \
    --project-name "$compose_project" \
    --env-file "$compose_environment" \
    --file "$compose_file" \
    "$@"
}

restic() {
  command "$restic_bin" "$@"
}

release_sha=$(jq -er '.gitSha | select(test("^[0-9a-f]{40}$"))' "$release_manifest")
cp "$release_manifest" "$staging_directory/release-manifest.json"
compose config --images > "$staging_directory/image-references.unsorted"
sort -u "$staging_directory/image-references.unsorted" \
  > "$staging_directory/image-references.txt"
rm -f "$staging_directory/image-references.unsorted"
: > "$staging_directory/image-inspect.ndjson"
while IFS= read -r image_reference; do
  [ -n "$image_reference" ] || continue
  docker image inspect "$image_reference" >> "$staging_directory/image-inspect.ndjson"
done < "$staging_directory/image-references.txt"
jq -s 'flatten' "$staging_directory/image-inspect.ndjson" \
  > "$staging_directory/image-manifests.json"
rm -f "$staging_directory/image-inspect.ndjson"

compose exec -T postgres sh -eu -c \
  'pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --format=custom --no-owner --file=-' \
  > "$staging_directory/postgres.dump"
compose exec -T postgres pg_restore --list \
  < "$staging_directory/postgres.dump" > /dev/null

if [ -f "$include_file" ]; then
  while IFS= read -r config_path; do
    case "$config_path" in
      ''|'#'*) continue ;;
      "$pih_root/config/"*) ;;
      *)
        echo "Backup include escapes the configuration directory: $config_path" >&2
        exit 1
        ;;
    esac
    case "$config_path" in
      *.env|*secret*|*password*|*token*|*credential*)
        echo "Refusing to back up secret-bearing configuration: $config_path" >&2
        exit 1
        ;;
    esac
    relative_path=${config_path#"$pih_root/config/"}
    target_path="$staging_directory/config/$relative_path"
    mkdir -p "$(dirname "$target_path")"
    cp -p "$config_path" "$target_path"
  done < "$include_file"
fi

RESTIC_BIN="$restic_bin" "$script_directory/restic-lock-guard.sh" --repair
restic backup "$staging_directory" \
  --tag personal-intelligence-hub \
  --tag "$release_sha"

# Retention is part of backup success: a snapshot followed by failed retention
# must leave this service failed so its OnFailure alert fires.
restic forget \
  --tag personal-intelligence-hub \
  --keep-daily "${PIH_BACKUP_KEEP_DAILY:-7}" \
  --keep-weekly "${PIH_BACKUP_KEEP_WEEKLY:-5}" \
  --keep-monthly "${PIH_BACKUP_KEEP_MONTHLY:-12}" \
  --prune
restic check
restic snapshots --latest 1 --tag personal-intelligence-hub --json \
  > "$backup_root/last-successful-snapshot.json"

echo "Personal Intelligence Hub backup and retention completed for $release_sha."
