#!/usr/bin/env bash
# Report of what Pin Bridge published to Pin: per listing the Pin item id, title, price, times
# and the status history, plus failed Pin calls from the worker log. For questions to Pin support.
#
# Run on the bridge server:
#   bash scripts/server/publish-report.sh                # last 24 hours, all agencies
#   bash scripts/server/publish-report.sh 48 dev         # last 48 hours, agency "dev"
# Writes /root/pin-publish-report-<timestamp>.txt and prints it.
set -euo pipefail

HOURS="${1:-24}"
SLUG="${2:-}"
[[ "$HOURS" =~ ^[0-9]+$ ]] || { echo "hours must be a number"; exit 2; }
cd "${PIN_BRIDGE_DIR:-/opt/pin-bridge}"
OUT="/root/pin-publish-report-$(date -u +%Y%m%d-%H%M%S).txt"

psql_run() {
  docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 "$@"' psql "$@"
}

{
  echo "Pin Bridge publish report, generated $(date -u '+%Y-%m-%d %H:%M UTC'), last $HOURS h${SLUG:+, agency $SLUG}"
  echo "Times are UTC (Trinidad = UTC-4)."
  echo

  psql_run -v hours="$HOURS" -v slug="$SLUG" <<'SQL'
\pset footer off
\echo '== Pin accounts'
select a.slug as agency, c.phone_e164 as phone, c.pin_user_id, c.status
from connections c join agencies a on a.id = c.agency_id
where (:'slug' = '' or a.slug = :'slug') order by a.slug;

\echo '== Listings'
select a.slug as agency, l.external_id, l.rubric,
       l.payload->>'title' as title, l.payload->>'price' as price,
       l.pin_item_id, l.sync_state, l.desired_state, l.pin_status,
       l.last_error->>'code' as error,
       to_char(l.created_at, 'MM-DD HH24:MI') as first_sent,
       to_char(l.last_synced_at, 'MM-DD HH24:MI') as published
from listings l join agencies a on a.id = l.agency_id
where l.updated_at > now() - make_interval(hours => :'hours'::int)
  and (:'slug' = '' or a.slug = :'slug')
order by l.created_at;

\echo '== History (events sent to the agency)'
select to_char(o.created_at, 'MM-DD HH24:MI:SS') as at, l.external_id,
       o.event, o.payload->'data'->'listing'->'pin'->>'item_id' as pin_item_id,
       o.payload->'data'->'listing'->'pin'->>'status' as pin_status,
       o.payload->'data'->>'reason' as reason
from webhook_outbox o
join listings l on l.external_id = o.payload->'data'->'listing'->>'external_id'
               and l.connection_id::text = o.payload->'data'->'listing'->>'connection_id'
join agencies a on a.id = l.agency_id
where o.created_at > now() - make_interval(hours => :'hours'::int)
  and (:'slug' = '' or a.slug = :'slug')
order by o.created_at;
SQL

  echo
  echo "== Failed Pin calls and removals seen by the worker (successful calls are not logged)"
  docker compose logs worker --no-log-prefix --since "${HOURS}h" 2>/dev/null \
    | grep -E 'pin call failed|listing sync failed|pin item vanished|deleted_on_pin' \
    | python3 -c '
import json, sys, datetime
for line in sys.stdin:
    try:
        e = json.loads(line)
    except ValueError:
        continue
    t = datetime.datetime.utcfromtimestamp(e.get("time", 0) / 1000).strftime("%m-%d %H:%M:%S")
    errs = "; ".join(str(x.get("field")) + ": " + str(x.get("message")) for x in e.get("pinErrors") or [])
    print(t, e.get("endpoint") or "", e.get("httpStatus") or "", e.get("msg") or "", e.get("listingId") or "", errs)
' || true
} | tee "$OUT"

echo
echo "Saved to $OUT"
