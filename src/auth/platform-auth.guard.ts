import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { ApiError } from '../common/api-error';
import { TokenBucket } from '../common/token-bucket';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { metrics } from '../observability/metrics';
import { RedisService } from '../queue/redis.service';
import { SignableRequest, checkSignature, claimNonce, signatureHeaders } from './signed-request';

/**
 * Authenticates the CRM platform (any agency deployment): X-Timestamp, X-Nonce and X-Signature
 * as for agencies, keyed by PLATFORM_SIGNING_SECRET, with no API key. Answers 404 while the
 * secret is not configured, so the endpoint does not exist on bridges that do not use it.
 */
@Injectable()
export class PlatformAuthGuard implements CanActivate {
  private readonly logger = new Logger(PlatformAuthGuard.name);
  private readonly bucket: TokenBucket;

  constructor(
    private readonly redis: RedisService,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.bucket = new TokenBucket(redis);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const secret = this.env.PLATFORM_SIGNING_SECRET;
    if (!secret) {
      throw ApiError.notFound('Route');
    }
    const req = context.switchToHttp().getRequest<SignableRequest>();
    const reject = (reason: string, extra: object = {}): never => {
      this.logger.warn({ reason, ip: req.ip, path: req.url, ...extra }, 'platform auth rejected');
      throw ApiError.unauthorized();
    };

    // Same strict per-IP budget as the public invite endpoint: it creates agencies.
    const perMinute = this.env.ENROLL_IP_RATE_LIMIT_PER_MIN;
    const wait = await this.bucket.take(
      `pin-bridge:enroll-ip:${req.ip}`,
      perMinute / 60,
      Math.max(1, Math.floor(perMinute)),
    );
    if (wait > 0) {
      metrics.enrollments.inc({ result: 'rate_limited' });
      throw ApiError.tooManyRequests(
        'rate_limited',
        'Too many enrollment attempts from this IP address.',
        wait / 1000,
      );
    }

    const headers = signatureHeaders(req);
    if (!headers) {
      return reject('missing_headers');
    }
    const tolerance = this.env.SIGNATURE_TOLERANCE_SECONDS;
    const problem = checkSignature(req, headers, secret, tolerance);
    if (problem) {
      return reject(problem.failure, { skewSeconds: problem.skewSeconds });
    }
    if (!(await claimNonce(this.redis, 'platform', headers.nonce, tolerance))) {
      return reject('replayed_nonce');
    }
    return true;
  }
}
