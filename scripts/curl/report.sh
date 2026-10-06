#!/usr/bin/env bash
# Runs the read-only checks plus a webhook round trip and writes everything to one file
# (pb-report.txt) that is safe to share: the API key and secrets are masked.
# Nothing is published and no SMS is sent.
#
#   export PB_API_KEY=pb_... PB_SIGNING_SECRET=...
#   export PB_WEBHOOK_URL=https://webhook.site/<uuid>   # optional, enables the webhook checks
#   ./report.sh
set -uo pipefail
cd "$(dirname "$0")"
PB_URL=${PB_URL:-https://bridge.duckcrm.one}
: "${PB_API_KEY:?set PB_API_KEY}" "${PB_SIGNING_SECRET:?set PB_SIGNING_SECRET}"

report=${PB_REPORT:-pb-report.txt}

# section <title> <command...>: prints the command and its full output.
section() {
  local title=$1
  shift
  echo
  echo "=== $title"
  echo "\$ $*"
  "$@" 2>&1
}

run() {
  echo "Pin Bridge report, $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "PB_URL=$PB_URL"
  echo "Client IP: $(curl -4 -s --max-time 5 ifconfig.me || echo unknown)"

  section "Smoke test" ./smoke.sh

  section "Who am I" ./pb.sh GET /v1/me
  section "Connections" ./pb.sh GET /v1/connections
  section "Rent attributes (full)" ./pb.sh GET /v1/dictionaries/categories/residential_rent/attributes
  section "Sale attributes (full)" ./pb.sh GET /v1/dictionaries/categories/residential_sale/attributes
  section "Validate examples/listing.json" ./pb.sh POST /v1/listings/validate \
    "{\"listing\":$(cat examples/listing.json)}"

  if [ -n "${PB_WEBHOOK_URL:-}" ]; then
    section "Set webhook" ./pb.sh PUT /v1/webhooks "{\"url\":\"$PB_WEBHOOK_URL\",\"events\":[]}"
    section "Get webhook" ./pb.sh GET /v1/webhooks
    section "Send ping" ./pb.sh POST /v1/webhooks/test
    echo
    echo "(waiting 15 s for the delivery)"
    sleep 15
    section "Deliveries" ./pb.sh GET '/v1/webhooks/deliveries?limit=5'
  else
    echo
    echo "=== Webhooks skipped (set PB_WEBHOOK_URL to test them)"
  fi
}

# Mask credentials before anything reaches the file.
run | sed \
  -e "s|$PB_API_KEY|pb_***|g" \
  -e "s|$PB_SIGNING_SECRET|***|g" \
  -e 's|"signing_secret": *"[^"]*"|"signing_secret":"***"|g' |
  tee "$report"

echo
echo "Saved to $(pwd)/$report"
