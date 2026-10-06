import { Module } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiModule } from '../../src/api/api.module';
import { sign } from '../../src/auth/signature';
import { DictionariesService } from '../../src/dictionaries/dictionaries.service';
import { ListingSyncModule } from '../../src/listing-sync/listing-sync.module';
import { PinClient } from '../../src/pin/pin.client';
import { StatusSyncModule } from '../../src/status-sync/status-sync.module';
import { StatusSyncService } from '../../src/status-sync/status-sync.service';
import { FakePin, startFakePin } from '../fake-pin/fake-pin';
import { ImageServer, startImageServer } from '../support/image-server';
import { Credentials, signedRequest } from '../support/signed-request';
import { TestApp, createTestApp } from '../support/test-app';

/** API and the publishing worker in one process, like api + worker containers. */
@Module({ imports: [ApiModule, ListingSyncModule, StatusSyncModule] })
class ApiAndWorkerModule {}

vi.setConfig({ testTimeout: 20_000, hookTimeout: 30_000 });

let fake: FakePin;
let images: ImageServer;
let t: TestApp;

beforeAll(async () => {
  fake = await startFakePin({ freeRentListings: 0 });
  images = await startImageServer();
  t = await createTestApp(ApiAndWorkerModule, {
    PIN_BASE_URL: fake.url,
    PIN_REQUEST_TIMEOUT_MS: '400',
    PIN_RATE_LIMIT_RPS: '1000',
    PIN_RATE_LIMIT_BURST: '1000',
    PIN_BREAKER_MIN_REQUESTS: '1000',
    API_RATE_LIMIT_RPS: '1000',
    API_RATE_LIMIT_BURST: '1000',
    CONNECTION_SMS_PER_AGENCY_PER_HOUR: '1000',
    LISTING_SYNC_ATTEMPTS: '3',
    LISTING_SYNC_BACKOFF_MS: '100',
    IMAGE_FETCH_TIMEOUT_MS: '1000',
    UNSAFE_ALLOW_PRIVATE_OUTBOUND_HOSTS: 'true',
  });
  // Reference data the mapper needs.
  await t.app.get(DictionariesService).syncAll();
});

afterAll(async () => {
  await t?.close();
  await Promise.all([fake?.close(), images?.close()]);
});

beforeEach(async () => {
  await t.app.get(PinClient).circuitBreaker.reset();
});

// Background jobs of one test must not consume the faults injected by the next one.
afterEach(() => t.waitForIdleListings());

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const json = (res: { json(): unknown }) => res.json() as Json;

let seq = 0;
const uniquePhone = () =>
  `+18687${String((Date.now() % 100_000) * 10 + (seq++ % 10))
    .padStart(6, '0')
    .slice(-6)}`;

async function setup(): Promise<{
  creds: Credentials;
  connectionId: string;
  phone: string;
  slug: string;
}> {
  const { creds, slug } = await t.newAgency();
  const phone = uniquePhone();
  const started = json(
    await signedRequest(t.app, creds, {
      method: 'POST',
      path: '/v1/connections',
      body: { phone, display_name: 'John Doe' },
    }),
  );
  const confirmed = await signedRequest(t.app, creds, {
    method: 'POST',
    path: `/v1/connections/${started.id}/confirm`,
    body: { code: fake.control.smsCode() },
  });
  expect(confirmed.statusCode).toBe(200);
  return { creds, connectionId: started.id as string, phone, slug };
}

const photo = (name: string) => `${images.url}/photo/${name}`;

const listing = (overrides: Record<string, unknown> = {}) => ({
  category: 'residential_rent',
  title: '2-bedroom apartment in Valsayn',
  description: 'Fully furnished.',
  price: 3500,
  region: 'central',
  coordinates: { lat: 10.65, lng: -61.41 },
  images: [photo('a'), photo('b')],
  attributes: { type: 'Apartment', bedrooms: 2 },
  ...overrides,
});

function api(creds: Credentials, connectionId: string) {
  const base = `/v1/connections/${connectionId}/listings`;
  return {
    put: (externalId: string, body: unknown, idempotencyKey?: string) =>
      t.app
        .inject({ method: 'GET', url: '/' })
        .then(() =>
          signedRequestWithKey(creds, 'PUT', `${base}/${externalId}`, body, idempotencyKey),
        ),
    get: (externalId: string) => signedRequest(t.app, creds, { path: `${base}/${externalId}` }),
    list: (query = '') => signedRequest(t.app, creds, { path: `${base}${query}` }),
    deactivate: (externalId: string) =>
      signedRequest(t.app, creds, { method: 'POST', path: `${base}/${externalId}/deactivate` }),
    activate: (externalId: string) =>
      signedRequest(t.app, creds, { method: 'POST', path: `${base}/${externalId}/activate` }),
    remove: (externalId: string) =>
      signedRequest(t.app, creds, { method: 'DELETE', path: `${base}/${externalId}` }),
  };
}

async function signedRequestWithKey(
  creds: Credentials,
  method: 'PUT',
  path: string,
  body: unknown,
  idempotencyKey?: string,
) {
  if (!idempotencyKey) {
    return signedRequest(t.app, creds, { method, path, body });
  }
  // signedRequest has no header option; inject manually with the same signing.
  const payload = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}-nonce`;
  return t.app.inject({
    method,
    url: path,
    payload,
    headers: {
      authorization: `Bearer ${creds.apiKey}`,
      'x-timestamp': timestamp,
      'x-nonce': nonce,
      'x-signature': sign(creds.signingSecret, { timestamp, nonce, method, path, body: payload }),
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
  });
}

/** Polls the API until the listing reaches a settled state (or the predicate holds). */
async function settled(
  creds: Credentials,
  connectionId: string,
  externalId: string,
  predicate: (l: Json) => boolean = (l) => l.sync_state === 'synced' || l.sync_state === 'failed',
  timeoutMs = 8_000,
): Promise<Json> {
  const deadline = Date.now() + timeoutMs;
  let last: Json = {};
  while (Date.now() < deadline) {
    last = json(await api(creds, connectionId).get(externalId));
    if (predicate(last)) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`listing ${externalId} did not settle: ${JSON.stringify(last)}`);
}

const pinItemOf = (l: Json) => fake.control.state.items.get(Number(l.pin.item_id));

describe('publishing listings', () => {
  it('publishes a listing with photos and reports it live', async () => {
    const { creds, connectionId, slug } = await setup();
    const res = await api(creds, connectionId).put('L1', listing());
    expect(res.statusCode).toBe(202);
    expect(json(res)).toMatchObject({
      external_id: 'L1',
      desired_state: 'active',
      sync_state: 'queued',
      live: false,
    });

    const done = await settled(creds, connectionId, 'L1');
    expect(done).toMatchObject({
      sync_state: 'synced',
      live: true,
      pin: { status: 'published', not_paid: false },
      images: [
        { url: photo('a'), status: 'uploaded', error: null },
        { url: photo('b'), status: 'uploaded', error: null },
      ],
      last_error: null,
    });
    const item = pinItemOf(done)!;
    expect(item).toMatchObject({
      external_id: `${slug}.L1`,
      title: '2-bedroom apartment in Valsayn',
      attrs: { type: 2, bedrooms: 2 },
    });
    expect(item.images).toHaveLength(2);
    expect(item.user.name).toBe('John Doe');
  });

  it('answers 200 and does nothing when the same listing is sent again', async () => {
    const { creds, connectionId } = await setup();
    await api(creds, connectionId).put('L1', listing());
    await settled(creds, connectionId, 'L1');
    const calls = fake.control.state.calls.length;
    const again = await api(creds, connectionId).put('L1', listing());
    expect(again.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fake.control.state.calls.length).toBe(calls);
  });

  it('updates in place and uploads only changed photos', async () => {
    const { creds, connectionId } = await setup();
    await api(creds, connectionId).put('L1', listing());
    const first = await settled(creds, connectionId, 'L1');
    const pics = fake.control.callCount('POST /items/pics/');

    const res = await api(creds, connectionId).put(
      'L1',
      listing({ price: 3200, images: [photo('a'), photo('c')] }),
    );
    expect(res.statusCode).toBe(202);
    const second = await settled(
      creds,
      connectionId,
      'L1',
      (l) => l.sync_state === 'synced' && l.version === 2,
    );
    expect(second.pin.item_id).toBe(first.pin.item_id);
    expect(pinItemOf(second)?.price).toBe(3200);
    expect(fake.control.callCount('POST /items/pics/')).toBe(pics + 1);
  });

  it('hides, shows and removes', async () => {
    const { creds, connectionId } = await setup();
    const a = api(creds, connectionId);
    await a.put('L1', listing());
    const published = await settled(creds, connectionId, 'L1');

    expect((await a.deactivate('L1')).statusCode).toBe(202);
    const hidden = await settled(
      creds,
      connectionId,
      'L1',
      (l) => l.sync_state === 'synced' && l.desired_state === 'inactive',
    );
    expect(hidden).toMatchObject({ pin: { status: 'hidden' }, live: false });
    expect(pinItemOf(published)?.status).toBe(2);

    await a.activate('L1');
    const shown = await settled(
      creds,
      connectionId,
      'L1',
      (l) => l.sync_state === 'synced' && l.desired_state === 'active',
    );
    expect(shown.pin.status).toBe('published');

    expect((await a.remove('L1')).statusCode).toBe(202);
    const removed = await settled(
      creds,
      connectionId,
      'L1',
      (l) => l.sync_state === 'synced' && l.desired_state === 'removed',
    );
    expect(removed.pin.item_id).toBeNull();
    expect(fake.control.state.items.has(Number(published.pin.item_id))).toBe(false);
    expect((await a.remove('L1')).statusCode).toBe(200);
  });

  it('flags paid placement: synced but not live until paid', async () => {
    const { creds, connectionId } = await setup();
    await api(creds, connectionId).put('L1', listing({ price: 6000 }));
    const done = await settled(creds, connectionId, 'L1');
    expect(done).toMatchObject({
      sync_state: 'synced',
      live: false,
      pin: { status: 'published', not_paid: true },
    });
    expect(done.warnings).toContainEqual(expect.objectContaining({ code: 'may_be_paid' }));
  });

  it('refuses invalid listings before queuing', async () => {
    const { creds, connectionId } = await setup();
    const res = await api(creds, connectionId).put(
      'L1',
      listing({ attributes: { bedrooms: 'many' } }),
    );
    expect(res.statusCode).toBe(422);
    expect(json(res).error).toMatchObject({
      code: 'invalid_listing',
      details: {
        errors: expect.arrayContaining([expect.objectContaining({ field: 'attributes.bedrooms' })]),
      },
    });
    expect((await api(creds, connectionId).get('L1')).statusCode).toBe(404);
    expect((await api(creds, connectionId).put('x'.repeat(65), listing())).statusCode).toBe(404);
    expect(
      (await api(creds, connectionId).put('L2', { ...listing(), external_id: 'other' })).statusCode,
    ).toBe(422);
  });

  it('keeps tenants apart', async () => {
    const a = await setup();
    const b = await setup();
    await api(a.creds, a.connectionId).put('L1', listing());
    expect((await api(b.creds, a.connectionId).get('L1')).statusCode).toBe(404);
    expect((await api(b.creds, a.connectionId).put('L1', listing())).statusCode).toBe(404);
  });

  it('lists with filters and a cursor', async () => {
    const { creds, connectionId } = await setup();
    const a = api(creds, connectionId);
    for (const id of ['L1', 'L2', 'L3']) {
      await a.put(id, listing());
    }
    for (const id of ['L1', 'L2', 'L3']) {
      await settled(creds, connectionId, id);
    }
    const first = json(await a.list('?limit=2'));
    expect(first.data.map((l: Json) => l.external_id)).toEqual(['L1', 'L2']);
    const second = json(await a.list(`?limit=2&cursor=${first.next_cursor}`));
    expect(second).toMatchObject({
      data: [expect.objectContaining({ external_id: 'L3' })],
      next_cursor: null,
    });
    expect(json(await a.list('?sync_state=failed')).data).toEqual([]);
  });

  it('supports Idempotency-Key', async () => {
    const { creds, connectionId } = await setup();
    const a = api(creds, connectionId);
    const first = await a.put('L1', listing(), 'key-1');
    const replay = await a.put('L1', listing(), 'key-1');
    expect(replay.statusCode).toBe(first.statusCode);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    const misuse = await a.put('L1', listing({ price: 1 }), 'key-1');
    expect(misuse.statusCode).toBe(422);
    expect(json(misuse).error.code).toBe('idempotency_key_reused');
  });
});

describe('publishing failures', () => {
  it('marks a listing Pin rejects as failed, and retries it when sent again', async () => {
    const { creds, connectionId } = await setup();
    fake.control.failNext({
      route: 'POST /items/',
      status: 400,
      body: { title: ['Forbidden words.'] },
    });
    await api(creds, connectionId).put('L1', listing());
    const failed = await settled(creds, connectionId, 'L1');
    expect(failed).toMatchObject({
      sync_state: 'failed',
      last_error: {
        code: 'pin_rejected',
        pin_errors: [{ field: 'title', message: 'Forbidden words.' }],
      },
    });
    expect((await api(creds, connectionId).put('L1', listing())).statusCode).toBe(202);
    expect((await settled(creds, connectionId, 'L1', (l) => l.sync_state === 'synced')).live).toBe(
      true,
    );
  });

  it('retries through a temporary Pin outage', async () => {
    const { creds, connectionId } = await setup();
    fake.control.failNext({ route: 'POST /items/', status: 503 });
    await api(creds, connectionId).put('L1', listing());
    const done = await settled(creds, connectionId, 'L1');
    expect(done.sync_state).toBe('synced');
    expect(fake.control.callCount('POST /items/')).toBeGreaterThanOrEqual(2);
  });

  it('does not duplicate an item whose creation timed out', async () => {
    const { creds, connectionId, slug, phone } = await setup();
    fake.control.failNext({ route: 'POST /items/', delayMs: 700 });
    await api(creds, connectionId).put('L1', listing());
    const done = await settled(creds, connectionId, 'L1', (l) => l.sync_state === 'synced', 10_000);
    const mine = [...fake.control.state.items.values()].filter(
      (i) => i.ownerPhone === phone.slice(1),
    );
    expect(mine.map((i) => i.external_id)).toEqual([`${slug}.L1`]);
    expect(done.pin.item_id).toBe(String(mine[0]!.id));
  });

  it('pauses on a revoked token and resumes after reconnecting', async () => {
    const { creds, connectionId, phone } = await setup();
    fake.control.revokeToken(phone);
    await api(creds, connectionId).put('L1', listing());
    const paused = await settled(creds, connectionId, 'L1');
    expect(paused).toMatchObject({
      sync_state: 'failed',
      last_error: { code: 'connection_reauth_required' },
    });
    const connection = json(
      await signedRequest(t.app, creds, { path: `/v1/connections/${connectionId}` }),
    );
    expect(connection.status).toBe('reauth_required');

    await t.prisma.connection.update({
      where: { id: connectionId },
      data: { smsCooldownUntil: null },
    });
    await signedRequest(t.app, creds, {
      method: 'POST',
      path: '/v1/connections',
      body: { phone, display_name: 'John Doe' },
    });
    await signedRequest(t.app, creds, {
      method: 'POST',
      path: `/v1/connections/${connectionId}/confirm`,
      body: { code: fake.control.smsCode() },
    });
    expect((await settled(creds, connectionId, 'L1', (l) => l.sync_state === 'synced')).live).toBe(
      true,
    );
  });

  it('publishes without a photo that is gone, with a warning', async () => {
    const { creds, connectionId } = await setup();
    await api(creds, connectionId).put(
      'L1',
      listing({ images: [photo('a'), `${images.url}/missing.jpg`, `${images.url}/small.jpg`] }),
    );
    const done = await settled(creds, connectionId, 'L1');
    expect(done.sync_state).toBe('synced');
    expect(done.images.map((i: Json) => i.status)).toEqual(['uploaded', 'failed', 'uploaded']);
    expect(pinItemOf(done)?.images).toHaveLength(2);
    expect(done.warnings.map((w: Json) => w.code)).toEqual(
      expect.arrayContaining(['image_http_error', 'image_low_resolution']),
    );
  });

  it('retries a temporarily unreachable photo, then fails clearly', async () => {
    const { creds, connectionId } = await setup();
    await api(creds, connectionId).put('L1', listing({ images: [`${images.url}/broken.jpg`] }));
    const done = await settled(creds, connectionId, 'L1', undefined, 10_000);
    expect(done).toMatchObject({ sync_state: 'failed', last_error: { code: 'image_unavailable' } });
    expect(images.hits.get('/broken.jpg')).toBeGreaterThanOrEqual(3);
  });

  it('does not toggle twice when the toggle response was lost', async () => {
    const { creds, connectionId } = await setup();
    await api(creds, connectionId).put('L1', listing());
    const published = await settled(creds, connectionId, 'L1');
    // Pin applies the toggle but the response arrives after our timeout.
    const togglesBefore = fake.control.callCount('POST /items/toggle_active/:id/');
    fake.control.failNext({ route: 'POST /items/toggle_active/:id/', delayMs: 700 });
    await api(creds, connectionId).deactivate('L1');
    const hidden = await settled(
      creds,
      connectionId,
      'L1',
      (l) => l.sync_state === 'synced' && l.desired_state === 'inactive',
      10_000,
    );
    expect(hidden.pin.status).toBe('hidden');
    expect(pinItemOf(published)?.status).toBe(2);
    expect(fake.control.callCount('POST /items/toggle_active/:id/') - togglesBefore).toBe(1);
  });

  it('puts visibility right when it drifted on Pin', async () => {
    const { creds, connectionId } = await setup();
    await api(creds, connectionId).put('L1', listing());
    const published = await settled(creds, connectionId, 'L1');
    fake.control.setModeration(Number(published.pin.item_id), 2); // hidden in Pin's own UI
    await t.app.get(StatusSyncService).syncConnection(connectionId);
    await settled(creds, connectionId, 'L1', (l) => l.sync_state === 'synced' && l.version === 2);
    expect(pinItemOf(published)?.status).toBe(0);
  });

  it('publishes again when the item was deleted on Pin', async () => {
    const { creds, connectionId } = await setup();
    await api(creds, connectionId).put('L1', listing());
    const first = await settled(creds, connectionId, 'L1');
    fake.control.state.items.delete(Number(first.pin.item_id));

    await api(creds, connectionId).put('L1', listing({ price: 3100 }));
    const again = await settled(
      creds,
      connectionId,
      'L1',
      (l) => l.sync_state === 'synced' && l.version === 2,
    );
    expect(again.pin.item_id).not.toBe(first.pin.item_id);
    expect(pinItemOf(again)?.price).toBe(3100);
  });

  it('applies only the latest version when updates race', async () => {
    const { creds, connectionId } = await setup();
    const a = api(creds, connectionId);
    await Promise.all(
      [1, 2, 3, 4].map((n) => a.put('L1', listing({ title: `Version number ${n}` }))),
    );
    await a.put('L1', listing({ title: 'Final version' }));
    const done = await settled(
      creds,
      connectionId,
      'L1',
      (l) => l.sync_state === 'synced' && l.version === 5,
    );
    expect(pinItemOf(done)?.title).toBe('Final version');
    const items = [...fake.control.state.items.values()].filter(
      (i) => i.external_id.endsWith('.L1') && i.title === 'Final version',
    );
    expect(items).toHaveLength(1);
  });
});
