# Operating Pin Bridge

## Deploy

On the server whose IP Pin has allowlisted:

```bash
cp .env.example .env              # DOMAIN, passwords, ENCRYPTION_KEY, API_KEY_PEPPER, METRICS_TOKEN
docker compose up -d --build
docker compose run --rm worker node dist/cli/pin-smoke.js     # Cloudflare lets us through?
docker compose run --rm worker node dist/cli/admin.js dict:sync
docker compose run --rm worker node dist/cli/admin.js dict:show --kind rubric_form --key 21
```

Keep a copy of `.env` outside the server, in a password manager. Without `ENCRYPTION_KEY`, Pin
tokens and signing secrets in the database cannot be decrypted. Without `API_KEY_PEPPER`, every
issued API key stops working.

The production process refuses to start without `METRICS_TOKEN`, or with
`UNSAFE_ALLOW_PRIVATE_OUTBOUND_HOSTS` enabled.

## Monitoring and alerts

```bash
echo -n "$METRICS_TOKEN" > docker/monitoring/metrics_token
cp docker/monitoring/alertmanager.example.yml docker/monitoring/alertmanager.yml   # set chat_id
echo -n "<telegram bot token>" > docker/monitoring/telegram_bot_token
docker compose --profile monitoring up -d
ssh -L 9090:127.0.0.1:9090 -L 9093:127.0.0.1:9093 server   # Prometheus / Alertmanager UIs
```

Both `api` and `worker` expose `/metrics` (bearer `METRICS_TOKEN`). Caddy never serves it
publicly. Queue and database gauges come from the worker only, so they are reported once.

| Alert                                  | Meaning and first steps                                                                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `PinBridgeTargetDown`                  | api or worker is not answering. `docker compose ps`, `docker compose logs --tail 200 <service>`.                                                |
| `PinCloudflareBlocked`                 | Pin's Cloudflare refuses our IP. Run `pin-smoke.js`. If the server IP changed, ask Pin to update the allowlist.                                 |
| `PinCircuitOpen`                       | Pin is failing. Calls pause and retry automatically; check pin.tt status, and tell Pin if it persists.                                          |
| `PinErrorRateHigh`                     | Over 20% of Pin calls fail (5xx, timeouts, 429). Same as above. If 429: lower `PIN_RATE_LIMIT_RPS`.                                             |
| `PinUnexpectedResponses`               | Pin returned data we cannot parse; their API may have changed. Check worker logs for `unexpected shape`.                                        |
| `PinDictionariesStale`                 | Reference data not refreshed for 2 days. `admin.js dict:sync`, check logs.                                                                      |
| `ListingQueueBacklog`                  | Listings wait more than 10 min. Pin is slow, the breaker is open, or one agency sent a huge batch. Consider raising `LISTING_SYNC_CONCURRENCY`. |
| `ListingsStuck`                        | No progress for 45 min. The reconciler re-queues them hourly; check worker logs.                                                                |
| `ListingSyncFailures`                  | Many listings failed. Group `last_error.code` in `listings` to see why.                                                                         |
| `ConnectionsNeedReauth`                | Accounts logged out by Pin. The agencies were notified by webhook; remind them.                                                                 |
| `WebhookBacklog` / `WebhookEventsDead` | An agency endpoint is down. Look at `webhook_outbox.last_error` and contact the agency.                                                         |

The alert rules have unit tests in `docker/monitoring/alerts.test.yml`. Run them with
`docker run --rm -v "$PWD/docker/monitoring:/m" -w /m --entrypoint promtool prom/prometheus:v3.5.0 test rules alerts.test.yml`.

## Backups

```bash
./scripts/backup.sh                                   # backups/pinbridge-<UTC>.dump, 14 days kept
# cron: 17 3 * * * cd /opt/pin-bridge && ./scripts/backup.sh >> /var/log/pin-bridge-backup.log 2>&1
docker compose stop api worker && ./scripts/restore.sh backups/pinbridge-….dump && docker compose up -d
```

`backup.sh` checks every dump with `pg_restore --list` before keeping it. Copy dumps off the
server (see the `rclone` line in the script). Redis is not backed up: if its data is lost, the
reconciler re-queues listings that were waiting, and job schedules are recreated at start-up.

## Rotating secrets

- **Agency API key**: `admin.js key:issue --slug x` (two may be active), then the agency deploys
  it, then `admin.js key:revoke --prefix …`.
- **`ENCRYPTION_KEY`**: move the old key to `ENCRYPTION_PREVIOUS_KEYS=k1:<old>`, set a new
  `ENCRYPTION_KEY` and `ENCRYPTION_KEY_ID=k2`, restart. Old rows still decrypt.
- **Webhook secret**: the agency calls `PUT /v1/webhooks` with `rotate_secret: true`.

## Capacity

Load test (`npm run loadtest`; signed requests, 60% PUT listing, 30% GET listing, 10% GET
/v1/me), with the API and the load generator on the same 4-vCPU VM:

| Rate    | p50   | p90    | p97.5  | p99    | Errors |
| ------- | ----- | ------ | ------ | ------ | ------ |
| 50 rps  | 22 ms | 47 ms  | 65 ms  | 89 ms  | 0      |
| 200 rps | 59 ms | 120 ms | 145 ms | 156 ms | 0      |

The API only writes and enqueues, so Pin is never the bottleneck for agencies. Publishing
throughput is bounded by `PIN_RATE_LIMIT_RPS` (default 5 rps to Pin, about 1–2 listings per
second with photos). Raise it only after Pin confirms what they tolerate.
