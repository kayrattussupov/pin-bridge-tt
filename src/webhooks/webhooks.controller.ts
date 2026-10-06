import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { AgencyAuthGuard } from '../auth/agency-auth.guard';
import { AgencyContext, CurrentAgency } from '../auth/agency-context';
import { parseInput } from '../common/validation';
import { WEBHOOK_EVENT_TYPES } from './webhook-events';
import { WebhooksService } from './webhooks.service';

const putSchema = z.object({
  url: z.string().max(2000),
  /** Empty or omitted: every event type. */
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).max(WEBHOOK_EVENT_TYPES.length).default([]),
  rotate_secret: z.boolean().default(false),
});

const deliveriesSchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

@Controller('v1/webhooks')
@UseGuards(AgencyAuthGuard)
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Put()
  async put(
    @CurrentAgency() agency: AgencyContext,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(putSchema, body);
    const result = await this.webhooks.put(agency, {
      url: input.url,
      events: [...new Set(input.events)],
      rotateSecret: input.rotate_secret,
    });
    void reply.status(result.created ? 201 : 200);
    return result.webhook;
  }

  @Get()
  get(@CurrentAgency() agency: AgencyContext) {
    return this.webhooks.get(agency);
  }

  @Delete()
  @HttpCode(204)
  async remove(@CurrentAgency() agency: AgencyContext): Promise<void> {
    await this.webhooks.remove(agency);
  }

  /** Queues a `ping` event to check the endpoint and signature verification. */
  @Post('test')
  @HttpCode(202)
  ping(@CurrentAgency() agency: AgencyContext) {
    return this.webhooks.ping(agency);
  }

  @Get('deliveries')
  deliveries(@CurrentAgency() agency: AgencyContext, @Query() query: unknown) {
    return this.webhooks.deliveries(agency, parseInput(deliveriesSchema, query).limit);
  }
}
