import { createHash } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Dispatcher, request } from 'undici';
import { ApiError } from '../common/api-error';
import {
  BLOCKED_HOST_CODE,
  checkOutboundUrl,
  createSafeDispatcher,
  errorCodeOf,
} from '../common/safe-http';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';

export const ENROLL_PROOF_PATH = '/.well-known/pin-bridge-enroll';
const MAX_PROOF_BYTES = 1024;

/** What an agency deployment serves at ENROLL_PROOF_PATH while it enrolls: hex SHA-256. */
export function enrollProof(clientRequestId: string): string {
  return createHash('sha256').update(clientRequestId).digest('hex');
}

/** The agency's own address, from PLATFORM_AGENCY_ORIGIN; without a trailing slash. */
export function agencyOrigin(template: string, slug: string): string {
  return template.replaceAll('{slug}', slug).replace(/\/+$/, '');
}

/** True if `url` lies under the agency's origin (same scheme, host and port, and path prefix). */
export function isUnderOrigin(url: string, origin: string): boolean {
  let target: URL;
  let base: URL;
  try {
    target = new URL(url);
    base = new URL(origin);
  } catch {
    return false;
  }
  const prefix = base.pathname.replace(/\/+$/, '');
  return target.origin === base.origin && target.pathname.startsWith(`${prefix}/`);
}

/**
 * Proves that a platform call for an agency slug comes from the deployment that serves that
 * agency's domain: every deployment holds the platform secret, but only one answers on
 * https://<slug>.duckcrm.one. The proof is bound to the call by its client_request_id.
 */
@Injectable()
export class DomainProofService implements OnModuleDestroy {
  private readonly logger = new Logger(DomainProofService.name);
  private readonly dispatcher: Dispatcher;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.dispatcher = createSafeDispatcher({
      allowPrivateHosts: env.UNSAFE_ALLOW_PRIVATE_OUTBOUND_HOSTS,
      connectTimeoutMs: env.PLATFORM_VERIFY_TIMEOUT_MS,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.dispatcher.close();
  }

  originOf(slug: string): string {
    return agencyOrigin(this.env.PLATFORM_AGENCY_ORIGIN, slug);
  }

  async verify(slug: string, clientRequestId: string): Promise<void> {
    const url = `${this.originOf(slug)}${ENROLL_PROOF_PATH}`;
    const fail = (reason: string) => {
      this.logger.warn({ slug, url, reason }, 'agency domain not verified');
      return new ApiError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'domain_not_verified',
        `${url} must answer 200 with the hex SHA-256 of client_request_id.`,
        { url, reason },
      );
    };
    const checked = checkOutboundUrl(url, this.env.UNSAFE_ALLOW_PRIVATE_OUTBOUND_HOSTS);
    if ('problem' in checked) {
      throw fail(checked.problem);
    }
    let text: string;
    try {
      // undici's request() does not follow redirects: the proof must come from this very host.
      const res = await request(checked.url, {
        method: 'GET',
        dispatcher: this.dispatcher,
        signal: AbortSignal.timeout(this.env.PLATFORM_VERIFY_TIMEOUT_MS),
        headers: { 'user-agent': 'PinBridge-Enroll/1', accept: 'text/plain' },
      });
      text = await this.readSmall(res.body);
      if (res.statusCode !== 200) {
        throw fail(`HTTP ${res.statusCode}`);
      }
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      throw fail(
        errorCodeOf(error) === BLOCKED_HOST_CODE
          ? 'host resolves to a non-public address'
          : error instanceof Error
            ? error.message
            : String(error),
      );
    }
    if (text.trim().toLowerCase() !== enrollProof(clientRequestId)) {
      throw fail('proof mismatch');
    }
  }

  private async readSmall(body: Dispatcher.ResponseData['body']): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of body) {
      size += (chunk as Buffer).length;
      if (size > MAX_PROOF_BYTES) {
        body.destroy();
        return '';
      }
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}
