import type { Listing, ListingImage } from '../generated/prisma/client';

export const PIN_STATUS_NAMES = [
  'published',
  'on_moderation',
  'hidden',
  'rejected',
  'blocked',
] as const;
export type PinStatusName = (typeof PIN_STATUS_NAMES)[number];

export function pinStatusName(status: number | null): PinStatusName | null {
  return status === null ? null : (PIN_STATUS_NAMES[status] ?? null);
}

export interface ListingView {
  external_id: string;
  connection_id: string;
  category: string;
  desired_state: Listing['desiredState'];
  sync_state: Listing['syncState'];
  /** True only when Pin shows the listing to buyers: published and not waiting for payment. */
  live: boolean;
  pin: {
    item_id: string | null;
    status: PinStatusName | null;
    not_paid: boolean | null;
    moderator_comment: string | null;
  };
  images: { url: string; status: ListingImage['status']; error: string | null }[];
  warnings: unknown[];
  last_error: unknown;
  version: number;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export function listingView(listing: Listing & { images?: ListingImage[] }): ListingView {
  const payload = listing.payload as { category?: string };
  return {
    external_id: listing.externalId,
    connection_id: listing.connectionId,
    category: payload.category ?? String(listing.rubric),
    desired_state: listing.desiredState,
    sync_state: listing.syncState,
    live: listing.desiredState === 'active' && listing.pinStatus === 0 && listing.notPaid === false,
    pin: {
      item_id: listing.pinItemId,
      status: pinStatusName(listing.pinStatus),
      not_paid: listing.notPaid,
      moderator_comment: listing.moderatorComment,
    },
    images: (listing.images ?? [])
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((image) => ({ url: image.sourceUrl, status: image.status, error: image.error })),
    warnings: (listing.warnings as unknown[] | null) ?? [],
    last_error: listing.lastError ?? null,
    version: listing.version,
    last_synced_at: listing.lastSyncedAt?.toISOString() ?? null,
    created_at: listing.createdAt.toISOString(),
    updated_at: listing.updatedAt.toISOString(),
  };
}
