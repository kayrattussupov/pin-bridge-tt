import { z } from 'zod';
import { CATEGORY_NAMES, REGION_NAMES } from '../dictionaries/catalog';

// Strip control characters (keep newlines and tabs), trim, and cap runs of blank lines.
const cleanText = (value: string) =>
  value
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const text = (min: number, max: number) =>
  z.string().transform(cleanText).pipe(z.string().min(min).max(max));

const attributeValue = z.union([
  z.string().max(200),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string().max(200), z.number()])).max(50),
]);

const pinAttrValue = z.union([
  z.number(),
  z.string().max(200),
  z.array(z.union([z.number(), z.string().max(200)])).max(50),
]);

/**
 * The listing format agencies send. Values are human-readable ("bedrooms": 3, "type":
 * "Apartment", "region": "central"); Pin Bridge maps them to Pin's ids. Unknown fields are
 * rejected so that typos do not silently drop data.
 */
export const listingSchema = z
  .object({
    external_id: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,64}$/, 'use 1-64 characters: letters, digits, . _ -'),
    category: z.enum(CATEGORY_NAMES),
    title: text(3, 100),
    description: text(0, 5000).default(''),
    price: z.number().nonnegative().max(1e10),
    currency: z.enum(['TTD']).default('TTD'),
    negotiable_price: z.boolean().default(false),
    region: z.enum(REGION_NAMES),
    district_ids: z.array(z.number().int().positive()).max(10).optional(),
    coordinates: z
      .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
      .strict()
      .optional(),
    // https is enforced by ListingValidationService (plain http only with the unsafe dev flag).
    images: z
      .array(z.url({ protocol: /^https?$/ }).max(2000))
      .max(50)
      .default([]),
    contact: z
      .object({
        name: text(1, 100).optional(),
        email: z.email().max(200).optional(),
        hide_phone: z.boolean().default(false),
      })
      .strict()
      .default({ hide_phone: false }),
    link: z
      .url({ protocol: /^https?$/ })
      .max(2000)
      .optional(),
    attributes: z.record(z.string().max(100), attributeValue).default({}),
    /** Advanced: raw Pin `attrs` (slug → variant key), applied over `attributes`. */
    pin_attrs: z.record(z.string().max(100), pinAttrValue).optional(),
  })
  .strict();

export type ListingInput = z.infer<typeof listingSchema>;
