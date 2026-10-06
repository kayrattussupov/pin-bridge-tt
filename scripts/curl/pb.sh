#!/usr/bin/env bash
# Signed request to Pin Bridge with curl. Needs bash, curl and openssl (macOS, Linux, WSL, Git Bash).
#
#   export PB_API_KEY=pb_... PB_SIGNING_SECRET=...
#   ./pb.sh GET /v1/me
#   ./pb.sh POST /v1/listings/validate '{"listing":{...}}'
#   ./pb.sh PUT /v1/connections/<id>/listings/8842 @listing.json
#
# Prints the response body, then "HTTP <status>" on the last line.
# Optional: PB_IDEMPOTENCY_KEY (sent as Idempotency-Key), and for negative tests
# PB_TIMESTAMP, PB_NONCE, PB_SIGNATURE (override the computed values).
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "usage: $0 METHOD PATH [JSON | @file]" >&2
  exit 2
fi
PB_URL=${PB_URL:-https://bridge.duckcrm.one}
: "${PB_API_KEY:?set PB_API_KEY}" "${PB_SIGNING_SECRET:?set PB_SIGNING_SECRET}"

method=$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')
path=$2
body=${3:-}
if [ "${body:0:1}" = "@" ]; then
  body=$(cat "${body:1}")
fi

timestamp=${PB_TIMESTAMP:-$(date +%s)}
nonce=${PB_NONCE:-$(openssl rand -hex 16)}
body_hash=$(printf '%s' "$body" | openssl dgst -sha256 -hex | awk '{print $NF}')
canonical=$(printf '%s\n%s\n%s\n%s\n%s' "$timestamp" "$nonce" "$method" "$path" "$body_hash")
signature=${PB_SIGNATURE:-v1=$(printf '%s' "$canonical" | openssl dgst -sha256 -hmac "$PB_SIGNING_SECRET" -hex | awk '{print $NF}')}

args=(
  -sS -X "$method" "${PB_URL%/}$path"
  -H "Authorization: Bearer $PB_API_KEY"
  -H "X-Timestamp: $timestamp"
  -H "X-Nonce: $nonce"
  -H "X-Signature: $signature"
  -w '\nHTTP %{http_code}\n'
)
if [ -n "$body" ]; then
  args+=(-H 'Content-Type: application/json' --data-binary "$body")
fi
if [ -n "${PB_IDEMPOTENCY_KEY:-}" ]; then
  args+=(-H "Idempotency-Key: $PB_IDEMPOTENCY_KEY")
fi

exec curl "${args[@]}"
