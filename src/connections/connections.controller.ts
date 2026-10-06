import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { AgencyAuthGuard } from '../auth/agency-auth.guard';
import { AgencyContext, CurrentAgency } from '../auth/agency-context';
import { parseInput } from '../common/validation';
import { ConnectionsService } from './connections.service';

const startSchema = z.object({
  phone: z.string().min(7).max(32),
  /** Name buyers see on the listings (Pin's `user.name`). */
  display_name: z.string().trim().min(1).max(100),
});

const confirmSchema = z.object({
  code: z.string().regex(/^\d{4,8}$/, 'must be the 4-8 digit code from the SMS'),
});

/**
 * Connecting a Pin account (one-time per phone number):
 *   1. POST /v1/connections            { phone, display_name } → Pin sends an SMS code
 *   2. POST /v1/connections/:id/confirm { code }               → status becomes "active"
 * The confirm that activates the number returns `pin_credentials` once, for the agency's own
 * copy. Pin Bridge keeps its encrypted copy for publishing and background jobs.
 */
@Controller('v1/connections')
@UseGuards(AgencyAuthGuard)
export class ConnectionsController {
  constructor(private readonly connections: ConnectionsService) {}

  @Post()
  async start(
    @CurrentAgency() agency: AgencyContext,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(startSchema, body);
    const result = await this.connections.start(agency, {
      phone: input.phone,
      displayName: input.display_name,
    });
    void reply.status(result.created ? 201 : 200);
    return { ...result.connection, sms_sent: result.smsSent };
  }

  @Get()
  async list(@CurrentAgency() agency: AgencyContext) {
    return { data: await this.connections.list(agency) };
  }

  @Get(':id')
  get(@CurrentAgency() agency: AgencyContext, @Param('id') id: string) {
    return this.connections.get(agency, id);
  }

  @Post(':id/confirm')
  @HttpCode(200)
  async confirm(
    @CurrentAgency() agency: AgencyContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const result = await this.connections.confirm(agency, id, parseInput(confirmSchema, body).code);
    return result.pinCredentials
      ? { ...result.connection, pin_credentials: result.pinCredentials }
      : result.connection;
  }

  @Post(':id/resend')
  @HttpCode(200)
  resend(@CurrentAgency() agency: AgencyContext, @Param('id') id: string) {
    return this.connections.resend(agency, id);
  }

  @Delete(':id')
  disable(@CurrentAgency() agency: AgencyContext, @Param('id') id: string) {
    return this.connections.disable(agency, id);
  }
}
