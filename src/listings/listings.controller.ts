import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { AgencyAuthGuard } from '../auth/agency-auth.guard';
import { AgencyContext, AuthenticatedRequest, CurrentAgency } from '../auth/agency-context';
import { parseInput } from '../common/validation';
import type { DesiredState } from '../generated/prisma/client';
import { IdempotencyService } from './idempotency.service';
import { ListingValidationService } from './listing-validation.service';
import { ListingCommandResult, ListingsService } from './listings.service';

const validateSchema = z.object({
  connection_id: z.uuid().optional(),
  listing: z.unknown(),
});

const listQuerySchema = z.object({
  sync_state: z.enum(['queued', 'processing', 'synced', 'failed']).optional(),
  desired_state: z.enum(['active', 'inactive', 'removed']).optional(),
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

@Controller('v1')
@UseGuards(AgencyAuthGuard)
export class ListingsController {
  constructor(
    private readonly validation: ListingValidationService,
    private readonly listings: ListingsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /** Checks a listing without publishing it. Always 200; see `valid`, `errors`, `warnings`. */
  @Post('listings/validate')
  @HttpCode(200)
  validate(@CurrentAgency() agency: AgencyContext, @Body() body: unknown) {
    const input = parseInput(validateSchema, body);
    return this.validation.validate(agency, input.listing, input.connection_id);
  }

  /** Create or replace a listing. 202: queued for Pin; 200: identical to what is stored. */
  @Put('connections/:connectionId/listings/:externalId')
  upsert(
    @CurrentAgency() agency: AgencyContext,
    @Param('connectionId') connectionId: string,
    @Param('externalId') externalId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.command(agency, req, reply, idempotencyKey, body, () =>
      this.listings.upsert(agency, connectionId, externalId, body),
    );
  }

  @Get('connections/:connectionId/listings')
  list(
    @CurrentAgency() agency: AgencyContext,
    @Param('connectionId') connectionId: string,
    @Query() query: unknown,
  ) {
    const filters = parseInput(listQuerySchema, query);
    return this.listings.list(agency, connectionId, {
      syncState: filters.sync_state,
      desiredState: filters.desired_state,
      cursor: filters.cursor,
      limit: filters.limit,
    });
  }

  @Get('connections/:connectionId/listings/:externalId')
  get(
    @CurrentAgency() agency: AgencyContext,
    @Param('connectionId') connectionId: string,
    @Param('externalId') externalId: string,
  ) {
    return this.listings.get(agency, connectionId, externalId);
  }

  @Post('connections/:connectionId/listings/:externalId/deactivate')
  deactivate(
    @CurrentAgency() agency: AgencyContext,
    @Param('connectionId') connectionId: string,
    @Param('externalId') externalId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.setState(agency, connectionId, externalId, idempotencyKey, req, reply, 'inactive');
  }

  @Post('connections/:connectionId/listings/:externalId/activate')
  activate(
    @CurrentAgency() agency: AgencyContext,
    @Param('connectionId') connectionId: string,
    @Param('externalId') externalId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.setState(agency, connectionId, externalId, idempotencyKey, req, reply, 'active');
  }

  @Delete('connections/:connectionId/listings/:externalId')
  remove(
    @CurrentAgency() agency: AgencyContext,
    @Param('connectionId') connectionId: string,
    @Param('externalId') externalId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.setState(agency, connectionId, externalId, idempotencyKey, req, reply, 'removed');
  }

  private setState(
    agency: AgencyContext,
    connectionId: string,
    externalId: string,
    idempotencyKey: string | undefined,
    req: AuthenticatedRequest,
    reply: FastifyReply,
    desired: DesiredState,
  ) {
    return this.command(agency, req, reply, idempotencyKey, { desired }, () =>
      this.listings.setDesiredState(agency, connectionId, externalId, desired),
    );
  }

  private async command(
    agency: AgencyContext,
    req: AuthenticatedRequest,
    reply: FastifyReply,
    idempotencyKey: string | undefined,
    body: unknown,
    execute: () => Promise<ListingCommandResult>,
  ) {
    const result = await this.idempotency.run(
      agency.agencyId,
      idempotencyKey,
      { method: req.method, path: req.url, body },
      async () => {
        const { status, listing } = await execute();
        return { status, body: listing };
      },
    );
    if (result.replayed) {
      void reply.header('idempotent-replayed', 'true');
    }
    void reply.status(result.status);
    return result.body;
  }
}
