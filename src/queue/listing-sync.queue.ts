import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { PrismaService } from '../database/prisma.service';
import { LISTING_JOBS, QUEUES } from './queue.constants';

export interface ListingSyncJob {
  listingId: string;
}

/**
 * Schedules listing reconciliation. A job carries only the listing id: the worker always
 * applies the latest stored state, so extra or out-of-order jobs are harmless.
 */
@Injectable()
export class ListingSyncQueue {
  constructor(
    @InjectQueue(QUEUES.listings) private readonly queue: Queue<ListingSyncJob>,
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async enqueue(listingId: string, version: number): Promise<void> {
    await this.add(listingId, `sync-${listingId}-v${version}`);
  }

  /** After a connection becomes active again, retry everything that waited on it. */
  async enqueueForConnection(connectionId: string): Promise<number> {
    const pending = await this.prisma.listing.findMany({
      where: { connectionId, syncState: { not: 'synced' } },
      select: { id: true },
    });
    const stamp = Date.now();
    await Promise.all(pending.map((l) => this.add(l.id, `resume-${l.id}-${stamp}`)));
    return pending.length;
  }

  /**
   * Safety net for lost jobs (e.g. Redis data loss): re-queues listings that have waited longer
   * than any retry gap and whose current job is gone. Re-queuing is harmless: sync is idempotent.
   */
  async reconcileStuck(olderThanMs: number): Promise<number> {
    const stuck = await this.prisma.listing.findMany({
      where: {
        syncState: { in: ['queued', 'processing'] },
        updatedAt: { lt: new Date(Date.now() - olderThanMs) },
      },
      select: { id: true, version: true },
      take: 500,
    });
    let requeued = 0;
    const stamp = Date.now();
    for (const listing of stuck) {
      const job = await this.queue.getJob(`sync-${listing.id}-v${listing.version}`);
      const state = job ? await job.getState() : 'missing';
      if (
        state === 'missing' ||
        state === 'completed' ||
        state === 'failed' ||
        state === 'unknown'
      ) {
        await this.add(listing.id, `reconcile-${listing.id}-${stamp}`);
        requeued += 1;
      }
    }
    return requeued;
  }

  private async add(listingId: string, jobId: string): Promise<void> {
    await this.queue.add(
      LISTING_JOBS.sync,
      { listingId },
      {
        jobId,
        attempts: this.env.LISTING_SYNC_ATTEMPTS,
        backoff: { type: 'exponential', delay: this.env.LISTING_SYNC_BACKOFF_MS },
      },
    );
  }
}
