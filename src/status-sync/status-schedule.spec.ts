import { describe, expect, it } from 'vitest';
import { nextStatusCheckDelayMs } from './status-schedule';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('nextStatusCheckDelayMs', () => {
  it('checks pending moderation or payment often at first, then less', () => {
    expect(nextStatusCheckDelayMs({ pinStatus: 1, notPaid: false }, 5 * MIN)).toBe(2 * MIN);
    expect(nextStatusCheckDelayMs({ pinStatus: 0, notPaid: true }, 30 * MIN)).toBe(10 * MIN);
    expect(nextStatusCheckDelayMs({ pinStatus: 1, notPaid: false }, 3 * HOUR)).toBe(HOUR);
  });

  it('keeps an eye on published listings (post-moderation) every 6 h', () => {
    expect(nextStatusCheckDelayMs({ pinStatus: 0, notPaid: false }, 10 * HOUR)).toBe(6 * HOUR);
  });

  it('checks hidden, rejected and blocked listings daily', () => {
    for (const pinStatus of [2, 3, 4]) {
      expect(nextStatusCheckDelayMs({ pinStatus, notPaid: false }, HOUR)).toBe(24 * HOUR);
    }
  });
});
