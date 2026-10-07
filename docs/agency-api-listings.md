# Pin Bridge API: listing format and validation

Send listings in Pin Bridge's own format, with readable values. Pin Bridge translates them to
Pin's internal ids. For example, on Pin "3 bedrooms" is variant key `10`, not `3`; you send
`"bedrooms": 3`.

All requests are signed as described in [agency-api-auth.md](agency-api-auth.md).

## Listing

```json
{
  "external_id": "8842",
  "category": "residential_rent",
  "title": "2-bedroom apartment in Valsayn",
  "description": "Fully furnished, A/C, gated community, parking.",
  "price": 3500,
  "currency": "TTD",
  "negotiable_price": false,
  "region": "central",
  "district_ids": [1701],
  "coordinates": { "lat": 10.65, "lng": -61.41 },
  "images": ["https://cdn.your-agency.tt/8842/1.jpg"],
  "contact": { "name": "John Doe", "email": "john@your-agency.tt", "hide_phone": false },
  "link": "https://your-agency.tt/listings/8842",
  "attributes": {
    "type": "Apartment",
    "bedrooms": 3,
    "number-of-bathrooms": 2,
    "water": ["WASA", "Tank"],
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
| `contact.name` | Seller name shown on Pin. Defaults to the connection's `display_name`.                  |
| `link`         | Optional link back to the listing on your site.                                         |
| `attributes`   | Category attributes with readable values, see below.                                    |
| `pin_attrs`    | Advanced: raw Pin `attrs` (slug → variant key), applied over `attributes`.              |

Unknown fields are rejected, so a typo cannot silently drop data.

### Attributes

`GET /v1/dictionaries/categories/{category}/attributes` lists each attribute with `slug`, `type`
(`select`, `multiselect`, `number`, `text`), `required`, and the accepted `values`. The same
values also come as `options: [{ "value": "House", "label": "House" }]` for select widgets: send
`value` in `attributes`. Values are readable labels, not Pin's internal ids; Pin Bridge translates
them.

- `select`: one of `values`, case-insensitive (`"apartment"` matches `"Apartment"`). A number above
  an open-ended value matches it: `"bedrooms": 6` becomes `"4+"`.
- `multiselect`: an array of `values`.
- `number`: a number.
- `true` / `false` match `Yes` / `No` values.

Pin's attribute lists can change. Pin Bridge refreshes them daily, so read them from the
dictionary endpoint rather than hard-coding them.

## Validating

`POST /v1/listings/validate` checks a listing without publishing it:

```json
{ "connection_id": "optional, to also check with Pin", "listing": { … } }
```

It always answers `200`:

```json
{
  "valid": false,
  "errors": [
    {
      "field": "attributes.bedrooms",
      "code": "unknown_value",
      "message": "\"many\" is not a valid Bedrooms.",
      "allowed": ["1", "2", "3", "4+"]
    }
  ],
  "warnings": [
    {
      "field": "price",
      "code": "may_be_paid",
      "message": "Paid placement (69.00 TT$ / 30 days) for rent above 4000 TT$ after 4 free such listings per 30 days."
    }
  ],
  "checked_by_pin": false
}
```

When the listing is valid, `pin_payload` shows exactly what will be sent to Pin. With an active
`connection_id`, Pin's own validation runs too (`checked_by_pin: true`); photos are not
uploaded for this check. Warnings do not block publishing. They flag paid placement, missing or
extra photos, and coordinates outside Trinidad and Tobago.

## Reference data

| Endpoint                                                | Returns                              |
| ------------------------------------------------------- | ------------------------------------ |
| `GET /v1/dictionaries/categories`                       | Categories and paid placement rules. |
| `GET /v1/dictionaries/categories/{category}/attributes` | Attributes and accepted values.      |
| `GET /v1/dictionaries/regions`                          | Regions.                             |
| `GET /v1/dictionaries/regions/{region}/districts`       | Districts of a region.               |

`503 dictionary_unavailable` means Pin Bridge has not loaded Pin's reference data yet. Retry later.
