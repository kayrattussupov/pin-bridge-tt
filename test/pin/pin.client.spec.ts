import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PinClient, PinClientOptions, PinLogger } from '../../src/pin/pin.client';
import { PinError } from '../../src/pin/pin.errors';
import type { CreateItemPayload, PinAuth } from '../../src/pin/pin.types';
import { FakePin, startFakePin } from '../fake-pin/fake-pin';
import { testPrefix, testRedis } from '../support/redis';

const PHONE = '+18681234567';
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const silent: PinLogger = { debug: () => undefined, warn: () => undefined };

let fake: FakePin;
let redis: Redis;
const clients: PinClient[] = [];

beforeAll(async () => {
  redis = testRedis();
  fake = await startFakePin({ freeRentListings: 0 });
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await fake.close();
  await redis.quit();
});

beforeEach(() => fake.control.reset());

function makeClient(
  overrides: { baseUrl?: string; requestTimeoutMs?: number; minRequests?: number } = {},
): PinClient {
  const options: PinClientOptions = {
    transport: {
      baseUrl: overrides.baseUrl ?? fake.url,
      connectTimeoutMs: 1_000,
      userAgent: 'PinBridge/test',
      maxResponseBytes: 1024 * 1024,
    },
    requestTimeoutMs: overrides.requestTimeoutMs ?? 2_000,
    uploadTimeoutMs: 5_000,
    breaker: {
      keyPrefix: testPrefix('client-breaker'),
      windowMs: 10_000,
      bucketMs: 1_000,
      minRequests: overrides.minRequests ?? 1_000,
      failureRatio: 0.5,
      openMs: 5_000,
      probeTimeoutMs: 1_000,
    },
    rateLimit: {
      key: testPrefix('client-rl'),
      ratePerSecond: 1_000,
      burst: 1_000,
      maxWaitMs: 1_000,
    },
    backoff: { baseMs: 5, maxMs: 20, maxAttempts: 3 },
  };
  const client = new PinClient(options, redis, silent);
  clients.push(client);
  return client;
}

async function connect(client: PinClient, phone = PHONE): Promise<PinAuth> {
  const deviceKey = await client.createDeviceKey();
  await client.requestSmsCode(deviceKey, phone);
  const token = await client.confirmSmsCode(deviceKey, phone, fake.control.smsCode());
  return { deviceKey, token };
}

function rentItem(overrides: Partial<CreateItemPayload> = {}): CreateItemPayload {
  return {
    rubric: 21,
    city: 17,
    currency_id: 1,
    title: '2-bedroom apartment in Valsayn',
    description: 'Fully furnished, A/C, gated community, parking.',
    price: 3500,
    images: [],
    coordinates: { latitude: 10.65, longitude: -61.41 },
    user: { name: 'John Doe', email: '' },
    phone_hide: false,
    negotiable_price: false,
    external_id: 'duck-8842',
    item_link: '',
    attrs: { type: 2, bedrooms: 2, 'number-of-bathrooms': 30, water: [10, 20], 'floor-area': 1200 },
    ...overrides,
  };
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected the call to fail');
    },
    (error: unknown) => error as PinError,
  );

describe('PinClient against fake-pin', () => {
  describe('account connection', () => {
    it('connects with device key + SMS code and gets the same token on reconnect', async () => {
      const client = makeClient();
      const first = await connect(client);
      expect(first.token).toMatch(/\w{16,}/);

      const second = await connect(client);
      expect(second.deviceKey).not.toBe(first.deviceKey);
      expect(second.token).toBe(first.token);
    });

    it('sends Device-Api-Key and the token on every call', async () => {
      const client = makeClient();
      const auth = await connect(client);
      await client.listMyItems(auth);
      const call = fake.control.state.calls.at(-1)!;
      expect(call).toMatchObject({
        route: 'GET /items/front_my/',
        deviceKey: auth.deviceKey,
        authorization: `Token ${auth.token}`,
      });
    });

    it('reports the SMS cooldown', async () => {
      const client = makeClient();
      const deviceKey = await client.createDeviceKey();
      expect(await client.requestSmsCode(deviceKey, PHONE)).toEqual({ retryAfterSeconds: 60 });
    });

    it('surfaces Pin refusing a non-TT number', async () => {
      const client = makeClient();
      const deviceKey = await client.createDeviceKey();
      const error = await failure(client.requestSmsCode(deviceKey, '+77011234567'));
      expect(error.kind).toBe('validation');
      expect(error.pinErrors[0]?.message).toBe('Could not determine the country by number');
    });

    it('stops at 5 SMS requests per device key per 10 minutes', async () => {
      const client = makeClient();
      const deviceKey = await client.createDeviceKey();
      for (let i = 0; i < 5; i++) {
        await client.requestSmsCode(deviceKey, PHONE);
      }
      const error = await failure(client.requestSmsCode(deviceKey, PHONE));
      expect(error.kind).toBe('validation');
      expect(error.smsRetryAfterSeconds).toBeGreaterThan(500);
      // A fresh device key has its own limit.
      await expect(
        client.requestSmsCode(await client.createDeviceKey(), PHONE),
      ).resolves.toBeDefined();
    });

    it('rejects a wrong code', async () => {
      const client = makeClient();
      const deviceKey = await client.createDeviceKey();
      await client.requestSmsCode(deviceKey, PHONE);
      const error = await failure(client.confirmSmsCode(deviceKey, PHONE, '0000'));
      expect(error.kind).toBe('validation');
    });

    it('classifies a call without a device key', async () => {
      const client = makeClient();
      const error = await failure(client.getAllCities(''));
      expect(error.kind).toBe('missing_device_key');
    });

    it('classifies a revoked token as unauthorized', async () => {
      const client = makeClient();
      const auth = await connect(client);
      fake.control.revokeToken(PHONE);
      const error = await failure(client.listMyItems(auth));
      expect(error.kind).toBe('unauthorized');
    });
  });

  describe('publishing', () => {
    it('uploads pictures and creates a published item', async () => {
      const client = makeClient();
      const auth = await connect(client);
      const picId = await client.uploadPicture(auth, {
        data: JPEG,
        filename: 'front.jpg',
        contentType: 'image/jpeg',
      });
      await client.validateAd(auth, rentItem({ images: [picId] }));
      const item = await client.createItem(auth, rentItem({ images: [picId] }));
      expect(item).toMatchObject({ status: 0, not_paid: false, external_id: 'duck-8842' });
    });

    it('turns a non-image upload into a validation error', async () => {
      const client = makeClient();
      const auth = await connect(client);
      const error = await failure(
        client.uploadPicture(auth, {
          data: Buffer.from('not an image'),
          filename: 'x.jpg',
          contentType: 'image/jpeg',
        }),
      );
      expect(error.kind).toBe('validation');
      expect(error.pinErrors[0]).toMatchObject({ field: 'img' });
    });

    it('keeps only the first 16 images, as Pin does silently', async () => {
      const client = makeClient();
      const auth = await connect(client);
      const ids: string[] = [];
      for (let i = 0; i < 20; i++) {
        ids.push(
          await client.uploadPicture(auth, {
            data: JPEG,
            filename: `${i}.jpg`,
            contentType: 'image/jpeg',
          }),
        );
      }
      const item = await client.createItem(auth, rentItem({ images: ids }));
      expect((item as unknown as { images: unknown[] }).images).toHaveLength(16);
    });

    it('returns field errors from Pin', async () => {
      const client = makeClient();
      const auth = await connect(client);
      const error = await failure(
        client.createItem(
          auth,
          rentItem({ coordinates: [-61.41, 10.65] as never, user: { name: '' } }),
        ),
      );
      expect(error.kind).toBe('validation');
      expect(error.pinErrors.map((e) => e.field)).toEqual(
        expect.arrayContaining(['coordinates', 'user']),
      );
    });

    it('flags a paid rent listing above 4000 TT$ with not_paid', async () => {
      const client = makeClient();
      const auth = await connect(client);
      const item = await client.createItem(auth, rentItem({ price: 6000 }));
      expect(item).toMatchObject({ status: 0, not_paid: true });
    });

    it('lists, edits, hides and removes items', async () => {
      const client = makeClient();
      const auth = await connect(client);
      const created = await client.createItem(auth, rentItem());

      fake.control.setModeration(Number(created.id), 3, 'Duplicate listing');
      const page = await client.listMyItems(auth);
      expect(page.results).toEqual([
        expect.objectContaining({
          id: created.id,
          status: 3,
          moderator_comment: 'Duplicate listing',
        }),
      ]);
      expect(page.next).toBeNull();

      const patched = await client.partialUpdateItem(auth, created.id, { price: 3200 });
      expect(patched).toMatchObject({ id: created.id, price: 3200 });
      const updated = await client.updateItem(auth, created.id, rentItem({ title: 'New title' }));
      expect(updated).toMatchObject({ title: 'New title' });

      await client.toggleActive(auth, created.id);
      fake.control.setModeration(Number(created.id), 0);
      await client.toggleActive(auth, created.id);
      expect(fake.control.state.items.get(Number(created.id))?.status).toBe(2);

      await client.removeItem(auth, created.id);
      expect((await client.listMyItems(auth)).results).toEqual([]);
      expect((await failure(client.removeItem(auth, created.id))).kind).toBe('not_found');
    });

    it('refuses to touch another user item', async () => {
      const client = makeClient();
      const owner = await connect(client);
      const other = await connect(client, '+18687654321');
      const item = await client.createItem(owner, rentItem());
      expect((await failure(client.removeItem(other, item.id))).kind).toBe('forbidden');
    });

    it('reads the dictionaries needed to build attrs', async () => {
      const client = makeClient();
      const deviceKey = await client.createDeviceKey();
      expect(await client.getAllCities(deviceKey)).toContainEqual({ id: 17, name: 'Central' });
      expect(await client.getRubricForm(deviceKey, 21)).toMatchObject({ rubric: 21 });
      expect(await client.getRubricTree(deviceKey)).toBeInstanceOf(Array);
      expect(await client.getCityDistricts(deviceKey, 17)).toHaveLength(2);
    });
  });

  describe('failures and retries', () => {
    it('retries a safe call through transient 5xx', async () => {
      const client = makeClient();
      const auth = await connect(client);
      fake.control.failNext({ route: 'GET /items/front_my/', status: 503, times: 2 });
      await expect(client.listMyItems(auth)).resolves.toBeDefined();
      expect(fake.control.callCount('GET /items/front_my/')).toBe(3);
    });

    it('gives up after maxAttempts', async () => {
      const client = makeClient();
      const auth = await connect(client);
      fake.control.failNext({ route: 'GET /items/front_my/', status: 502, times: 5 });
      expect((await failure(client.listMyItems(auth))).kind).toBe('server');
      expect(fake.control.callCount('GET /items/front_my/')).toBe(3);
    });

    it('does not resend item creation after a 5xx', async () => {
      const client = makeClient();
      const auth = await connect(client);
      fake.control.failNext({ route: 'POST /items/', status: 503 });
      expect((await failure(client.createItem(auth, rentItem()))).kind).toBe('server');
      expect(fake.control.callCount('POST /items/')).toBe(1);
    });

    it('reports outcome unknown when item creation times out, even though Pin created it', async () => {
      const client = makeClient({ requestTimeoutMs: 100 });
      const auth = await connect(client);
      fake.control.failNext({ route: 'POST /items/', delayMs: 300 });
      const error = await failure(client.createItem(auth, rentItem()));
      expect(error).toMatchObject({ kind: 'timeout', outcomeUnknown: true });
      expect(fake.control.callCount('POST /items/')).toBe(1);

      // This is why callers must reconcile by external_id before creating again.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const page = await client.listMyItems(auth);
      expect(page.results.map((i) => i.external_id)).toEqual(['duck-8842']);
    });

    it('resends even a non-idempotent call when the connection was refused', async () => {
      const unreachable = makeClient({ baseUrl: 'http://127.0.0.1:1' });
      const error = await failure(
        unreachable.createItem({ deviceKey: 'k', token: 't' }, rentItem()),
      );
      expect(error).toMatchObject({ kind: 'network', notSent: true, outcomeUnknown: false });
    });

    it('recognizes the Cloudflare block and opens the breaker so calls stop reaching Pin', async () => {
      const client = makeClient({ minRequests: 3 });
      fake.control.cloudflareBlockAll(true);
      for (let i = 0; i < 3; i++) {
        expect((await failure(client.createDeviceKey())).kind).toBe('cloudflare_blocked');
      }
      const sent = fake.control.state.calls.length;
      expect((await failure(client.createDeviceKey())).kind).toBe('breaker_open');
      expect(fake.control.state.calls.length).toBe(sent);
      expect(await client.circuitBreaker.state()).toBe('open');
    });

    it('does not count validation errors against Pin health', async () => {
      const client = makeClient({ minRequests: 2 });
      const auth = await connect(client);
      for (let i = 0; i < 4; i++) {
        await failure(client.createItem(auth, rentItem({ title: '' })));
      }
      expect(await client.circuitBreaker.state()).toBe('closed');
    });

    it('flags a 2xx with an unexpected body', async () => {
      const client = makeClient();
      fake.control.failNext({
        route: 'POST /items/device_api_key/',
        status: 200,
        body: { status: 0 },
      });
      expect((await failure(client.createDeviceKey())).kind).toBe('unexpected_response');
    });

    it('reads the device key from `id`, as prod returns it', async () => {
      const client = makeClient();
      fake.control.failNext({
        route: 'POST /items/device_api_key/',
        status: 201,
        body: {
          id: 'd2c8ccce-59df-4e5f-a968-46cdde86f948',
          user: 1120268,
          push_token: null,
          maestro_uuid: null,
          phone: '',
        },
      });
      expect(await client.createDeviceKey()).toBe('d2c8ccce-59df-4e5f-a968-46cdde86f948');
    });
  });
});
