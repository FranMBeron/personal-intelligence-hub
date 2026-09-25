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
compose_project=${PIH_COMPOSE_PROJECT:-personal-intelligence-hub}
release_directory="$pih_root/releases/$release_sha"
compose_file="$release_directory/infrastructure/docker/compose.production.yaml"
base_environment="$pih_root/config/compose.env"
release_environment="$pih_root/config/releases/$release_sha.compose.env"
previous_release=$(readlink -f "$pih_root/current" 2>/dev/null || true)
previous_environment=$(readlink -f "$pih_root/config/current-compose.env" 2>/dev/null || true)
deployment_succeeded=0

for command_name in docker jq curl syft grype; do
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
if grep -Eq '^PIH_(API|WEB)_IMAGE=' "$base_environment"; then
  echo "Base Compose environment must not contain release image references." >&2
  exit 1
fi

mkdir -p "$pih_root/config/releases"
environment_temporary="$release_environment.tmp.$$"
cp "$base_environment" "$environment_temporary"
printf '\nPIH_API_IMAGE=pih-api:%s\nPIH_WEB_IMAGE=pih-web:%s\n' \
  "$release_sha" "$release_sha" >> "$environment_temporary"
chmod 600 "$environment_temporary"
mv -f "$environment_temporary" "$release_environment"

rollback_application() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ] && [ "$deployment_succeeded" -eq 0 ] && \
    [ -f "$previous_release/infrastructure/docker/compose.production.yaml" ] && \
    [ -f "$previous_environment" ]; then
    echo "Deployment failed; restoring previous application images." >&2
    docker compose \
      --project-name "$compose_project" \
      --env-file "$previous_environment" \
      --file "$previous_release/infrastructure/docker/compose.production.yaml" \
      up --detach --wait --remove-orphans || true
  fi
  exit "$status"
}
trap rollback_application EXIT HUP INT TERM

docker build --file "$release_directory/infrastructure/docker/api.Dockerfile" \
  --tag "pih-api:$release_sha" "$release_directory"
docker build --file "$release_directory/infrastructure/docker/web.Dockerfile" \
  --tag "pih-web:$release_sha" "$release_directory"

syft "pih-api:$release_sha" \
  --output "cyclonedx-json=$release_directory/sbom-api.cyclonedx.json"
syft "pih-web:$release_sha" \
  --output "cyclonedx-json=$release_directory/sbom-web.cyclonedx.json"
grype "pih-api:$release_sha" --fail-on high
grype "pih-web:$release_sha" --fail-on high

image_inspect_temporary="$release_directory/image-inspect.tmp.$$"
docker image inspect "pih-api:$release_sha" "pih-web:$release_sha" \
  > "$image_inspect_temporary"
jq '[.[] | {id: .Id, repoTags: .RepoTags, repoDigests: .RepoDigests}]' \
  "$image_inspect_temporary" \
  > "$release_directory/image-manifests.json"
rm -f "$image_inspect_temporary"
jq -n \
  --arg gitSha "$release_sha" \
  --arg deployedAt "$(date --utc +%Y-%m-%dT%H:%M:%SZ)" \
  --slurpfile images "$release_directory/image-manifests.json" \
  '{gitSha: $gitSha, deployedAt: $deployedAt, images: $images[0]}' \
  > "$release_directory/release-manifest.json"

docker compose \
  --project-name "$compose_project" \
  --env-file "$release_environment" \
  --file "$compose_file" \
  config --quiet
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
mv -Tf "$current_temporary" "$pih_root/current"
mv -Tf "$environment_link_temporary" "$pih_root/config/current-compose.env"
deployment_succeeded=1
trap - EXIT HUP INT TERM

echo "Deployed Personal Intelligence Hub release $release_sha."
