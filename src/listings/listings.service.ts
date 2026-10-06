import { createHash } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import type { AgencyContext } from '../auth/agency-context';
import { ApiError } from '../common/api-error';
import { ConnectionsService } from '../connections/connections.service';
import { PrismaService } from '../database/prisma.service';
import { Prisma } from '../generated/prisma/client';
import type { DesiredState, Listing, SyncState } from '../generated/prisma/client';
import { ListingSyncQueue } from '../queue/listing-sync.queue';
import { ListingValidationService } from './listing-validation.service';
import { ListingView, listingView } from './listing-view';

const EXTERNAL_ID = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_PAGE = 100;

export interface ListingCommandResult {
  /** 202 when Pin work was queued, 200 when nothing had to change. */
  status: 200 | 202;
  listing: ListingView;
}

/** Agency-side listing commands. Everything that talks to Pin happens later, in the worker. */
@Injectable()
export class ListingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: ConnectionsService,
    private readonly validation: ListingValidationService,
    private readonly queue: ListingSyncQueue,
  ) {}

  /** Create or replace a listing (full document). Invalid data is refused before queuing. */
  async upsert(
    agency: AgencyContext,
    connectionId: string,
    externalId: string,
    body: unknown,
  ): Promise<ListingCommandResult> {
    try {
      return await this.upsertOnce(agency, connectionId, externalId, body);
    } catch (error) {
      // Two first-time PUTs of the same listing raced to create the row: the loser retries as
      // an update of the row the winner created.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return this.upsertOnce(agency, connectionId, externalId, body);
      }
      throw error;
    }
  }

  private async upsertOnce(
    agency: AgencyContext,
    connectionId: string,
    externalId: string,
    body: unknown,
  ): Promise<ListingCommandResult> {
    this.checkExternalId(externalId);
    const connection = await this.connections.findOwned(agency, connectionId);
    if (connection.status === 'disabled') {
      throw new ApiError(
        HttpStatus.CONFLICT,
        'connection_not_active',
        'The connection is disabled; connect it again first.',
      );
    }
    const record =
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    if (record.external_id !== undefined && record.external_id !== externalId) {
      throw new ApiError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'invalid_listing',
        'external_id in the body does not match the URL.',
      );
    }
    const mapping = await this.validation.map(
      agency,
      { ...record, external_id: externalId },
      connection.displayName,
    );
    if (mapping.errors.length || !mapping.listing) {
      throw new ApiError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'invalid_listing',
        'The listing is not valid.',
        {
          errors: mapping.errors,
          warnings: mapping.warnings,
        },
      );
    }
    const listing = mapping.listing;
    const payloadHash = createHash('sha256').update(JSON.stringify(listing)).digest('hex');
    const where = {
      agencyId_connectionId_externalId: {
        agencyId: agency.agencyId,
        connectionId: connection.id,
        externalId,
      },
    };
    const existing = await this.prisma.listing.findUnique({ where });
    if (
      existing &&
      existing.payloadHash === payloadHash &&
      existing.desiredState === 'active' &&
      existing.syncState !== 'failed'
    ) {
      return { status: 200, listing: await this.view(existing.id) };
    }

    const saved = await this.prisma.$transaction(async (tx) => {
      const data = {
        rubric: mapping.payload!.rubric,
        payload: listing as unknown as Prisma.InputJsonValue,
        payloadHash,
        desiredState: 'active' as DesiredState,
        syncState: 'queued' as SyncState,
        warnings: mapping.warnings as unknown as Prisma.InputJsonValue,
        lastError: Prisma.DbNull,
      };
      const row = existing
        ? await tx.listing.update({
            where: { id: existing.id },
            data: { ...data, version: { increment: 1 } },
          })
        : await tx.listing.create({
            data: { ...data, agencyId: agency.agencyId, connectionId: connection.id, externalId },
          });
      await this.replaceImages(tx, row.id, mapping.imageUrls);
      return row;
    });
    await this.queue.enqueue(saved.id, saved.version);
    return { status: 202, listing: await this.view(saved.id) };
  }

  /** Hide (`inactive`), show again (`active`) or delete (`removed`) on Pin. */
  async setDesiredState(
    agency: AgencyContext,
    connectionId: string,
    externalId: string,
    desiredState: DesiredState,
  ): Promise<ListingCommandResult> {
    const listing = await this.findOwned(agency, connectionId, externalId);
    if (listing.desiredState === desiredState && listing.syncState === 'synced') {
      return { status: 200, listing: await this.view(listing.id) };
    }
    const updated = await this.prisma.listing.update({
      where: { id: listing.id },
      data: { desiredState, syncState: 'queued', version: { increment: 1 } },
    });
    await this.queue.enqueue(updated.id, updated.version);
    return { status: 202, listing: await this.view(updated.id) };
  }

  async get(agency: AgencyContext, connectionId: string, externalId: string): Promise<ListingView> {
    return this.view((await this.findOwned(agency, connectionId, externalId)).id);
  }

  async list(
    agency: AgencyContext,
    connectionId: string,
    filters: {
      syncState?: SyncState;
      desiredState?: DesiredState;
      cursor?: string;
      limit?: number;
    },
  ): Promise<{ data: ListingView[]; next_cursor: string | null }> {
    const connection = await this.connections.findOwned(agency, connectionId);
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), MAX_PAGE);
    const rows = await this.prisma.listing.findMany({
      where: {
        agencyId: agency.agencyId,
        connectionId: connection.id,
        ...(filters.syncState ? { syncState: filters.syncState } : {}),
        ...(filters.desiredState ? { desiredState: filters.desiredState } : {}),
        ...(filters.cursor ? { externalId: { gt: filters.cursor } } : {}),
      },
      orderBy: { externalId: 'asc' },
      take: limit + 1,
      include: { images: true },
    });
    const page = rows.slice(0, limit);
    return {
      data: page.map(listingView),
      next_cursor: rows.length > limit ? page[page.length - 1]!.externalId : null,
    };
  }

  private async replaceImages(
    tx: Prisma.TransactionClient,
    listingId: string,
    urls: string[],
  ): Promise<void> {
    const current = await tx.listingImage.findMany({ where: { listingId } });
    const byPosition = new Map(current.map((image) => [image.position, image]));
    for (const [position, sourceUrl] of urls.entries()) {
      const image = byPosition.get(position);
      if (!image) {
        await tx.listingImage.create({ data: { listingId, position, sourceUrl } });
      } else if (image.sourceUrl !== sourceUrl || image.status === 'failed') {
        // A new URL means a new photo: forget the old hash and Pin picture id for this slot.
        // A photo that failed before gets another chance when the listing is sent again.
        await tx.listingImage.update({
          where: { id: image.id },
          data: {
            sourceUrl,
            sha256: null,
            pinPicId: null,
            width: null,
            height: null,
            status: 'pending',
            error: null,
          },
        });
      }
    }
    await tx.listingImage.deleteMany({ where: { listingId, position: { gte: urls.length } } });
  }

  private async findOwned(
    agency: AgencyContext,
    connectionId: string,
    externalId: string,
  ): Promise<Listing> {
    this.checkExternalId(externalId);
    const connection = await this.connections.findOwned(agency, connectionId);
    const listing = await this.prisma.listing.findUnique({
      where: {
        agencyId_connectionId_externalId: {
          agencyId: agency.agencyId,
          connectionId: connection.id,
          externalId,
        },
      },
    });
    if (!listing) {
      throw ApiError.notFound('Listing');
    }
    return listing;
  }

  private async view(listingId: string): Promise<ListingView> {
    return listingView(
      await this.prisma.listing.findUniqueOrThrow({
        where: { id: listingId },
        include: { images: true },
      }),
    );
  }

  private checkExternalId(externalId: string): void {
    if (!EXTERNAL_ID.test(externalId)) {
      throw ApiError.notFound('Listing');
    }
  }
}
