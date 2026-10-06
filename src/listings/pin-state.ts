import type { Prisma } from '../generated/prisma/client';
import type { WebhookEvents } from '../webhooks/webhook-events';
import { listingView, pinStatusName } from './listing-view';

export interface PinState {
  pinStatus: number | null;
  notPaid: boolean | null;
  moderatorComment: string | null;
}

export const pinStateOf = (l: PinState): PinState => ({
  pinStatus: l.pinStatus,
  notPaid: l.notPaid,
  moderatorComment: l.moderatorComment,
});

/**
 * Emits `listing.status_changed` (moderation, payment or moderator comment changed) and
 * `listing.awaiting_payment` (Pin now waits for payment) for one listing, inside `tx`.
 */
export async function emitPinStateEvents(
  tx: Prisma.TransactionClient,
  events: WebhookEvents,
  listingId: string,
  before: PinState,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const listing = await tx.listing.findUniqueOrThrow({
    where: { id: listingId },
    include: { images: true },
  });
  const after = pinStateOf(listing);
  const changed =
    before.pinStatus !== after.pinStatus ||
    before.notPaid !== after.notPaid ||
    before.moderatorComment !== after.moderatorComment;
  if (!changed) {
    return;
  }
  const view = listingView(listing);
  await events.emit(tx, listing.agencyId, 'listing.status_changed', {
    listing: view,
    previous: { status: pinStatusName(before.pinStatus), not_paid: before.notPaid },
    ...extra,
  });
  if (after.notPaid === true && before.notPaid !== true) {
    await events.emit(tx, listing.agencyId, 'listing.awaiting_payment', { listing: view });
  }
}
