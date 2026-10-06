#!/usr/bin/env bash
# Connects a Pin account (Trinidad and Tobago number) through Pin Bridge. Sends a REAL SMS.
#
#   ./connect.sh "+1 868 XXX XXXX" "Display Name"
#
# Prints the connection id at the end; use it with publish.sh.
set -euo pipefail
cd "$(dirname "$0")"

phone=${1:?usage: $0 PHONE [DISPLAY_NAME]}
name=${2:-Pin Bridge Test}

# Read a top-level string field from a JSON body without requiring jq.
field() { grep -o "\"$1\": *\"[^\"]*\"" | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/'; }

echo "POST /v1/connections"
res=$(./pb.sh POST /v1/connections "{\"phone\":\"$phone\",\"display_name\":\"$name\"}")
echo "$res"
id=$(printf '%s' "$res" | field id)
status=$(printf '%s' "$res" | field status)
if [ -z "$id" ]; then
  echo "No connection id in the response." >&2
  exit 1
fi
if [ "$status" = "active" ]; then
  echo
  echo "Already connected. Connection id: $id"
  exit 0
fi

while true; do
  echo
  read -r -p "SMS code (or 'resend'): " code
  if [ "$code" = "resend" ]; then
    ./pb.sh POST "/v1/connections/$id/resend"
    continue
  fi
  res=$(./pb.sh POST "/v1/connections/$id/confirm" "{\"code\":\"$code\"}")
  echo "$res"
  if [ "$(printf '%s' "$res" | field status)" = "active" ]; then
    break
  fi
done

echo
echo "Connected. Connection id: $id"
echo "Next: PB_CONNECTION_ID=$id ./publish.sh"
