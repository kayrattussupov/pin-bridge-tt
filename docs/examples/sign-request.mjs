// Minimal Pin Bridge client for Node.js 18+ (no dependencies).
// Usage: PB_URL=https://bridge.duckcrm.one PB_API_KEY=... PB_SIGNING_SECRET=... node sign-request.mjs
import { createHash, createHmac, randomBytes } from 'node:crypto';

export async function pinBridgeRequest(method, path, body) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('hex');
  const bodyHash = createHash('sha256').update(payload).digest('hex');
  const canonical = [timestamp, nonce, method.toUpperCase(), path, bodyHash].join('\n');
  const signature =
    'v1=' + createHmac('sha256', process.env.PB_SIGNING_SECRET).update(canonical).digest('hex');

  const res = await fetch((process.env.PB_URL ?? 'https://bridge.duckcrm.one') + path, {
    method,
    headers: {
      authorization: `Bearer ${process.env.PB_API_KEY}`,
      'x-timestamp': timestamp,
      'x-nonce': nonce,
      'x-signature': signature,
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    body: payload || undefined,
  });
  return { status: res.status, body: await res.json() };
}

console.log(await pinBridgeRequest('GET', '/v1/me'));
