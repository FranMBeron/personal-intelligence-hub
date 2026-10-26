#!/bin/sh
# Interactive configurator for the private connectors host environment file.
#
# Values are typed at a terminal; every credential is read with terminal echo
# disabled. Values never enter argv, shell history, stdout or stderr: they are
# handled only by shell builtins (read, case, printf) and written to a
# root-only candidate file. The candidate is validated by the installed
# connectors runtime, loaded by the systemd manager exactly as the service
# loads it, and only then atomically replaces the live file.
#
# The Telegram bot token, sender allowlist and chat routes are not handled
# here; they stay in the Hermes gateway's own private configuration.
set -eu
umask 077
LC_ALL=C
export LC_ALL

case $- in *x*) echo "Refusing to run with shell tracing enabled." >&2; exit 64 ;; esac
if [ "$#" -ne 0 ]; then
  echo "Usage: $0   (interactive; takes no arguments)" >&2
  exit 64
fi

configure_root=${PIH_CONFIGURE_ROOT:-}
connectors_root=${PIH_CONNECTORS_ROOT:-/opt/pih-connectors}
connectors_node=${PIH_CONNECTORS_NODE:-/usr/bin/node}
config_directory="$configure_root/etc/pih-connectors"
target_file="$config_directory/connectors.env"
validator="$connectors_root/current/dist/src/operations/validate-config-command.js"
bff_socket=/run/pih-connectors/web/connectors.sock
delegation_socket=/run/pih-connectors/agents/hermes-delegation.sock
database_path=/var/lib/pih-connectors/connectors.sqlite
calendar_callback_path=/api/ui/v1/calendar/oauth/callback

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root so the file can be owned by root:root." >&2
  exit 1
fi
if [ ! -t 0 ]; then
  echo "An interactive terminal is required; values are never read from pipes or arguments." >&2
  exit 1
fi
for command_name in stty jq systemd-run mktemp stat chown chmod mv; do
  command -v "$command_name" > /dev/null 2>&1 || {
    echo "Required command is missing: $command_name" >&2
    exit 1
  }
done
if [ ! -f "$validator" ]; then
  echo "The installed connectors runtime has no validation command; deploy it first." >&2
  exit 1
fi

saved_tty=$(stty -g)
candidate=
cleanup() {
  status=$?
  trap - EXIT
  stty "$saved_tty" 2> /dev/null || true
  if [ -n "$candidate" ]; then rm -f -- "$candidate"; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

reject() {
  stty "$saved_tty" 2> /dev/null || true
  printf '\nRejected %s: %s. Nothing was written.\n' "$1" "$2" >&2
  exit 1
}

# Builtin-only value checks. Values may not contain single quotes (the file
# uses single-quoted systemd EnvironmentFile values) or any control character.
check_line() {
  case "$2" in *"'"*) reject "$1" "single quotes are not allowed" ;; esac
  case "$2" in *[![:print:]]*) reject "$1" "newlines and control characters are not allowed" ;; esac
}

answer=
ask() {
  stty echo
  if [ -n "$3" ]; then printf '%s [%s]: ' "$2" "$3" >&2; else printf '%s: ' "$2" >&2; fi
  IFS= read -r answer || reject "$1" "input ended"
  [ -n "$answer" ] || answer=$3
  [ -n "$answer" ] || reject "$1" "a value is required"
  check_line "$1" "$answer"
}

ask_secret() {
  stty -echo
  printf '%s (hidden): ' "$2" >&2
  IFS= read -r answer || reject "$1" "input ended"
  stty echo
  printf '\n' >&2
  [ -n "$answer" ] || reject "$1" "a blank credential is not allowed"
  check_line "$1" "$answer"
}

ask_yes_no() {
  stty echo
  printf '%s [%s]: ' "$1" "$2" >&2
  IFS= read -r answer || reject "$1" "input ended"
  [ -n "$answer" ] || answer=$2
  case "$answer" in
    y|Y|yes) answer=yes ;;
    n|N|no) answer=no ;;
    *) reject "$1" "answer yes or no" ;;
  esac
}

require_charset() {
  case "$2" in *[!$3]*) reject "$1" "$4" ;; esac
}

require_integer() {
  case "$2" in ''|0*|*[!0-9]*) reject "$1" "must be a positive integer" ;; esac
  [ "${#2}" -le 10 ] || reject "$1" "is out of range"
}

require_base64url_key() {
  require_charset "$1" "$2" 'A-Za-z0-9_-' "must be base64url"
  [ "${#2}" -eq 43 ] || reject "$1" "must encode exactly 32 bytes"
}

require_profile_id() {
  case "$2" in [a-z]*) ;; *) reject "$1" "must be a lowercase profile identifier" ;; esac
  require_charset "$1" "$2" 'a-z0-9-' "must be a lowercase profile identifier"
  [ "${#2}" -le 63 ] || reject "$1" "is too long"
}

require_json_array() {
  case "$2" in \[*\]) ;; *) reject "$1" "must be compact JSON on one line" ;; esac
}

lines=
fields=
emit() {
  lines="$lines$1='$2'
"
  fields="$fields $1"
}

profile_ids=
contains_profile() {
  case " $profile_ids " in *" $1 "*) return 0 ;; esac
  return 1
}

json_query() {
  # Non-secret JSON only, passed on stdin; never used for credentials.
  printf '%s' "$1" | jq -er "$2" 2> /dev/null
}

echo "Private connectors configuration. Credential prompts do not echo input." >&2

# Foundation
emit NODE_ENV production
ask CONNECTORS_SOCKET_PATH "Host BFF socket path" "$bff_socket"
[ "$answer" = "$bff_socket" ] || reject CONNECTORS_SOCKET_PATH "must be $bff_socket"
emit CONNECTORS_SOCKET_PATH "$answer"
ask CONNECTORS_SOCKET_GID "Numeric GID of pih-connectors-clients (getent group pih-connectors-clients)" ""
require_integer CONNECTORS_SOCKET_GID "$answer"
emit CONNECTORS_SOCKET_GID "$answer"
emit CONNECTORS_DATABASE_PATH "$database_path"
ask_secret CONNECTORS_SERVICE_CREDENTIALS_JSON "Service credential map (compact JSON array)"
require_json_array CONNECTORS_SERVICE_CREDENTIALS_JSON "$answer"
emit CONNECTORS_SERVICE_CREDENTIALS_JSON "$answer"
ask DEFAULT_TIME_ZONE "Default IANA time zone" "Etc/UTC"
require_charset DEFAULT_TIME_ZONE "$answer" 'A-Za-z0-9_+/-' "must be an IANA time zone name"
emit DEFAULT_TIME_ZONE "$answer"
ask LOG_LEVEL "Log level (debug, info, warn, error)" "info"
case "$answer" in debug|info|warn|error) ;; *) reject LOG_LEVEL "must be debug, info, warn or error" ;; esac
emit LOG_LEVEL "$answer"

set -- --production

# Hermes
ask_yes_no "Configure Hermes" "yes"
if [ "$answer" = yes ]; then
  set -- "$@" --require hermes
  ask HERMES_API_ORIGIN "Hermes loopback API origin (http://127.0.0.1:<port>)" ""
  case "$answer" in
    http://127.0.0.1:*) hermes_port=${answer#http://127.0.0.1:} ;;
    "http://[::1]:"*) hermes_port=${answer#"http://[::1]:"} ;;
    *) reject HERMES_API_ORIGIN "must be a literal loopback HTTP origin" ;;
  esac
  require_integer HERMES_API_ORIGIN "$hermes_port"
  [ "$hermes_port" -le 65535 ] || reject HERMES_API_ORIGIN "port is out of range"
  emit HERMES_API_ORIGIN "$answer"

  ask HERMES_PROFILES_JSON "Hermes profiles (compact JSON array, no credentials)" ""
  require_json_array HERMES_PROFILES_JSON "$answer"
  hermes_profiles=$answer
  profile_ids=$(json_query "$hermes_profiles" '[.[] | .id | select(type == "string" and test("^[a-z][a-z0-9-]{0,62}$"))] | if length > 0 then join(" ") else error("none") end') || \
    reject HERMES_PROFILES_JSON "must list profiles with lowercase identifiers"
  if ! json_query "$hermes_profiles" 'all(.[]; (.id | type) == "string" and (.id | test("^[a-z][a-z0-9-]{0,62}$")))' > /dev/null; then
    reject HERMES_PROFILES_JSON "contains an invalid profile identifier"
  fi
  key_names=$(json_query "$hermes_profiles" '[.[] | select(.enabled == true) | .keyEnvironment] | join(" ")') || \
    reject HERMES_PROFILES_JSON "must name a key variable for every enabled profile"
  emit HERMES_PROFILES_JSON "$hermes_profiles"

  ask HERMES_DEFAULT_PROFILE_ID "Default gateway profile ID" ""
  require_profile_id HERMES_DEFAULT_PROFILE_ID "$answer"
  contains_profile "$answer" || reject HERMES_DEFAULT_PROFILE_ID "is not a configured profile"
  emit HERMES_DEFAULT_PROFILE_ID "$answer"

  for key_name in $key_names; do
    case "$key_name" in HERMES_*_API_KEY) ;; *) reject HERMES_PROFILES_JSON "key variables must match HERMES_<NAME>_API_KEY" ;; esac
    require_charset HERMES_PROFILES_JSON "$key_name" 'A-Z0-9_' "key variables must match HERMES_<NAME>_API_KEY"
    ask_secret "$key_name" "API key for $key_name"
    emit "$key_name" "$answer"
  done

  ask HERMES_UPLOAD_DIRECTORY "Hermes upload directory" "/var/lib/pih-connectors/hermes-uploads"
  case "$answer" in /*) ;; *) reject HERMES_UPLOAD_DIRECTORY "must be absolute" ;; esac
  require_charset HERMES_UPLOAD_DIRECTORY "$answer" 'A-Za-z0-9._/-' "must be a plain absolute path"
  emit HERMES_UPLOAD_DIRECTORY "$answer"
  emit HERMES_IMAGE_MAX_BYTES 5242880
  emit HERMES_UPLOAD_TTL_SECONDS 600
  emit HERMES_EVENT_RETENTION_HOURS 168
  emit HERMES_IDEMPOTENCY_RETENTION_HOURS 168

  ask_yes_no "Configure Hermes delegation" "no"
  if [ "$answer" = yes ]; then
    ask HERMES_DELEGATION_ORCHESTRATOR_ID "Delegating orchestrator profile ID" ""
    require_profile_id HERMES_DELEGATION_ORCHESTRATOR_ID "$answer"
    contains_profile "$answer" || reject HERMES_DELEGATION_ORCHESTRATOR_ID "is not a configured profile"
    emit HERMES_DELEGATION_ORCHESTRATOR_ID "$answer"
    ask HERMES_DELEGATION_SOCKET_PATH "Agent-only delegation socket path" "$delegation_socket"
    [ "$answer" = "$delegation_socket" ] || reject HERMES_DELEGATION_SOCKET_PATH "must be $delegation_socket"
    emit HERMES_DELEGATION_SOCKET_PATH "$answer"
    ask HERMES_DELEGATION_SOCKET_GROUP_ID "Numeric GID of hermes-agents" ""
    require_integer HERMES_DELEGATION_SOCKET_GROUP_ID "$answer"
    emit HERMES_DELEGATION_SOCKET_GROUP_ID "$answer"
    ask HERMES_DELEGATION_PEERS_JSON "Delegation peers (compact JSON array, no tokens)" ""
    require_json_array HERMES_DELEGATION_PEERS_JSON "$answer"
    peers_json=$answer
    peer_profiles=$(json_query "$peers_json" '[.[] | .sourceAgentId, .targetAgentId] | map(tostring) | join(" ")') || \
      reject HERMES_DELEGATION_PEERS_JSON "must be a JSON array of peers"
    for peer_profile in $peer_profiles; do
      contains_profile "$peer_profile" || reject HERMES_DELEGATION_PEERS_JSON "references an unknown profile"
    done
    token_names=$(json_query "$peers_json" '[.[] | .tokenEnvironment | tostring] | join(" ")') || \
      reject HERMES_DELEGATION_PEERS_JSON "must name a token variable for every peer"
    emit HERMES_DELEGATION_PEERS_JSON "$peers_json"
    for token_name in $token_names; do
      case "$token_name" in HERMES_*_PEER_TOKEN) ;; *) reject HERMES_DELEGATION_PEERS_JSON "token variables must match HERMES_<NAME>_PEER_TOKEN" ;; esac
      require_charset HERMES_DELEGATION_PEERS_JSON "$token_name" 'A-Z0-9_' "token variables must match HERMES_<NAME>_PEER_TOKEN"
      ask_secret "$token_name" "Peer token for $token_name"
      emit "$token_name" "$answer"
    done
  fi
fi

# Google Calendar
ask_yes_no "Configure Google Calendar" "yes"
if [ "$answer" = yes ]; then
  set -- "$@" --require calendar
  ask PIH_HTTPS_ORIGIN "Private PIH HTTPS origin (https://<private-host>)" ""
  case "$answer" in https://?*) ;; *) reject PIH_HTTPS_ORIGIN "must be an https:// origin" ;; esac
  require_charset PIH_HTTPS_ORIGIN "${answer#https://}" 'A-Za-z0-9.:-' "must be an origin without path, query or credentials"
  pih_origin=$answer
  ask GOOGLE_CALENDAR_OAUTH_REDIRECT_URI "Google OAuth redirect URI" "$pih_origin$calendar_callback_path"
  [ "$answer" = "$pih_origin$calendar_callback_path" ] || \
    reject GOOGLE_CALENDAR_OAUTH_REDIRECT_URI "must be the Calendar callback on the configured PIH HTTPS origin"
  emit GOOGLE_CALENDAR_OAUTH_REDIRECT_URI "$answer"
  ask_secret GOOGLE_CALENDAR_CLIENT_ID "Google OAuth client ID"
  emit GOOGLE_CALENDAR_CLIENT_ID "$answer"
  ask_secret GOOGLE_CALENDAR_CLIENT_SECRET "Google OAuth client secret"
  emit GOOGLE_CALENDAR_CLIENT_SECRET "$answer"
  emit GOOGLE_CALENDAR_OAUTH_STATE_TTL_SECONDS 600
  emit GOOGLE_CALENDAR_PROPOSAL_TTL_SECONDS 900
  emit GOOGLE_CALENDAR_RETENTION_INTERVAL_SECONDS 3600
  ask GOOGLE_CALENDAR_ACTIVE_ENCRYPTION_KEY_ID "Active Calendar encryption key ID" ""
  case "$answer" in [A-Za-z0-9]*) ;; *) reject GOOGLE_CALENDAR_ACTIVE_ENCRYPTION_KEY_ID "must start with a letter or digit" ;; esac
  require_charset GOOGLE_CALENDAR_ACTIVE_ENCRYPTION_KEY_ID "$answer" 'A-Za-z0-9._-' "must be a key identifier"
  [ "${#answer}" -le 64 ] || reject GOOGLE_CALENDAR_ACTIVE_ENCRYPTION_KEY_ID "is too long"
  emit GOOGLE_CALENDAR_ACTIVE_ENCRYPTION_KEY_ID "$answer"
  ask_secret GOOGLE_CALENDAR_ENCRYPTION_KEYS_JSON "Calendar encryption keyring (compact JSON array)"
  require_json_array GOOGLE_CALENDAR_ENCRYPTION_KEYS_JSON "$answer"
  emit GOOGLE_CALENDAR_ENCRYPTION_KEYS_JSON "$answer"
  ask_secret GOOGLE_CALENDAR_BLIND_INDEX_KEY "Calendar blind-index key (base64url, 32 bytes)"
  require_base64url_key GOOGLE_CALENDAR_BLIND_INDEX_KEY "$answer"
  emit GOOGLE_CALENDAR_BLIND_INDEX_KEY "$answer"
fi

# Device connection
ask_yes_no "Configure a device connection" "no"
if [ "$answer" = yes ]; then
  set -- "$@" --require devices
  emit DEVICE_CONNECTIONS_ENABLED true
  ask DEVICE_CONNECTION_ID "Device connection ID" ""
  require_profile_id DEVICE_CONNECTION_ID "$answer"
  emit DEVICE_CONNECTION_ID "$answer"
  ask DEVICE_CONNECTION_LABEL "Device connection label" ""
  emit DEVICE_CONNECTION_LABEL "$answer"
  ask DEVICE_CONNECTION_BRIDGE_SOCKET_PATH "Private bridge socket path" ""
  case "$answer" in /*.sock) ;; *) reject DEVICE_CONNECTION_BRIDGE_SOCKET_PATH "must be an absolute .sock path" ;; esac
  case "$answer" in /run/pih-connectors/web/*|/run/pih-connectors/agents/*) reject DEVICE_CONNECTION_BRIDGE_SOCKET_PATH "must stay outside the BFF and delegation sockets" ;; esac
  require_charset DEVICE_CONNECTION_BRIDGE_SOCKET_PATH "$answer" 'A-Za-z0-9._/-' "must be a plain absolute path"
  emit DEVICE_CONNECTION_BRIDGE_SOCKET_PATH "$answer"
  ask DEVICE_CONNECTION_HUMAN_ACTOR "Bridge actor label for the owner" "owner"
  require_charset DEVICE_CONNECTION_HUMAN_ACTOR "$answer" 'a-z0-9_-' "must be a lowercase actor label"
  emit DEVICE_CONNECTION_HUMAN_ACTOR "$answer"
  ask DEVICE_CONNECTION_OWNER_ACTOR_ID "PIH owner actor ID (UUID of the only person allowed)" ""
  case "$answer" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
    *) reject DEVICE_CONNECTION_OWNER_ACTOR_ID "must be a lowercase UUID" ;;
  esac
  emit DEVICE_CONNECTION_OWNER_ACTOR_ID "$answer"
  ask DEVICE_CONNECTION_AGENT_ACTORS_JSON "Agent profile to bridge actor map (compact JSON object)" "{}"
  case "$answer" in \{*\}) ;; *) reject DEVICE_CONNECTION_AGENT_ACTORS_JSON "must be a compact JSON object" ;; esac
  agent_profiles=$(json_query "$answer" 'keys | join(" ")') || reject DEVICE_CONNECTION_AGENT_ACTORS_JSON "must be a JSON object"
  for agent_profile in $agent_profiles; do
    contains_profile "$agent_profile" || reject DEVICE_CONNECTION_AGENT_ACTORS_JSON "references an unknown profile"
  done
  emit DEVICE_CONNECTION_AGENT_ACTORS_JSON "$answer"
fi

# Write a root-only candidate next to the live file, validate it with the
# installed runtime under the systemd manager, then rename it into place.
if [ -L "$config_directory" ]; then reject output "the configuration directory must not be a symbolic link"; fi
if [ ! -d "$config_directory" ]; then mkdir -m 0700 "$config_directory"; fi
case "$(stat -c '%u:%g:%a' "$config_directory")" in
  0:0:700|0:0:750|0:0:755) ;;
  *) reject output "the configuration directory must be root-owned and not group or world writable" ;;
esac
candidate=$(mktemp "$config_directory/.connectors.env.candidate.XXXXXX")
printf '%s' "$lines" > "$candidate"
lines=
answer=
chown 0:0 "$candidate"
chmod 0600 "$candidate"
if [ ! -f "$candidate" ] || [ -L "$candidate" ] || [ "$(stat -c '%u:%g:%a' "$candidate")" != "0:0:600" ]; then
  reject output "the candidate file is not a root:root mode 0600 regular file"
fi

echo "Validating the candidate with the installed connectors runtime..." >&2
if ! systemd-run --quiet --wait --pipe --collect --service-type=exec \
  -p UMask=0077 -p NoNewPrivileges=yes -p PrivateNetwork=yes -p ProtectSystem=strict -p PrivateTmp=yes \
  -p "EnvironmentFile=$candidate" -- \
  "$connectors_node" "$validator" "$@" < /dev/null; then
  echo "Validation failed; $target_file was not changed." >&2
  exit 1
fi

mv -f -- "$candidate" "$target_file"
candidate=
echo "Wrote $target_file (root:root 0600) with fields:$fields" >&2
echo "Restart the connectors service through the reviewed release process to apply it." >&2
