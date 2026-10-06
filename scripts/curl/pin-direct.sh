#!/usr/bin/env bash
# Calls pin.tt directly with an EXISTING device key and user token, bypassing Pin Bridge.
# For testing the publishing endpoints by hand. Needs bash and curl (macOS, Linux, WSL, Git Bash).
#
#   export PIN_DEVICE_KEY=... PIN_TOKEN=...      (or: source pin-test.env)
#   ./pin-direct.sh my                            items of the token's user (front_my)
#   ./pin-direct.sh find <external_id>            same, only the item with this external_id
#   ./pin-direct.sh tree | form [rubric] | cities | districts <city_id>     dictionaries
#   ./pin-direct.sh pic <photo.jpg>               upload a picture, prints its id
#   ./pin-direct.sh validate <item.json>          dry run (validate_ad), creates nothing
#   ./pin-direct.sh create <item.json>            REAL listing (asks first; not idempotent)
#   ./pin-direct.sh update <item_id> <item.json>  full edit
#   ./pin-direct.sh patch <item_id> '<json>'      partial edit, e.g. '{"price":3400}'
#   ./pin-direct.sh toggle <item_id>              published <-> hidden (asks first)
#   ./pin-direct.sh remove <item_id>              remove from pin.tt (asks first)
#
# The token cannot be renewed, so this script never calls device_api_key or phone_verify and never
# prints the key or the token. Headers go to curl through a file descriptor, not the command line.
#
# Pin lets in only allowlisted IPs (Cloudflare 403 otherwise). From a computer outside the allowlist
# go through the Pin Bridge server:  ssh -N -D 1080 user@server   and  PIN_PROXY=socks5h://127.0.0.1:1080
# Prints the response body, then "HTTP <status>" on the last line. PIN_YES=1 skips the questions.
set -euo pipefail

: "${PIN_DEVICE_KEY:?set PIN_DEVICE_KEY (or source pin-test.env)}"
: "${PIN_TOKEN:?set PIN_TOKEN (or source pin-test.env)}"
base=${PIN_BASE_URL:-https://pin.tt}/api/v1.6

# Auth headers live in a private temp file (curl -H @file), so they never show up in `ps`.
headers=$(umask 077 && mktemp)
trap 'rm -f "$headers"' EXIT
printf 'Device-Api-Key: %s\nAuthorization: Token %s\nAccept: application/json\n' \
  "$PIN_DEVICE_KEY" "$PIN_TOKEN" >"$headers"

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

pretty() {
  if command -v jq >/dev/null 2>&1; then jq . 2>/dev/null || cat; else cat; fi
}

# pin METHOD PATH [curl args...]: one request with both auth headers.
pin() {
  local method=$1 path=$2
  shift 2
  local proxy=()
  [ -n "${PIN_PROXY:-}" ] && proxy=(--proxy "$PIN_PROXY")
  local out code
  out=$(mktemp)
  code=$(curl -4 -sS --max-time "${PIN_TIMEOUT:-60}" -X "$method" "${proxy[@]}" \
    -H "@$headers" -o "$out" -w '%{http_code}' "$@" "$base$path") || true
  if [ "$(head -c 1 "$out")" = "<" ]; then
    echo "(HTML page, not JSON: $(head -c 120 "$out" | tr -d '\r\n')…)"
  else
    pretty <"$out"
  fi
  rm -f "$out"
  echo
  echo "HTTP $code"
  if [ "$code" = 403 ] && [ -z "${PIN_PROXY:-}" ]; then
    echo "hint: 403 is usually Cloudflare: this IP is not allowlisted, use PIN_PROXY (see the top of $0)" >&2
  fi
  [ "${code:0:1}" = 2 ]
}

json() { pin "$@" -H 'Content-Type: application/json'; }

body_of() {
  [ -f "$1" ] || { echo "no such file: $1" >&2; exit 2; }
  echo "--data-binary"
  echo "@$1"
}

confirm() {
  [ "${PIN_YES:-}" = 1 ] && return 0
  read -r -p "$1 [y/N] " answer
  [ "$answer" = y ] || { echo "cancelled"; exit 1; }
}

external_id_of() {
  sed -n 's/.*"external_id": *"\([^"]*\)".*/\1/p' "$1" | head -n 1
}

cmd=${1:-}
[ -n "$cmd" ] || usage
shift

case "$cmd" in
  my) pin GET "/items/front_my/${1:+?page=$1}" ;;
  find)
    [ $# -eq 1 ] || usage
    # Not paginated here: enough for a test account with a handful of items.
    pin GET /items/front_my/ | grep -E "\"external_id\": *\"$1\"|HTTP" || echo "not found on page 1"
    ;;
  tree) pin GET /items/tree_v2/ ;;
  form) pin GET "/items/rubric_form/${1:-21}/" ;;
  cities) pin GET /items/all_cities/ ;;
  districts)
    [ $# -eq 1 ] || usage
    pin GET "/items/city_districts/$1/"
    ;;
  pic)
    [ $# -eq 1 ] && [ -f "$1" ] || usage
    pin POST /items/pics/ -F "img=@$1"
    ;;
  validate)
    [ $# -eq 1 ] || usage
    mapfile -t data < <(body_of "$1")
    json POST /items/validate_ad/ "${data[@]}"
    ;;
  create)
    [ $# -eq 1 ] || usage
    mapfile -t data < <(body_of "$1")
    ext=$(external_id_of "$1")
    echo "== checking that $ext is not on Pin yet (create is not idempotent)"
    if PIN_YES=1 "$0" find "$ext" | grep -q '"external_id"'; then
      echo "already on Pin: use update <item_id> instead of create" >&2
      exit 1
    fi
    confirm "Publish a REAL listing ($ext) on pin.tt?"
    json POST /items/ "${data[@]}"
    ;;
  update)
    [ $# -eq 2 ] || usage
    mapfile -t data < <(body_of "$2")
    json POST "/items/$1/" "${data[@]}"
    ;;
  patch)
    [ $# -eq 2 ] || usage
    json PATCH "/items/$1/partial_update/" --data-binary "$2"
    ;;
  toggle)
    [ $# -eq 1 ] || usage
    confirm "Flip published/hidden for item $1?"
    pin POST "/items/toggle_active/$1/"
    ;;
  remove)
    [ $# -eq 1 ] || usage
    confirm "Remove item $1 from pin.tt?"
    pin POST "/items/to_remove/$1/"
    ;;
  *) usage ;;
esac
