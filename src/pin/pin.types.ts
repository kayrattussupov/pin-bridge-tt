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

/**
 * Prod front_my returns `status` as an object, not the number POST /items/ gives (2026-10-07):
 * `{"status": ["Pending for review", "Active until …"], "code": "status_check", "comment": "", …}`.
 * Verified: `status_check` (on review) and `status_active` (published, "Active until …"). Codes
 * are looked up without the `status_` prefix; the others are guesses from their names. Unknown
 * codes map to undefined (the previous status is kept) and are logged by the status sync.
 */
const FRONT_MY_STATUS_CODES: Record<string, number> = {
  check: PIN_ITEM_STATUS.onModeration,
  moderation: PIN_ITEM_STATUS.onModeration,
  active: PIN_ITEM_STATUS.published,
  published: PIN_ITEM_STATUS.published,
  hidden: PIN_ITEM_STATUS.hidden,
  inactive: PIN_ITEM_STATUS.hidden,
  deactivated: PIN_ITEM_STATUS.hidden,
  rejected: PIN_ITEM_STATUS.rejected,
  declined: PIN_ITEM_STATUS.rejected,
  blocked: PIN_ITEM_STATUS.blocked,
  banned: PIN_ITEM_STATUS.blocked,
};

const statusObjectSchema = z.looseObject({
  code: z.string().optional(),
  comment: z.string().nullable().optional(),
  status: z.array(z.string()).optional(),
});

function numericStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 4
    ? value
    : undefined;
}

export const pinItemSchema = z
  .looseObject({
    id,
    status: z.unknown().optional(),
    not_paid: z.boolean().nullable().optional(),
    moderator_comment: z.string().nullable().optional(),
    external_id: z.string().nullable().optional(),
  })
  .transform((item) => {
    const detail = statusObjectSchema.safeParse(item.status);
    if (!detail.success || item.status === null || typeof item.status !== 'object') {
      return { ...item, status: numericStatus(item.status) };
    }
    const code = detail.data.code;
    return {
      ...item,
      status: code === undefined ? undefined : FRONT_MY_STATUS_CODES[code.replace(/^status_/, '')],
      moderator_comment: item.moderator_comment ?? (detail.data.comment || null),
      /** Pin's raw status code and labels, kept for logging codes we cannot map yet. */
      status_code: code,
      status_text: detail.data.status,
    };
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
