# Pin Bridge API: connecting a Pin account

Listings are published on Pin under the account of a phone number. Each number is connected once,
with an SMS code. Pin Bridge keeps the resulting Pin credentials (Device-Api-Key and token),
encrypted, because it talks to Pin in the background (photos, retries, status sync). Your server
gets its own copy once, to store encrypted and use with Pin directly if it wants to.
All requests are signed as described in [agency-api-auth.md](agency-api-auth.md).

Every agency connects its numbers through Pin Bridge: you send the phone number and the SMS
code, Pin Bridge runs Pin's three steps (device key, SMS, token) and publishes your listings
under that account.

Pin accepts Trinidad and Tobago numbers only. Send them in any common format
(`+1 868 723 4567`, `(868) 723-4567`, `723-4567`); responses use E.164 (`+18687234567`).

## Flow

```
POST /v1/connections               { "phone": "+1 868 723 4567", "display_name": "John Doe" }
→ 201 { "id": "…", "status": "pending_code", "resend_after_seconds": 60, "confirm_attempts_left": 5, "sms_sent": true, … }

        (the account owner receives an SMS and types the code into your UI)

POST /v1/connections/{id}/confirm  { "code": "1234" }
→ 200 { "id": "…", "status": "active", …,
        "pin_credentials": { "device_key": "3919d512-…", "token": "0c712ed4…" } }
```

`pin_credentials` is returned only by the confirm that activates the number, never again. They
are what Pin expects as `Device-Api-Key: <device_key>` and `Authorization: Token <token>`. Store
them on your server, encrypted; you do not need them to publish through Pin Bridge.

`display_name` is the name buyers see on the listings.

Calling `POST /v1/connections` again for a number that is already `active` returns it with
`200` and `"sms_sent": false`. No SMS is sent.

| Endpoint                            | Purpose                                               |
| ----------------------------------- | ----------------------------------------------------- |
| `POST /v1/connections`              | Start, or restart, connecting a number. Sends an SMS. |
| `POST /v1/connections/{id}/confirm` | Submit the SMS code.                                  |
| `POST /v1/connections/{id}/resend`  | Send a new code. Also resets the wrong-code counter.  |
| `GET /v1/connections`               | List your connections.                                |
| `GET /v1/connections/{id}`          | One connection.                                       |
| `DELETE /v1/connections/{id}`       | Disconnect. Pin Bridge forgets the Pin token.         |

## Statuses

| `status`          | Meaning                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `pending_code`    | Waiting for the SMS code.                                                                                  |
| `active`          | Connected. Listings can be published.                                                                      |
| `reauth_required` | Pin logged the account out. Publishing is paused until you run the flow again with `POST /v1/connections`. |
| `disabled`        | Disconnected by you.                                                                                       |

## Limits

- A new code is available after `resend_after_seconds`, the cooldown Pin reports.
- At most 5 codes per number in 10 minutes. This is Pin's own limit.
- At most 5 wrong codes per SMS. After that, request a new code.
- Per agency, a limited number of SMS per hour (30 by default).

Exceeding a limit returns `429` with `Retry-After`.

## Errors

| HTTP | `code`                       | What to do                                                                         |
| ---- | ---------------------------- | ---------------------------------------------------------------------------------- |
| 422  | `invalid_phone`              | Not a Trinidad and Tobago number, or Pin refused it.                               |
| 422  | `invalid_code`               | Wrong or expired code. `details.confirm_attempts_left` says how many tries remain. |
| 422  | `validation_failed`          | Bad request body; see `details`.                                                   |
| 429  | `sms_rate_limited`           | Wait `Retry-After` seconds before requesting a code.                               |
| 429  | `sms_code_attempts_exceeded` | Request a new code with `/resend`.                                                 |
| 409  | `connection_busy`            | Another request for the same connection is running; retry shortly.                 |
| 409  | `connection_not_active`      | No code is pending; request one first.                                             |
| 404  | `not_found`                  | Unknown connection id, or a connection of another agency.                          |
| 503  | `pin_unavailable`            | Pin is temporarily unavailable; retry after `Retry-After`.                         |
