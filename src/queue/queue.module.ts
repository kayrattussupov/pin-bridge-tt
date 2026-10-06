import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { QUEUES } from './queue.constants';
import { ListingSyncQueue } from './listing-sync.queue';
import { RedisService } from './redis.service';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        connection: { url: env.REDIS_URL },
        prefix: 'pin-bridge',
        defaultJobOptions: {
          removeOnComplete: { age: 24 * 3600, count: 10_000 },
          removeOnFail: { age: 7 * 24 * 3600 },
        },
      }),
    }),
    BullModule.registerQueue(
      { name: QUEUES.system },
      { name: QUEUES.dictionaries },
      { name: QUEUES.listings },
      { name: QUEUES.status },
      { name: QUEUES.webhooks },
    ),
  ],
  providers: [RedisService, ListingSyncQueue],
  exports: [BullModule, RedisService, ListingSyncQueue],
})
export class QueueModule {}
