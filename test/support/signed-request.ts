import { randomBytes } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sign } from '../../src/auth/signature';

export interface Credentials {
  apiKey: string;
  signingSecret: string;
}

export interface SignedRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  remoteAddress?: string;
  /** Override pieces to simulate broken or malicious clients. */
  timestamp?: string;
  nonce?: string;
  signWith?: string;
  /** Sign this body but send `body`. */
  signedBody?: string;
}

/** Sends a request the way an agency server should, signed per docs/agency-api-auth.md. */
export async function signedRequest(
  app: NestFastifyApplication,
  credentials: Credentials,
  options: SignedRequestOptions,
) {
  const method = options.method ?? 'GET';
  const payload = options.body === undefined ? '' : JSON.stringify(options.body);
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = options.nonce ?? randomBytes(16).toString('hex');
  const signature = sign(options.signWith ?? credentials.signingSecret, {
    timestamp,
    nonce,
    method,
    path: options.path,
    body: options.signedBody ?? payload,
  });
  return app.inject({
    method,
    url: options.path,
    payload: payload || undefined,
    remoteAddress: options.remoteAddress,
    headers: {
      authorization: `Bearer ${credentials.apiKey}`,
      'x-timestamp': timestamp,
      'x-nonce': nonce,
      'x-signature': signature,
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
  });
}

/** Auth headers for a hand-built request (signs `signedBody`). */
export function signatureHeaders(
  credentials: Credentials,
  method: string,
  path: string,
  signedBody: string,
): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('hex');
  return {
    'x-timestamp': timestamp,
    'x-nonce': nonce,
    'x-signature': sign(credentials.signingSecret, {
      timestamp,
      nonce,
      method,
      path,
      body: signedBody,
    }),
  };
}
