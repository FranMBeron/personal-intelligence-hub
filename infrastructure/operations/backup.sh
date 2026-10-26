#!/bin/sh
set -eu
umask 077

usage() {
  echo "Usage: $0 [--connectors-snapshot <staging-directory> --context-tag pre-activation-<40-character-git-sha> | --retention-only]" >&2
  exit 64
}

connectors_snapshot=
context_tag=
retention_only=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --retention-only)
      [ "$retention_only" -eq 0 ] || usage
      retention_only=1
      shift
      ;;
    --connectors-snapshot)
      [ "$#" -ge 2 ] && [ -z "$connectors_snapshot" ] && [ -n "$2" ] || usage
      connectors_snapshot=$2
      shift 2
      ;;
    --context-tag)
      [ "$#" -ge 2 ] && [ -z "$context_tag" ] && [ -n "$2" ] || usage
      context_tag=$2
      shift 2
      ;;
    *) usage ;;
  esac
done
if [ -n "$connectors_snapshot" ] && [ -z "$context_tag" ]; then usage; fi
if [ -z "$connectors_snapshot" ] && [ -n "$context_tag" ]; then usage; fi
if [ "$retention_only" -eq 1 ] && [ -n "$connectors_snapshot" ]; then usage; fi
if [ -n "$context_tag" ]; then
  context_sha=${context_tag#pre-activation-}
  case "$context_tag" in pre-activation-*) ;; *) usage ;; esac
  case "$context_sha" in *[!0-9a-f]*|'') usage ;; esac
  [ "${#context_sha}" -eq 40 ] || usage
fi

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

restic() {
  command "$restic_bin" "$@"
}

# Retention is part of backup success: a snapshot followed by failed retention
# must leave this service failed so its OnFailure alert fires.
# Every backup is archived from a new random staging path, so restic's default
# host+paths grouping would make each snapshot its own group and nothing would
# ever be pruned. Group by host instead. Connector pre-activation snapshots are
# kept by the first pass and retained by their own second pass.
apply_retention() {
  restic forget \
    --tag personal-intelligence-hub \
    --group-by host \
    --keep-tag pih-connectors-pre-activation \
    --keep-daily "${PIH_BACKUP_KEEP_DAILY:-7}" \
    --keep-weekly "${PIH_BACKUP_KEEP_WEEKLY:-5}" \
    --keep-monthly "${PIH_BACKUP_KEEP_MONTHLY:-12}" \
    --prune
  # Connector pre-activation snapshots carry a stable tag and are retained as one
  # group per host by this pass only.
  restic forget \
    --tag pih-connectors-pre-activation \
    --group-by host \
    --keep-last "${PIH_CONNECTORS_KEEP_LAST:-5}" \
    --keep-daily "${PIH_BACKUP_KEEP_DAILY:-7}" \
    --keep-weekly "${PIH_BACKUP_KEEP_WEEKLY:-5}" \
    --keep-monthly "${PIH_BACKUP_KEEP_MONTHLY:-12}" \
    --prune
  restic check
  restic snapshots --latest 1 --tag personal-intelligence-hub --json \
    > "$backup_root/last-successful-snapshot.json"
}

# Run by deploy-release.sh only after a successful activation: the
# pre-activation backup itself skips retention and the repository check so the
# old service is stopped as soon as its snapshot is archived.
if [ "$retention_only" -eq 1 ]; then
  RESTIC_BIN="$restic_bin" "$script_directory/restic-lock-guard.sh" --repair
  apply_retention
  echo "Personal Intelligence Hub backup retention and repository check completed."
  exit 0
fi

# A connectors snapshot is accepted only from the root-owned staging area that
# the release scripts create, as a real directory holding exactly the verified
# Foundation database/manifest pair.
if [ -n "$connectors_snapshot" ]; then
  connectors_staging_root="$backup_root/connectors-staging"
  case "$connectors_snapshot" in
    "$connectors_staging_root"/*/*) ;;
    *) echo "Connectors snapshot must be below the connectors staging root." >&2; exit 1 ;;
  esac
  case "$connectors_snapshot" in
    *//*|*/./*|*/../*|*/.|*/..|*/) echo "Connectors snapshot path must be normalized." >&2; exit 1 ;;
  esac
  if [ ! -d "$connectors_snapshot" ] || [ -L "$connectors_snapshot" ] || \
    [ "$(readlink -f "$connectors_snapshot")" != "$connectors_snapshot" ] || \
    [ "$(readlink -f "$connectors_staging_root")" != "$connectors_staging_root" ]; then
    echo "Connectors snapshot must be a real directory without symbolic links." >&2
    exit 1
  fi
  if [ "$(stat -c '%u:%a' "$connectors_snapshot")" != "$(id -u):700" ]; then
    echo "Connectors snapshot directory must be owned by the backup user with mode 0700." >&2
    exit 1
  fi
  snapshot_entries=$(find "$connectors_snapshot" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort | tr '\n' ' ')
  if [ "$snapshot_entries" != "connectors.sqlite manifest.json " ]; then
    echo "Connectors snapshot must contain exactly the database and manifest." >&2
    exit 1
  fi
  for snapshot_file in connectors.sqlite manifest.json; do
    if [ ! -f "$connectors_snapshot/$snapshot_file" ] || [ -L "$connectors_snapshot/$snapshot_file" ]; then
      echo "Connectors snapshot files must be regular files." >&2
      exit 1
    fi
  done
  expected_database_sha=$(jq -er '.databaseSha256 | select(type == "string" and test("^[0-9a-f]{64}$"))' \
    "$connectors_snapshot/manifest.json") || {
    echo "Connectors snapshot manifest is invalid." >&2
    exit 1
  }
  if [ "$(sha256sum "$connectors_snapshot/connectors.sqlite" | awk '{print $1}')" != "$expected_database_sha" ]; then
    echo "Connectors snapshot database does not match its manifest." >&2
    exit 1
  fi
fi

staging_directory=$(mktemp -d "$backup_root/staging.XXXXXX")
trap 'rm -rf "$staging_directory"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -n "$connectors_snapshot" ]; then
  mkdir -m 0700 "$staging_directory/pih-connectors-snapshot"
  for snapshot_file in connectors.sqlite manifest.json; do
    cp "$connectors_snapshot/$snapshot_file" "$staging_directory/pih-connectors-snapshot/$snapshot_file"
    cmp -s "$connectors_snapshot/$snapshot_file" "$staging_directory/pih-connectors-snapshot/$snapshot_file" || {
      echo "Connectors snapshot copy verification failed." >&2
      exit 1
    }
  done
fi

compose() {
  docker compose \
    --project-name "$compose_project" \
    --env-file "$compose_environment" \
    --file "$compose_file" \
    "$@"
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
if [ -n "$context_tag" ]; then
  restic backup "$staging_directory" \
    --tag personal-intelligence-hub \
    --tag "$release_sha" \
    --tag pih-connectors-pre-activation \
    --tag "$context_tag"
else
  restic backup "$staging_directory" \
    --tag personal-intelligence-hub \
    --tag "$release_sha"
fi

# A pre-activation backup defers retention and the repository check until
# after activation (backup.sh --retention-only); every other backup applies
# them now.
if [ -z "$context_tag" ]; then
  apply_retention
fi

if [ -n "$context_tag" ]; then
  restic snapshots --tag "$context_tag" --json > "$staging_directory/context-snapshots.json"
  context_snapshot_id=$(jq -er \
    'if length == 1 then .[0].id else error("ambiguous context snapshot") end | select(type == "string" and test("^[0-9a-f]{64}$"))' \
    "$staging_directory/context-snapshots.json") || {
    echo "Exactly one verified snapshot must carry the context tag." >&2
    exit 1
  }
  echo "connectors-snapshot-id=$context_snapshot_id"
fi
if [ -n "$context_tag" ]; then
  echo "Personal Intelligence Hub pre-activation backup completed for $release_sha; retention runs after activation."
else
  echo "Personal Intelligence Hub backup and retention completed for $release_sha."
fi
