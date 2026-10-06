#!/usr/bin/env bash
# Read-only checks of a deployed Pin Bridge, run from your own computer.
# Nothing is published and no SMS is sent.
#
#   export PB_API_KEY=pb_... PB_SIGNING_SECRET=...
#   ./smoke.sh
set -uo pipefail
cd "$(dirname "$0")"
PB_URL=${PB_URL:-https://bridge.duckcrm.one}
: "${PB_API_KEY:?set PB_API_KEY}" "${PB_SIGNING_SECRET:?set PB_SIGNING_SECRET}"
PB_URL=${PB_URL%/}

passed=0
failed=0
out=$(mktemp)
trap 'rm -f "$out"' EXIT

# check <name> <expected status regex> <command...>: runs a command whose last output line is
# "HTTP <code>" and compares the code.
check() {
  local name=$1 expected=$2
  shift 2
  "$@" >"$out" 2>&1
  local status
  status=$(tail -n 1 "$out" | sed -n 's/^HTTP //p')
  if [[ "$status" =~ ^($expected)$ ]]; then
    passed=$((passed + 1))
    printf '  ok    %-52s HTTP %s\n' "$name" "$status"
  else
    failed=$((failed + 1))
    printf '  FAIL  %-52s HTTP %s (expected %s)\n' "$name" "${status:-none}" "$expected"
    sed '$d' "$out" | head -c 600 | sed 's/^/        /'
    echo
  fi
}

# Response body of the last check.
body() { sed '$d' "$out"; }

plain() { curl -sS -w '\nHTTP %{http_code}\n' "$@"; }

echo "Pin Bridge: $PB_URL"
echo
echo "Public endpoints"
check "GET /health/live" 200 plain "$PB_URL/health/live"
# Caddy (https) hides readiness; a plain http URL talks to the API directly.
if [[ "$PB_URL" == https://* ]]; then
  check "GET /health/ready is hidden by Caddy" 404 plain "$PB_URL/health/ready"
  check "GET /metrics is hidden by Caddy" 404 plain "$PB_URL/metrics"
fi

echo
echo "Authentication"
check "no credentials -> 401" 401 plain "$PB_URL/v1/me"
check "wrong signature -> 401" 401 env PB_SIGNATURE=v1=deadbeef ./pb.sh GET /v1/me
check "timestamp 10 minutes old -> 401" 401 env PB_TIMESTAMP=$(($(date +%s) - 600)) ./pb.sh GET /v1/me
check "GET /v1/me" 200 ./pb.sh GET /v1/me
echo "        $(body | tr -d '\n' | head -c 300)"
nonce=$(openssl rand -hex 16)
check "first use of a nonce" 200 env PB_NONCE="$nonce" ./pb.sh GET /v1/me
check "replayed nonce -> 401" 401 env PB_NONCE="$nonce" ./pb.sh GET /v1/me

echo
echo "Pin reference data (503 dictionary_unavailable = the worker could not reach Pin yet)"
check "GET /v1/dictionaries/categories" 200 ./pb.sh GET /v1/dictionaries/categories
check "GET /v1/dictionaries/regions" 200 ./pb.sh GET /v1/dictionaries/regions
check "GET /v1/dictionaries/regions/central/districts" 200 ./pb.sh GET /v1/dictionaries/regions/central/districts
check "GET .../categories/residential_rent/attributes" 200 ./pb.sh GET /v1/dictionaries/categories/residential_rent/attributes

echo
echo "Listing validation (dry run, nothing reaches Pin)"
check "validate an invalid listing -> valid:false" 200 ./pb.sh POST /v1/listings/validate \
  '{"listing":{"external_id":"smoke-1","category":"residential_rent","title":"x","price":-1,"region":"mars"}}'
if body | grep -q '"valid":false'; then
  echo "        valid:false, as expected"
else
  failed=$((failed + 1))
  echo "  FAIL  expected valid:false: $(body | head -c 300)"
fi
check "validate examples/listing.json" 200 ./pb.sh POST /v1/listings/validate \
  "{\"listing\":$(cat examples/listing.json)}"
echo "        $(body | tr -d '\n' | head -c 600)"

echo
echo "Connections and listings"
check "GET /v1/connections" 200 ./pb.sh GET /v1/connections
check "unknown connection -> 404" 404 ./pb.sh GET /v1/connections/00000000-0000-0000-0000-000000000000/listings

echo
echo "passed: $passed, failed: $failed"
[ "$failed" -eq 0 ]
