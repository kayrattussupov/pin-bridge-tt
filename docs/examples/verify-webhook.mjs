// Verifying Pin Bridge webhooks in Node.js 18+ (no dependencies).
// Use the RAW request body: re-serializing parsed JSON changes the bytes and breaks the signature.
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyPinBridgeWebhook(rawBody, signatureHeader, secret, toleranceSeconds = 300) {
  const parts = Object.fromEntries(signatureHeader.split(',').map((p) => p.split('=', 2)));
  const timestamp = Number(parts.t);
  if (
    !parts.v1 ||
    !Number.isFinite(timestamp) ||
    Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds
  ) {
    return false;
  }
  const expected = createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Self-check: node verify-webhook.mjs
if (process.argv[1]?.endsWith('verify-webhook.mjs')) {
  const body = '{"id":"e1","type":"ping"}';
  const t = Math.floor(Date.now() / 1000);
  const header = `t=${t},v1=${createHmac('sha256', 'secret').update(`${t}.${body}`).digest('hex')}`;
  console.log(
    verifyPinBridgeWebhook(body, header, 'secret'),
    verifyPinBridgeWebhook(body, header, 'wrong'),
  );
}
