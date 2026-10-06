# Pin Bridge API: authentication

Every request from an agency server carries four headers:

| Header          | Value                                                                         |
| --------------- | ----------------------------------------------------------------------------- |
| `Authorization` | `Bearer <API key>`                                                            |
| `X-Timestamp`   | Current Unix time in seconds. Must be within 5 minutes of server time.        |
| `X-Nonce`       | Random string, 16–128 chars of `A-Z a-z 0-9 _ -`. Never reuse one.            |
| `X-Signature`   | `v1=` + hex HMAC-SHA256 of the canonical string, keyed by the signing secret. |

You receive the API key and the signing secret once: from `POST /v1/enroll` when your server
redeems an invite code ([agency-onboarding.md](agency-onboarding.md)), or from the operator. Keep
both on your server only, never in a browser or mobile app.

## Canonical string

Five lines joined with `\n` (no trailing newline):

```
<X-Timestamp>
<X-Nonce>
<HTTP method, uppercase>
<path with query string, exactly as sent, e.g. /v1/me or /v1/listings?cursor=abc>
<hex SHA-256 of the raw request body; for an empty body: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855>
```

Sign the exact bytes you send. Serialize the JSON once, sign that string, and send the same string
as the body.

## Errors

All errors have this shape:

```json
{
  "error": {
    "code": "unauthorized",
    "message": "Invalid or missing credentials.",
    "request_id": "..."
  }
}
```

| HTTP | `code`         | Meaning                                                              |
| ---- | -------------- | -------------------------------------------------------------------- |
| 401  | `unauthorized` | Key, signature, timestamp or nonce is wrong. Check your clock (NTP). |
| 403  | `forbidden`    | Only if an IP allowlist was set for your agency (off by default).    |
| 429  | `rate_limited` | Too many requests for this key. Wait `Retry-After` seconds.          |

Send `X-Request-Id` if you want your own id echoed back and recorded in our logs. Include
`request_id` when you report a problem.

## Checking your setup

`GET /v1/me` returns your agency and key prefix when everything is right. Working examples:

- Node.js: [`examples/sign-request.mjs`](examples/sign-request.mjs)
- PHP: [`examples/sign-request.php`](examples/sign-request.php)

```bash
PB_URL=https://bridge.duckcrm.one PB_API_KEY=pb_... PB_SIGNING_SECRET=... node sign-request.mjs
```

## Key rotation

An agency can have two active keys. To rotate: ask for a new key, deploy it, then ask us to
revoke the old one.
