# Pin Bridge API: connecting an agency

There are two ways for an agency server to get its API key:

- **Platform enrollment** (`POST /v1/platform/agencies`): an agency's CRM deployment on
  `https://<slug>.duckcrm.one` connects itself. No operator, no invite code.
- **Invite code** (`POST /v1/enroll`): the operator hands out a one-time code. For agencies
  outside the platform.

## Platform enrollment: `POST /v1/platform/agencies`

Every CRM deployment holds the platform signing secret (`PLATFORM_SIGNING_SECRET` on the bridge).
The request is signed exactly like an agency request ([agency-api-auth.md](agency-api-auth.md))
with that secret; `Authorization` is not needed.

Since every deployment holds that secret, the bridge also checks that the caller really serves
the agency's subdomain: before answering, it fetches
`https://<slug>.duckcrm.one/.well-known/pin-bridge-enroll` and expects the hex SHA-256 of the
request's `client_request_id` as the body (`text/plain`, `200`, no redirects). A deployment
therefore cannot obtain keys for another agency's slug.

```
CRM deployment (morelli-realty.duckcrm.one)                     Pin Bridge
client_request_id = random, kept until the keys are stored
serve /.well-known/pin-bridge-enroll = sha256(client_request_id)
POST /v1/platform/agencies (signed with the platform secret) ──▶ GET https://morelli-realty.duckcrm.one
                                                                       /.well-known/pin-bridge-enroll
                                                                 creates agency "morelli-realty", key, webhook
◀── api_key, signing_secret, webhook.signing_secret
```

```json
{
  "slug": "morelli-realty",
  "name": "Morelli Realty",
  "client_request_id": "3f9c0a5e6b7d4c21a8e0f1b2c3d4e5f6",
  "webhook_url": "https://morelli-realty.duckcrm.one/api/pin-bridge/webhook"
}
```

| Field               | Rules                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------- |
| `slug`              | The agency's subdomain: `a-z 0-9 -`, 2–31 characters. It becomes the agency slug as is. |
| `name`              | 1–100 characters.                                                                       |
| `client_request_id` | 16–128 characters of `A-Z a-z 0-9 _ -`, random. Its SHA-256 is the domain proof.        |
| `webhook_url`       | Optional. Must be on the agency's own origin (`https://<slug>.duckcrm.one/...`).        |

`201` has the same body as `POST /v1/enroll` below.

| HTTP | `code`                | Meaning                                                                                             |
| ---- | --------------------- | --------------------------------------------------------------------------------------------------- |
| 401  | `unauthorized`        | Bad or missing signature, stale timestamp, reused nonce.                                            |
| 403  | `forbidden`           | The agency is suspended.                                                                            |
| 409  | `agency_exists`       | The slug belongs to an agency created by the operator or an invite, not by the platform.            |
| 422  | `domain_not_verified` | The proof URL did not answer `200` with the right hash; `details.url` and `details.reason` say why. |
| 422  | `invalid_webhook_url` | Not on the agency's origin, or refused for the usual reasons.                                       |
| 422  | `validation_failed`   | Bad body; see `details`.                                                                            |
| 429  | `rate_limited`        | Too many attempts from your IP. Wait `Retry-After`.                                                 |
| 404  | `not_found`           | Platform enrollment is not enabled on this bridge.                                                  |

**Calling again for an existing agency** returns `201` with `"retried": true` and fresh keys for
the same agency; every earlier key and the old webhook secret stop working. This covers both a
lost response and a deployment that lost its keys (new server, restored database): proving the
domain is all it takes, no operator is involved. Agencies created by the operator or an invite
are never reachable this way (`409`).

Operators: platform enrollments appear in `invite:list` with `created_by = platform`. Suspend or
revoke keys of such agencies as usual.

# Connecting with an invite code

An agency's server connects itself to Pin Bridge with a one-time invite code. There are no keys
to copy by hand: a "Connect" button on the agency's admin page redeems the code, stores the
credentials it receives, and from then on signs every request with them
([agency-api-auth.md](agency-api-auth.md)).

Pin Bridge lives at one address for every agency: `https://bridge.duckcrm.one`.

## Flow

```
Operator                         Agency server                              Pin Bridge
pb-admin invite:create ──code──▶ admin pastes code, clicks "Connect"
                                 POST /v1/enroll {invite_code, ...}  ─────▶ creates agency, key,
                                                                            webhook endpoint
                                 ◀──── api_key, signing_secret, webhook.signing_secret
                                 store them (encrypted), then signed calls:
                                 POST /v1/webhooks/test, POST /v1/connections (SMS) ...
                                 GET  /v1/me → setup checklist
```

1. The operator runs `invite:create --name "Agency name"` and gives the code to the agency. A
   code works once and expires after 7 days by default.
2. The agency server calls `POST /v1/enroll` and stores what it gets back.
3. The agency connects its Pin phone number ([agency-api-connections.md](agency-api-connections.md)).
4. `GET /v1/me` returns a `setup` checklist the admin page can show.

## `POST /v1/enroll`

The only unsigned endpoint: there is no key yet.

```json
{
  "invite_code": "pbi_82274ff81a9c_MJQADjH4mkloEWLmABRfED4OMI1QCNdC",
  "client_request_id": "3f9c0a5e6b7d4c21a8e0f1b2c3d4e5f6",
  "webhook_url": "https://agency.example/api/pin-bridge/webhook",
  "agency_name": "Duck Realty"
}
```

| Field               | Rules                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `invite_code`       | The code from the operator.                                                                          |
| `client_request_id` | 16–128 characters of `A-Z a-z 0-9 _ -`, random, generated once per attempt. See "Retrying" below.    |
| `webhook_url`       | Optional. Same rules as `PUT /v1/webhooks`: public `https` URL ([webhooks](agency-api-webhooks.md)). |
| `agency_name`       | Optional. Overrides the name the operator gave the invite.                                           |

`201`:

```json
{
  "agency": { "id": "…", "slug": "duck-realty", "name": "Duck Realty" },
  "api_key": "pb_0123456789ab_…",
  "signing_secret": "…",
  "key_prefix": "pb_0123456789ab",
  "webhook": {
    "url": "https://agency.example/api/pin-bridge/webhook",
    "events": [],
    "enabled": true,
    "signing_secret": "…",
    "created_at": "…",
    "updated_at": "…"
  },
  "retried": false
}
```

`api_key`, `signing_secret` and `webhook.signing_secret` are shown only in this response. Store
them on your server, encrypted, never in a browser. `webhook` is `null` when no `webhook_url`
was sent.

| HTTP | `code`                | Meaning                                                                       |
| ---- | --------------------- | ----------------------------------------------------------------------------- |
| 401  | `invalid_invite`      | The code is wrong, expired, revoked or already used. Ask for a new one.       |
| 422  | `invalid_webhook_url` | The webhook URL was refused. The code is **not** used up; fix it and resend.  |
| 422  | `validation_failed`   | Bad body; see `details`.                                                      |
| 429  | `rate_limited`        | Too many attempts from your IP (5 per minute by default). Wait `Retry-After`. |

### Retrying

If the request times out or your server fails before storing the answer, send the **same**
`invite_code` with the **same** `client_request_id` again within one hour. You get `201` with
`"retried": true`, the same agency, a new API key and a new webhook secret; everything issued by
the earlier attempt stops working. Keep the `client_request_id` until the credentials are stored.

A different `client_request_id`, or a retry after an hour, gets `401 invalid_invite`.

## Setup checklist: `GET /v1/me`

```json
{
  "agency": { "id": "…", "slug": "duck-realty", "name": "Duck Realty" },
  "api_key": { "prefix": "pb_0123456789ab", "scopes": ["*"] },
  "request_ip": "203.0.113.7",
  "setup": {
    "webhook": {
      "url": "https://agency.example/api/pin-bridge/webhook",
      "enabled": true,
      "last_delivery": {
        "type": "ping",
        "status": "delivered",
        "attempts": 1,
        "last_status": 200,
        "last_error": null,
        "created_at": "…"
      }
    },
    "connections": { "active": 1, "pending_code": 0, "reauth_required": 0 },
    "dictionaries_ready": true
  }
}
```

Everything works when `webhook.last_delivery.status` is `delivered`, `connections.active` is at
least 1 and `dictionaries_ready` is `true`. `webhook` is `null` until an endpoint is set, and
`last_delivery` is `null` until the first event (send one with `POST /v1/webhooks/test`).

## Building the "Connect" button

Agency sites on Next.js (Vercel) and Supabase: hand
[`agency-integration-plan.md`](agency-integration-plan.md) to the site's project. It covers the
wizard, encrypted credential storage, the signed client, the webhook receiver and test vectors.

## For operators

```bash
pb-admin invite:create --name "Duck Realty" [--slug duck] [--ttl-days 7]   # prints the code once
pb-admin invite:list                                                     # open / used / expired / revoked
pb-admin invite:revoke --prefix pbi_82274ff81a9c
```

An agency created this way is like any other: `agency:suspend`, `key:list` and `key:revoke`
work as before, and it accepts requests from any IP unless `agency:set-ips` is used.
