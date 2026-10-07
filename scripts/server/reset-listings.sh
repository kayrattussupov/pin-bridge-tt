#!/usr/bin/env bash
# Forgets an agency's listings in Pin Bridge so the CRM can publish them again from scratch:
# deletes the listing rows (photos cascade) and the agency's stored Idempotency-Key responses.
#
# Listings that exist on Pin (pin_item_id set, or a create that may have reached Pin) are kept:
# deleting their rows would leave orphaned items on Pin. Remove those from the CRM first.
#
# Run on the bridge server:
#   bash scripts/server/reset-listings.sh dev                    # all of agency "dev"
#   bash scripts/server/reset-listings.sh dev P-00098 P-01543    # only these external ids
set -euo pipefail

SLUG="${1:?usage: reset-listings.sh <agency-slug> [external_id ...]}"
shift
cd "${PIN_BRIDGE_DIR:-/opt/pin-bridge}"

psql_run() {
  docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 "$@"' psql "$@"
}

# Slug and ids are passed as psql variables (quoted by psql via :'name'), never spliced into SQL.
IDS=""
for id in "$@"; do IDS+="${IDS:+,}$id"; done

FILTER="l.agency_id = (select id from agencies where slug = :'slug')
  and (:'ids' = '' or l.external_id = any(string_to_array(:'ids', ',')))"

echo "Agency: $SLUG${IDS:+, listings: $IDS}"
psql_run -v slug="$SLUG" -v ids="$IDS" <<SQL
select l.external_id, l.sync_state, l.desired_state, l.pin_item_id,
       case when l.pin_item_id is not null or l.create_unknown then 'KEEP (on Pin)' else 'delete' end as action
from listings l where $FILTER order by l.external_id;
SQL

read -r -p "Delete the rows marked 'delete' and this agency's idempotency keys? [y/N] " answer
[[ "$answer" == [yY] ]] || { echo "Cancelled."; exit 0; }

psql_run -v slug="$SLUG" -v ids="$IDS" <<SQL
begin;
delete from idempotency_keys k
  using listings l
  where k.agency_id = l.agency_id and $FILTER
    and l.pin_item_id is null and not l.create_unknown
    and k.key like l.external_id || ':%';
delete from idempotency_keys
  where :'ids' = '' and agency_id = (select id from agencies where slug = :'slug');
delete from listings l
  where $FILTER and l.pin_item_id is null and not l.create_unknown;
commit;
SQL
echo "Done. Publish again from the CRM."
