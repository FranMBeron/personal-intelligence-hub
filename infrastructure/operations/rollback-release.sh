#!/bin/sh
set -eu
umask 077

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <previous-40-character-git-sha>" >&2
  exit 64
fi
release_sha=$1
case "$release_sha" in *[!0-9a-f]*|'') exit 64 ;; esac
if [ "${#release_sha}" -ne 40 ]; then exit 64; fi

pih_root=${PIH_ROOT:-/srv/personal-intelligence-hub}
connectors_root=${PIH_CONNECTORS_ROOT:-/opt/pih-connectors}
compose_project=${PIH_COMPOSE_PROJECT:-personal-intelligence-hub}
connectors_service=personal-intelligence-hub-connectors.service
release_directory="$pih_root/releases/$release_sha"
release_environment="$pih_root/config/releases/$release_sha.compose.env"
compose_file="$release_directory/infrastructure/docker/compose.production.yaml"
release_manifest="$release_directory/release-manifest.json"
connectors_current="$connectors_root/current"
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
      restore_connectors_state || echo "Previous connectors service restore failed." >&2
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
  exit "$status"
}
trap rollback_failure EXIT HUP INT TERM

connectors_current_temporary="$connectors_root/.current-rollback.$release_sha.$$"
connectors_rollout_started=1
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
echo "Rolled application images back to $release_sha. Database state was not changed."
