#!/usr/bin/env bash
# Enrolls an agency the way a CRM deployment does (POST /v1/platform/agencies) and saves the
# credentials to pb-credentials.env (mode 600).
#
#   export PB_PLATFORM_SIGNING_SECRET=...
#   ./platform-enroll.sh morelli-realty "Morelli Realty" [https://morelli-realty.duckcrm.one/api/pin-bridge/webhook]
#
# Before the call, the agency's domain must serve the proof printed below at
#   https://<slug>.duckcrm.one/.well-known/pin-bridge-enroll
# Keep PB_CLIENT_REQUEST_ID fixed so the published proof stays valid: rerunning with it gives the
# same agency fresh keys (the old ones stop working). No operator or invite code is involved.
set -euo pipefail
cd "$(dirname "$0")"
PB_URL=${PB_URL:-https://bridge.duckcrm.one}
: "${PB_PLATFORM_SIGNING_SECRET:?set PB_PLATFORM_SIGNING_SECRET}"
slug=${1:?usage: $0 SLUG NAME [WEBHOOK_URL]}
name=${2:?usage: $0 SLUG NAME [WEBHOOK_URL]}
webhook=${3:-}
request_id=${PB_CLIENT_REQUEST_ID:-$(openssl rand -hex 16)}
proof=$(printf '%s' "$request_id" | openssl dgst -sha256 -hex | awk '{print $NF}')
echo "PB_CLIENT_REQUEST_ID=$request_id"
echo "Proof to serve at /.well-known/pin-bridge-enroll: $proof"
if [ -z "${PB_PROOF_READY:-}" ]; then
  read -r -p "Press Enter once the proof is served... "
fi
proof_url="https://$slug.duckcrm.one/.well-known/pin-bridge-enroll"
served=$(curl -sS --max-time 10 "$proof_url" 2>/dev/null | tr -d '[:space:]' || true)
if [ "$served" != "$proof" ]; then
  echo "Warning: $proof_url does not serve the proof yet (got: ${served:-nothing})." >&2
fi

body="{\"slug\":\"$slug\",\"name\":\"$name\",\"client_request_id\":\"$request_id\""
if [ -n "$webhook" ]; then
  body="$body,\"webhook_url\":\"$webhook\""
fi
body="$body}"

res=$(PB_API_KEY=platform PB_SIGNING_SECRET=$PB_PLATFORM_SIGNING_SECRET \
  ./pb.sh POST /v1/platform/agencies "$body")
status=$(printf '%s' "$res" | tail -n 1)
json=$(printf '%s' "$res" | sed '$d')

field() { printf '%s' "$json" | grep -o "\"$1\": *\"[^\"]*\"" | sed -n "${2:-1}p" | sed 's/.*"\([^"]*\)"$/\1/'; }

if [ "$status" != "HTTP 201" ]; then
  echo "$status: $json" >&2
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
