import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';

const READY_TIMEOUT_MS = 10_000;

/**
 * Shared Redis client for app-level use (health, rate limits, nonces, locks). BullMQ keeps its own.
 *
 * The offline queue is off so that during a Redis outage commands fail fast instead of piling up
 * behind agency requests. That also means nothing may run before the first connection is up,
 * hence the wait in onModuleInit.
 */
@Injectable()
export class RedisService extends Redis implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(ENV) env: Env) {
    super(env.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: false });
  }

  async onModuleInit(): Promise<void> {
    if (this.status === 'ready') {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Redis not ready after ${READY_TIMEOUT_MS} ms`));
      }, READY_TIMEOUT_MS);
      const onReady = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off('ready', onReady);
      };
      this.on('ready', onReady);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.quit();
  }
}
