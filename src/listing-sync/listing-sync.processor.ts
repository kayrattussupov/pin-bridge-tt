import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DelayedError, Job } from 'bullmq';
import { withRedisLock } from '../common/redis-lock';
import { RedisSemaphore } from '../common/redis-semaphore';
import { PrismaService } from '../database/prisma.service';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import type { ListingSyncJob } from '../queue/listing-sync.queue';
import { QUEUES } from '../queue/queue.constants';
import { RedisService } from '../queue/redis.service';
import { metrics } from '../observability/metrics';
import { ListingSyncService, SyncOutcome } from './listing-sync.service';

/** One listing is never synced by two workers at once; longer than the slowest full publish. */
const LOCK_TTL_MS = 10 * 60 * 1000;
const LOCKED_RETRY_MS = 3_000;

@Processor(QUEUES.listings)
export class ListingSyncProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(ListingSyncProcessor.name);
  private readonly slots: RedisSemaphore;

  constructor(
    private readonly sync: ListingSyncService,
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {
    super();
    this.slots = new RedisSemaphore(redis);
  }

  onApplicationBootstrap(): void {
    this.worker.concurrency = this.env.LISTING_SYNC_CONCURRENCY;
  }

  async process(job: Job<ListingSyncJob>, token?: string): Promise<SyncOutcome> {
    const { listingId } = job.data;
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const owner = await this.prisma.listing.findUnique({
      where: { id: listingId },
      select: { agencyId: true },
    });
    if (!owner) {
      return { result: 'skipped' };
    }
    // Fairness: one agency uploading thousands of listings may use only part of the workers.
    const slotKey = `pin-bridge:agency-sync-slots:${owner.agencyId}`;
    const holder = `${job.id}:${job.attemptsMade}`;
    if (
      !(await this.slots.acquire(slotKey, holder, this.env.AGENCY_SYNC_CONCURRENCY, LOCK_TTL_MS))
    ) {
      await job.moveToDelayed(Date.now() + 2_000 + Math.floor(Math.random() * 3_000), token);
      throw new DelayedError();
    }
    try {
      return await this.runLocked(job, token, listingId, finalAttempt);
    } finally {
      await this.slots.release(slotKey, holder);
    }
  }

  private async runLocked(
    job: Job<ListingSyncJob>,
    token: string | undefined,
    listingId: string,
    finalAttempt: boolean,
  ): Promise<SyncOutcome> {
    let locked;
    try {
      locked = await withRedisLock(
        this.redis,
        `pin-bridge:lock:listing:${listingId}`,
        LOCK_TTL_MS,
        () => this.sync.run(listingId, { finalAttempt }),
      );
    } catch (error) {
      metrics.listingSync.inc({ result: 'retry' });
      throw error;
    }
    if (!locked.acquired) {
      // Another job is syncing this listing; come back shortly (does not use up an attempt).
      await job.moveToDelayed(Date.now() + LOCKED_RETRY_MS, token);
      throw new DelayedError();
    }
    metrics.listingSync.inc({ result: locked.value.result });
    this.logger.log(
      { listingId, jobId: job.id, attempt: job.attemptsMade + 1, result: locked.value.result },
      'listing sync',
    );
    return locked.value;
  }
}
