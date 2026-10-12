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
release_manifest="$release_directory/release-manifest.json"
deployment_succeeded=0
connectors_rollout_started=0
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
for image_name in api web postgres connectors-build; do
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
  "$release_directory/infrastructure/operations/check-connectors-readiness.mjs"; do
  [ -f "$required_file" ] || { echo "Release source is incomplete." >&2; exit 1; }
done

mkdir -p "$pih_root/config/releases" "$connectors_root/releases"
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

environment_temporary="$release_environment.tmp.$$"
cp "$base_environment" "$environment_temporary"
printf '\nPIH_API_IMAGE=pih-api:%s\nPIH_WEB_IMAGE=pih-web:%s\n' \
  "$release_sha" "$release_sha" >> "$environment_temporary"
chmod 600 "$environment_temporary"
mv -f "$environment_temporary" "$release_environment"

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
    node "$release_directory/infrastructure/operations/check-connectors-readiness.mjs" || return 1
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
      systemctl stop "$connectors_service" || echo "Connectors stop failed during restore." >&2
      restore_connectors_state || echo "Previous connectors service restore failed." >&2
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
  exit "$status"
}
trap rollback_deployment EXIT HUP INT TERM

docker build --file "$release_directory/infrastructure/docker/api.Dockerfile" \
  --tag "pih-api:$release_sha" "$release_directory"
docker build --file "$release_directory/infrastructure/docker/web.Dockerfile" \
  --tag "pih-web:$release_sha" "$release_directory"
docker build --file "$release_directory/infrastructure/docker/postgres.Dockerfile" \
  --tag "pih-postgres:$release_sha" "$release_directory"
node_image=node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
docker build --build-arg "NODE_IMAGE=$node_image" \
  --file "$release_directory/infrastructure/docker/connectors-build.Dockerfile" \
  --tag "pih-connectors-build:$release_sha" "$release_directory"

syft "pih-api:$release_sha" \
  --output "cyclonedx-json=$release_directory/sbom-api.cyclonedx.json"
syft "pih-web:$release_sha" \
  --output "cyclonedx-json=$release_directory/sbom-web.cyclonedx.json"
syft "pih-postgres:$release_sha" \
  --output "cyclonedx-json=$release_directory/sbom-postgres.cyclonedx.json"
syft "pih-connectors-build:$release_sha" \
  --output "cyclonedx-json=$release_directory/sbom-connectors.cyclonedx.json"
grype "pih-api:$release_sha" --fail-on high
grype "pih-web:$release_sha" --fail-on high
grype "pih-postgres:$release_sha" --fail-on high
grype "pih-connectors-build:$release_sha" --fail-on high

mkdir -m 0755 "$connectors_release_directory"
connectors_container=$(docker create --name "pih-connectors-export-$release_sha-$$" "pih-connectors-build:$release_sha")
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
rm -f "$expected_migrations" "$actual_migrations"
chown -R 0:0 "$connectors_release_directory"
chmod -R a-w "$connectors_release_directory"

postgres_image=$(docker image inspect --format '{{.Id}}' "pih-postgres:$release_sha")
printf '\nPIH_POSTGRES_IMAGE=%s\n' "$postgres_image" >> "$release_environment"

previous_connectors_enabled=$(systemctl is-enabled "$connectors_service" 2>/dev/null || true)
previous_connectors_active=$(systemctl is-active "$connectors_service" 2>/dev/null || true)
[ -n "$previous_connectors_enabled" ] || previous_connectors_enabled=not-found
[ -n "$previous_connectors_active" ] || previous_connectors_active=inactive

image_inspect_temporary="$release_directory/image-inspect.tmp.$$"
docker image inspect "pih-api:$release_sha" "pih-web:$release_sha" "pih-postgres:$release_sha" "pih-connectors-build:$release_sha" \
  > "$image_inspect_temporary"
jq '[.[] | {id: .Id, repoTags: .RepoTags, repoDigests: .RepoDigests}]' \
  "$image_inspect_temporary" \
  > "$release_directory/image-manifests.json"
rm -f "$image_inspect_temporary"
jq -n \
  --arg gitSha "$release_sha" \
  --arg deployedAt "$(date --utc +%Y-%m-%dT%H:%M:%SZ)" \
  --arg connectorsImage "pih-connectors-build:$release_sha" \
  --arg connectorsRuntime "$connectors_release_directory" \
  --arg previousConnectorsRuntime "$previous_connectors_runtime" \
  --arg previousConnectorsEnabled "$previous_connectors_enabled" \
  --arg previousConnectorsActive "$previous_connectors_active" \
  --slurpfile images "$release_directory/image-manifests.json" \
  '{gitSha: $gitSha, deployedAt: $deployedAt, images: $images[0],
    connectors: {buildImage: $connectorsImage, runtimeDirectory: $connectorsRuntime,
      previousConnectorsRuntime: (if $previousConnectorsRuntime == "" then null else $previousConnectorsRuntime end),
      previousConnectorsEnabled: $previousConnectorsEnabled,
      previousConnectorsActive: $previousConnectorsActive,
      enabled: "enabled", active: "active"}}' \
  > "$release_manifest"
chown 0:0 "$release_manifest" "$release_directory/image-manifests.json" "$release_directory/sbom-connectors.cyclonedx.json"
chmod 0444 "$release_manifest" "$release_directory/image-manifests.json" "$release_directory/sbom-connectors.cyclonedx.json"

connectors_current_temporary="$connectors_root/.current.$release_sha.$$"
ln -s "$connectors_release_directory" "$connectors_current_temporary"
connectors_rollout_started=1
mv -Tf "$connectors_current_temporary" "$connectors_current"
systemctl enable "$connectors_service"
systemctl restart "$connectors_service"
node "$release_directory/infrastructure/operations/check-connectors-readiness.mjs" || {
  echo "Connectors readiness failed." >&2
  exit 1
}

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

echo "Deployed Personal Intelligence Hub release $release_sha."
