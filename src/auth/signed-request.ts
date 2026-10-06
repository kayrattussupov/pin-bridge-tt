import type { FastifyRequest } from 'fastify';
import type { RedisService } from '../queue/redis.service';
import { NONCE_PATTERN, verifySignature } from './signature';

/** A request whose raw body Nest captured, so it can be signed byte for byte. */
export type SignableRequest = FastifyRequest & { rawBody?: Buffer };

export interface SignatureHeaders {
  timestamp: string;
  nonce: string;
  signature: string;
}

export type SignatureFailure = 'stale_timestamp' | 'bad_nonce' | 'unsigned_body' | 'bad_signature';

export function headerOf(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function signatureHeaders(req: FastifyRequest): SignatureHeaders | undefined {
  const timestamp = headerOf(req, 'x-timestamp');
  const nonce = headerOf(req, 'x-nonce');
  const signature = headerOf(req, 'x-signature');
  return timestamp && nonce && signature ? { timestamp, nonce, signature } : undefined;
}

/**
 * Checks X-Timestamp, X-Nonce and X-Signature against `secret` (see auth/signature.ts).
 * Returns why the request is refused, or undefined when it is authentic. Replays are checked
 * separately with claimNonce, after this succeeds.
 */
export function checkSignature(
  req: SignableRequest,
  headers: SignatureHeaders,
  secret: string,
  toleranceSeconds: number,
): { failure: SignatureFailure; skewSeconds?: number } | undefined {
  const { timestamp, nonce, signature } = headers;
  const skew = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!/^\d{1,12}$/.test(timestamp) || skew > toleranceSeconds) {
    return { failure: 'stale_timestamp', skewSeconds: Math.round(skew) };
  }
  if (!NONCE_PATTERN.test(nonce)) {
    return { failure: 'bad_nonce' };
  }
  // Only bodies Nest captured as raw bytes can be signed; anything else (e.g. text/plain) would
  // otherwise be checked against an empty body.
  if (req.body !== undefined && req.body !== null && req.rawBody === undefined) {
    return { failure: 'unsigned_body' };
  }
  const valid = verifySignature(
    secret,
    { timestamp, nonce, method: req.method, path: req.url, body: req.rawBody ?? '' },
    signature,
  );
  return valid ? undefined : { failure: 'bad_signature' };
}

/** Records a nonce; false if it was already used within the signature tolerance. */
export async function claimNonce(
  redis: RedisService,
  scope: string,
  nonce: string,
  toleranceSeconds: number,
): Promise<boolean> {
  const fresh = await redis.set(
    `pin-bridge:nonce:${scope}:${nonce}`,
    '1',
    'EX',
    toleranceSeconds * 2,
    'NX',
  );
  return fresh === 'OK';
}
