import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Header `X-PinBridge-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`.
 * Receivers recompute it over the raw body and reject old timestamps to stop replays.
 */
export function signWebhook(
  secret: string,
  body: string,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

export function verifyWebhook(
  secret: string,
  body: string,
  header: string,
  toleranceSeconds = 300,
  now = Math.floor(Date.now() / 1000),
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((p) => p.split('=', 2) as [string, string]),
  );
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > toleranceSeconds || !parts.v1) {
    return false;
  }
  const expected = Buffer.from(signWebhook(secret, body, timestamp));
  const actual = Buffer.from(`t=${parts.t},v1=${parts.v1}`);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Delay before attempt `attempt + 1`: base * 3^(attempt - 1), capped at 2 h, ±20% jitter. */
export function webhookRetryDelayMs(
  attempt: number,
  baseMs: number,
  random: () => number = Math.random,
): number {
  const raw = Math.min(baseMs * 3 ** Math.max(0, attempt - 1), 2 * 3600 * 1000);
  return Math.round(raw * (0.8 + random() * 0.4));
}
