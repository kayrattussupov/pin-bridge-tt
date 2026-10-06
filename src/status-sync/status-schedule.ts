const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * When to read a listing's status from Pin again. Pin moderates after publishing (a published
 * listing can still be rejected) and charges in some categories, so:
 * - on moderation or waiting for payment: often at first, then less (2 min → 10 min → 1 h);
 * - published and paid: every 6 h, to catch late moderation;
 * - hidden, rejected, blocked: daily.
 */
export function nextStatusCheckDelayMs(
  state: { pinStatus: number | null; notPaid: boolean | null },
  msSincePublished: number,
): number {
  const pending = state.pinStatus === 1 || state.notPaid === true;
  if (pending) {
    if (msSincePublished < 15 * MINUTE) {
      return 2 * MINUTE;
    }
    return msSincePublished < 2 * HOUR ? 10 * MINUTE : HOUR;
  }
  if (state.pinStatus === 0) {
    return 6 * HOUR;
  }
  return state.pinStatus === null ? HOUR : 24 * HOUR;
}
