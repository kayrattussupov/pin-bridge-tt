# Pin Bridge API: listing format and validation

Send listings in Pin Bridge's own format, with readable values. Pin Bridge translates them to
Pin's internal ids. For example, on Pin "House" is variant key `1`; you send `"type": "House"`.

All requests are signed as described in [agency-api-auth.md](agency-api-auth.md).

## Listing

```json
{
  "external_id": "8842",
  "category": "residential_sale",
  "title": "3-bedroom house in St. Ann's",
  "description": "Gated community, fully tiled, A/C in all rooms, covered parking.",
  "price": 1850000,
  "currency": "TTD",
  "negotiable_price": false,
  "region": "central",
  "district_ids": [1701],
  "coordinates": { "lat": 10.65, "lng": -61.41 },
  "images": ["https://cdn.your-agency.tt/8842/1.jpg"],
  "contact": { "name": "John Doe", "email": "john@your-agency.tt", "hide_phone": false },
  "attributes": {
    "type": "House",
    "bedrooms": 3,
    "village": "St. Ann's",
    "number-of-bathrooms": "2.5",
    "parking": "Covered",
    "water": ["Hot", "Cold"],
    "floor-area": 1200
  }
}
```

| Field          | Rules                                                                                   |
| -------------- | --------------------------------------------------------------------------------------- |
| `external_id`  | Your id, 1–64 characters `A-Z a-z 0-9 . _ -`. Unique per Pin account.                   |
| `category`     | `residential_sale` or `residential_rent`.                                               |
| `title`        | 3–100 characters.                                                                       |
| `description`  | Up to 5000 characters, plain text.                                                      |
| `price`        | Number, in `currency`. Only `TTD` is supported.                                         |
| `region`       | `central`, `north_east`, `north_west`, `south_west`, `south_east`, `tobago`.            |
| `district_ids` | Optional; ids from `GET /v1/dictionaries/regions/{region}/districts`.                   |
| `coordinates`  | Optional `{lat, lng}`.                                                                  |
| `images`       | HTTPS URLs of JPEG/PNG photos. Pin shows at most 16; long side 1600 px or more is best. |
| `contact.name` | Seller name shown on Pin. Defaults to the connection's `display_name`. See below.       |
| `link`         | Optional link back to the listing on your site. Dropped in `residential_sale`.         |
| `attributes`   | Category attributes with readable values, see below.                                    |
| `pin_attrs`    | Advanced: raw Pin `attrs` (slug or `attrs__slug` → variant key), over `attributes`.     |

Unknown fields are rejected, so a typo cannot silently drop data.

Pin refuses any link in `residential_sale` ("Item link not allowed in this category"), so Pin Bridge
does not send `link` there and returns a `link_not_allowed` warning instead.

Pin's own rules, checked only by Pin when the listing is published (the listing then fails with
`pin_rejected` and Pin's message in `last_error.pin_errors`):

- `contact.name`: Pin rejects names that look like placeholders: a single letter, only numbers or
  symbols, or a single generic word such as "seller", "owner", "user", "admin", "test", or a brand
  ("apple", "toyota"). Send the agent's or the agency's real name.

### Attributes

`GET /v1/dictionaries/categories/{category}/attributes` lists each attribute with `slug`, `type`
(`select`, `multiselect`, `number`, `text`), `required`, and the accepted `values`. The same
values also come as `options: [{ "value": "House", "label": "House" }]` for select widgets: send
`value` in `attributes`. Values are readable labels, not Pin's internal ids; Pin Bridge translates
them.

- `select`: one of `values`, case-insensitive (`"house"` matches `"House"`). Numbers match their
  label (`"bedrooms": 3` is `"3"`); if a list ends with an open-ended value such as `"9+"`, a
  larger number matches it.
- `multiselect`: an array of `values` (`"water": ["Hot", "Cold"]`).
- `number`: a number.
- `text`: free text (`"village": "St. Ann's"`).
- `true` / `false` match `Yes` / `No` values.

Required attributes are marked `required: true`; for `residential_sale` they are currently `type`,
`bedrooms` (`Studio`, `1` … `15`) and `village`. A listing without them is refused with
`code: "required"`.

Pin's attribute lists can change. Pin Bridge refreshes them daily, so read them from the
dictionary endpoint rather than hard-coding them.

## Validating

`POST /v1/listings/validate` checks a listing without publishing it:

```json
{ "connection_id": "optional, to also check with Pin", "listing": { … } }
```

It answers `200` whether the listing is valid or not (`409 connection_not_active` and
`429 rate_limited` apply only with a `connection_id`):

```json
{
  "valid": false,
  "errors": [
    {
      "field": "attributes.type",
      "code": "unknown_value",
      "message": "\"Bungalow\" is not a valid Type.",
      "allowed": ["Apartment", "House", "Villa", "Townhouse", "Condo"]
    }
  ],
  "warnings": [
    {
      "field": "price",
      "code": "may_be_paid",
      "message": "Paid placement (69.00 TT$ / 30 days) after the first 5 free listings per 30 days."
    }
  ],
  "checked_by_pin": false
}
```

When the listing is valid, `pin_payload` shows exactly what will be sent to Pin. With an active
`connection_id`, Pin's own validation runs too (`checked_by_pin: true`); photos are not
uploaded for this check. If Pin's check is unavailable (at the moment Pin answers it with an
error), the answer is still `200` with Pin Bridge's own checks only: `checked_by_pin: false` and a
`pin_check_unavailable` warning. Pin's own rules above are then checked at publishing.

Warnings do not block publishing. They flag paid placement, missing or extra photos, coordinates
outside Trinidad and Tobago, and an unavailable Pin check.

## Reference data

| Endpoint                                                | Returns                              |
| ------------------------------------------------------- | ------------------------------------ |
| `GET /v1/dictionaries/categories`                       | Categories and paid placement rules. |
| `GET /v1/dictionaries/categories/{category}/attributes` | Attributes and accepted values.      |
| `GET /v1/dictionaries/regions`                          | Regions.                             |
| `GET /v1/dictionaries/regions/{region}/districts`       | Districts of a region.               |

`503 dictionary_unavailable` means Pin Bridge has not loaded Pin's reference data yet. Retry later.
