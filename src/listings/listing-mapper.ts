import {
  CATEGORIES,
  CURRENCIES,
  MAX_PIN_IMAGES,
  PAID_RULES,
  REGIONS,
  RENT_PAID_THRESHOLD,
} from '../dictionaries/catalog';
import type { District } from '../dictionaries/dictionaries.service';
import type { AttributeField, AttributeVariant, RubricForm } from '../dictionaries/rubric-form';
import type { CreateItemPayload } from '../pin/pin.types';
import type { ListingInput } from './listing.schema';

export interface ListingIssue {
  field: string;
  code: string;
  message: string;
  allowed?: string[];
}

export interface MappingContext {
  form: RubricForm;
  agencySlug: string;
  /** Default seller name: the connection's display name. */
  displayName: string;
  /** Districts of the listing's region, when known. */
  districts?: District[];
}

export interface MappingResult {
  errors: ListingIssue[];
  warnings: ListingIssue[];
  /** Pin payload without picture ids (pictures are uploaded at publish time). */
  payload?: CreateItemPayload;
  imageUrls: string[];
}

/** Rough bounding box of Trinidad and Tobago, to catch swapped or wrong coordinates. */
const TT_BOUNDS = { minLat: 9.9, maxLat: 11.5, minLng: -62.1, maxLng: -60.3 };

const YES = new Set(['yes', 'true', 'y', '1']);
const NO = new Set(['no', 'false', 'n', '0']);

const normalize = (value: string) =>
  value.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\.$/, '');

/**
 * The external id Pin sees: namespaced by agency so two agencies never collide. Slugs cannot
 * contain ".", so the first "." always separates them ("duck" + "realty-1" is "duck.realty-1",
 * never the same as "duck-realty" + "1").
 */
export const pinExternalId = (agencySlug: string, externalId: string) =>
  `${agencySlug}.${externalId}`;

function matchVariant(
  field: AttributeField,
  value: string | number | boolean,
): AttributeVariant | undefined {
  const variants = field.variants;
  if (typeof value === 'boolean') {
    const wanted = value ? YES : NO;
    return variants.find((v) => wanted.has(normalize(v.label)));
  }
  const exact = variants.find((v) => normalize(v.label) === normalize(String(value)));
  if (exact) {
    return exact;
  }
  // "5 bedrooms" with a top variant "4+": pick the largest "N+" with N <= value.
  const numeric = typeof value === 'number' ? value : Number(String(value).trim());
  if (Number.isFinite(numeric)) {
    const open = variants
      .map((v) => ({ v, n: /^(\d+(?:\.\d+)?)\s*\+$/.exec(v.label.trim())?.[1] }))
      .filter(
        (x): x is { v: AttributeVariant; n: string } => x.n !== undefined && Number(x.n) <= numeric,
      )
      .sort((a, b) => Number(b.n) - Number(a.n));
    return open[0]?.v;
  }
  return undefined;
}

const PIN_ATTR_PREFIX_RE = /^attrs__/;

/**
 * Pin reads attribute keys with the `attrs__` prefix, nested in `attrs`:
 * `{"attrs": {"attrs__bedrooms": 1}}`. Bare slugs (`{"bedrooms": 1}`) are silently ignored and
 * reported as "can not be empty"; so are top-level `attrs__bedrooms` keys (prod, 2026-10-07).
 */
function pinAttrs(attrs: CreateItemPayload['attrs']): CreateItemPayload['attrs'] {
  return Object.fromEntries(Object.entries(attrs).map(([slug, v]) => [`attrs__${slug}`, v]));
}

function mapAttribute(
  field: AttributeField,
  value: ListingInput['attributes'][string],
  issues: ListingIssue[],
): CreateItemPayload['attrs'][string] | undefined {
  const path = `attributes.${field.slug}`;
  const allowed = field.variants.map((v) => v.label);
  const unknownValue = (v: unknown) =>
    issues.push({
      field: path,
      code: 'unknown_value',
      message: `"${String(v)}" is not a valid ${field.title}.`,
      allowed,
    });

  switch (field.kind) {
    case 'number': {
      const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
      if (!Number.isFinite(n)) {
        issues.push({
          field: path,
          code: 'not_a_number',
          message: `${field.title} must be a number.`,
        });
        return undefined;
      }
      return n;
    }
    case 'text':
      if (typeof value === 'object') {
        issues.push({
          field: path,
          code: 'not_text',
          message: `${field.title} must be a single value.`,
        });
        return undefined;
      }
      return String(value);
    case 'select': {
      if (Array.isArray(value)) {
        issues.push({
          field: path,
          code: 'single_value_expected',
          message: `${field.title} takes one value.`,
          allowed,
        });
        return undefined;
      }
      const variant = matchVariant(field, value);
      if (!variant) {
        unknownValue(value);
        return undefined;
      }
      return variant.key;
    }
    case 'multiselect': {
      const values = Array.isArray(value) ? value : [value];
      const keys: (number | string)[] = [];
      for (const item of values) {
        const variant = matchVariant(field, item);
        if (!variant) {
          unknownValue(item);
        } else if (!keys.includes(variant.key)) {
          keys.push(variant.key);
        }
      }
      return keys.length ? keys : undefined;
    }
  }
}

/** Maps a validated agency listing to Pin's `POST /items/` body, collecting every problem at once. */
export function mapListing(listing: ListingInput, ctx: MappingContext): MappingResult {
  const errors: ListingIssue[] = [];
  const warnings: ListingIssue[] = [];
  const fields = new Map(ctx.form.fields.map((f) => [f.slug, f]));
  const attrs: CreateItemPayload['attrs'] = {};

  for (const [slug, value] of Object.entries(listing.attributes)) {
    const field = fields.get(slug);
    if (!field) {
      errors.push({
        field: `attributes.${slug}`,
        code: 'unknown_attribute',
        message: `"${slug}" is not an attribute of ${listing.category}.`,
        allowed: [...fields.keys()],
      });
      continue;
    }
    const mapped = mapAttribute(field, value, errors);
    if (mapped !== undefined) {
      attrs[slug] = mapped;
    }
  }
  for (const [key, value] of Object.entries(listing.pin_attrs ?? {})) {
    const slug = key.replace(PIN_ATTR_PREFIX_RE, '');
    if (!fields.has(slug)) {
      warnings.push({
        field: `pin_attrs.${key}`,
        code: 'unknown_attribute',
        message: `"${slug}" is not in Pin's form for ${listing.category}; sent as is.`,
      });
    }
    attrs[slug] = value;
  }
  for (const field of ctx.form.fields) {
    if (
      field.required &&
      attrs[field.slug] === undefined &&
      !errors.some((e) => e.field === `attributes.${field.slug}`)
    ) {
      errors.push({
        field: `attributes.${field.slug}`,
        code: 'required',
        message: `${field.title} is required for ${listing.category}.`,
        ...(field.variants.length ? { allowed: field.variants.map((v) => v.label) } : {}),
      });
    }
  }

  if (listing.district_ids?.length && ctx.districts) {
    const known = new Set(ctx.districts.map((d) => d.id));
    for (const id of listing.district_ids.filter((d) => !known.has(d))) {
      errors.push({
        field: 'district_ids',
        code: 'unknown_district',
        message: `District ${id} is not in region ${listing.region}.`,
      });
    }
  }

  if (listing.images.length > MAX_PIN_IMAGES) {
    warnings.push({
      field: 'images',
      code: 'too_many_images',
      message: `Pin shows at most ${MAX_PIN_IMAGES} images; the rest will not be published.`,
    });
  }
  if (listing.images.length === 0) {
    warnings.push({
      field: 'images',
      code: 'no_images',
      message: 'Listings without photos perform poorly.',
    });
  }
  if (listing.coordinates) {
    const { lat, lng } = listing.coordinates;
    if (
      lat < TT_BOUNDS.minLat ||
      lat > TT_BOUNDS.maxLat ||
      lng < TT_BOUNDS.minLng ||
      lng > TT_BOUNDS.maxLng
    ) {
      warnings.push({
        field: 'coordinates',
        code: 'outside_trinidad_and_tobago',
        message: 'Coordinates are outside Trinidad and Tobago. Are lat and lng swapped?',
      });
    }
  }
  if (listing.category === 'residential_sale' || listing.price > RENT_PAID_THRESHOLD) {
    warnings.push({ field: 'price', code: 'may_be_paid', message: PAID_RULES[listing.category] });
  }

  const imageUrls = listing.images.slice(0, MAX_PIN_IMAGES);
  if (errors.length) {
    return { errors, warnings, imageUrls };
  }
  const payload: CreateItemPayload = {
    rubric: CATEGORIES[listing.category].rubric,
    city: REGIONS[listing.region].id,
    ...(listing.district_ids?.length ? { city_districts: listing.district_ids } : {}),
    currency_id: CURRENCIES[listing.currency],
    title: listing.title,
    description: listing.description,
    price: listing.price,
    images: [],
    ...(listing.coordinates
      ? { coordinates: { latitude: listing.coordinates.lat, longitude: listing.coordinates.lng } }
      : {}),
    user: { name: listing.contact.name ?? ctx.displayName, email: listing.contact.email ?? '' },
    phone_hide: listing.contact.hide_phone,
    negotiable_price: listing.negotiable_price,
    external_id: pinExternalId(ctx.agencySlug, listing.external_id),
    item_link: listing.link ?? '',
    attrs: pinAttrs(attrs),
  };
  return { errors, warnings, payload, imageUrls };
}
