import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_VERSION = 'v1';
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export interface SignatureInput {
  /** Unix time in seconds, as sent in X-Timestamp. */
  timestamp: string;
  nonce: string;
  method: string;
  /** Request target exactly as sent: path plus query string, e.g. `/v1/me?x=1`. */
  path: string;
  body: Buffer | string;
}

/**
 * The string agencies sign with HMAC-SHA256 (hex), sent as `X-Signature: v1=<hex>`:
 *
 *   <timestamp>\n<nonce>\n<METHOD>\n<path?query>\n<sha256 hex of the raw body>
 */
export function canonicalString(input: SignatureInput): string {
  const bodyHash = createHash('sha256').update(input.body).digest('hex');
  return [input.timestamp, input.nonce, input.method.toUpperCase(), input.path, bodyHash].join(
    '\n',
  );
}

export function sign(secret: string, input: SignatureInput): string {
  const mac = createHmac('sha256', secret).update(canonicalString(input)).digest('hex');
  return `${SIGNATURE_VERSION}=${mac}`;
}

export function verifySignature(secret: string, input: SignatureInput, header: string): boolean {
  const expected = Buffer.from(sign(secret, input));
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
