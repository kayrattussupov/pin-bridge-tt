import { Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { PrismaService } from '../database/prisma.service';
import { WORKER_HEARTBEAT_INTERVAL_MS, WORKER_HEARTBEAT_KEY } from '../queue/queue.constants';
import { RedisService } from '../queue/redis.service';

const CHECK_TIMEOUT_MS = 2_000;

@Injectable()
export class HealthIndicators {
  constructor(
    private readonly health: HealthIndicatorService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  database() {
    return this.health
      .check('database')
      .attempt(async () => {
        await this.prisma.$queryRaw`SELECT 1`;
      })
      .withTimeout(CHECK_TIMEOUT_MS);
  }

  redisPing() {
    return this.health
      .check('redis')
      .attempt(async () => {
        await this.redis.ping();
      })
      .withTimeout(CHECK_TIMEOUT_MS);
  }

  /** The worker is considered alive while its repeatable heartbeat job keeps running. */
  workerHeartbeat() {
    return this.health
      .check('worker_heartbeat')
      .attempt(async () => {
        const raw = await this.redis.get(WORKER_HEARTBEAT_KEY);
        const ageMs = raw ? Date.now() - Number(raw) : Number.POSITIVE_INFINITY;
        if (ageMs > WORKER_HEARTBEAT_INTERVAL_MS * 3) {
          throw new Error(raw ? `heartbeat is ${Math.round(ageMs / 1000)}s old` : 'no heartbeat');
        }
        return { ageMs };
      })
      .withTimeout(CHECK_TIMEOUT_MS);
  }
}
