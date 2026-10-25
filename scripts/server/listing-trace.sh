#!/usr/bin/env bash
# Everything Pin Bridge knows about one listing, in order: what the CRM sent us, what we sent to
# Pin and what Pin answered, what we told the CRM. For investigations ("who hid this item?").
#
# Run on the bridge server:
#   bash scripts/server/listing-trace.sh P-02569 dev        # external_id and agency slug
#   bash scripts/server/listing-trace.sh P-02569 dev 72     # also look 72 h back in the logs (default 48)
# Writes /root/listing-trace-<external_id>-<timestamp>.txt and prints it.
#
# Pin request bodies are not stored. What Pin made of our request is in its answer to
# items.create / items.update (Pin echoes the item back). Pin answers are kept
# PIN_RESPONSE_RETENTION_DAYS days (since 2026-10-24), Docker logs until the container is recreated.
set -euo pipefail

EXT="${1:?usage: $0 EXTERNAL_ID AGENCY_SLUG [HOURS]}"
SLUG="${2:?usage: $0 EXTERNAL_ID AGENCY_SLUG [HOURS]}"
HOURS="${3:-48}"
[[ "$HOURS" =~ ^[0-9]+$ ]] || { echo "hours must be a number"; exit 2; }
cd "${PIN_BRIDGE_DIR:-/opt/pin-bridge}"
OUT="/root/listing-trace-${EXT//[^A-Za-z0-9_-]/_}-$(date -u +%Y%m%d-%H%M%S).txt"

psql_run() {
  docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 "$@"' psql "$@"
}

{
  echo "Pin Bridge listing trace: $SLUG / $EXT, generated $(date -u '+%Y-%m-%d %H:%M UTC')"
  echo "Times are UTC (Trinidad = UTC-4). Pin calls it reference number $SLUG.$EXT."
  echo

  psql_run -v ext="$EXT" -v slug="$SLUG" <<'SQL'
\set QUIET on
\pset footer off
\pset pager off
-- Every Pin item id this listing ever had: the current one, the ones reported to the CRM, and
-- the ones whose create/update answer carries our reference number.
create temp table ids as
select l.id as listing_id, l.connection_id, l.agency_id
from listings l join agencies a on a.id = l.agency_id
where a.slug = :'slug' and l.external_id = :'ext';

create temp table items as
select distinct item_id from (
  select l.pin_item_id as item_id from listings l join ids on ids.listing_id = l.id
  union
  select o.payload->'data'->'listing'->'pin'->>'item_id'
  from webhook_outbox o join ids on o.payload->'data'->'listing'->>'connection_id' = ids.connection_id::text
  where o.payload->'data'->'listing'->>'external_id' = :'ext'
  union
  select p.item_id from pin_responses p
  where p.endpoint <> 'items.front_my' and p.body->>'external_id' = :'slug' || '.' || :'ext'
) s where item_id is not null;

\echo '== 1. Listing now'
\x on
select a.slug as agency, c.phone_e164 as phone, c.pin_user_id, l.external_id, l.id as listing_id,
       l.connection_id, l.rubric, l.sync_state, l.desired_state, l.pin_item_id, l.pin_status,
       l.not_paid, l.moderator_comment, l.pin_seller_name, l.last_error, l.warnings, l.version,
       l.created_at, l.last_synced_at, l.status_checked_at, l.next_status_check_at
from listings l join ids on ids.listing_id = l.id
join agencies a on a.id = l.agency_id join connections c on c.id = l.connection_id;
\x off

\echo '== Pin item ids of this listing'
select item_id from items order by item_id;

\echo '== 2. What the CRM sent: the stored listing (last accepted PUT)'
select jsonb_pretty(l.payload) as payload from listings l join ids on ids.listing_id = l.id;

\echo '== 2b. Answers we gave to the CRM (idempotency keys, kept 24 h)'
select k.created_at, k.key, k.response_status, left(k.response_body::text, 400) as response
from idempotency_keys k join ids on ids.agency_id = k.agency_id
where k.key like :'ext' || ':%' order by k.created_at;

\echo '== 3. Pin: every answer about these items, oldest first'
\echo '   (front_my rows: what Pin listed for this item, or ABSENT when the item was not in the list)'
select p.created_at, p.endpoint, p.attempt, p.http_status, p.outcome, p.item_id, p.duration_ms
from pin_responses p
where p.item_id in (select item_id from items)
union all
select p.created_at, p.endpoint, p.attempt, p.http_status, p.outcome,
       coalesce((select r->>'id' from jsonb_array_elements(p.body->'results') r
                 where r->>'id' in (select item_id from items) limit 1), 'ABSENT'),
       p.duration_ms
from pin_responses p join ids on ids.connection_id = p.connection_id
where p.endpoint = 'items.front_my'
  and p.created_at >= (select coalesce(min(created_at), now()) from pin_responses
                       where item_id in (select item_id from items))
order by 1;

\echo '== 3b. Pin answers to item writes in full (create, update, toggle, remove)'
select p.created_at, p.endpoint, p.http_status, jsonb_pretty(p.body) as body
from pin_responses p
where p.item_id in (select item_id from items) and p.endpoint <> 'items.front_my'
order by p.created_at;

\echo '== 3c. What front_my said about the item, each time it changed'
select min(created_at) as first_seen, max(created_at) as last_seen, count(*) as times, item
from (
  select p.created_at, (select jsonb_pretty(r - 'images' - 'photos') from jsonb_array_elements(p.body->'results') r
                        where r->>'id' in (select item_id from items) limit 1) as item
  from pin_responses p join ids on ids.connection_id = p.connection_id
  where p.endpoint = 'items.front_my'
) s where item is not null
group by item order by first_seen;

\echo '== 4. What we told the CRM (webhooks)'
select o.created_at, o.event, o.delivered_at, o.last_status, o.attempts,
       o.payload->'data'->'listing'->>'sync_state' as sync_state,
       o.payload->'data'->'listing'->'pin'->>'item_id' as pin_item_id,
       o.payload->'data'->'listing'->'pin'->>'status' as pin_status,
       o.payload->'data'->>'reason' as reason,
       o.payload->'data'->'listing'->'last_error'->>'code' as error
from webhook_outbox o join ids on o.payload->'data'->'listing'->>'connection_id' = ids.connection_id::text
where o.payload->'data'->'listing'->>'external_id' = :'ext'
order by o.created_at;

\echo '== 5. Other Pin writes on the same Pin account in this time (bridge-made only)'
select p.created_at, p.endpoint, p.http_status, p.outcome, p.item_id, c.phone_e164, a.slug
from pin_responses p join connections c on c.id = p.connection_id join agencies a on a.id = c.agency_id
where p.endpoint <> 'items.front_my'
  and c.pin_user_id = (select c2.pin_user_id from connections c2 join ids on ids.connection_id = c2.id)
  and p.created_at > now() - interval '7 days'
order by p.created_at;
SQL

  LISTING_ID=$(psql_run -At -v ext="$EXT" -v slug="$SLUG" <<'SQL'
select l.id from listings l join agencies a on a.id = l.agency_id where a.slug = :'slug' and l.external_id = :'ext';
SQL
)
  ITEMS=$(psql_run -At -v ext="$EXT" -v slug="$SLUG" <<'SQL'
select distinct item_id from pin_responses where endpoint <> 'items.front_my' and body->>'external_id' = :'slug' || '.' || :'ext'
union select pin_item_id from listings l join agencies a on a.id = l.agency_id
where a.slug = :'slug' and l.external_id = :'ext' and pin_item_id is not null;
SQL
)

  echo
  echo "== 6. Requests from the CRM for this listing (Caddy access log, last $HOURS h)"
  docker compose logs caddy --no-log-prefix --since "${HOURS}h" 2>/dev/null \
    | EXT="$EXT" python3 -c '
import json, os, sys, datetime, urllib.parse
ext = os.environ["EXT"]
for line in sys.stdin:
    try:
        e = json.loads(line)
    except ValueError:
        continue
    r = e.get("request") or {}
    uri = r.get("uri") or ""
    if "/listings/" + urllib.parse.quote(ext) not in uri and "/listings/" + ext not in uri and not uri.startswith("/v1/listings/validate"):
        continue
    h = r.get("headers") or {}
    t = datetime.datetime.utcfromtimestamp(e.get("ts", 0)).strftime("%m-%d %H:%M:%S")
    idem = (h.get("Idempotency-Key") or [""])[0]
    ua = (h.get("User-Agent") or [""])[0]
    print(t, r.get("method"), uri, e.get("status"), r.get("remote_ip") or "", idem, ua)
' || true

  echo
  echo "== 7. Worker log about this listing (last $HOURS h)"
  PATTERN="${LISTING_ID:-none}"
  for id in $ITEMS; do PATTERN="$PATTERN|$id"; done
  docker compose logs worker --no-log-prefix --since "${HOURS}h" 2>/dev/null \
    | grep -E "$PATTERN" \
    | python3 -c '
import json, sys, datetime
for line in sys.stdin:
    try:
        e = json.loads(line)
    except ValueError:
        print(line.rstrip())
        continue
    t = datetime.datetime.utcfromtimestamp(e.get("time", 0) / 1000).strftime("%m-%d %H:%M:%S")
    rest = {k: v for k, v in e.items() if k not in ("level", "time", "pid", "hostname", "msg", "context")}
    print(t, e.get("msg"), json.dumps(rest, ensure_ascii=False))
' || true
} | tee "$OUT"

echo
echo "Saved to $OUT"
