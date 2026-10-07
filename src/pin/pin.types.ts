import { z } from 'zod';

// Response schemas are deliberately loose: Pin has no published OpenAPI for prod, so we validate
// only the fields we rely on and keep the rest (passthrough) for logging and later use.

const id = z.union([z.number(), z.string()]).transform(String);

/**
 * Prod returns the key as `id` (`{"id": "<uuid>", "user": ..., "maestro_uuid": null, ...}`);
 * Pin's docs called it `uuid`, so both are accepted.
 */
export const deviceKeySchema = z
  .looseObject({ id: z.string().min(1).optional(), uuid: z.string().min(1).optional() })
  .refine((body) => body.id ?? body.uuid, { message: 'no device key in `id` or `uuid`' })
  .transform((body) => ({ uuid: (body.id ?? body.uuid)! }));

export const phoneVerifyRequestSchema = z.looseObject({
  status: z.number(),
  end_date: z.union([z.number(), z.string()]).optional(),
});

export const phoneVerifyConfirmSchema = z.looseObject({
  status: z.literal(0),
  token: z.string().min(1),
});

export const picSchema = z.looseObject({ id });

/** Moderation status of an item: 0 published, 1 on review, 2 hidden, 3 rejected, 4 blocked. */
export const PIN_ITEM_STATUS = {
  published: 0,
  onModeration: 1,
  hidden: 2,
  rejected: 3,
  blocked: 4,
} as const;

const STATUS_KEYS = ['id', 'value', 'code', 'status'] as const;

/**
 * POST /items/ returns `status` as a number, but prod front_my returns an object there (seen
 * 2026-10-07, exact shape not captured yet). Take the numeric code from either form; anything
 * unrecognised becomes undefined so one odd item cannot fail the whole status poll.
 */
function pinStatusCode(value: unknown): number | undefined {
  const asCode = (v: unknown): number | undefined => {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 4 ? n : undefined;
  };
  if (value !== null && typeof value === 'object') {
    for (const key of STATUS_KEYS) {
      const code = asCode((value as Record<string, unknown>)[key]);
      if (code !== undefined) {
        return code;
      }
    }
    return undefined;
  }
  return asCode(value);
}

export const pinItemSchema = z.looseObject({
  id,
  status: z.unknown().optional().transform(pinStatusCode),
  not_paid: z.boolean().optional(),
  moderator_comment: z.string().nullable().optional(),
  external_id: z.string().nullable().optional(),
});
export type PinItem = z.infer<typeof pinItemSchema>;

/** front_my may be a bare array or a paginated `{results, next}` envelope; accept both. */
export const pinItemListSchema = z.union([
  z.array(pinItemSchema).transform((results) => ({ results, next: null as string | null })),
  z
    .looseObject({
      results: z.array(pinItemSchema),
      next: z.string().nullable().optional(),
    })
    .transform((page) => ({ results: page.results, next: page.next ?? null })),
]);
export type PinItemList = z.infer<typeof pinItemListSchema>;

export interface PinAuth {
  deviceKey: string;
  token: string;
}

export interface PinCoordinates {
  latitude: number;
  longitude: number;
}

/**
 * Body of POST /items/ as described by Pin. `attrs` keys are `attrs__<slug>` and values are
 * variant keys from rubric_form.
 */
export interface CreateItemPayload {
  rubric: number;
  /** On pin.tt this is the region id: 17 Central, 18 NE, 21 NW, 23 SW, 22 SE, 15 Tobago. */
  city: number;
  city_districts?: number[];
  currency_id: number;
  title: string;
  description: string;
  price?: number;
  images: (number | string)[];
  coordinates?: PinCoordinates;
  user: { name: string; email?: string };
  phone_hide?: boolean;
  negotiable_price?: boolean;
  external_id: string;
  item_link?: string;
  attrs: Record<string, number | string | (number | string)[]>;
}

export interface UploadPictureInput {
  data: Buffer;
  filename: string;
  contentType: 'image/jpeg' | 'image/png';
}
