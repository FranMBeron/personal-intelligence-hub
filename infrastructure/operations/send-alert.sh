#!/bin/sh
set -eu

unit_name=${1:-personal-intelligence-hub}
alert_url=${PIH_ALERT_WEBHOOK_URL:-}
host_name=$(hostname)
message="Personal Intelligence Hub operation failed on $host_name: $unit_name"

logger --tag personal-intelligence-hub "$message"
if [ -z "$alert_url" ]; then
  echo "PIH_ALERT_WEBHOOK_URL is not configured; failure was logged locally." >&2
  exit 1
fi
case "$alert_url" in
  https://*|http://127.0.0.1:*|http://localhost:*) ;;
  *)
    echo "Alert webhook must use HTTPS or a loopback HTTP endpoint." >&2
    exit 1
    ;;
esac

payload=$(jq -cn \
  --arg service "$unit_name" \
  --arg host "$host_name" \
  --arg message "$message" \
  '{service: $service, host: $host, message: $message}')
curl --fail --silent --show-error \
  --connect-timeout 5 \
  --max-time 15 \
  --header 'content-type: application/json' \
  --data-binary "$payload" \
  "$alert_url" > /dev/null
