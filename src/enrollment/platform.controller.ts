import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SLUG_PATTERN } from '../agencies/agencies.service';
import { PlatformAuthGuard } from '../auth/platform-auth.guard';
import { NONCE_PATTERN } from '../auth/signature';
import { ApiError } from '../common/api-error';
import { parseInput } from '../common/validation';
import { DomainProofService, isUnderOrigin } from './domain-proof';
import { EnrollmentService } from './enrollment.service';

const provisionSchema = z
  .object({
    /** The agency's subdomain: morelli-realty for https://morelli-realty.duckcrm.one. */
    slug: z.string().regex(SLUG_PATTERN, 'lowercase letters, digits and -, 2-31 characters'),
    name: z.string().trim().min(1).max(100),
    /** Random id chosen by the deployment; its SHA-256 is served as the domain proof. */
    client_request_id: z.string().regex(NONCE_PATTERN, '16-128 characters of A-Z a-z 0-9 _ -'),
    webhook_url: z.string().max(2000).optional(),
  })
  .strict();

/**
 * Self-service enrollment by the CRM platform: an agency deployment connects itself, without an
 * operator or invite code. Signed with PLATFORM_SIGNING_SECRET and bound to the agency's own
 * subdomain, see DomainProofService.
 */
@Controller('v1/platform/agencies')
@UseGuards(PlatformAuthGuard)
export class PlatformController {
  constructor(
    private readonly enrollment: EnrollmentService,
    private readonly proof: DomainProofService,
  ) {}

  @Post()
  @HttpCode(201)
  async provision(@Body() body: unknown, @Req() req: FastifyRequest) {
    const input = parseInput(provisionSchema, body);
    const origin = this.proof.originOf(input.slug);
    if (input.webhook_url !== undefined && !isUnderOrigin(input.webhook_url, origin)) {
      throw new ApiError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'invalid_webhook_url',
        `The webhook URL must be under ${origin}/.`,
      );
    }
    await this.proof.verify(input.slug, input.client_request_id);
    const result = await this.enrollment.provision({
      slug: input.slug,
      name: input.name,
      clientRequestId: input.client_request_id,
      webhookUrl: input.webhook_url,
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
