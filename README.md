# Pin Bridge

Integration server between real estate agencies and the [pin.tt](https://pin.tt) API.
Pin allows API access from a single allowlisted server, so every agency talks to Pin Bridge and
Pin Bridge talks to Pin. Design and roadmap: [`docs/PLAN.md`](docs/PLAN.md).

Deploying on an Ubuntu server and testing it with curl from your computer:
[`docs/deploy-ubuntu.md`](docs/deploy-ubuntu.md) (in Russian), scripts in [`scripts/curl/`](scripts/curl).
What was verified against Pin's prod, with real requests and responses:
[`docs/pin-api-verified.md`](docs/pin-api-verified.md).
Asking Pin to allowlist the server (request text and a plain-curl check of Pin from the server):
[`docs/pin-access-request.md`](docs/pin-access-request.md).

## Processes

| Process  | Entrypoint           | Role                                                           |
| -------- | -------------------- | -------------------------------------------------------------- |
| `api`    | `src/main.api.ts`    | REST API for agencies (behind Caddy). Never blocks on Pin.     |
| `worker` | `src/main.worker.ts` | BullMQ jobs: everything that calls Pin. Serves `/health` only. |

Both expose `GET /health/live` (process up) and `GET /health/ready` (PostgreSQL and Redis
reachable; the worker also requires a fresh heartbeat from its own job loop). Caddy only exposes
`/health/live` publicly.

## Agencies and API keys

Agencies authenticate with an API key plus an HMAC signature over each request (timestamp,
single-use nonce, method, path and body hash). Agencies are not tied to IP addresses by default (their servers often have
dynamic IPs); an optional per-agency IP allowlist can be set for static ones, and
each key has its own rate limit. The contract for agencies is in
[`docs/agency-api-auth.md`](docs/agency-api-auth.md), with working Node.js and PHP examples.

Only a peppered hash of each API key is stored. Signing secrets (and later Pin tokens) are
encrypted with AES-256-GCM (`ENCRYPTION_KEY`), bound to their row so a ciphertext cannot be
moved to another record. Agency and key changes are written to `audit_log`.

Agencies connect themselves with a one-time invite code: the operator runs `invite:create`, and
the agency's server redeems the code once through the public `POST /v1/enroll`, which creates
the agency, its first key and its webhook endpoint in one transaction (contract and retry rules:
[`docs/agency-onboarding.md`](docs/agency-onboarding.md)). Agency deployments of the CRM platform
(`https://<slug>.duckcrm.one`) can instead enroll with no operator at all through
`POST /v1/platform/agencies`, signed with `PLATFORM_SIGNING_SECRET` and proven by a file on the
agency's own subdomain. After the SMS step the agency also receives its own copy of the Pin
credentials once. The agency sites (Next.js on Vercel +
Supabase) are built in their own project; the implementation plan to hand to that project is
[`docs/agency-integration-plan.md`](docs/agency-integration-plan.md).
`GET /v1/me` includes a `setup` checklist for onboarding screens.

To try the API from your own computer (test agency keys, signed curl requests, SMS and a real
listing), follow [`docs/testing-from-your-computer.md`](docs/testing-from-your-computer.md).

Operators manage agencies with the admin CLI:

```bash
docker compose run --rm worker node dist/cli/admin.js agency:create --name "Duck Realty" --slug duck   # any IP
docker compose run --rm worker node dist/cli/admin.js key:issue --slug duck     # shown once
docker compose run --rm worker node dist/cli/admin.js key:list --slug duck
docker compose run --rm worker node dist/cli/admin.js key:revoke --prefix pb_0123456789ab
docker compose run --rm worker node dist/cli/admin.js agency:suspend --slug duck
docker compose run --rm worker node dist/cli/admin.js agency:set-ips --slug duck --ip 198.51.100.0/24   # only for agencies with static IPs; no --ip = any IP
docker compose run --rm worker node dist/cli/admin.js agency:list
docker compose run --rm worker node dist/cli/admin.js invite:create --name "Duck Realty"   # shown once
docker compose run --rm worker node dist/cli/admin.js invite:list
docker compose run --rm worker node dist/cli/admin.js invite:revoke --prefix pbi_0123456789ab
```

An agency checks its setup with `GET /v1/me`.

## Pin account connections

`/v1/connections` runs Pin's SMS login for an agency's phone number (contract:
[`docs/agency-api-connections.md`](docs/agency-api-connections.md)). Each connection gets its own
Pin device key, so Pin's 5-SMS-per-10-minutes limit applies per number. The device key and the
resulting token are stored encrypted and never returned. Pin Bridge enforces the limits before
calling Pin: the resend cooldown from Pin's `end_date`, 5 SMS per 10 minutes, a per-agency
hourly SMS budget, and 5 wrong codes per SMS. A Redis lock per connection serializes concurrent
calls. An SMS whose outcome is unknown (timeout) still counts, so a retry cannot double-send.

Jobs get credentials through `ConnectionsService.authFor()`. When Pin rejects a token they call
`markReauthRequired()`: the connection moves to `reauth_required` until the agency reconnects.

## Pin reference data and listing mapping

The worker keeps a local copy of Pin's dictionaries (rubric tree, regions, districts, and the
attribute forms of rubrics 20 and 21) in the `dictionaries` table. It syncs on start when the
copy is missing or older than a day, and daily at 04:17 UTC. A failed sync keeps the previous
copy. A changed form is logged and audited (`dictionary.changed`), because it can break mapping.
Dictionary calls use Pin Bridge's own device key (stored encrypted in `system_secrets`, recreated
automatically if Pin forgets it).

Agencies send listings with readable values (`docs/agency-api-listings.md`).
`src/listings/listing-mapper.ts` turns them into Pin's `POST /items/` body, with Pin's variant
keys taken from the rubric form. `POST /v1/listings/validate` exposes this as a dry run, with
Pin's `validate_ad` as an optional second check.

The format of Pin's `rubric_form` response is not documented. `src/dictionaries/rubric-form.ts`
accepts several plausible shapes and fails loudly on anything else. Check the real one on the
production server:

```bash
docker compose run --rm worker node dist/cli/admin.js dict:sync
docker compose run --rm worker node dist/cli/admin.js dict:show --kind rubric_form --key 21
```

## Publishing

`PUT /v1/connections/{id}/listings/{external_id}` validates and maps the listing synchronously
(422 on bad data), stores it as the desired state, and queues a sync job (contract:
[`docs/agency-api-publishing.md`](docs/agency-api-publishing.md)). The worker's
`ListingSyncService` reconciles one listing at a time under a Redis lock. A job only carries the
listing id, and the latest stored version is always applied, so duplicate or out-of-order jobs
are harmless.

- Photos are fetched by `ImageFetcher`, which blocks SSRF: https only, every resolved address
  must be public (checked inside the socket's DNS lookup, so DNS rebinding cannot slip through),
  and redirects are re-checked (max 3). Size and time are capped. sharp converts photos to JPEG
  with a 1600 px long side and uploads them one by one. An unchanged URL reuses its Pin picture
  id.
- Create, then full update when the Pin payload hash changed, then visibility (`toggle_active`
  only when the current status differs), or removal.
- No duplicates: a create that timed out sets `create_unknown`, and the next attempt looks the
  item up by `external_id` in `front_my`. A "duplicate external_id" answer adopts the existing
  item. An item deleted on Pin's side is recreated.
- Temporary failures (Pin, photo host) retry with exponential backoff (`LISTING_SYNC_ATTEMPTS`,
  `LISTING_SYNC_BACKOFF_MS`). Permanent ones mark the listing `failed` with a reason. A revoked
  token moves the connection to `reauth_required`, and its listings resume automatically after
  the agency reconnects.

`UNSAFE_ALLOW_PRIVATE_OUTBOUND_HOSTS=true` disables the SSRF checks for local testing. Never
set it in production; the worker logs an error if you do.

## Webhooks and status tracking

State changes write webhook events into `webhook_outbox` in the same transaction as the change
(transactional outbox), so an event is never lost or sent for a change that rolled back. The
worker's dispatcher claims due rows with `FOR UPDATE SKIP LOCKED`, so several workers never
deliver the same row at once. It signs each body (`t=…,v1=HMAC(secret, "t.body")`) and posts it
through the same SSRF-safe dispatcher as photos. Failed deliveries retry with ~3x backoff (capped
at 2 h) for `WEBHOOK_MAX_AGE_MS` (24 h), then go `dead`. Delivered rows are pruned after 7 days.
The contract for agencies is in [`docs/agency-api-webhooks.md`](docs/agency-api-webhooks.md).

`StatusSyncService` reads Pin's `front_my` once per account, not once per listing, for accounts
with listings due a check (`next_status_check_at`). Moderation, payment and moderator comment
changes become `listing.status_changed` and `listing.awaiting_payment`. An item missing from a
complete scan is reported as `deleted_on_pin`, and a revoked token marks the connection
`reauth_required`. Schedule: 1 min after publishing, 2/10/60 min while pending, 6 h for
published, 24 h for hidden, rejected and blocked.

## Talking to Pin

`src/pin/` is the only code that calls pin.tt. Every call goes through:

1. **Circuit breaker** (Redis, shared by api and workers). Opens when at least
   `PIN_BREAKER_MIN_REQUESTS` calls in `PIN_BREAKER_WINDOW_MS` include `PIN_BREAKER_FAILURE_RATIO`
   upstream failures (5xx, timeouts, network errors, 429, Cloudflare blocks). While it is open,
   calls fail fast with `breaker_open`. After `PIN_BREAKER_OPEN_MS` one probe call decides
   whether it closes again. Validation errors do not count.
2. **Rate limiter**: a global token bucket in Redis (`PIN_RATE_LIMIT_RPS`, `PIN_RATE_LIMIT_BURST`).
3. **HTTP**: a keep-alive undici pool, optionally through `PIN_HTTPS_PROXY`.
4. **Classification** into `PinError.kind`: `cloudflare_blocked`, `missing_device_key`,
   `unauthorized`, `forbidden`, `validation` (with Pin's field errors), `rate_limited`,
   `not_found`, `server`, `timeout`, `network`, `unexpected_response`, and so on.
5. **Retry**, only where resending is safe: GETs, `validate_ad`, picture upload and full edit
   are retried up to 3 times with jittered backoff. Item creation, toggle, removal and SMS calls
   are never resent unless the connection was refused (`notSent`). If such a call times out,
   the error carries `outcomeUnknown: true`, and the caller must check `front_my` by
   `external_id` before trying again.

### fake-pin

`test/fake-pin/` is an in-memory imitation of the Pin API, built from what Pin's developer
described (there is no staging stand). It implements the Device-Api-Key requirement, TT-only
phone_verify with the 5 SMS / 10 min limit, stable tokens, picture upload, the silent 16-image
cut, `not_paid` in rubrics 20/21, moderation states and the Cloudflare block page. It can also
inject failures (`failNext`, `cloudflareBlockAll`, `revokeToken`, `setModeration`).

```bash
npm run fake-pin                          # http://127.0.0.1:4010, SMS code 1234
PIN_BASE_URL=http://127.0.0.1:4010 npm run start:worker
```

### Smoke test on the production server

Run on the allowlisted server to confirm that Cloudflare lets us through:

```bash
docker compose run --rm worker node dist/cli/pin-smoke.js
# with the test number from Pin:
docker compose run --rm worker node dist/cli/pin-smoke.js --phone +1868XXXXXXX
docker compose run --rm worker node dist/cli/pin-smoke.js --device-key <key> --phone +1868XXXXXXX --code <code>
```

`cloudflare_blocked` means the server IP is not in Pin's allowlist.

## Local development

Requirements: Node.js 22+, PostgreSQL 16, Redis 7.

```bash
npm ci
export DATABASE_URL=postgresql://pinbridge:pinbridge@localhost:5432/pinbridge
export REDIS_URL=redis://localhost:6379
export ENCRYPTION_KEY=$(openssl rand -base64 32) API_KEY_PEPPER=$(openssl rand -base64 32)
npx prisma generate          # writes the client to src/generated/prisma
npx prisma migrate dev       # applies migrations to the local database
npm run build
npm run start:api            # http://localhost:3000/health/ready
npm run start:worker         # http://localhost:3001/health/ready
```

Tests that touch Redis or PostgreSQL read `REDIS_URL` and `DATABASE_URL` (defaults in
`test/support/env.ts`). Unit tests (`src/**`) run in parallel. Integration tests (`test/**`) share
the database and run one file at a time.

There is no CI; run the checks before pushing:

```bash
npm run format:check && npm run lint && npm run typecheck && npm test && npm run build
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
```

Schema changes: edit `prisma/schema.prisma`, then `npx prisma migrate dev --name <change>` and
commit the generated folder under `prisma/migrations/`. The `migrate diff` check above fails if the
migrations and the schema drift apart.

## Deployment

Deploy on the server whose IP is allowlisted by Pin (Cloudflare blocks other IPs with 403).

```bash
cp .env.example .env   # set DOMAIN and strong passwords
docker compose up -d --build
```

The stack: `caddy` (TLS on 443) → `api` → `postgres` / `redis` (internal network, no internet),
plus `worker` (internal + outbound internet for Pin) and a one-shot `migrate` service that runs
`prisma migrate deploy` before the app starts. App containers run as a non-root user with a
read-only filesystem. Redis uses AOF so queued jobs survive restarts.

If more hosts are added later, all Pin traffic must still leave through the allowlisted IP: set
`PIN_HTTPS_PROXY` to a forward proxy running on that host.

## Operations and security

- [`docs/OPERATIONS.md`](docs/OPERATIONS.md): deploy, monitoring (Prometheus, Alertmanager to
  Telegram, `docker compose --profile monitoring`), the alert runbook, backups and restore,
  secret rotation, and load test results.
- [`docs/SECURITY.md`](docs/SECURITY.md): threat model, controls, review findings and their fixes.
- The worker re-queues listings whose job was lost (e.g. Redis data loss) every 5 minutes.

## Configuration

All variables are validated at startup (`src/config/env.ts`); the process exits listing every
invalid one. See `.env.example`.
