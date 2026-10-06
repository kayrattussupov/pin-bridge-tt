import { Module } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiModule } from '../../src/api/api.module';
import { DictionariesService } from '../../src/dictionaries/dictionaries.service';
import { ListingSyncModule } from '../../src/listing-sync/listing-sync.module';
import { PinClient } from '../../src/pin/pin.client';
import { StatusSyncModule } from '../../src/status-sync/status-sync.module';
import { StatusSyncService } from '../../src/status-sync/status-sync.service';
import { WebhookDispatcher } from '../../src/webhooks/webhook-dispatcher';
import { verifyWebhook } from '../../src/webhooks/webhook-signature';
import { WebhooksModule } from '../../src/webhooks/webhooks.module';
import {
  StatusSyncProcessor,
  WebhookDispatchProcessor,
} from '../../src/worker/periodic.processors';
import { FakePin, startFakePin } from '../fake-pin/fake-pin';
import { ImageServer, startImageServer } from '../support/image-server';
import { Credentials, signedRequest } from '../support/signed-request';
import { TestApp, createTestApp } from '../support/test-app';
import { WebhookReceiver, startWebhookReceiver } from '../support/webhook-receiver';

vi.setConfig({ testTimeout: 20_000, hookTimeout: 30_000 });

/** API plus the worker parts that produce and deliver events. */
@Module({
  imports: [ApiModule, ListingSyncModule, StatusSyncModule, WebhooksModule],
  providers: [WebhookDispatchProcessor, StatusSyncProcessor],
})
class EverythingModule {}

const ENV = {
  PIN_RATE_LIMIT_RPS: '1000',
  PIN_RATE_LIMIT_BURST: '1000',
  PIN_BREAKER_MIN_REQUESTS: '1000',
  API_RATE_LIMIT_RPS: '1000',
  API_RATE_LIMIT_BURST: '1000',
  CONNECTION_SMS_PER_AGENCY_PER_HOUR: '1000',
  LISTING_SYNC_ATTEMPTS: '2',
  LISTING_SYNC_BACKOFF_MS: '100',
  WEBHOOK_DISPATCH_INTERVAL_MS: '100',
  WEBHOOK_RETRY_BASE_MS: '100',
  WEBHOOK_MAX_AGE_MS: '60000',
  // Status sync is driven by the tests directly.
  STATUS_SYNC_INTERVAL_MS: '3600000',
};

let fake: FakePin;
let images: ImageServer;
let receiver: WebhookReceiver;
let t: TestApp;

beforeAll(async () => {
  fake = await startFakePin({ freeRentListings: 0 });
  images = await startImageServer();
  receiver = await startWebhookReceiver();
  t = await createTestApp(EverythingModule, {
    ...ENV,
    PIN_BASE_URL: fake.url,
    UNSAFE_ALLOW_PRIVATE_OUTBOUND_HOSTS: 'true',
  });
  await t.app.get(DictionariesService).syncAll();
});

afterAll(async () => {
  await t?.close();
  await Promise.all([fake?.close(), images?.close(), receiver?.close()]);
});

beforeEach(async () => {
  await t.app.get(PinClient).circuitBreaker.reset();
});

afterEach(() => t.waitForIdleListings());

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const json = (res: { json(): unknown }) => res.json() as Json;

let seq = 0;
async function setup(events: string[] = []) {
  const { creds, slug } = await t.newAgency();
  const path = `/hook/${slug}`;
  const registered = await signedRequest(t.app, creds, {
    method: 'PUT',
    path: '/v1/webhooks',
    body: { url: `${receiver.url}${path}`, events },
  });
  expect(registered.statusCode).toBe(201);
  const secret = json(registered).signing_secret as string;
  const phone = `+18687${String(100_000 + ((Date.now() + seq++) % 900_000)).slice(-6)}`;
  const started = json(
    await signedRequest(t.app, creds, {
      method: 'POST',
      path: '/v1/connections',
      body: { phone, display_name: 'John Doe' },
    }),
  );
  await signedRequest(t.app, creds, {
    method: 'POST',
    path: `/v1/connections/${started.id}/confirm`,
    body: { code: fake.control.smsCode() },
  });
  return { creds, slug, path, secret, connectionId: started.id as string, phone };
}

const listing = (overrides: Record<string, unknown> = {}) => ({
  category: 'residential_rent',
  title: '2-bedroom apartment in Valsayn',
  price: 3500,
  region: 'central',
  images: [`${images.url}/photo/a`],
  attributes: { type: 'Apartment', bedrooms: 2 },
  ...overrides,
});

const put = (creds: Credentials, connectionId: string, externalId: string, body: unknown) =>
  signedRequest(t.app, creds, {
    method: 'PUT',
    path: `/v1/connections/${connectionId}/listings/${externalId}`,
    body,
  });

describe('webhook endpoint management', () => {
  it('creates, reads, updates and rotates the signing secret', async () => {
    const { creds } = await t.newAgency();
    const url = `${receiver.url}/hook/manage`;
    const created = await signedRequest(t.app, creds, {
      method: 'PUT',
      path: '/v1/webhooks',
      body: { url },
    });
    expect(created.statusCode).toBe(201);
    expect(json(created)).toMatchObject({
      url,
      events: [],
      enabled: true,
      signing_secret: expect.any(String),
    });

    const read = json(await signedRequest(t.app, creds, { path: '/v1/webhooks' }));
    expect(read.signing_secret).toBeUndefined();

    const updated = await signedRequest(t.app, creds, {
      method: 'PUT',
      path: '/v1/webhooks',
      body: { url, events: ['listing.failed'] },
    });
    expect(updated.statusCode).toBe(200);
    expect(json(updated)).toMatchObject({ events: ['listing.failed'] });
    expect(json(updated).signing_secret).toBeUndefined();

    const rotated = json(
      await signedRequest(t.app, creds, {
        method: 'PUT',
        path: '/v1/webhooks',
        body: { url, rotate_secret: true },
      }),
    );
    expect(rotated.signing_secret).not.toBe(json(created).signing_secret);

    expect(
      (await signedRequest(t.app, creds, { method: 'DELETE', path: '/v1/webhooks' })).statusCode,
    ).toBe(204);
    expect((await signedRequest(t.app, creds, { path: '/v1/webhooks' })).statusCode).toBe(404);
  });

  it('rejects unknown event types', async () => {
    const { creds } = await t.newAgency();
    const res = await signedRequest(t.app, creds, {
      method: 'PUT',
      path: '/v1/webhooks',
      body: { url: `${receiver.url}/x`, events: ['listing.exploded'] },
    });
    expect(res.statusCode).toBe(422);
  });

  it('refuses private or insecure URLs when SSRF protection is on', async () => {
    const strict = await createTestApp(ApiModule, {
      ...ENV,
      UNSAFE_ALLOW_PRIVATE_OUTBOUND_HOSTS: 'false',
    });
    try {
      const { creds } = await strict.newAgency();
      for (const url of [
        'http://example.com/hook',
        'https://127.0.0.1/hook',
        'https://localhost/hook',
        'https://10.0.0.7/hook',
        'https://[::1]/hook',
        'https://user:pw@example.com/hook',
        'https://no-such-host.invalid/hook',
      ]) {
        const res = await signedRequest(strict.app, creds, {
          method: 'PUT',
          path: '/v1/webhooks',
          body: { url },
        });
        expect(res.statusCode, url).toBe(422);
        expect(json(res).error.code).toBe('invalid_webhook_url');
      }
    } finally {
      await strict.close();
      process.env.UNSAFE_ALLOW_PRIVATE_OUTBOUND_HOSTS = 'true';
    }
  });
});

describe('webhook delivery', () => {
  it('delivers a signed ping', async () => {
    const { creds, path, secret } = await setup();
    const queued = await signedRequest(t.app, creds, { method: 'POST', path: '/v1/webhooks/test' });
    expect(queued.statusCode).toBe(202);
    const eventId = json(queued).event_id;
    const ping = await receiver.waitFor(path, (w) => w.body.id === eventId);
    expect(ping.body).toMatchObject({ type: 'ping', created_at: expect.any(String) });
    expect(ping.headers['x-pinbridge-event']).toBe('ping');
    expect(ping.headers['x-pinbridge-event-id']).toBe(eventId);
    expect(verifyWebhook(secret, ping.raw, ping.headers['x-pinbridge-signature'] as string)).toBe(
      true,
    );
    expect(verifyWebhook('wrong', ping.raw, ping.headers['x-pinbridge-signature'] as string)).toBe(
      false,
    );
  });

  it('reports publishing: synced and the first Pin status', async () => {
    const { creds, path, connectionId } = await setup();
    await put(creds, connectionId, 'L1', listing());
    const synced = await receiver.waitFor(path, (w) => w.body.type === 'listing.synced');
    expect(synced.body.data.listing).toMatchObject({
      external_id: 'L1',
      sync_state: 'synced',
      live: true,
    });
    const status = await receiver.waitFor(path, (w) => w.body.type === 'listing.status_changed');
    expect(status.body.data).toMatchObject({
      listing: { pin: { status: 'published' } },
      previous: { status: null, not_paid: null },
    });
  });

  it('announces paid placement', async () => {
    const { creds, path, connectionId } = await setup();
    await put(creds, connectionId, 'L1', listing({ price: 6000 }));
    const event = await receiver.waitFor(path, (w) => w.body.type === 'listing.awaiting_payment');
    expect(event.body.data.listing).toMatchObject({ live: false, pin: { not_paid: true } });
  });

  it('reports a listing Pin rejects', async () => {
    const { creds, path, connectionId } = await setup();
    fake.control.failNext({
      route: 'POST /items/',
      status: 400,
      body: { title: ['Forbidden words.'] },
    });
    await put(creds, connectionId, 'L1', listing());
    const failed = await receiver.waitFor(path, (w) => w.body.type === 'listing.failed');
    expect(failed.body.data.listing.last_error).toMatchObject({ code: 'pin_rejected' });
  });

  it('only sends subscribed event types (ping always)', async () => {
    const { creds, path, connectionId } = await setup(['listing.failed']);
    await put(creds, connectionId, 'L1', listing());
    await signedRequest(t.app, creds, { method: 'POST', path: '/v1/webhooks/test' });
    await receiver.waitFor(path, (w) => w.body.type === 'ping');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(receiver.of(path).map((w) => w.body.type)).toEqual(['ping']);
  });

  it('never sends one agency’s events to another', async () => {
    const a = await setup();
    const b = await setup();
    await put(a.creds, a.connectionId, 'L1', listing());
    await receiver.waitFor(a.path, (w) => w.body.type === 'listing.synced');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(receiver.of(b.path).filter((w) => w.body.type.startsWith('listing.'))).toEqual([]);
  });

  it('retries failed deliveries', async () => {
    const { creds, path } = await setup();
    await receiver.waitFor(path, (w) => w.body.type === 'connection.connected');
    receiver.respond(path, [500, 503, 200]);
    const { event_id: eventId } = json(
      await signedRequest(t.app, creds, { method: 'POST', path: '/v1/webhooks/test' }),
    );
    await receiver.waitFor(
      path,
      (w) => w.body.id === eventId && receiver.of(path, 'ping').length >= 3,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const log = json(await signedRequest(t.app, creds, { path: '/v1/webhooks/deliveries' })).data;
    expect(log.find((d: Json) => d.event_id === eventId)).toMatchObject({
      type: 'ping',
      status: 'delivered',
      attempts: 3,
      last_status: 200,
    });
  });

  it('gives up after WEBHOOK_MAX_AGE_MS and shows it as dead', async () => {
    const { creds, path } = await setup();
    await receiver.waitFor(path, (w) => w.body.type === 'connection.connected');
    receiver.respond(path, [500]);
    const { event_id: eventId } = json(
      await signedRequest(t.app, creds, { method: 'POST', path: '/v1/webhooks/test' }),
    );
    await t.prisma.webhookOutbox.updateMany({
      where: { eventId },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });
    const deadline = Date.now() + 8_000;
    let row: Json | undefined;
    while (Date.now() < deadline) {
      const log = json(await signedRequest(t.app, creds, { path: '/v1/webhooks/deliveries' })).data;
      row = log.find((d: Json) => d.event_id === eventId);
      if (row?.status === 'dead') {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(row).toMatchObject({
      status: 'dead',
      last_status: 500,
      last_error: 'HTTP 500',
      next_attempt_at: null,
    });
  });

  it('delivers each event once even with several dispatchers racing', async () => {
    const { creds, path } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      ids.push(
        json(await signedRequest(t.app, creds, { method: 'POST', path: '/v1/webhooks/test' }))
          .event_id,
      );
    }
    const dispatcher = t.app.get(WebhookDispatcher);
    await Promise.all([
      dispatcher.dispatchDue(),
      dispatcher.dispatchDue(),
      dispatcher.dispatchDue(),
    ]);
    await receiver.waitFor(path, () =>
      ids.every((id) => receiver.of(path).some((w) => w.body.id === id)),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const counts = ids.map((id) => receiver.of(path).filter((w) => w.body.id === id).length);
    expect(counts.every((c) => c === 1)).toBe(true);
  });
});

describe('status sync (moderation and payment)', () => {
  it('reports moderation after publishing', async () => {
    const { creds, path, connectionId } = await setup();
    await put(creds, connectionId, 'L1', listing());
    const synced = await receiver.waitFor(path, (w) => w.body.type === 'listing.synced');
    const itemId = Number(synced.body.data.listing.pin.item_id);

    fake.control.setModeration(itemId, 3, 'Duplicate listing');
    const result = await t.app.get(StatusSyncService).syncConnection(connectionId);
    expect(result).toMatchObject({ checked: 1, changed: 1 });
    const event = await receiver.waitFor(
      path,
      (w) =>
        w.body.type === 'listing.status_changed' && w.body.data.listing.pin.status === 'rejected',
    );
    expect(event.body.data).toMatchObject({
      listing: { live: false, pin: { moderator_comment: 'Duplicate listing' } },
      previous: { status: 'published' },
    });
    const view = json(
      await signedRequest(t.app, creds, { path: `/v1/connections/${connectionId}/listings/L1` }),
    );
    expect(view.pin).toMatchObject({ status: 'rejected', moderator_comment: 'Duplicate listing' });

    // Unchanged on the next check: no new event; next check in a day for rejected listings.
    expect(await t.app.get(StatusSyncService).syncConnection(connectionId)).toMatchObject({
      changed: 0,
    });
    const row = await t.prisma.listing.findFirstOrThrow({
      where: { connectionId, externalId: 'L1' },
    });
    expect(row.nextStatusCheckAt!.getTime() - Date.now()).toBeGreaterThan(23 * 3600 * 1000);
  });

  it('detects a listing deleted on Pin', async () => {
    const { creds, path, connectionId } = await setup();
    await put(creds, connectionId, 'L1', listing());
    const synced = await receiver.waitFor(path, (w) => w.body.type === 'listing.synced');
    fake.control.state.items.delete(Number(synced.body.data.listing.pin.item_id));

    await t.app.get(StatusSyncService).syncConnection(connectionId);
    const event = await receiver.waitFor(path, (w) => w.body.data?.reason === 'deleted_on_pin');
    expect(event.body.data.listing).toMatchObject({
      sync_state: 'failed',
      pin: { item_id: null, status: null },
      last_error: { code: 'deleted_on_pin' },
    });
  });

  it('reports a forced logout as connection.reauth_required', async () => {
    const { creds, path, connectionId, phone } = await setup();
    await put(creds, connectionId, 'L1', listing());
    await receiver.waitFor(path, (w) => w.body.type === 'listing.synced');
    fake.control.revokeToken(phone);
    await t.app.get(StatusSyncService).syncConnection(connectionId);
    const event = await receiver.waitFor(path, (w) => w.body.type === 'connection.reauth_required');
    expect(event.body.data).toMatchObject({
      connection: { id: connectionId, status: 'reauth_required' },
    });
  });

  it('picks due accounts in a tick', async () => {
    const { creds, path, connectionId } = await setup();
    await put(creds, connectionId, 'L1', listing());
    await receiver.waitFor(path, (w) => w.body.type === 'listing.synced');
    await t.prisma.listing.updateMany({
      where: { connectionId },
      data: { nextStatusCheckAt: new Date(Date.now() - 1000) },
    });
    const result = await t.app.get(StatusSyncService).tick();
    expect(result.connections).toBeGreaterThanOrEqual(1);
    const row = await t.prisma.listing.findFirstOrThrow({ where: { connectionId } });
    expect(row.statusCheckedAt).not.toBeNull();
    // Published and paid: next check in about 6 hours.
    expect(row.nextStatusCheckAt!.getTime() - Date.now()).toBeGreaterThan(5 * 3600 * 1000);
  });
});
