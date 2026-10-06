import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { AgenciesService } from '../agencies/agencies.service';
import { ApiError } from '../common/api-error';
import { TokenBucket } from '../common/token-bucket';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { RedisService } from '../queue/redis.service';
import type { AuthenticatedRequest } from './agency-context';
import { verifyApiKey } from './api-key';
import { isIpAllowed } from './ip-allowlist';
import { checkSignature, claimNonce, headerOf, signatureHeaders } from './signed-request';

/**
 * Authenticates an agency server:
 *   Authorization: Bearer <api key>
 *   X-Timestamp:   unix seconds (within SIGNATURE_TOLERANCE_SECONDS)
 *   X-Nonce:       16-128 chars of [A-Za-z0-9_-], never reused
 *   X-Signature:   v1=<hex HMAC-SHA256(signing secret, canonical string)>, see auth/signature.ts
 *
 * Every authentication failure answers the same 401 so callers cannot probe which part was
 * wrong; the precise reason goes to the log.
 */
@Injectable()
export class AgencyAuthGuard implements CanActivate {
  private readonly logger = new Logger(AgencyAuthGuard.name);
  private readonly bucket: TokenBucket;

  constructor(
    private readonly agencies: AgenciesService,
    private readonly redis: RedisService,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.bucket = new TokenBucket(redis);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const reject = (reason: string, extra: object = {}): never => {
      this.logger.warn({ reason, ip: req.ip, path: req.url, ...extra }, 'agency auth rejected');
      throw ApiError.unauthorized();
    };

    // Cheap per-IP budget before touching the database, against key guessing and floods.
    const ipWait = await this.bucket.take(
      `pin-bridge:api-ip-limit:${req.ip}`,
      this.env.API_IP_RATE_LIMIT_RPS,
      this.env.API_IP_RATE_LIMIT_RPS * 2,
    );
    if (ipWait > 0) {
      throw ApiError.tooManyRequests(
        'rate_limited',
        'Too many requests from this IP address.',
        ipWait / 1000,
      );
    }

    const authorization = headerOf(req, 'authorization') ?? '';
    const apiKey = /^Bearer (\S+)$/.exec(authorization)?.[1];
    const headers = signatureHeaders(req);
    if (!apiKey || !headers) {
      return reject('missing_headers');
    }

    const key = await this.agencies.findKeyForAuth(apiKey);
    if (!key || !verifyApiKey(apiKey, key.keyHash, this.env.API_KEY_PEPPER)) {
      return reject('unknown_key');
    }
    const log = { keyPrefix: key.keyPrefix, agencyId: key.agencyId };
    if (key.revokedAt) {
      return reject('revoked_key', log);
    }
    if (key.agency.status !== 'active') {
      return reject('agency_suspended', log);
    }
    if (!isIpAllowed(req.ip, key.agency.ipAllowlist)) {
      this.logger.warn({ reason: 'ip_not_allowed', ip: req.ip, ...log }, 'agency auth rejected');
      throw ApiError.forbidden(`Requests from ${req.ip} are not allowed for this agency.`);
    }

    const tolerance = this.env.SIGNATURE_TOLERANCE_SECONDS;
    const problem = checkSignature(req, headers, this.agencies.signingSecretOf(key), tolerance);
    if (problem) {
      return reject(problem.failure, { ...log, skewSeconds: problem.skewSeconds });
    }
    // Checked after the signature, so nobody can burn an agency's nonces with forged requests.
    if (!(await claimNonce(this.redis, key.id, headers.nonce, tolerance))) {
      return reject('replayed_nonce', log);
    }
    // Charged only for authentic requests: a leaked key alone cannot drain the agency's budget.
    const wait = await this.bucket.take(
      `pin-bridge:api-rate-limit:${key.id}`,
      this.env.API_RATE_LIMIT_RPS,
      this.env.API_RATE_LIMIT_BURST,
    );
    if (wait > 0) {
      throw ApiError.rateLimited(wait);
    }

    req.agency = {
      agencyId: key.agency.id,
      agencySlug: key.agency.slug,
      agencyName: key.agency.name,
      apiKeyId: key.id,
      apiKeyPrefix: key.keyPrefix,
      scopes: key.scopes,
    };
    void this.agencies.touchApiKey(key.id).catch((error: unknown) => {
      this.logger.warn({ err: error, ...log }, 'failed to update api key last_used_at');
    });
    return true;
  }
}
