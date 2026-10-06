import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { DictionariesService, SyncResult } from '../dictionaries/dictionaries.service';
import { PrismaService } from '../database/prisma.service';
import {
  DICTIONARY_JOBS,
  DICTIONARY_SYNC_CRON,
  DICTIONARY_SYNC_INTERVAL_MS,
  QUEUES,
} from '../queue/queue.constants';

/**
 * Keeps the local copy of Pin's reference data fresh: daily, and right after start-up when the
 * copy is missing or stale. A failed sync keeps the previous data; the job retries with backoff.
 */
@Processor(QUEUES.dictionaries)
export class DictionarySyncProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(DictionarySyncProcessor.name);

  constructor(
    @InjectQueue(QUEUES.dictionaries) private readonly queue: Queue,
    private readonly dictionaries: DictionariesService,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    const jobOptions = { attempts: 5, backoff: { type: 'exponential', delay: 60_000 } };
    // A cron schedule, not `every`: `every` also fires at registration, i.e. on each restart.
    await this.queue.upsertJobScheduler(
      'dictionaries-daily',
      { pattern: DICTIONARY_SYNC_CRON },
      { name: DICTIONARY_JOBS.sync, opts: jobOptions },
    );
    const oldest = await this.prisma.dictionary.aggregate({
      _min: { fetchedAt: true },
      _count: true,
    });
    const stale =
      oldest._count === 0 ||
      !oldest._min.fetchedAt ||
      Date.now() - oldest._min.fetchedAt.getTime() > DICTIONARY_SYNC_INTERVAL_MS;
    if (stale) {
      // Fixed job id: several workers starting together enqueue one sync, not one each.
      await this.queue.add(
        DICTIONARY_JOBS.sync,
        {},
        { ...jobOptions, jobId: 'dictionaries-startup' },
      );
    }
  }

  async process(job: Job): Promise<SyncResult[]> {
    const results = await this.dictionaries.syncAll();
    if (results.every((r) => r.status === 'failed')) {
      throw new Error(`dictionary sync failed: ${results[0]?.error ?? 'unknown error'}`);
    }
    this.logger.log({ jobId: job.id }, 'dictionary sync job done');
    return results;
  }
}
