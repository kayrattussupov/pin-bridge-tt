import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { PinResponseStore } from '../pin/pin-response.store';
import { ListingSyncQueue } from '../queue/listing-sync.queue';
import {
  QUEUES,
  SYSTEM_JOBS,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_KEY,
} from '../queue/queue.constants';
import { RedisService } from '../queue/redis.service';

const RECONCILE_INTERVAL_MS = 5 * 60_000;
const PRUNE_INTERVAL_MS = 3600_000;
/** Longer than the largest retry gap of a listing job (30 s * 2^6 ≈ 32 min with 8 attempts). */
const STUCK_AFTER_MS = 60 * 60_000;

/**
 * System housekeeping on the `system` queue:
 * - heartbeat: proves Redis, the scheduler and the worker loop are alive (used by /health/ready);
 * - reconcile: re-queues listings whose job was lost;
 * - prune-pin-responses: drops recorded Pin answers older than PIN_RESPONSE_RETENTION_DAYS.
 */
@Processor(QUEUES.system)
export class HeartbeatProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(HeartbeatProcessor.name);

  constructor(
    @InjectQueue(QUEUES.system) private readonly systemQueue: Queue,
    private readonly redis: RedisService,
    private readonly listingSync: ListingSyncQueue,
    private readonly pinResponses: PinResponseStore,
    @Inject(ENV) private readonly env: Env,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    const opts = { removeOnComplete: true, removeOnFail: 100 };
    await this.systemQueue.upsertJobScheduler(
      SYSTEM_JOBS.heartbeat,
      { every: WORKER_HEARTBEAT_INTERVAL_MS },
      { name: SYSTEM_JOBS.heartbeat, opts },
    );
    await this.systemQueue.upsertJobScheduler(
      SYSTEM_JOBS.reconcile,
      { every: RECONCILE_INTERVAL_MS },
      { name: SYSTEM_JOBS.reconcile, opts },
    );
    await this.systemQueue.upsertJobScheduler(
      SYSTEM_JOBS.prunePinResponses,
      { every: PRUNE_INTERVAL_MS },
      { name: SYSTEM_JOBS.prunePinResponses, opts },
    );
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case SYSTEM_JOBS.heartbeat:
        await this.redis.set(
          WORKER_HEARTBEAT_KEY,
          String(Date.now()),
          'PX',
          WORKER_HEARTBEAT_INTERVAL_MS * 10,
        );
        return undefined;
      case SYSTEM_JOBS.reconcile: {
        const requeued = await this.listingSync.reconcileStuck(STUCK_AFTER_MS);
        if (requeued > 0) {
          this.logger.warn({ requeued }, 're-queued listings whose sync job was lost');
        }
        return { requeued };
      }
      case SYSTEM_JOBS.prunePinResponses: {
        // With retention 0 nothing new is recorded; whatever is left goes now.
        const days = this.env.PIN_RESPONSE_RETENTION_DAYS;
        const deleted = await this.pinResponses.prune(new Date(Date.now() - days * 86_400_000));
        return { deleted };
      }
      default:
        this.logger.warn({ jobName: job.name }, 'unknown system job');
        return undefined;
    }
  }
}
