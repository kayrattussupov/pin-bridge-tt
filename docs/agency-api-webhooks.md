# Pin Bridge API: webhooks

Pin Bridge notifies your server when something happens: a listing is published or fails, Pin
moderates it or asks for payment, an account needs reconnecting. Requests are signed as in
[agency-api-auth.md](agency-api-auth.md).

## Endpoint

| Method and path                        | Purpose                                                                           |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| `PUT /v1/webhooks`                     | Set the endpoint: `{ "url": "https://…", "events": [], "rotate_secret": false }`. |
| `GET /v1/webhooks`                     | Current endpoint, without the secret.                                             |
| `DELETE /v1/webhooks`                  | Stop sending webhooks.                                                            |
| `POST /v1/webhooks/test`               | Send a `ping`.                                                                    |
| `GET /v1/webhooks/deliveries?limit=20` | Recent deliveries: status, attempts, last HTTP status and error.                  |

- One endpoint per agency.
- `events` selects event types; empty means all of them.
- The URL must be `https` and publicly reachable; private and local addresses are refused.
- The response to the first `PUT`, and to `rotate_secret: true`, contains `signing_secret`. It
  is shown only then; store it.

## Delivery

```
POST <your url>
Content-Type: application/json
X-PinBridge-Event: listing.status_changed
X-PinBridge-Event-Id: 6f1c…
X-PinBridge-Signature: t=1791196448,v1=5d41…

{ "id": "6f1c…", "type": "listing.status_changed", "created_at": "2026-10-05T10:34:08.412Z", "data": { … } }
```

- Answer `2xx` within 10 seconds. Do the work afterwards, for example through your own queue.
- Any other answer, a timeout or a redirect counts as a failure. The event is retried at about
  10 s, 30 s, 1.5 min, 4.5 min and so on, capped at 2 h between tries, for 24 hours. After that
  it is marked `dead` in `/v1/webhooks/deliveries`.
- Delivery is at least once: deduplicate by `id`.
- Order is not guaranteed. Each listing payload carries `version` and `updated_at`; ignore
  anything older than what you already have. When in doubt, `GET` the listing.

### Verifying the signature

`v1` is the hex HMAC-SHA256 of `"<t>.<raw body>"` keyed by the signing secret. Reject the request
when it does not match or when `t` is more than 5 minutes off. Use the raw body bytes, not
re-serialized JSON. Working code:

- Node.js: [`examples/verify-webhook.mjs`](examples/verify-webhook.mjs)
- PHP: [`examples/verify-webhook.php`](examples/verify-webhook.php)

## Events

| `type`                       | When                                                                  | `data`                           |
| ---------------------------- | --------------------------------------------------------------------- | -------------------------------- |
| `listing.synced`             | Pin matches what you asked for (published, updated, hidden, removed). | `listing`                        |
| `listing.failed`             | Publishing stopped; see `listing.last_error`.                         | `listing`                        |
| `listing.status_changed`     | Pin's moderation status, payment flag or moderator comment changed.   | `listing`, `previous`, `reason?` |
| `listing.awaiting_payment`   | Pin created the item but shows it only after payment.                 | `listing`                        |
| `connection.connected`       | An account finished the SMS connection.                               | `connection`                     |
| `connection.reauth_required` | Pin logged the account out; publishing is paused until it reconnects. | `connection`, `reason`           |
| `ping`                       | You called `/v1/webhooks/test` (always sent, regardless of `events`). | `agency`                         |

`listing` has the same shape as `GET /v1/connections/{id}/listings/{external_id}`
([agency-api-publishing.md](agency-api-publishing.md)). `previous` is
`{ "status": …, "not_paid": … }` before the change.

`listing.status_changed` with `"reason": "deleted_on_pin"` means the item no longer exists on Pin
(removed by its owner or by moderation). The listing becomes `failed`; `PUT` it again to
republish.

## How Pin's status is tracked

Pin moderates after publishing, so a published listing can still be rejected or blocked later.
Pin Bridge reads every account's listings from Pin on a schedule:

- about a minute after publishing;
- every few minutes while a listing is on moderation or waiting for payment (less often after a
  few hours);
- every 6 hours for published listings;
- daily for hidden, rejected and blocked ones.

Each change arrives as `listing.status_changed`.
