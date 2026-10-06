import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { NONCE_PATTERN } from '../auth/signature';
import { ApiError } from '../common/api-error';
import { TokenBucket } from '../common/token-bucket';
import { parseInput } from '../common/validation';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { metrics } from '../observability/metrics';
import { RedisService } from '../queue/redis.service';
import { EnrollmentService } from './enrollment.service';

const enrollSchema = z
  .object({
    invite_code: z.string().max(200),
    /** Random id chosen by the agency server; resend the same one if the response was lost. */
    client_request_id: z.string().regex(NONCE_PATTERN, '16-128 characters of A-Z a-z 0-9 _ -'),
    webhook_url: z.string().max(2000).optional(),
    agency_name: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

/**
 * Public: no API key exists yet. Guarded by a strict per-IP budget and single-use invite codes
 * with 160+ bits of entropy.
 */
@Controller('v1/enroll')
export class EnrollmentController {
  private readonly bucket: TokenBucket;

  constructor(
    private readonly enrollment: EnrollmentService,
    redis: RedisService,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.bucket = new TokenBucket(redis);
  }

  @Post()
  @HttpCode(201)
  async enroll(@Body() body: unknown, @Req() req: FastifyRequest) {
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
    const input = parseInput(enrollSchema, body);
    const result = await this.enrollment.redeem({
      code: input.invite_code,
      clientRequestId: input.client_request_id,
      webhookUrl: input.webhook_url,
      agencyName: input.agency_name,
      ip: req.ip,
    });
    return {
      agency: { id: result.agency.id, slug: result.agency.slug, name: result.agency.name },
      api_key: result.apiKey,
      signing_secret: result.signingSecret,
      key_prefix: result.keyPrefix,
      webhook: result.webhook ?? null,
      retried: result.retried,
    };
  }
}
