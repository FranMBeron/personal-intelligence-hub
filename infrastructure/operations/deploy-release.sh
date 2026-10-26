#!/bin/sh
set -eu
umask 077

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <40-character-git-sha>" >&2
  exit 64
fi
release_sha=$1
case "$release_sha" in
  *[!0-9a-f]*|'') echo "Release must be a lowercase Git SHA." >&2; exit 64 ;;
esac
if [ "${#release_sha}" -ne 40 ]; then
  echo "Release must be a complete 40-character Git SHA." >&2
  exit 64
fi

pih_root=${PIH_ROOT:-/srv/personal-intelligence-hub}
connectors_root=${PIH_CONNECTORS_ROOT:-/opt/pih-connectors}
compose_project=${PIH_COMPOSE_PROJECT:-personal-intelligence-hub}
connectors_service=personal-intelligence-hub-connectors.service
release_directory="$pih_root/releases/$release_sha"
compose_file="$release_directory/infrastructure/docker/compose.production.yaml"
base_environment="$pih_root/config/compose.env"
release_environment="$pih_root/config/releases/$release_sha.compose.env"
connectors_release_directory="$connectors_root/releases/$release_sha"
connectors_current="$connectors_root/current"
connectors_database=${PIH_CONNECTORS_DATABASE_PATH:-/var/lib/pih-connectors/connectors.sqlite}
connectors_environment_file=${PIH_CONNECTORS_ENV_FILE:-/etc/pih-connectors/connectors.env}
connectors_node=${PIH_CONNECTORS_NODE:-/usr/bin/node}
connectors_staging_root="$pih_root/backups/connectors-staging"
release_manifest="$release_directory/release-manifest.json"
deployment_succeeded=0
connectors_rollout_started=0
connectors_upgrade=0
connectors_staging=
snapshot_verified=0
candidate_started=0
candidate_ready=0
application_rollout_started=0
application_pointer_update_started=0
connectors_container=

mkdir -p "$pih_root"
exec 9>"$pih_root/.deployment.lock"
if ! flock -n 9; then
  echo "Another deployment or rollback is already running." >&2
  exit 75
fi
previous_release=$(if [ -L "$pih_root/current" ]; then readlink -f "$pih_root/current" 2>/dev/null || true; fi)
previous_environment=$(if [ -L "$pih_root/config/current-compose.env" ]; then readlink -f "$pih_root/config/current-compose.env" 2>/dev/null || true; fi)
previous_connectors_runtime=$(if [ -L "$connectors_current" ]; then readlink -f "$connectors_current" 2>/dev/null || true; fi)
previous_release_sha=$(if [ -n "$previous_release" ]; then basename "$previous_release"; fi)

for command_name in docker jq curl syft grype node systemctl flock stat sha256sum find sort cmp chown chmod; do
  command -v "$command_name" > /dev/null 2>&1 || {
    echo "Required deployment command is missing: $command_name" >&2
    exit 1
  }
done
for required_file in "$compose_file" "$base_environment"; do
  [ -f "$required_file" ] || { echo "Missing deployment input: $required_file" >&2; exit 1; }
done
if [ -f "$release_directory/REVISION" ] && \
  [ "$(tr -d '\n' < "$release_directory/REVISION")" != "$release_sha" ]; then
  echo "Release directory revision does not match requested SHA." >&2
  exit 1
fi
if grep -Eq '^PIH_(API|WEB|POSTGRES)_IMAGE=' "$base_environment"; then
  echo "Base Compose environment must not contain release image references." >&2
  exit 1
fi

if [ -e "$release_environment" ] || [ -e "$release_manifest" ] || [ -e "$connectors_release_directory" ]; then
  echo "Release metadata or connectors runtime already exists; deploy a new Git SHA." >&2
  exit 1
fi
for image_name in api web postgres connectors-export; do
  if docker image inspect "pih-$image_name:$release_sha" > /dev/null 2>&1; then
    echo "Release image already exists; deploy a new Git SHA." >&2
    exit 1
  fi
done
for required_file in \
  "$release_directory/infrastructure/docker/api.Dockerfile" \
  "$release_directory/infrastructure/docker/web.Dockerfile" \
  "$release_directory/infrastructure/docker/postgres.Dockerfile" \
  "$release_directory/infrastructure/docker/connectors-build.Dockerfile" \
  "$release_directory/apps/connectors/src/migrations/0000_foundation.sql" \
  "$release_directory/infrastructure/operations/check-connectors-readiness.mjs" \
  "$release_directory/infrastructure/operations/check-connectors-migration-baseline.mjs"; do
  [ -f "$required_file" ] || { echo "Release source is incomplete." >&2; exit 1; }
done

# Connector data recovery: an upgrade (prior runtime and database both present)
# is protected by a verified snapshot; a first installation (both absent) has
# nothing to protect. Any other combination is an inconsistent host.
connectors_database_present=0
if [ -e "$connectors_database" ] || [ -L "$connectors_database" ]; then connectors_database_present=1; fi
if [ -n "$previous_connectors_runtime" ] && [ "$connectors_database_present" -eq 1 ]; then
  connectors_upgrade=1
elif [ -n "$previous_connectors_runtime" ] || [ "$connectors_database_present" -eq 1 ]; then
  echo "Connectors host state is inconsistent: the prior runtime and database must both exist or both be absent." >&2
  exit 1
fi
if [ "$connectors_upgrade" -eq 1 ]; then
  if [ ! -f "$connectors_database" ] || [ -L "$connectors_database" ]; then
    echo "Connectors database must be a regular file." >&2
    exit 1
  fi
  for adapter in backup-command.js restore-command.js; do
    [ -f "$previous_connectors_runtime/dist/src/operations/$adapter" ] || {
      echo "Active connectors runtime has no database backup adapter; take and verify a manual backup before upgrading." >&2
      exit 1
    }
  done
  for required_file in "$connectors_environment_file" "$pih_root/config/backup.env" "$pih_root/secrets/restic.env" \
    "$release_directory/infrastructure/operations/backup.sh"; do
    [ -f "$required_file" ] || { echo "Connectors backup input is missing: $required_file" >&2; exit 1; }
  done
  command -v systemd-run > /dev/null 2>&1 || {
    echo "Required deployment command is missing: systemd-run" >&2
    exit 1
  }
fi

mkdir -p "$pih_root/config/releases" "$connectors_root/releases"
deployer_environment=${CONNECTORS_DEPLOYER_ENV_FILE:-$pih_root/secrets/connectors-deployer.env}
if [ ! -f "$deployer_environment" ] || [ "$(stat -c '%u:%a' "$deployer_environment" 2>/dev/null || true)" != "0:600" ]; then
  echo "Root-only connectors deployer credentials are missing or have unsafe permissions." >&2
  exit 1
fi

# Deployer credentials reach only the readiness check: they are read in a
# subshell for that single invocation and never enter this shell, so docker,
# syft, grype, curl, restic and every other child run without them.
check_connectors_readiness() {
  (
    . "$deployer_environment"
    CONNECTORS_SOCKET_PATH=/run/pih-connectors/web/connectors.sock
    export CONNECTORS_DEPLOYER_SERVICE_TOKEN CONNECTORS_DEPLOYER_ISSUER \
      CONNECTORS_DEPLOYER_SIGNING_KEY CONNECTORS_DEPLOYER_ACTOR_ID CONNECTORS_SOCKET_PATH
    exec node "$release_directory/infrastructure/operations/check-connectors-readiness.mjs"
  )
}

environment_temporary="$release_environment.tmp.$$"
cp "$base_environment" "$environment_temporary"
printf '\nPIH_API_IMAGE=pih-api:%s\nPIH_WEB_IMAGE=pih-web:%s\n' \
  "$release_sha" "$release_sha" >> "$environment_temporary"
chmod 600 "$environment_temporary"
mv -f "$environment_temporary" "$release_environment"

# Run a command as a transient root service so the systemd manager loads
# environment files exactly as it does for the service; values never pass
# through this shell, argv or logs.
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

cleanup_connectors_staging() {
  if [ -n "$connectors_staging" ]; then
    rm -rf -- "$connectors_staging" || echo "Connectors staging cleanup failed." >&2
    connectors_staging=
  fi
}

# Replace the failed candidate database with the verified pre-activation
# snapshot. The candidate database is quarantined, never deleted.
restore_connectors_database() {
  if [ "$(systemctl is-active "$connectors_service" 2>/dev/null || true)" = active ]; then return 1; fi
  quarantine="$connectors_database.failed-$release_sha"
  for suffix in "" -wal -shm; do
    if [ -e "$quarantine$suffix" ] || [ -L "$quarantine$suffix" ]; then return 1; fi
  done
  for suffix in "" -wal -shm; do
    if [ -e "$connectors_database$suffix" ] || [ -L "$connectors_database$suffix" ]; then
      mv -T "$connectors_database$suffix" "$quarantine$suffix" || return 1
    fi
  done
  run_transient -p "EnvironmentFile=$connectors_environment_file" -- \
    "$connectors_node" "$previous_connectors_runtime/dist/src/operations/restore-command.js" \
    --backup "$connectors_staging/snapshot/connectors.sqlite" \
    --manifest "$connectors_staging/snapshot/manifest.json" \
    --target "$connectors_database" >&2 || return 1
  restore_database_ownership || return 1
  echo "Connectors database restored from the verified pre-activation snapshot; failed candidate data kept at $quarantine." >&2
}

# A failed first installation leaves no runtime link; move the database the
# candidate created aside (never delete it) so the host is clean again and the
# next deployment is a first installation instead of an inconsistent host.
quarantine_first_install_database() {
  if [ "$(systemctl is-active "$connectors_service" 2>/dev/null || true)" = active ]; then return 1; fi
  quarantine="$connectors_database.failed-first-install-$release_sha"
  for suffix in "" -wal -shm; do
    if [ -e "$quarantine$suffix" ] || [ -L "$quarantine$suffix" ]; then return 1; fi
  done
  for suffix in "" -wal -shm; do
    if [ -e "$connectors_database$suffix" ] || [ -L "$connectors_database$suffix" ]; then
      mv -T "$connectors_database$suffix" "$quarantine$suffix" || return 1
    fi
  done
  if [ -e "$quarantine" ]; then
    echo "First installation failed; the candidate database was kept aside at $quarantine." >&2
  fi
}

restore_application_pointers() {
  if [ -n "$previous_release" ]; then
    current_restore="$pih_root/.current-restore.$release_sha.$$"
    ln -s "$previous_release" "$current_restore" || return 1
    mv -Tf "$current_restore" "$pih_root/current" || return 1
  else
    rm -f "$pih_root/current" || return 1
  fi
  if [ -n "$previous_environment" ]; then
    environment_restore="$pih_root/config/.current-compose-restore.$release_sha.$$"
    ln -s "$previous_environment" "$environment_restore" || return 1
    mv -Tf "$environment_restore" "$pih_root/config/current-compose.env" || return 1
  else
    rm -f "$pih_root/config/current-compose.env" || return 1
  fi
}

restore_connectors_state() {
  if [ -n "$previous_connectors_runtime" ]; then
    connectors_current_temporary="$connectors_root/.current-restore.$release_sha.$$"
    ln -s "$previous_connectors_runtime" "$connectors_current_temporary" || return 1
    mv -Tf "$connectors_current_temporary" "$connectors_current" || return 1
  else
    rm -f "$connectors_current" || return 1
  fi
  case "$previous_connectors_enabled" in
    enabled|enabled-runtime|linked|linked-runtime) systemctl enable "$connectors_service" || return 1 ;;
    masked|masked-runtime) systemctl mask "$connectors_service" || return 1 ;;
    disabled|static|indirect|generated|transient|not-found) systemctl disable "$connectors_service" || return 1 ;;
    *) echo "Cannot restore prior connectors enabled state: $previous_connectors_enabled" >&2; return 1 ;;
  esac
  if [ "$previous_connectors_active" = "active" ]; then
    systemctl restart "$connectors_service" || return 1
    check_connectors_readiness || return 1
  else
    systemctl stop "$connectors_service" || return 1
  fi
}

rollback_deployment() {
  status=$?
  trap - EXIT HUP INT TERM
  set +e
  if [ "$status" -ne 0 ] && [ "$deployment_succeeded" -eq 0 ]; then
    if [ "$connectors_rollout_started" -eq 1 ]; then
      echo "Deployment failed; restoring previous connectors service." >&2
      connectors_stopped=0
      if systemctl stop "$connectors_service"; then connectors_stopped=1; else echo "Connectors stop failed during restore." >&2; fi
      if [ "$connectors_upgrade" -eq 1 ] && [ "$snapshot_verified" -eq 1 ] && \
        [ "$candidate_started" -eq 1 ] && [ "$candidate_ready" -eq 0 ]; then
        if [ "$connectors_stopped" -eq 1 ] && restore_connectors_database; then
          if ! restore_connectors_state; then
            echo "reason=previous_connectors_not_ready: Previous connectors service restore failed; connectors left stopped with the restored database, quarantined candidate database and encrypted pre-activation snapshot preserved." >&2
            systemctl stop "$connectors_service" || true
          fi
        else
          echo "reason=connectors_database_restore_failed: connectors left stopped and disabled; the candidate database (quarantined if it was moved) and the encrypted pre-activation snapshot are preserved; operator intervention required." >&2
          connectors_link_restore="$connectors_root/.current-restore.$release_sha.$$"
          ln -s "$previous_connectors_runtime" "$connectors_link_restore" && \
            mv -Tf "$connectors_link_restore" "$connectors_current" || echo "Previous connectors runtime link restore failed." >&2
          systemctl stop "$connectors_service" || true
          systemctl disable "$connectors_service" || echo "Connectors disable failed." >&2
        fi
      else
        if restore_connectors_state; then
          if [ "$connectors_upgrade" -eq 0 ] && [ -z "$previous_connectors_runtime" ]; then
            quarantine_first_install_database || echo "reason=first_install_cleanup_failed: the candidate database could not be moved aside; move it away before the next deployment." >&2
          fi
        else
          echo "Previous connectors service restore failed." >&2
        fi
      fi
    fi
    if [ "$application_pointer_update_started" -eq 1 ]; then
      restore_application_pointers || echo "Previous application pointers could not be restored." >&2
    fi
    if [ "$application_rollout_started" -eq 1 ] && \
      [ -n "$previous_release" ] && [ -f "$previous_release/infrastructure/docker/compose.production.yaml" ] && \
      [ -n "$previous_environment" ] && [ -f "$previous_environment" ]; then
      echo "Deployment failed; restoring previous application images." >&2
      docker compose \
        --project-name "$compose_project" \
        --env-file "$previous_environment" \
        --file "$previous_release/infrastructure/docker/compose.production.yaml" \
        up --detach --wait --remove-orphans || echo "Previous application restore failed." >&2
    fi
  fi
  if [ -n "$connectors_container" ]; then
    docker rm "$connectors_container" > /dev/null 2>&1 || true
  fi
  cleanup_connectors_staging
  exit "$status"
}
trap rollback_deployment EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

docker build --file "$release_directory/infrastructure/docker/api.Dockerfile" \
  --tag "pih-api:$release_sha" "$release_directory"
docker build --file "$release_directory/infrastructure/docker/web.Dockerfile" \
  --tag "pih-web:$release_sha" "$release_directory"
docker build --file "$release_directory/infrastructure/docker/postgres.Dockerfile" \
  --tag "pih-postgres:$release_sha" "$release_directory"
node_image=node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
docker build --build-arg "NODE_IMAGE=$node_image" \
  --file "$release_directory/infrastructure/docker/connectors-build.Dockerfile" \
  --tag "pih-connectors-export:$release_sha" "$release_directory"

syft "pih-api:$release_sha" \
  --output "cyclonedx-json=$release_directory/sbom-api.cyclonedx.json"
syft "pih-web:$release_sha" \
  --output "cyclonedx-json=$release_directory/sbom-web.cyclonedx.json"
syft "pih-postgres:$release_sha" \
  --output "cyclonedx-json=$release_directory/sbom-postgres.cyclonedx.json"
syft "pih-connectors-export:$release_sha" \
  --output "cyclonedx-json=$release_directory/sbom-connectors.cyclonedx.json"
grype "pih-api:$release_sha" --fail-on high
grype "pih-web:$release_sha" --fail-on high
grype "pih-postgres:$release_sha" --fail-on high
grype "pih-connectors-export:$release_sha" --fail-on high

mkdir -m 0755 "$connectors_release_directory"
connectors_container=$(docker create --name "pih-connectors-export-$release_sha-$$" "pih-connectors-export:$release_sha" /__export_only__)
docker cp "$connectors_container:/opt/connectors/." "$connectors_release_directory/"
docker rm "$connectors_container" > /dev/null
connectors_container=
source_migrations="$release_directory/apps/connectors/src/migrations"
bundle_migrations="$connectors_release_directory/dist/src/migrations"
[ -f "$connectors_release_directory/dist/src/main.js" ] && [ -d "$bundle_migrations" ] || {
  echo "Connectors runtime bundle is incomplete." >&2
  exit 1
}
expected_migrations="$connectors_root/.expected-migrations.$release_sha.$$"
actual_migrations="$connectors_root/.actual-migrations.$release_sha.$$"
find "$source_migrations" -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | LC_ALL=C sort > "$expected_migrations"
find "$bundle_migrations" -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | LC_ALL=C sort > "$actual_migrations"
if [ ! -s "$expected_migrations" ] || ! cmp -s "$expected_migrations" "$actual_migrations"; then
  rm -f "$expected_migrations" "$actual_migrations"
  echo "Connectors migration bundle does not match source." >&2
  exit 1
fi
while IFS= read -r migration; do
  if ! cmp -s "$source_migrations/$migration" "$bundle_migrations/$migration" || \
    [ "$(sha256sum "$source_migrations/$migration" | awk '{print $1}')" != \
      "$(sha256sum "$bundle_migrations/$migration" | awk '{print $1}')" ]; then
    rm -f "$expected_migrations" "$actual_migrations"
    echo "Connectors migration checksum verification failed." >&2
    exit 1
  fi
done < "$expected_migrations"
connector_migrations_json=$(jq -Rn '[inputs | sub("\\.sql$"; "")]' < "$expected_migrations")
active_connectors_manifest=-
if [ -n "$previous_release" ] && [ -f "$previous_release/release-manifest.json" ]; then
  active_connectors_manifest="$previous_release/release-manifest.json"
fi
previous_connectors_enabled=$(systemctl is-enabled "$connectors_service" 2>/dev/null || true)
previous_connectors_active=$(systemctl is-active "$connectors_service" 2>/dev/null || true)
[ -n "$previous_connectors_enabled" ] || previous_connectors_enabled=not-found
[ -n "$previous_connectors_active" ] || previous_connectors_active=inactive
node "$release_directory/infrastructure/operations/check-connectors-migration-baseline.mjs" \
  deploy "$expected_migrations" "$active_connectors_manifest" "$previous_connectors_active"
rm -f "$expected_migrations" "$actual_migrations"
chown -R 0:0 "$connectors_release_directory"
chmod -R a-w "$connectors_release_directory"

pre_activation_snapshot_id=
pre_activation_manifest_sha256=
if [ "$connectors_upgrade" -eq 1 ]; then
  # The old runtime owns the live database; a newer candidate must never open
  # it because opening applies that runtime's pending migrations.
  mkdir -p "$connectors_staging_root"
  chmod 700 "$pih_root/backups" "$connectors_staging_root"
  connectors_staging=$(mktemp -d "$connectors_staging_root/deploy.XXXXXX")
  connectors_database_owner=$(stat -c '%u:%g' "$connectors_database")
  run_transient -p "EnvironmentFile=$connectors_environment_file" -- \
    "$connectors_node" "$previous_connectors_runtime/dist/src/operations/backup-command.js" \
    --destination "$connectors_staging/snapshot" --database "$connectors_database" >&2 || {
    restore_database_ownership || true
    echo "Connectors pre-activation snapshot failed." >&2
    exit 1
  }
  restore_database_ownership
  run_transient \
    -p "EnvironmentFile=$pih_root/config/backup.env" \
    -p "EnvironmentFile=$pih_root/secrets/restic.env" \
    -E "PIH_ROOT=$pih_root" -- \
    /bin/sh "$release_directory/infrastructure/operations/backup.sh" \
    --connectors-snapshot "$connectors_staging/snapshot" \
    --context-tag "pre-activation-$release_sha" > "$connectors_staging/backup.log" || {
    echo "Encrypted connectors pre-activation backup failed; the active service was not stopped." >&2
    exit 1
  }
  pre_activation_snapshot_id=$(sed -n 's/^connectors-snapshot-id=\([0-9a-f]\{64\}\)$/\1/p' "$connectors_staging/backup.log")
  if [ "$(printf '%s\n' "$pre_activation_snapshot_id" | grep -c .)" -ne 1 ]; then
    echo "Encrypted connectors pre-activation backup did not report exactly one snapshot." >&2
    exit 1
  fi
  pre_activation_manifest_sha256=$(sha256sum "$connectors_staging/snapshot/manifest.json" | awk '{print $1}')
  snapshot_verified=1
fi

postgres_image=$(docker image inspect --format '{{.Id}}' "pih-postgres:$release_sha")
printf '\nPIH_POSTGRES_IMAGE=%s\n' "$postgres_image" >> "$release_environment"

image_inspect_temporary="$release_directory/image-inspect.tmp.$$"
docker image inspect "pih-api:$release_sha" "pih-web:$release_sha" "pih-postgres:$release_sha" "pih-connectors-export:$release_sha" \
  > "$image_inspect_temporary"
jq '[.[] | {id: .Id, repoTags: .RepoTags, repoDigests: .RepoDigests}]' \
  "$image_inspect_temporary" \
  > "$release_directory/image-manifests.json"
rm -f "$image_inspect_temporary"
jq -n \
  --arg gitSha "$release_sha" \
  --arg deployedAt "$(date --utc +%Y-%m-%dT%H:%M:%SZ)" \
  --arg connectorsImage "pih-connectors-export:$release_sha" \
  --arg connectorsRuntime "$connectors_release_directory" \
  --arg previousReleaseSha "$previous_release_sha" \
  --arg previousConnectorsRuntime "$previous_connectors_runtime" \
  --arg previousConnectorsEnabled "$previous_connectors_enabled" \
  --arg previousConnectorsActive "$previous_connectors_active" \
  --arg preActivationSnapshotId "$pre_activation_snapshot_id" \
  --arg preActivationManifestSha256 "$pre_activation_manifest_sha256" \
  --argjson connectorMigrations "$connector_migrations_json" \
  --slurpfile images "$release_directory/image-manifests.json" \
  '{gitSha: $gitSha, deployedAt: $deployedAt, images: $images[0],
    connectors: {exportImage: $connectorsImage, runtimeDirectory: $connectorsRuntime,
      previousReleaseSha: (if $previousReleaseSha == "" then null else $previousReleaseSha end),
      previousConnectorsRuntime: (if $previousConnectorsRuntime == "" then null else $previousConnectorsRuntime end),
      previousConnectorsEnabled: $previousConnectorsEnabled,
      previousConnectorsActive: $previousConnectorsActive,
      preActivationSnapshot: (if $preActivationSnapshotId == "" then null else
        {resticSnapshotId: $preActivationSnapshotId, manifestSha256: $preActivationManifestSha256} end),
      migrationHistoryFormatVersion: 1, migrations: $connectorMigrations,
      enabled: "enabled", active: "active"}}' \
  > "$release_manifest"
chown 0:0 "$release_manifest" "$release_directory/image-manifests.json" "$release_directory/sbom-connectors.cyclonedx.json"
chmod 0444 "$release_manifest" "$release_directory/image-manifests.json" "$release_directory/sbom-connectors.cyclonedx.json"

connectors_current_temporary="$connectors_root/.current.$release_sha.$$"
ln -s "$connectors_release_directory" "$connectors_current_temporary"
connectors_rollout_started=1
systemctl stop "$connectors_service"
mv -Tf "$connectors_current_temporary" "$connectors_current"
systemctl enable "$connectors_service"
candidate_started=1
systemctl restart "$connectors_service"
check_connectors_readiness || {
  echo "Connectors readiness failed." >&2
  exit 1
}
candidate_ready=1

docker compose \
  --project-name "$compose_project" \
  --env-file "$release_environment" \
  --file "$compose_file" \
  config --quiet
application_rollout_started=1
docker compose \
  --project-name "$compose_project" \
  --env-file "$release_environment" \
  --file "$compose_file" \
  up --detach --wait --remove-orphans

web_port=$(awk -F= '$1 == "PIH_WEB_PORT" { value=$2 } END { print value }' \
  "$release_environment")
web_port=${web_port:-3000}
case "$web_port" in *[!0-9]*|'') echo "Invalid PIH_WEB_PORT." >&2; exit 1 ;; esac
curl --fail --silent --show-error --max-time 10 \
  "http://127.0.0.1:$web_port/health" > /dev/null

current_temporary="$pih_root/.current.$release_sha.$$"
environment_link_temporary="$pih_root/config/.current-compose.$release_sha.$$"
ln -s "$release_directory" "$current_temporary"
ln -s "$release_environment" "$environment_link_temporary"
application_pointer_update_started=1
mv -Tf "$current_temporary" "$pih_root/current"
mv -Tf "$environment_link_temporary" "$pih_root/config/current-compose.env"
deployment_succeeded=1
trap - EXIT HUP INT TERM
cleanup_connectors_staging

# Retention and the repository check for the pre-activation backup run only
# now, after a successful activation, so they never widen the window between
# the snapshot and stopping the old service. A failure here does not roll the
# active release back; it is reported so the operator can rerun backup.sh.
if [ "$connectors_upgrade" -eq 1 ]; then
  run_transient \
    -p "EnvironmentFile=$pih_root/config/backup.env" \
    -p "EnvironmentFile=$pih_root/secrets/restic.env" \
    -E "PIH_ROOT=$pih_root" -- \
    /bin/sh "$release_directory/infrastructure/operations/backup.sh" --retention-only > /dev/null || {
    echo "Release $release_sha is active, but backup retention or the Restic repository check failed. Nothing was rolled back; run infrastructure/operations/backup.sh and investigate before the next deployment." >&2
    exit 1
  }
fi

echo "Deployed Personal Intelligence Hub release $release_sha."
