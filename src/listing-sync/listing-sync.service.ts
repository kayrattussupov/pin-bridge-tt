import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { AgencyContext } from '../auth/agency-context';
import { ApiError } from '../common/api-error';
import { ConnectionNotActiveError, ConnectionsService } from '../connections/connections.service';
import { PrismaService } from '../database/prisma.service';
import { Prisma } from '../generated/prisma/client';
import type { Agency, Connection, Listing, ListingImage } from '../generated/prisma/client';
import { ImageFetchError, ImageFetcher } from '../images/image-fetcher';
import { ListingIssue, pinExternalId } from '../listings/listing-mapper';
import { ListingValidationService } from '../listings/listing-validation.service';
import { listingView } from '../listings/listing-view';
import { PinState, emitPinStateEvents, pinStateOf } from '../listings/pin-state';
import { PinClient } from '../pin/pin.client';
import { PinError, isPinError } from '../pin/pin.errors';
import type { CreateItemPayload, PinAuth, PinItem } from '../pin/pin.types';
import { WebhookEvents } from '../webhooks/webhook-events';

type FullListing = Listing & { images: ListingImage[]; agency: Agency; connection: Connection };

/** Long side below this looks blurry in Pin's card (Pin's advice). */
const SMALL_IMAGE_PX = 800;
const HIDDEN = 2;
/** First moderation/payment check after publishing. */
const FIRST_STATUS_CHECK_MS = 60_000;
/** Moderation outcomes where toggling visibility makes no sense. */
const MODERATION_FINAL = new Set([3, 4]);
/** front_my pages scanned when looking an item up by external_id. */
const MAX_LOOKUP_PAGES = 50;

export interface SyncOutcome {
  result: 'synced' | 'superseded' | 'failed' | 'skipped';
  error?: Record<string, unknown>;
}

/** Thrown for failures worth another attempt (Pin or a photo host temporarily unavailable). */
export class RetryableSyncError extends Error {
  constructor(
    readonly details: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(String(details.message ?? details.code), options);
  }
}

class PermanentSyncError extends Error {
  constructor(readonly details: Record<string, unknown>) {
    super(String(details.message ?? details.code));
  }
}

const jsonOf = (value: unknown) => value as Prisma.InputJsonValue;

/**
 * Brings one listing on Pin to the state stored in Pin Bridge: create or update (with photos),
 * hide or show, remove. Safe to run any number of times: it reads the latest stored version and
 * only calls Pin for what differs. The caller holds a per-listing lock.
 */
@Injectable()
export class ListingSyncService {
  private readonly logger = new Logger(ListingSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: ConnectionsService,
    private readonly validation: ListingValidationService,
    private readonly pin: PinClient,
    private readonly images: ImageFetcher,
    private readonly events: WebhookEvents,
  ) {}

  async run(listingId: string, options: { finalAttempt: boolean }): Promise<SyncOutcome> {
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      include: { images: true, agency: true, connection: true },
    });
    if (!listing) {
      return { result: 'skipped' };
    }
    if (listing.syncState === 'synced') {
      return { result: 'skipped' };
    }
    const version = listing.version;
    await this.prisma.listing.updateMany({
      where: { id: listingId, version },
      data: { syncState: 'processing' },
    });

    const before = pinStateOf(listing);
    try {
      const warnings =
        listing.desiredState === 'removed'
          ? await this.remove(listing)
          : await this.publish(listing);
      const synced = await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.listing.updateMany({
          where: { id: listingId, version },
          data: {
            syncState: 'synced',
            lastSyncedAt: new Date(),
            lastError: Prisma.DbNull,
            // Pin moderates after publishing: start watching the outcome soon.
            nextStatusCheckAt:
              listing.desiredState === 'removed'
                ? null
                : new Date(Date.now() + FIRST_STATUS_CHECK_MS),
            ...(warnings ? { warnings: jsonOf(warnings) } : {}),
          },
        });
        if (count) {
          await this.emitListing(tx, listingId, 'listing.synced', before);
        }
        return count > 0;
      });
      // A newer version arrived while we worked; its own job applies it.
      return { result: synced ? 'synced' : 'superseded' };
    } catch (error) {
      return this.fail(listing, version, error, options.finalAttempt);
    }
  }

  /** Outbox event for the listing plus any moderation/payment change, in the same transaction. */
  private async emitListing(
    tx: Prisma.TransactionClient,
    listingId: string,
    type: 'listing.synced' | 'listing.failed',
    before: PinState,
  ): Promise<void> {
    const row = await tx.listing.findUniqueOrThrow({
      where: { id: listingId },
      include: { images: true },
    });
    await this.events.emit(tx, row.agencyId, type, { listing: listingView(row) });
    await emitPinStateEvents(tx, this.events, listingId, before);
  }

  // ---------------------------------------------------------------------------
  // Publish / update / visibility
  // ---------------------------------------------------------------------------

  private async publish(listing: FullListing): Promise<ListingIssue[]> {
    const auth = await this.auth(listing);
    const mapping = await this.validation.map(
      this.agencyContext(listing),
      listing.payload,
      listing.connection.displayName,
    );
    if (mapping.errors.length || !mapping.payload) {
      // Pin's form changed since the listing was accepted.
      throw new PermanentSyncError({
        code: 'mapping_failed',
        message: 'The listing no longer matches Pin’s attribute form; send it again.',
        errors: mapping.errors,
      });
    }
    const { picIds, warnings: imageWarnings } = await this.syncImages(listing, auth);
    const payload: CreateItemPayload = { ...mapping.payload, images: picIds };
    const pinHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');

    let itemId = listing.pinItemId;
    let item: PinItem | undefined;
    if (!itemId && listing.createUnknown) {
      item = await this.findByExternalId(auth, payload.external_id, listing.id);
      itemId = item?.id ?? null;
      await this.saveItem(listing.id, item, {
        createUnknown: false,
        pinHash: item ? null : undefined,
      });
    }

    if (itemId && listing.syncedPinHash !== pinHash) {
      try {
        item = await this.pin.updateItem(auth, itemId, payload);
        await this.saveItem(listing.id, item, { pinHash });
      } catch (error) {
        if (!(isPinError(error) && error.kind === 'not_found')) {
          throw error;
        }
        // Deleted on Pin's side (by the owner or moderation): publish it again.
        this.logger.warn({ listingId: listing.id, itemId }, 'pin item vanished, recreating');
        itemId = null;
        await this.prisma.listing.update({
          where: { id: listing.id },
          data: { pinItemId: null, pinStatus: null },
        });
      }
    }
    if (!itemId) {
      item = await this.create(listing, auth, payload);
      itemId = item.id;
      await this.saveItem(listing.id, item, { pinHash, createUnknown: false });
    }

    await this.applyVisibility(listing, auth, itemId, item);
    return [...mapping.warnings, ...imageWarnings];
  }

  private async create(
    listing: FullListing,
    auth: PinAuth,
    payload: CreateItemPayload,
  ): Promise<PinItem> {
    try {
      return await this.pin.createItem(auth, payload);
    } catch (error) {
      if (isPinError(error) && error.outcomeUnknown) {
        // Pin may have created it. Next attempt looks it up instead of creating a duplicate.
        await this.prisma.listing.update({
          where: { id: listing.id },
          data: { createUnknown: true },
        });
        throw error;
      }
      if (
        isPinError(error) &&
        error.kind === 'validation' &&
        error.pinErrors.some((e) => e.field === 'external_id')
      ) {
        // Already on Pin (e.g. created by a run whose response was lost): adopt it.
        const existing = await this.findByExternalId(auth, payload.external_id, listing.id);
        if (existing) {
          return this.pin.updateItem(auth, existing.id, payload);
        }
      }
      throw error;
    }
  }

  /**
   * `toggle_active` flips visibility, so it must start from Pin's real current state. When this
   * run did not just receive the item from Pin, read it again: after a toggle whose response was
   * lost, the stored status is stale and a second toggle would undo the first.
   */
  private async applyVisibility(
    listing: FullListing,
    auth: PinAuth,
    itemId: string,
    freshItem: PinItem | undefined,
  ): Promise<void> {
    const wantHidden = listing.desiredState === 'inactive';
    const storedMatches = (listing.pinStatus === HIDDEN) === wantHidden;
    if (!freshItem && storedMatches && listing.pinStatus !== null) {
      return;
    }
    const current = freshItem ?? (await this.findItem(auth, (item) => item.id === itemId));
    const status = current?.status;
    if (status === null || status === undefined || MODERATION_FINAL.has(status)) {
      return;
    }
    if (wantHidden === (status === HIDDEN)) {
      if (status !== listing.pinStatus) {
        await this.prisma.listing.update({
          where: { id: listing.id },
          data: { pinStatus: status },
        });
      }
      return;
    }
    const response = (await this.pin.toggleActive(auth, itemId)) as { status?: unknown } | null;
    const next = typeof response?.status === 'number' ? response.status : wantHidden ? HIDDEN : 0;
    await this.prisma.listing.update({ where: { id: listing.id }, data: { pinStatus: next } });
  }

  private async saveItem(
    listingId: string,
    item: PinItem | undefined,
    extra: { pinHash?: string | null; createUnknown?: boolean },
  ): Promise<void> {
    await this.prisma.listing.update({
      where: { id: listingId },
      data: {
        ...(item
          ? {
              pinItemId: item.id,
              pinStatus: item.status ?? null,
              notPaid: item.not_paid ?? null,
              moderatorComment: item.moderator_comment ?? null,
            }
          : {}),
        ...(extra.pinHash !== undefined ? { syncedPinHash: extra.pinHash } : {}),
        ...(extra.createUnknown !== undefined ? { createUnknown: extra.createUnknown } : {}),
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Photos
  // ---------------------------------------------------------------------------

  /**
   * Uploads photos one by one, in order. Unchanged URLs reuse their Pin picture id; a photo
   * that is gone or not an image is skipped with a warning; a temporarily unreachable photo
   * makes the whole sync retry later (so a CDN hiccup does not publish without photos).
   */
  private async syncImages(
    listing: FullListing,
    auth: PinAuth,
  ): Promise<{ picIds: string[]; warnings: ListingIssue[] }> {
    const picIds: string[] = [];
    const warnings: ListingIssue[] = [];
    const rows = listing.images.slice().sort((a, b) => a.position - b.position);
    for (const row of rows) {
      if (row.status === 'uploaded' && row.pinPicId) {
        picIds.push(row.pinPicId);
        continue;
      }
      let prepared;
      try {
        prepared = await this.images.prepare(row.sourceUrl);
      } catch (error) {
        if (error instanceof ImageFetchError && error.permanent) {
          await this.prisma.listingImage.update({
            where: { id: row.id },
            data: { status: 'failed', error: error.message },
          });
          warnings.push({
            field: `images.${row.position}`,
            code: `image_${error.code}`,
            message: error.message,
          });
          continue;
        }
        throw new RetryableSyncError(
          {
            code: 'image_unavailable',
            message: `Photo ${row.position + 1} could not be downloaded: ${(error as Error).message}`,
          },
          { cause: error },
        );
      }
      const twin = rows.find((r) => r.id !== row.id && r.sha256 === prepared.sha256 && r.pinPicId);
      const pinPicId =
        twin?.pinPicId ??
        (await this.pin.uploadPicture(auth, {
          data: prepared.data,
          filename: `${listing.externalId}-${row.position + 1}.jpg`,
          contentType: 'image/jpeg',
        }));
      await this.prisma.listingImage.update({
        where: { id: row.id },
        data: {
          sha256: prepared.sha256,
          pinPicId,
          width: prepared.width,
          height: prepared.height,
          status: 'uploaded',
          error: null,
        },
      });
      Object.assign(row, { sha256: prepared.sha256, pinPicId, status: 'uploaded' });
      if (Math.max(prepared.width, prepared.height) < SMALL_IMAGE_PX) {
        warnings.push({
          field: `images.${row.position}`,
          code: 'image_low_resolution',
          message: `Photo ${row.position + 1} is ${prepared.width}x${prepared.height}; below ${SMALL_IMAGE_PX} px it looks blurry on Pin.`,
        });
      }
      picIds.push(pinPicId);
    }
    for (const row of rows.filter((r) => r.status === 'failed')) {
      if (!warnings.some((w) => w.field === `images.${row.position}`)) {
        warnings.push({
          field: `images.${row.position}`,
          code: 'image_failed',
          message: row.error ?? 'Photo skipped.',
        });
      }
    }
    return { picIds, warnings };
  }

  // ---------------------------------------------------------------------------
  // Removal
  // ---------------------------------------------------------------------------

  private async remove(listing: FullListing): Promise<undefined> {
    let itemId = listing.pinItemId;
    if (!itemId && !listing.createUnknown) {
      return undefined;
    }
    const auth = await this.auth(listing);
    if (!itemId) {
      itemId =
        (await this.findByExternalId(auth, this.pinExternalIdOf(listing), listing.id))?.id ?? null;
    }
    if (itemId) {
      try {
        await this.pin.removeItem(auth, itemId);
      } catch (error) {
        if (!(isPinError(error) && error.kind === 'not_found')) {
          throw error;
        }
      }
    }
    await this.prisma.listing.update({
      where: { id: listing.id },
      data: {
        pinItemId: null,
        pinStatus: null,
        notPaid: null,
        syncedPinHash: null,
        createUnknown: false,
      },
    });
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async auth(listing: FullListing): Promise<PinAuth> {
    return this.connections.authFor(listing.connectionId);
  }

  /**
   * The item with this external_id, unless another listing row already owns it: never adopt
   * (and then overwrite or remove) an item that belongs to a different listing.
   */
  async findByExternalId(
    auth: PinAuth,
    externalId: string,
    listingId: string,
  ): Promise<PinItem | undefined> {
    const found = await this.findItem(auth, (item) => item.external_id === externalId);
    if (!found) {
      return undefined;
    }
    const owner = await this.prisma.listing.findFirst({
      where: { pinItemId: found.id, id: { not: listingId } },
      select: { id: true },
    });
    if (owner) {
      this.logger.error(
        { listingId, pinItemId: found.id, ownerListingId: owner.id },
        'pin item owned by another listing',
      );
      return undefined;
    }
    return found;
  }

  private async findItem(
    auth: PinAuth,
    match: (item: PinItem) => boolean,
  ): Promise<PinItem | undefined> {
    for (let page = 1; page <= MAX_LOOKUP_PAGES; page++) {
      const result = await this.pin.listMyItems(auth, { page });
      const found = result.results.find(match);
      if (found || !result.next) {
        return found;
      }
    }
    return undefined;
  }

  private pinExternalIdOf(listing: FullListing): string {
    return pinExternalId(listing.agency.slug, listing.externalId);
  }

  private agencyContext(listing: FullListing): AgencyContext {
    return {
      agencyId: listing.agency.id,
      agencySlug: listing.agency.slug,
      agencyName: listing.agency.name,
      apiKeyId: 'worker',
      apiKeyPrefix: 'worker',
      scopes: [],
    };
  }

  private async fail(
    listing: FullListing,
    version: number,
    error: unknown,
    finalAttempt: boolean,
  ): Promise<SyncOutcome> {
    const details = await this.describe(listing, error);
    const retryable = details.retryable === true;
    const attempt: Record<string, unknown> = { ...details, at: new Date().toISOString() };
    delete attempt.retryable;
    if (retryable && !finalAttempt) {
      await this.prisma.listing.updateMany({
        where: { id: listing.id, version },
        data: { syncState: 'queued', lastError: jsonOf({ ...attempt, will_retry: true }) },
      });
      throw new RetryableSyncError(attempt, { cause: error });
    }
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.listing.updateMany({
        where: { id: listing.id, version },
        data: { syncState: 'failed', lastError: jsonOf(attempt) },
      });
      if (count) {
        await this.emitListing(tx, listing.id, 'listing.failed', pinStateOf(listing));
      }
    });
    this.logger.warn({ listingId: listing.id, error: attempt }, 'listing sync failed');
    return { result: 'failed', error: attempt };
  }

  private async describe(listing: FullListing, error: unknown): Promise<Record<string, unknown>> {
    if (error instanceof PermanentSyncError) {
      return error.details;
    }
    if (error instanceof RetryableSyncError) {
      return { ...error.details, retryable: true };
    }
    if (error instanceof ConnectionNotActiveError) {
      return {
        code: 'connection_not_active',
        message: `The Pin account connection is ${error.status}; listings resume once it is connected again.`,
      };
    }
    if (error instanceof ApiError && error.code === 'dictionary_unavailable') {
      return { code: 'dictionary_unavailable', message: error.message, retryable: true };
    }
    if (isPinError(error)) {
      return this.describePinError(listing, error);
    }
    this.logger.error({ listingId: listing.id, err: error }, 'unexpected listing sync error');
    return { code: 'internal', message: 'Unexpected error; retrying.', retryable: true };
  }

  private async describePinError(
    listing: FullListing,
    error: PinError,
  ): Promise<Record<string, unknown>> {
    if (error.kind === 'unauthorized') {
      await this.connections.markReauthRequired(listing.connectionId, 'pin_unauthorized');
      return {
        code: 'connection_reauth_required',
        message:
          'Pin logged this account out. Connect it again; the listing is then published automatically.',
      };
    }
    if (error.kind === 'missing_device_key') {
      await this.connections.markReauthRequired(listing.connectionId, 'pin_device_key_rejected');
      return {
        code: 'connection_reauth_required',
        message: 'Pin no longer accepts this account’s device; connect it again.',
      };
    }
    if (error.retryable || error.kind === 'cloudflare_blocked') {
      return {
        code: 'pin_unavailable',
        message: `Pin is temporarily unavailable (${error.kind}).`,
        retryable: true,
      };
    }
    return {
      code: 'pin_rejected',
      message: 'Pin rejected the listing.',
      pin_errors: error.pinErrors,
      http_status: error.httpStatus,
    };
  }
}
