#!/usr/bin/env bash
# Redeems an invite code, like an agency's "Connect" button, and saves the credentials to
# pb-credentials.env (mode 600). Unsigned: POST /v1/enroll is the one public endpoint.
#
#   (PB_URL defaults to https://bridge.duckcrm.one)
#   ./enroll.sh pbi_... [https://webhook.site/<uuid>]
#   source pb-credentials.env      # sets PB_API_KEY and PB_SIGNING_SECRET for pb.sh
#
# If the call fails without an answer, rerun with the printed PB_CLIENT_REQUEST_ID to retry
# safely (same agency, fresh keys).
set -euo pipefail
cd "$(dirname "$0")"
PB_URL=${PB_URL:-https://bridge.duckcrm.one}
code=${1:?usage: $0 INVITE_CODE [WEBHOOK_URL]}
webhook=${2:-}
request_id=${PB_CLIENT_REQUEST_ID:-$(openssl rand -hex 16)}
echo "PB_CLIENT_REQUEST_ID=$request_id"

body="{\"invite_code\":\"$code\",\"client_request_id\":\"$request_id\""
if [ -n "$webhook" ]; then
  body="$body,\"webhook_url\":\"$webhook\""
fi
body="$body}"

res=$(curl -sS -X POST "${PB_URL%/}/v1/enroll" -H 'Content-Type: application/json' \
  --data-binary "$body" -w '\n%{http_code}')
status=$(printf '%s' "$res" | tail -n 1)
json=$(printf '%s' "$res" | sed '$d')

field() { printf '%s' "$json" | grep -o "\"$1\": *\"[^\"]*\"" | sed -n "${2:-1}p" | sed 's/.*"\([^"]*\)"$/\1/'; }

if [ "$status" != "201" ]; then
  echo "HTTP $status: $json" >&2
  exit 1
fi

umask 077
{
  echo "export PB_URL=${PB_URL%/}"
  echo "export PB_API_KEY=$(field api_key)"
  echo "export PB_SIGNING_SECRET=$(field signing_secret 1)"
  if [ -n "$webhook" ]; then
    echo "export PB_WEBHOOK_SECRET=$(field signing_secret 2)"
  fi
} >pb-credentials.env

echo "Agency: $(field slug) ($(field name)), key $(field key_prefix)"
echo "Saved to $(pwd)/pb-credentials.env. Next: source pb-credentials.env && ./pb.sh GET /v1/me"
