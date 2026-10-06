import { getQueueToken } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiModule } from '../../src/api/api.module';
import { DictionariesService } from '../../src/dictionaries/dictionaries.service';
import { ListingSyncModule } from '../../src/listing-sync/listing-sync.module';
import { MetricsCollector } from '../../src/observability/metrics.collector';
import { PinClient } from '../../src/pin/pin.client';
import { ListingSyncQueue } from '../../src/queue/listing-sync.queue';
import { QUEUES } from '../../src/queue/queue.constants';
import { PrismaService } from '../../src/database/prisma.service';
import { FakePin, startFakePin } from '../fake-pin/fake-pin';
import { signedRequest } from '../support/signed-request';
import { TestApp, createTestApp } from '../support/test-app';

vi.setConfig({ testTimeout: 20_000, hookTimeout: 30_000 });

@Module({ imports: [ApiModule, ListingSyncModule] })
class ApiAndWorkerModule {}

let fake: FakePin;
let t: TestApp;

beforeAll(async () => {
  fake = await startFakePin();
  t = await createTestApp(ApiAndWorkerModule, {
    PIN_BASE_URL: fake.url,
    PIN_RATE_LIMIT_RPS: '1000',
    PIN_RATE_LIMIT_BURST: '1000',
    PIN_BREAKER_MIN_REQUESTS: '1000',
    API_RATE_LIMIT_RPS: '1000',
    API_RATE_LIMIT_BURST: '1000',
    CONNECTION_SMS_PER_AGENCY_PER_HOUR: '1000',
    METRICS_TOKEN: 'metrics-token-for-tests',
  });
  await t.app.get(DictionariesService).syncAll();
});

afterAll(async () => {
  await t?.close();
  await fake?.close();
  delete process.env.METRICS_TOKEN;
});

const scrape = () =>
  t.app.inject({
    method: 'GET',
    url: '/metrics',
    headers: { authorization: 'Bearer metrics-token-for-tests' },
  });

describe('/metrics', () => {
  it('requires the metrics token when configured', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: '/metrics',
          headers: { authorization: 'Bearer nope-nope-nope-nope' },
        })
      ).statusCode,
    ).toBe(401);
    expect((await scrape()).statusCode).toBe(200);
  });

  it('records API latency by route template and Pin calls by outcome', async () => {
    const { creds } = await t.newAgency();
    await signedRequest(t.app, creds, { path: '/v1/me' });
    await signedRequest(t.app, creds, {
      path: '/v1/connections/00000000-0000-0000-0000-000000000000',
    });
    await signedRequest(t.app, creds, {
      method: 'POST',
      path: '/v1/connections',
      body: { phone: '+1 868 711 0000', display_name: 'X' },
    });
    const body = (await scrape()).body;
    expect(body).toMatch(
      /pinbridge_http_request_duration_seconds_count\{method="GET",route="\/v1\/me",status_code="200"\} \d+/,
    );
    // Templates, not concrete ids.
    expect(body).toContain('route="/v1/connections/:id",status_code="404"');
    expect(body).not.toContain('00000000-0000-0000-0000-000000000000');
    expect(body).toMatch(
      /pinbridge_pin_requests_total\{endpoint="users\.phone_verify\.request",outcome="ok"\} \d+/,
    );
    expect(body).toContain('pinbridge_process_cpu_user_seconds_total');
  });
});

describe('state gauges (worker)', () => {
  it('reports queues, listings, webhooks, dictionaries and the breaker', async () => {
    const collector = new MetricsCollector(
      t.app.get(PrismaService),
      t.app.get(PinClient),
      t.app.get<Queue>(getQueueToken(QUEUES.listings)),
      t.app.get<Queue>(getQueueToken(QUEUES.webhooks)),
      t.app.get<Queue>(getQueueToken(QUEUES.status)),
      t.app.get<Queue>(getQueueToken(QUEUES.dictionaries)),
    );
    const text = await collector.registry.metrics();
    for (const name of [
      'pinbridge_queue_jobs{queue="listings",state="waiting"}',
      'pinbridge_queue_oldest_waiting_seconds{queue="listings"}',
      'pinbridge_listings_stuck',
      'pinbridge_webhook_outbox{status="pending"}',
      'pinbridge_webhook_oldest_pending_seconds',
      'pinbridge_dictionary_age_seconds',
      'pinbridge_pin_breaker_state 0',
    ]) {
      expect(text).toContain(name);
    }
  });
});

describe('reconciler', () => {
  it('re-queues a listing whose job was lost', async () => {
    const { creds } = await t.newAgency();
    const started = (
      await signedRequest(t.app, creds, {
        method: 'POST',
        path: '/v1/connections',
        body: { phone: '+1 868 722 0001', display_name: 'X' },
      })
    ).json() as { id: string };
    await signedRequest(t.app, creds, {
      method: 'POST',
      path: `/v1/connections/${started.id}/confirm`,
      body: { code: fake.control.smsCode() },
    });
    const agency = await t.prisma.connection.findUniqueOrThrow({ where: { id: started.id } });
    // A listing row in "queued" whose job never existed (as after losing Redis), 2 hours old.
    const listing = await t.prisma.listing.create({
      data: {
        agencyId: agency.agencyId,
        connectionId: started.id,
        externalId: 'lost-1',
        rubric: 21,
        payload: {
          external_id: 'lost-1',
          category: 'residential_rent',
          title: 'Recovered listing',
          description: '',
          price: 1000,
          currency: 'TTD',
          negotiable_price: false,
          region: 'central',
          images: [],
          contact: { hide_phone: false },
          attributes: { type: 'House', bedrooms: 1 },
        },
        payloadHash: 'x',
        syncState: 'queued',
      },
    });
    await t.prisma
      .$executeRaw`UPDATE listings SET updated_at = now() - interval '2 hours' WHERE id = ${listing.id}::uuid`;

    expect(await t.app.get(ListingSyncQueue).reconcileStuck(60 * 60_000)).toBeGreaterThanOrEqual(1);
    const deadline = Date.now() + 10_000;
    let state = 'queued';
    while (Date.now() < deadline && state !== 'synced') {
      state = (await t.prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).syncState;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(state).toBe('synced');
    // Fresh listings are left alone.
    expect(await t.app.get(ListingSyncQueue).reconcileStuck(60 * 60_000)).toBe(0);
  });
});
