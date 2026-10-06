import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Queue } from 'bullmq';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { QUEUES } from '../queue/queue.constants';
import { StatusSyncService, StatusTickResult } from '../status-sync/status-sync.service';
import { DispatchResult, WebhookDispatcher } from '../webhooks/webhook-dispatcher';

const TICK = 'tick';
const tickOptions = { removeOnComplete: true, removeOnFail: 100 };

/** Delivers due webhook events every WEBHOOK_DISPATCH_INTERVAL_MS. */
@Processor(QUEUES.webhooks)
export class WebhookDispatchProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(WebhookDispatchProcessor.name);

  constructor(
    @InjectQueue(QUEUES.webhooks) private readonly queue: Queue,
    private readonly dispatcher: WebhookDispatcher,
    @Inject(ENV) private readonly env: Env,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'webhooks-dispatch',
      { every: this.env.WEBHOOK_DISPATCH_INTERVAL_MS },
      { name: TICK, opts: tickOptions },
    );
  }

  async process(): Promise<DispatchResult> {
    const total: DispatchResult = { delivered: 0, failed: 0, dead: 0 };
    // Keep draining while full batches come back, but yield after a while.
    for (let round = 0; round < 10; round++) {
      const result = await this.dispatcher.dispatchDue();
      total.delivered += result.delivered;
      total.failed += result.failed;
      total.dead += result.dead;
      if (result.delivered + result.failed + result.dead < 50) {
        break;
      }
    }
    if (total.delivered + total.failed + total.dead > 0) {
      this.logger.log(total, 'webhooks dispatched');
    }
    return total;
  }
}

/** Reads moderation/payment status from Pin every STATUS_SYNC_INTERVAL_MS. */
@Processor(QUEUES.status)
export class StatusSyncProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(StatusSyncProcessor.name);

  constructor(
    @InjectQueue(QUEUES.status) private readonly queue: Queue,
    private readonly statusSync: StatusSyncService,
    @Inject(ENV) private readonly env: Env,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'status-sync',
      { every: this.env.STATUS_SYNC_INTERVAL_MS },
      { name: TICK, opts: tickOptions },
    );
  }

  async process(): Promise<StatusTickResult> {
    const result = await this.statusSync.tick();
    if (result.connections > 0) {
      this.logger.log(result, 'status sync');
    }
    return result;
  }
}
