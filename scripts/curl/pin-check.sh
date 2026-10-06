#!/usr/bin/env bash
# Calls pin.tt directly with plain curl, from the server itself (Pin Bridge does not need to be
# installed). Shows whether Pin lets this server in and writes everything to pin-check.txt,
# ready to send to Pin. The phone number, device key and token are masked in the file.
#
#   ./pin-check.sh                                  IP, device key, dictionaries (no SMS)
#   PIN_PHONE=+1868XXXXXXX ./pin-check.sh           ...and send an SMS code (counts against
#                                                   Pin's 5 SMS per 10 minutes)
#   PIN_PHONE=+1868XXXXXXX PIN_CODE=1234 PIN_DEVICE_KEY=<uuid from the previous run> ./pin-check.sh
#                                                   ...and exchange the code for a token
set -uo pipefail
cd "$(dirname "$0")"

base=${PIN_BASE_URL:-https://pin.tt}/api/v1.6
report=${PIN_REPORT:-pin-check.txt}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# pin <name> <curl args...>: one request over IPv4 (the address Pin allowlists), prints the status,
# the headers that tell Cloudflare apart from Pin, and the start of the body.
pin() {
  local name=$1
  shift
  echo
  echo "=== $name"
  local code
  : >"$tmp/body"
  code=$(curl -4 -sS --max-time 20 -o "$tmp/body" -D "$tmp/headers" -w '%{http_code}' \
    -H 'Accept: application/json' "$@" 2>"$tmp/err")
  echo "HTTP $code"
  [ -s "$tmp/err" ] && cat "$tmp/err"
  grep -iE '^(server|cf-ray|cf-mitigated|date):' "$tmp/headers" 2>/dev/null | tr -d '\r'
  echo "body: $(head -c 400 "$tmp/body" | tr -d '\r\n')"
  if grep -qiE 'cloudflare|cf-mitigated' "$tmp/headers" && [ "$code" = 403 ]; then
    echo "-> 403 from Cloudflare: this IP is not allowed"
  fi
  last_code=$code
}

run() {
  echo "Pin check, $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Host: $(hostname)"
  echo "IPv4: $(curl -4 -fs --max-time 5 ifconfig.me || echo none)"
  echo "IPv6: $(curl -6 -fs --max-time 5 ifconfig.me || echo none)"
  echo "Pin:  $base"

  device_key=${PIN_DEVICE_KEY:-}
  if [ -z "$device_key" ]; then
    pin "1. POST /items/device_api_key/" -X POST -H 'Content-Type: application/json' -d '{}' \
      "$base/items/device_api_key/"
    # Prod returns the key as "id" (Pin's docs said "uuid").
    device_key=$(grep -oE '"(id|uuid)" *: *"[^"]+"' "$tmp/body" | head -1 | sed -E 's/.*: *"([^"]+)"/\1/')
    if [ -z "$device_key" ]; then
      echo
      echo "RESULT: Pin did not issue a device key (HTTP $last_code). Nothing else can work."
      return
    fi
    echo "device key: $device_key"
  fi
  dk=(-H "Device-Api-Key: $device_key")

  pin "2. GET /items/tree_v2/" "${dk[@]}" "$base/items/tree_v2/"
  pin "3. GET /items/rubric_form/21/" "${dk[@]}" "$base/items/rubric_form/21/"
  pin "4. GET /items/all_cities/" "${dk[@]}" "$base/items/all_cities/"

  if [ -n "${PIN_PHONE:-}" ] && [ -z "${PIN_CODE:-}" ]; then
    pin "5. GET /users/phone_verify/ (sends an SMS)" "${dk[@]}" -G \
      --data-urlencode "phone=$PIN_PHONE" --data-urlencode 'check_type=sms' \
      "$base/users/phone_verify/"
    echo
    echo "Run again with PIN_CODE=<code from the SMS> PIN_DEVICE_KEY=$device_key"
  elif [ -n "${PIN_PHONE:-}" ]; then
    pin "6. POST /users/phone_verify/?token=1" "${dk[@]}" -X POST \
      -H 'Content-Type: application/json' \
      -d "{\"phone\":\"$PIN_PHONE\",\"code\":\"$PIN_CODE\",\"check_type\":\"sms\"}" \
      "$base/users/phone_verify/?token=1"
    if grep -q '"token"' "$tmp/body"; then
      echo "-> token issued: the whole login flow works from this server"
    fi
  fi

  echo
  echo "RESULT: device key issued, Pin lets this server in."
}

mask() {
  sed -E \
    -e 's/("token" *: *")[^"]*/\1***/g' \
    -e 's/(Device-Api-Key=|device key: |PIN_DEVICE_KEY=)([0-9a-fA-F-]{8})[0-9a-fA-F-]*/\1\2***/g' \
    -e 's/(\+?1868)[0-9]{3}([0-9]{4})/\1***\2/g'
}

run 2>&1 | tee "$tmp/raw" | mask | tee "$report" >/dev/null
# The screen keeps the full device key (needed for the PIN_CODE step); the file is masked.
cat "$tmp/raw"
echo
echo "Saved to $report (masked, safe to send)"
