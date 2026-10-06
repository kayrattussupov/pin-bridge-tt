import { describe, expect, it } from 'vitest';
import { signWebhook, verifyWebhook, webhookRetryDelayMs } from './webhook-signature';

describe('webhook signature', () => {
  const body = '{"id":"e1","type":"ping"}';

  it('round-trips', () => {
    const header = signWebhook('secret', body, 1_791_190_000);
    expect(header).toMatch(/^t=1791190000,v1=[0-9a-f]{64}$/);
    expect(verifyWebhook('secret', body, header, 300, 1_791_190_100)).toBe(true);
  });

  it('rejects another secret, a changed body, and old timestamps', () => {
    const header = signWebhook('secret', body, 1_791_190_000);
    expect(verifyWebhook('other', body, header, 300, 1_791_190_000)).toBe(false);
    expect(verifyWebhook('secret', `${body} `, header, 300, 1_791_190_000)).toBe(false);
    expect(verifyWebhook('secret', body, header, 300, 1_791_190_301)).toBe(false);
    expect(verifyWebhook('secret', body, 'garbage', 300, 1_791_190_000)).toBe(false);
  });
});

describe('webhookRetryDelayMs', () => {
  it('grows 3x per attempt, capped at 2 h, with ±20% jitter', () => {
    const mid = () => 0.5;
    expect([1, 2, 3, 4].map((n) => webhookRetryDelayMs(n, 10_000, mid))).toEqual([
      10_000, 30_000, 90_000, 270_000,
    ]);
    expect(webhookRetryDelayMs(20, 10_000, mid)).toBe(2 * 3600 * 1000);
    expect(webhookRetryDelayMs(1, 10_000, () => 0)).toBe(8_000);
    expect(webhookRetryDelayMs(1, 10_000, () => 0.999_999)).toBe(12_000);
  });
});
