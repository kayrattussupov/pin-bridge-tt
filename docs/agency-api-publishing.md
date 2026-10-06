# Pin Bridge API: publishing listings

Listings are published under a connected Pin account ([agency-api-connections.md](agency-api-connections.md)),
in the format of [agency-api-listings.md](agency-api-listings.md). All requests are signed
([agency-api-auth.md](agency-api-auth.md)).

Publishing is asynchronous. Pin Bridge validates your request immediately and answers within
milliseconds. It then talks to Pin in the background: it uploads the photos one by one, creates
or updates the item, and sets its visibility. Read the result with `GET`, or with webhooks
(coming next).

## Endpoints

| Method and path                                                                          | Effect                                                                                 |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `PUT /v1/connections/{connection_id}/listings/{external_id}`                             | Create or replace the whole listing.                                                   |
| `GET /v1/connections/{connection_id}/listings/{external_id}`                             | Current state.                                                                         |
| `GET /v1/connections/{connection_id}/listings?sync_state=&desired_state=&cursor=&limit=` | List, 50 per page by default, 100 max, ordered by `external_id`; follow `next_cursor`. |
| `POST /v1/connections/{connection_id}/listings/{external_id}/deactivate`                 | Hide on Pin (keeps the item).                                                          |
| `POST /v1/connections/{connection_id}/listings/{external_id}/activate`                   | Show again.                                                                            |
| `DELETE /v1/connections/{connection_id}/listings/{external_id}`                          | Remove from Pin.                                                                       |

`PUT` takes the listing document without `external_id`, since it is in the URL. If you include
it, it must match.

| Response                    | Meaning                                                             |
| --------------------------- | ------------------------------------------------------------------- |
| `202`                       | Accepted and queued for Pin.                                        |
| `200`                       | Nothing to do: identical to what is already published or requested. |
| `422 invalid_listing`       | Rejected before queuing; `details.errors` lists every problem.      |
| `404`                       | Unknown connection or listing (or one of another agency).           |
| `409 connection_not_active` | The connection is disabled.                                         |

Sending the same listing again is safe and cheap. Send the full document whenever anything
changes; Pin Bridge works out what to change on Pin. A photo whose URL is unchanged is not
downloaded again, so use a new URL when a photo changes.

`Idempotency-Key: <your request id>` makes retries of a request safe: the first response is
replayed for 24 hours (with `Idempotent-Replayed: true`). Reusing a key for a different request
returns `422 idempotency_key_reused`.

## Listing state

```json
{
  "external_id": "8842",
  "desired_state": "active",
  "sync_state": "synced",
  "live": true,
  "pin": {
    "item_id": "48213",
    "status": "published",
    "not_paid": false,
    "moderator_comment": null
  },
  "images": [
    { "url": "https://cdn.your-agency.tt/8842/1.jpg", "status": "uploaded", "error": null }
  ],
  "warnings": [],
  "last_error": null,
  "version": 3,
  "last_synced_at": "2026-10-05T10:19:20.248Z"
}
```

- `desired_state`: what you asked for (`active`, `inactive`, `removed`).
- `sync_state`: `queued`, `processing`, `synced` (Pin matches `desired_state`), or `failed`
  (see `last_error`).
- `pin.status`: Pin's moderation state: `published`, `on_moderation`, `hidden`, `rejected`,
  `blocked`. Pin moderates after publishing, so this can change later.
- `pin.not_paid`: `true` means Pin created the item but shows it only after payment from the
  account balance (paid categories).
- `live`: `true` only when buyers can see the listing (`published` and not waiting for payment).

## Failures

| `last_error.code`            | Meaning and what to do                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `pin_rejected`               | Pin refused the data (`pin_errors`). Fix it and `PUT` again.                        |
| `connection_reauth_required` | Pin logged the account out. Reconnect it; queued listings then go out on their own. |
| `connection_not_active`      | The connection is not active. Same as above.                                        |
| `mapping_failed`             | Pin changed its attribute form since you sent the listing. `PUT` it again.          |
| `image_unavailable`          | A photo stayed unreachable through all retries. Check the URL and `PUT` again.      |
| `pin_unavailable`            | Pin stayed unavailable through all retries. `PUT` again later.                      |

Temporary problems (Pin or your photo host briefly unavailable) are retried automatically for
about an hour. While that happens, `sync_state` stays `queued` and `last_error.will_retry` is
`true`.

Photos that are permanently broken (404, not an image, larger than 15 MB) are skipped with a
warning, and the listing is published without them. Photos are converted to JPEG at most 1600 px
on the long side. Photos under 800 px get a warning because they look blurry on Pin.

Disconnecting an account does not delete its listings on Pin. Remove them first if needed.
