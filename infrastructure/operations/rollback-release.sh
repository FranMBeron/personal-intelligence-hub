#!/bin/sh
set -eu
umask 077

usage() {
  echo "Usage: $0 [--restore-connectors-snapshot] <previous-40-character-git-sha>" >&2
  exit 64
}
restore_connectors_snapshot=0
if [ "$#" -eq 2 ] && [ "$1" = "--restore-connectors-snapshot" ]; then
  restore_connectors_snapshot=1
  shift
fi
[ "$#" -eq 1 ] || usage
release_sha=$1
case "$release_sha" in *[!0-9a-f]*|'') usage ;; esac
if [ "${#release_sha}" -ne 40 ]; then usage; fi

pih_root=${PIH_ROOT:-/srv/personal-intelligence-hub}
connectors_root=${PIH_CONNECTORS_ROOT:-/opt/pih-connectors}
compose_project=${PIH_COMPOSE_PROJECT:-personal-intelligence-hub}
connectors_service=personal-intelligence-hub-connectors.service
release_directory="$pih_root/releases/$release_sha"
release_environment="$pih_root/config/releases/$release_sha.compose.env"
compose_file="$release_directory/infrastructure/docker/compose.production.yaml"
release_manifest="$release_directory/release-manifest.json"
connectors_current="$connectors_root/current"
connectors_database=${PIH_CONNECTORS_DATABASE_PATH:-/var/lib/pih-connectors/connectors.sqlite}
connectors_environment_file=${PIH_CONNECTORS_ENV_FILE:-/etc/pih-connectors/connectors.env}
connectors_node=${PIH_CONNECTORS_NODE:-/usr/bin/node}
connectors_staging_root="$pih_root/backups/connectors-staging"
connectors_staging=
database_quarantined=0
database_quarantine=
application_rollout_started=0
application_pointer_update_started=0
connectors_rollout_started=0
rollback_succeeded=0

mkdir -p "$pih_root"
exec 9>"$pih_root/.deployment.lock"
if ! flock -n 9; then
  echo "Another deployment or rollback is already running." >&2
  exit 75
fi
previous_release=$(if [ -L "$pih_root/current" ]; then readlink -f "$pih_root/current" 2>/dev/null || true; fi)
previous_environment=$(if [ -L "$pih_root/config/current-compose.env" ]; then readlink -f "$pih_root/config/current-compose.env" 2>/dev/null || true; fi)
previous_connectors_runtime=$(if [ -L "$connectors_current" ]; then readlink -f "$connectors_current" 2>/dev/null || true; fi)

for command_name in docker jq curl node systemctl flock stat; do
  command -v "$command_name" > /dev/null 2>&1 || {
    echo "Required rollback command is missing: $command_name" >&2
    exit 1
  }
done
for required_file in "$release_environment" "$compose_file" "$release_manifest"; do
  [ -f "$required_file" ] || { echo "Rollback input is missing: $required_file" >&2; exit 1; }
done
if [ "$(jq -r '.gitSha' "$release_manifest")" != "$release_sha" ]; then
  echo "Rollback manifest does not match the requested release." >&2
  exit 1
fi
connectors_runtime=$(jq -r '.connectors.runtimeDirectory // empty' "$release_manifest")
if [ -n "$connectors_runtime" ]; then
  expected_connectors_runtime="$connectors_root/releases/$release_sha"
  if [ "$connectors_runtime" != "$expected_connectors_runtime" ]; then
    echo "Rollback connectors runtime does not match the requested release." >&2
    exit 1
  fi
  target_connectors_enabled=$(jq -er '.connectors.enabled' "$release_manifest")
  target_connectors_active=$(jq -er '.connectors.active' "$release_manifest")
else
  if [ -z "$previous_release" ] || [ ! -f "$previous_release/release-manifest.json" ]; then
    echo "Rollback release has no connectors metadata and no active release can supply its predecessor state." >&2
    exit 1
  fi
  active_manifest="$previous_release/release-manifest.json"
  previous_release_sha=$(jq -r '.connectors.previousReleaseSha // empty' "$active_manifest")
  if [ "$release_sha" != "$previous_release_sha" ]; then
    echo "Rollback target is not the immediate predecessor recorded by the active connectors release." >&2
    exit 1
  fi
  connectors_runtime=$(jq -r '.connectors.previousConnectorsRuntime // empty' "$active_manifest")
  target_connectors_enabled=$(jq -er '.connectors.previousConnectorsEnabled' "$active_manifest")
  target_connectors_active=$(jq -er '.connectors.previousConnectorsActive' "$active_manifest")
fi
if [ -n "$connectors_runtime" ]; then
  case "$connectors_runtime" in
    "$connectors_root"/releases/[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
      ;;
    *) echo "Rollback connectors runtime path is outside the managed release directory." >&2; exit 1 ;;
  esac
  if [ ! -f "$connectors_runtime/dist/src/main.js" ] || \
    [ ! -d "$connectors_runtime/dist/src/migrations" ]; then
    echo "Rollback connectors runtime is missing or does not match release metadata." >&2
    exit 1
  fi
fi

active_connectors_manifest=-
if [ -n "$previous_release" ] && [ -f "$previous_release/release-manifest.json" ]; then
  active_connectors_manifest="$previous_release/release-manifest.json"
fi
migration_policy_script="$release_directory/infrastructure/operations/check-connectors-migration-baseline.mjs"
if [ -n "$previous_release" ] && \
  [ -f "$previous_release/infrastructure/operations/check-connectors-migration-baseline.mjs" ]; then
  migration_policy_script="$previous_release/infrastructure/operations/check-connectors-migration-baseline.mjs"
fi
if [ -f "$migration_policy_script" ]; then
  node "$migration_policy_script" rollback /dev/null "$active_connectors_manifest" "$release_manifest" "$target_connectors_active"
elif [ -n "$previous_release" ] && \
  [ "$(jq -r '.connectors.migrationHistoryFormatVersion // 0' "$active_connectors_manifest")" -eq 1 ] && \
  [ "$(jq -r '.connectors.migrations | length' "$active_connectors_manifest")" -gt 1 ]; then
  echo "Active provider migration history requires the migration baseline policy helper." >&2
  exit 1
fi

deployer_environment=${CONNECTORS_DEPLOYER_ENV_FILE:-$pih_root/secrets/connectors-deployer.env}
if [ ! -f "$deployer_environment" ] || [ "$(stat -c '%u:%a' "$deployer_environment" 2>/dev/null || true)" != "0:600" ]; then
  echo "Root-only connectors deployer credentials are missing or have unsafe permissions." >&2
  exit 1
fi
. "$deployer_environment"
export CONNECTORS_DEPLOYER_SERVICE_TOKEN CONNECTORS_DEPLOYER_ISSUER
export CONNECTORS_DEPLOYER_SIGNING_KEY CONNECTORS_DEPLOYER_ACTOR_ID
CONNECTORS_SOCKET_PATH=/run/pih-connectors/web/connectors.sock
export CONNECTORS_SOCKET_PATH
previous_connectors_enabled=$(systemctl is-enabled "$connectors_service" 2>/dev/null || true)
previous_connectors_active=$(systemctl is-active "$connectors_service" 2>/dev/null || true)
[ -n "$previous_connectors_enabled" ] || previous_connectors_enabled=not-found
[ -n "$previous_connectors_active" ] || previous_connectors_active=inactive

# Explicit, operator-approved data rollback: every precondition is proven
# before any service is stopped.
refuse_snapshot_restore() {
  echo "$1 No service was stopped." >&2
  exit 1
}
if [ "$restore_connectors_snapshot" -eq 1 ]; then
  active_release_sha=
  if [ -n "$previous_release" ]; then active_release_sha=$(basename "$previous_release"); fi
  active_manifest_file="$previous_release/release-manifest.json"
  if [ -z "$active_release_sha" ] || [ ! -f "$active_manifest_file" ]; then
    refuse_snapshot_restore "No active release metadata records a connectors snapshot."
  fi
  if [ "$release_sha" = "$active_release_sha" ]; then
    refuse_snapshot_restore "Cannot restore a connectors snapshot while rolling back to the current release."
  fi
  if [ "$(jq -r '.gitSha // empty' "$active_manifest_file")" != "$active_release_sha" ] || \
    [ "$(jq -r '.connectors.previousReleaseSha // empty' "$active_manifest_file")" != "$release_sha" ]; then
    refuse_snapshot_restore "The recorded connectors snapshot does not belong to the requested release."
  fi
  snapshot_id=$(jq -er '.connectors.preActivationSnapshot.resticSnapshotId | select(type == "string" and test("^[0-9a-f]{64}$"))' \
    "$active_manifest_file") || refuse_snapshot_restore "Active release has no recorded connectors pre-activation snapshot."
  snapshot_manifest_sha256=$(jq -er '.connectors.preActivationSnapshot.manifestSha256 | select(type == "string" and test("^[0-9a-f]{64}$"))' \
    "$active_manifest_file") || refuse_snapshot_restore "Active release has no recorded connectors pre-activation snapshot."
  if [ -z "$connectors_runtime" ] || [ ! -f "$connectors_runtime/dist/src/operations/restore-command.js" ]; then
    refuse_snapshot_restore "Rollback target runtime has no connectors restore adapter."
  fi
  if [ ! -f "$connectors_database" ] || [ -L "$connectors_database" ]; then
    refuse_snapshot_restore "Current connectors database is missing or not a regular file."
  fi
  for required_file in "$connectors_environment_file" "$pih_root/secrets/restic.env"; do
    [ -f "$required_file" ] || refuse_snapshot_restore "Connectors restore input is missing: $required_file."
  done
  command -v systemd-run > /dev/null 2>&1 || refuse_snapshot_restore "Required rollback command is missing: systemd-run."
  restic_path=$(command -v "${RESTIC_BIN:-restic}" 2>/dev/null || true)
  case "$restic_path" in /*) ;; *) refuse_snapshot_restore "Required rollback command is missing: restic." ;; esac
  echo "WARNING: --restore-connectors-snapshot replaces the current connectors database with the pre-activation snapshot recorded by release $active_release_sha. Changes made since that activation are not merged; the current database is quarantined, not deleted." >&2
fi

run_transient() {
  systemd-run --quiet --wait --pipe --collect --service-type=exec -p UMask=0077 "$@" < /dev/null
}

restore_database_ownership() {
  for database_file in "$connectors_database" "$connectors_database-wal" "$connectors_database-shm"; do
    if [ -f "$database_file" ] && [ ! -L "$database_file" ]; then
      chown "$connectors_database_owner" "$database_file" || return 1
    fi
  done
}

# Undo a snapshot restore: keep the restored copy aside and move the
# quarantined current database back. Nothing is deleted.
put_back_current_database() {
  if [ "$(systemctl is-active "$connectors_service" 2>/dev/null || true)" = active ]; then return 1; fi
  rejected="$connectors_database.rejected-restore-$release_sha-$(date -u +%Y%m%dT%H%M%SZ)"
  for suffix in "" -wal -shm; do
    if [ -e "$rejected$suffix" ] || [ -L "$rejected$suffix" ]; then return 1; fi
  done
  for suffix in "" -wal -shm; do
    if [ -e "$connectors_database$suffix" ] || [ -L "$connectors_database$suffix" ]; then
      mv -T "$connectors_database$suffix" "$rejected$suffix" || return 1
    fi
  done
  for suffix in "" -wal -shm; do
    if [ -e "$database_quarantine$suffix" ]; then
      mv -T "$database_quarantine$suffix" "$connectors_database$suffix" || return 1
    fi
  done
  echo "Current connectors database put back; the rejected restored copy is kept at $rejected." >&2
}

restore_application_pointers() {
  if [ -n "$previous_release" ]; then
    current_restore="$pih_root/.rollback-current-restore.$release_sha.$$"
    ln -s "$previous_release" "$current_restore" || return 1
    mv -Tf "$current_restore" "$pih_root/current" || return 1
  else
    rm -f "$pih_root/current" || return 1
  fi
  if [ -n "$previous_environment" ]; then
    environment_restore="$pih_root/config/.rollback-compose-restore.$release_sha.$$"
    ln -s "$previous_environment" "$environment_restore" || return 1
    mv -Tf "$environment_restore" "$pih_root/config/current-compose.env" || return 1
  else
    rm -f "$pih_root/config/current-compose.env" || return 1
  fi
}

restore_connectors_state() {
  if [ -n "$previous_connectors_runtime" ]; then
    current_temporary="$connectors_root/.current-restore.$release_sha.$$"
    ln -s "$previous_connectors_runtime" "$current_temporary" || return 1
    mv -Tf "$current_temporary" "$connectors_current" || return 1
  else
    rm -f "$connectors_current" || return 1
  fi
  case "$previous_connectors_enabled" in
    enabled|enabled-runtime|linked|linked-runtime) systemctl enable "$connectors_service" || return 1 ;;
    masked|masked-runtime) systemctl mask "$connectors_service" || return 1 ;;
    disabled|static|indirect|generated|transient|not-found) systemctl disable "$connectors_service" || return 1 ;;
    *) echo "Cannot restore prior connectors enabled state: $previous_connectors_enabled" >&2; return 1 ;;
  esac
  if [ "$previous_connectors_active" = active ]; then
    systemctl restart "$connectors_service" || return 1
    node "$release_directory/infrastructure/operations/check-connectors-readiness.mjs" || return 1
  else
    systemctl stop "$connectors_service" || return 1
  fi
}
rollback_failure() {
  status=$?
  trap - EXIT HUP INT TERM
  set +e
  if [ "$status" -ne 0 ] && [ "$rollback_succeeded" -eq 0 ]; then
    if [ "$connectors_rollout_started" -eq 1 ]; then
      echo "Deployment failed; restoring previous connectors service." >&2
      systemctl stop "$connectors_service" || true
      if [ "$database_quarantined" -eq 1 ]; then
        if put_back_current_database; then
          restore_connectors_state || echo "Previous connectors service restore failed." >&2
        else
          echo "reason=connectors_database_putback_failed: connectors left stopped; the quarantined database at $database_quarantine is preserved; operator intervention required." >&2
        fi
      else
        restore_connectors_state || echo "Previous connectors service restore failed." >&2
      fi
    fi
    if [ "$application_pointer_update_started" -eq 1 ]; then
      restore_application_pointers || echo "Previous application pointers could not be restored." >&2
    fi
    if [ "$application_rollout_started" -eq 1 ] && \
      [ -n "$previous_release" ] && [ -f "$previous_release/infrastructure/docker/compose.production.yaml" ] && \
      [ -n "$previous_environment" ] && [ -f "$previous_environment" ]; then
      docker compose --project-name "$compose_project" --env-file "$previous_environment" \
        --file "$previous_release/infrastructure/docker/compose.production.yaml" \
        up --detach --wait --remove-orphans || echo "Previous application restore failed." >&2
    fi
  fi
  if [ -n "$connectors_staging" ]; then
    rm -rf -- "$connectors_staging" || echo "Connectors staging cleanup failed." >&2
  fi
  exit "$status"
}
trap rollback_failure EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$restore_connectors_snapshot" -eq 1 ]; then
  mkdir -p "$connectors_staging_root"
  chmod 700 "$pih_root/backups" "$connectors_staging_root"
  connectors_staging=$(mktemp -d "$connectors_staging_root/rollback.XXXXXX")
  run_transient -p "EnvironmentFile=$pih_root/secrets/restic.env" -- \
    "$restic_path" restore "$snapshot_id" --target "$connectors_staging/restic" \
    --include pih-connectors-snapshot >&2 || refuse_snapshot_restore "Connectors snapshot retrieval from Restic failed."
  snapshot_directory=$(find "$connectors_staging/restic" -type d -name pih-connectors-snapshot)
  if [ -z "$snapshot_directory" ] || [ "$(printf '%s\n' "$snapshot_directory" | wc -l)" -ne 1 ]; then
    refuse_snapshot_restore "Restic snapshot does not contain exactly one connectors snapshot."
  fi
  if [ "$(find "$snapshot_directory" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort | tr '\n' ' ')" != "connectors.sqlite manifest.json " ] || \
    [ ! -f "$snapshot_directory/connectors.sqlite" ] || [ -L "$snapshot_directory/connectors.sqlite" ] || \
    [ ! -f "$snapshot_directory/manifest.json" ] || [ -L "$snapshot_directory/manifest.json" ]; then
    refuse_snapshot_restore "Retrieved connectors snapshot must contain exactly the database and manifest."
  fi
  if [ "$(sha256sum "$snapshot_directory/manifest.json" | awk '{print $1}')" != "$snapshot_manifest_sha256" ]; then
    refuse_snapshot_restore "Retrieved connectors manifest checksum does not match the release metadata."
  fi
  # Full verification (checksum, key versions, migrations, integrity) through
  # the target runtime's adapter into a scratch target before any service stops.
  mkdir -m 0700 "$connectors_staging/verify"
  run_transient -p "EnvironmentFile=$connectors_environment_file" -- \
    "$connectors_node" "$connectors_runtime/dist/src/operations/restore-command.js" \
    --backup "$snapshot_directory/connectors.sqlite" --manifest "$snapshot_directory/manifest.json" \
    --target "$connectors_staging/verify/connectors.sqlite" >&2 || \
    refuse_snapshot_restore "Connectors snapshot verification failed."
  connectors_database_owner=$(stat -c '%u:%g' "$connectors_database")
fi

connectors_current_temporary="$connectors_root/.current-rollback.$release_sha.$$"
connectors_rollout_started=1
if [ "$restore_connectors_snapshot" -eq 1 ]; then
  systemctl stop "$connectors_service"
  if [ "$(systemctl is-active "$connectors_service" 2>/dev/null || true)" = active ]; then
    echo "Connectors service did not stop; database was not changed." >&2
    exit 1
  fi
  database_quarantine="$connectors_database.pre-rollback-$active_release_sha-$(date -u +%Y%m%dT%H%M%SZ)"
  for suffix in "" -wal -shm; do
    if [ -e "$database_quarantine$suffix" ] || [ -L "$database_quarantine$suffix" ]; then
      echo "Connectors quarantine path already exists." >&2
      exit 1
    fi
  done
  database_quarantined=1
  for suffix in "" -wal -shm; do
    if [ -e "$connectors_database$suffix" ] || [ -L "$connectors_database$suffix" ]; then
      mv -T "$connectors_database$suffix" "$database_quarantine$suffix"
    fi
  done
  run_transient -p "EnvironmentFile=$connectors_environment_file" -- \
    "$connectors_node" "$connectors_runtime/dist/src/operations/restore-command.js" \
    --backup "$snapshot_directory/connectors.sqlite" --manifest "$snapshot_directory/manifest.json" \
    --target "$connectors_database" >&2
  restore_database_ownership
fi
if [ -n "$connectors_runtime" ]; then
  ln -s "$connectors_runtime" "$connectors_current_temporary"
  mv -Tf "$connectors_current_temporary" "$connectors_current"
else
  rm -f "$connectors_current"
fi
case "$target_connectors_enabled" in
  enabled) systemctl enable "$connectors_service" ;;
  disabled|static|indirect|generated|transient|not-found) systemctl disable "$connectors_service" ;;
  *) echo "Rollback manifest has an unsupported connectors enabled state." >&2; exit 1 ;;
esac
case "$target_connectors_active" in
  active)
    [ -n "$connectors_runtime" ] || { echo "Active rollback connectors runtime is unavailable." >&2; exit 1; }
    systemctl restart "$connectors_service"
    node "$release_directory/infrastructure/operations/check-connectors-readiness.mjs" || {
      echo "Connectors readiness failed; application Compose was not changed." >&2
      exit 1
    }
    ;;
  inactive) systemctl stop "$connectors_service" ;;
  *) echo "Rollback manifest has an unsupported connectors active state." >&2; exit 1 ;;
esac

application_rollout_started=1
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
application_pointer_update_started=1
mv -Tf "$current_temporary" "$pih_root/current"
mv -Tf "$environment_link_temporary" "$pih_root/config/current-compose.env"
rollback_succeeded=1
if [ "$restore_connectors_snapshot" -eq 1 ]; then
  echo "Rolled back to $release_sha. Connectors database restored from the pre-activation snapshot; the previous database is quarantined at $database_quarantine. PostgreSQL state was not changed."
else
  echo "Rolled application images back to $release_sha. Database state was not changed."
fi
