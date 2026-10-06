import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { ListingSyncQueue } from '../queue/listing-sync.queue';
import {
  QUEUES,
  SYSTEM_JOBS,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_KEY,
} from '../queue/queue.constants';
import { RedisService } from '../queue/redis.service';

const RECONCILE_INTERVAL_MS = 5 * 60_000;
/** Longer than the largest retry gap of a listing job (30 s * 2^6 ≈ 32 min with 8 attempts). */
const STUCK_AFTER_MS = 60 * 60_000;

/**
 * System housekeeping on the `system` queue:
 * - heartbeat: proves Redis, the scheduler and the worker loop are alive (used by /health/ready);
 * - reconcile: re-queues listings whose job was lost.
 */
@Processor(QUEUES.system)
export class HeartbeatProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(HeartbeatProcessor.name);

  constructor(
    @InjectQueue(QUEUES.system) private readonly systemQueue: Queue,
    private readonly redis: RedisService,
    private readonly listingSync: ListingSyncQueue,
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
      default:
        this.logger.warn({ jobName: job.name }, 'unknown system job');
        return undefined;
    }
  }
}
