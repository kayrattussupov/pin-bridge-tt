#!/usr/bin/env bash
# Publishes a REAL listing on pin.tt through Pin Bridge, waits for the result, then removes it.
#
#   PB_CONNECTION_ID=<id from connect.sh> ./publish.sh [listing.json]
#
# The default listing is a rent below 4000 TT$, which Pin places for free.
# PB_KEEP=1 keeps the listing on Pin instead of removing it at the end.
set -euo pipefail
cd "$(dirname "$0")"
: "${PB_CONNECTION_ID:?set PB_CONNECTION_ID (from connect.sh)}"

file=${1:-examples/listing.json}
external_id=$(sed -n 's/.*"external_id": *"\([^"]*\)".*/\1/p' "$file" | head -n 1)
listing_path="/v1/connections/$PB_CONNECTION_ID/listings/$external_id"
field() { grep -o "\"$1\": *\"[^\"]*\"" | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/'; }

echo "== Dry run with Pin's own validation"
./pb.sh POST /v1/listings/validate "{\"connection_id\":\"$PB_CONNECTION_ID\",\"listing\":$(cat "$file")}"
echo
read -r -p "Publish $external_id on pin.tt? [y/N] " answer
[ "$answer" = "y" ] || exit 0

echo
echo "== PUT $listing_path"
PB_IDEMPOTENCY_KEY="publish-$external_id-$(date +%s)" ./pb.sh PUT "$listing_path" "@$file"

echo
echo "== Waiting for sync (up to 3 minutes)"
for _ in $(seq 1 36); do
  sleep 5
  res=$(./pb.sh GET "$listing_path")
  state=$(printf '%s' "$res" | field sync_state)
  echo "  sync_state=$state"
  if [ "$state" = "synced" ] || [ "$state" = "failed" ]; then
    break
  fi
done
echo "$res"

if [ "${PB_KEEP:-}" = "1" ]; then
  echo
  echo "Kept on Pin. Remove later with: ./pb.sh DELETE $listing_path"
  exit 0
fi

echo
read -r -p "Remove $external_id from pin.tt now? [Y/n] " answer
if [ "$answer" != "n" ]; then
  ./pb.sh DELETE "$listing_path"
  sleep 10
  ./pb.sh GET "$listing_path"
fi
