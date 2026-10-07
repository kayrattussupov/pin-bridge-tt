import { Inject, Injectable, Logger } from '@nestjs/common';
import { withRedisLock } from '../common/redis-lock';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { ConnectionNotActiveError, ConnectionsService } from '../connections/connections.service';
import { PrismaService } from '../database/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { emitPinStateEvents, pinStateOf } from '../listings/pin-state';
import { PinClient } from '../pin/pin.client';
import { isPinError } from '../pin/pin.errors';
import type { PinAuth, PinItem } from '../pin/pin.types';
import { ListingSyncQueue } from '../queue/listing-sync.queue';
import { RedisService } from '../queue/redis.service';
import { WebhookEvents } from '../webhooks/webhook-events';
import { nextStatusCheckDelayMs } from './status-schedule';

const MAX_PAGES = 50;
const LOCK_TTL_MS = 5 * 60_000;
const RETRY_AFTER_ERROR_MS = 5 * 60_000;
const INCOMPLETE_SCAN_RETRY_MS = 15 * 60_000;

export interface StatusTickResult {
  connections: number;
  checked: number;
  changed: number;
}

/**
 * Reads moderation and payment status from Pin's front_my (one call per page per account, not
 * per listing) and turns changes into webhook events.
 */
@Injectable()
export class StatusSyncService {
  private readonly logger = new Logger(StatusSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: ConnectionsService,
    private readonly pin: PinClient,
    private readonly redis: RedisService,
    private readonly events: WebhookEvents,
    private readonly listingSync: ListingSyncQueue,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Checks the accounts that have listings due for a status check. */
  async tick(): Promise<StatusTickResult> {
    const due = await this.prisma.listing.findMany({
      where: {
        nextStatusCheckAt: { lte: new Date() },
        pinItemId: { not: null },
        desiredState: { not: 'removed' },
        connection: { status: 'active' },
      },
      distinct: ['connectionId'],
      select: { connectionId: true },
      take: this.env.STATUS_SYNC_CONNECTIONS_PER_TICK,
    });
    const result: StatusTickResult = { connections: 0, checked: 0, changed: 0 };
    for (const { connectionId } of due) {
      const locked = await withRedisLock(
        this.redis,
        `pin-bridge:lock:status:${connectionId}`,
        LOCK_TTL_MS,
        () => this.syncConnection(connectionId),
      );
      if (locked.acquired) {
        result.connections += 1;
        result.checked += locked.value.checked;
        result.changed += locked.value.changed;
      }
    }
    return result;
  }

  async syncConnection(connectionId: string): Promise<{ checked: number; changed: number }> {
    let auth: PinAuth;
    try {
      auth = await this.connections.authFor(connectionId);
    } catch (error) {
      if (error instanceof ConnectionNotActiveError) {
        return { checked: 0, changed: 0 };
      }
      throw error;
    }

    await this.connections.recordPinUserId(connectionId, auth);

    let items: Map<string, PinItem>;
    let complete: boolean;
    try {
      ({ items, complete } = await this.readAll(auth));
    } catch (error) {
      if (
        isPinError(error) &&
        (error.kind === 'unauthorized' || error.kind === 'missing_device_key')
      ) {
        await this.connections.markReauthRequired(connectionId, `pin_${error.kind}`);
        return { checked: 0, changed: 0 };
      }
      this.logger.warn({ connectionId, err: error }, 'status sync failed, will retry');
      await this.prisma.listing.updateMany({
        where: { connectionId, nextStatusCheckAt: { lte: new Date() } },
        data: { nextStatusCheckAt: new Date(Date.now() + RETRY_AFTER_ERROR_MS) },
      });
      return { checked: 0, changed: 0 };
    }

    const listings = await this.prisma.listing.findMany({
      where: { connectionId, pinItemId: { not: null }, desiredState: { not: 'removed' } },
    });
    let changed = 0;
    for (const listing of listings) {
      const item = items.get(listing.pinItemId!);
      const before = pinStateOf(listing);
      const now = Date.now();
      const sincePublished = now - (listing.lastSyncedAt ?? listing.createdAt).getTime();

      if (!item) {
        if (!complete || listing.syncState !== 'synced') {
          // Not sure it is gone (partial scan, or a sync is in flight): look again later.
          await this.prisma.listing.update({
            where: { id: listing.id },
            data: { nextStatusCheckAt: new Date(now + INCOMPLETE_SCAN_RETRY_MS) },
          });
          continue;
        }
        // Deleted on Pin's side (by the owner or by moderation).
        changed += 1;
        await this.prisma.$transaction(async (tx) => {
          await tx.listing.update({
            where: { id: listing.id },
            data: {
              pinItemId: null,
              pinStatus: null,
              notPaid: null,
              syncedPinHash: null,
              syncState: 'failed',
              lastError: {
                code: 'deleted_on_pin',
                message:
                  'The item no longer exists on Pin. Send the listing again to republish it.',
              } as Prisma.InputJsonValue,
              statusCheckedAt: new Date(now),
              nextStatusCheckAt: null,
            },
          });
          await emitPinStateEvents(tx, this.events, listing.id, before, {
            reason: 'deleted_on_pin',
          });
        });
        continue;
      }

      if (item.status === undefined && 'status_code' in item) {
        this.logger.warn(
          {
            listingId: listing.id,
            itemId: item.id,
            code: item.status_code,
            text: item.status_text,
          },
          'unknown pin status code, keeping the previous status',
        );
      }
      const after = {
        pinStatus: item.status ?? listing.pinStatus,
        notPaid: item.not_paid ?? listing.notPaid,
        moderatorComment: item.moderator_comment ?? null,
      };
      const isChange =
        after.pinStatus !== before.pinStatus ||
        after.notPaid !== before.notPaid ||
        after.moderatorComment !== before.moderatorComment;
      changed += isChange ? 1 : 0;
      // Visibility on Pin differs from what the agency asked for (e.g. a toggle whose response
      // was lost, or a change made in Pin's own UI): queue a sync to put it right.
      const drifted =
        listing.syncState === 'synced' &&
        ((listing.desiredState === 'inactive' && after.pinStatus === 0) ||
          (listing.desiredState === 'active' && after.pinStatus === 2));
      const updated = await this.prisma.$transaction(async (tx) => {
        const row = await tx.listing.update({
          where: { id: listing.id },
          data: {
            ...after,
            statusCheckedAt: new Date(now),
            nextStatusCheckAt: new Date(now + nextStatusCheckDelayMs(after, sincePublished)),
            ...(drifted ? { syncState: 'queued', version: { increment: 1 } } : {}),
          },
        });
        if (isChange) {
          await emitPinStateEvents(tx, this.events, listing.id, before);
        }
        return row;
      });
      if (drifted) {
        this.logger.warn(
          { listingId: listing.id, desired: listing.desiredState, pinStatus: after.pinStatus },
          'visibility drift, re-syncing',
        );
        await this.listingSync.enqueue(updated.id, updated.version);
      }
    }
    return { checked: listings.length, changed };
  }

  private async readAll(
    auth: PinAuth,
  ): Promise<{ items: Map<string, PinItem>; complete: boolean }> {
    const items = new Map<string, PinItem>();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const result = await this.pin.listMyItems(auth, { page });
      for (const item of result.results) {
        items.set(item.id, item);
      }
      if (!result.next) {
        return { items, complete: true };
      }
    }
    return { items, complete: false };
  }
}
