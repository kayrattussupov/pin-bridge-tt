import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Gauge, Registry } from 'prom-client';
import { PrismaService } from '../database/prisma.service';
import { PinClient } from '../pin/pin.client';
import { QUEUES } from '../queue/queue.constants';

const STUCK_AFTER_MS = 15 * 60_000;
const BREAKER_VALUE = { closed: 0, half_open: 1, open: 2 } as const;

/**
 * Gauges read at scrape time from Redis and PostgreSQL. Registered only in the worker, so the
 * state is reported once even when several API instances are scraped.
 */
@Injectable()
export class MetricsCollector {
  readonly registry = new Registry();

  constructor(
    private readonly prisma: PrismaService,
    private readonly pin: PinClient,
    @InjectQueue(QUEUES.listings) listings: Queue,
    @InjectQueue(QUEUES.webhooks) webhooks: Queue,
    @InjectQueue(QUEUES.status) status: Queue,
    @InjectQueue(QUEUES.dictionaries) dictionaries: Queue,
  ) {
    const queues = { listings, webhooks, status, dictionaries };
    const registers = [this.registry];

    new Gauge({
      name: 'pinbridge_queue_jobs',
      help: 'Jobs per queue and state',
      labelNames: ['queue', 'state'] as const,
      registers,
      async collect() {
        for (const [name, queue] of Object.entries(queues)) {
          const counts = await queue.getJobCounts(
            'waiting',
            'active',
            'delayed',
            'failed',
            'prioritized',
          );
          for (const [state, count] of Object.entries(counts)) {
            this.set({ queue: name, state }, count);
          }
        }
      },
    });

    new Gauge({
      name: 'pinbridge_queue_oldest_waiting_seconds',
      help: 'Age of the oldest job waiting to be picked up',
      labelNames: ['queue'] as const,
      registers,
      async collect() {
        for (const [name, queue] of Object.entries(queues)) {
          const [oldest] = await queue.getJobs(['waiting'], 0, 0, true);
          this.set({ queue: name }, oldest ? (Date.now() - oldest.timestamp) / 1000 : 0);
        }
      },
    });

    const db = this.prisma;
    new Gauge({
      name: 'pinbridge_listings',
      help: 'Listings by sync state',
      labelNames: ['sync_state'] as const,
      registers,
      async collect() {
        this.reset();
        for (const row of await db.listing.groupBy({ by: ['syncState'], _count: true })) {
          this.set({ sync_state: row.syncState }, row._count);
        }
      },
    });

    new Gauge({
      name: 'pinbridge_listings_stuck',
      help: 'Listings queued or processing for more than 15 minutes without progress',
      registers,
      async collect() {
        this.set(
          await db.listing.count({
            where: {
              syncState: { in: ['queued', 'processing'] },
              updatedAt: { lt: new Date(Date.now() - STUCK_AFTER_MS) },
            },
          }),
        );
      },
    });

    new Gauge({
      name: 'pinbridge_connections',
      help: 'Pin account connections by status',
      labelNames: ['status'] as const,
      registers,
      async collect() {
        this.reset();
        for (const row of await db.connection.groupBy({ by: ['status'], _count: true })) {
          this.set({ status: row.status }, row._count);
        }
      },
    });

    new Gauge({
      name: 'pinbridge_webhook_outbox',
      help: 'Webhook events not yet delivered (pending) or given up (dead, last 7 days)',
      labelNames: ['status'] as const,
      registers,
      async collect() {
        const [pending, dead] = await Promise.all([
          db.webhookOutbox.count({ where: { deliveredAt: null, deadAt: null } }),
          db.webhookOutbox.count({
            where: { deadAt: { gt: new Date(Date.now() - 7 * 86_400_000) } },
          }),
        ]);
        this.set({ status: 'pending' }, pending);
        this.set({ status: 'dead' }, dead);
      },
    });

    new Gauge({
      name: 'pinbridge_webhook_oldest_pending_seconds',
      help: 'Age of the oldest undelivered webhook event',
      registers,
      async collect() {
        const oldest = await db.webhookOutbox.findFirst({
          where: { deliveredAt: null, deadAt: null },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        });
        this.set(oldest ? (Date.now() - oldest.createdAt.getTime()) / 1000 : 0);
      },
    });

    new Gauge({
      name: 'pinbridge_dictionary_age_seconds',
      help: 'Age of the oldest locally stored Pin dictionary',
      registers,
      async collect() {
        const oldest = await db.dictionary.aggregate({ _min: { fetchedAt: true } });
        this.set(
          oldest._min.fetchedAt ? (Date.now() - oldest._min.fetchedAt.getTime()) / 1000 : -1,
        );
      },
    });

    const pinClient = this.pin;
    new Gauge({
      name: 'pinbridge_pin_breaker_state',
      help: 'Circuit breaker towards pin.tt: 0 closed, 1 half-open, 2 open',
      registers,
      async collect() {
        this.set(BREAKER_VALUE[await pinClient.circuitBreaker.state()]);
      },
    });
  }
}
