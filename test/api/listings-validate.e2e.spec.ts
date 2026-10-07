import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiModule } from '../../src/api/api.module';
import { DictionariesService } from '../../src/dictionaries/dictionaries.service';
import { PinClient } from '../../src/pin/pin.client';
import { FakePin, RUBRIC_FORMS, startFakePin } from '../fake-pin/fake-pin';
import { Credentials, signedRequest } from '../support/signed-request';
import { TestApp, createTestApp } from '../support/test-app';

let fake: FakePin;
let t: TestApp;
let dictionaries: DictionariesService;

beforeAll(async () => {
  fake = await startFakePin();
  t = await createTestApp(ApiModule, {
    PIN_BASE_URL: fake.url,
    PIN_RATE_LIMIT_RPS: '1000',
    PIN_RATE_LIMIT_BURST: '1000',
    PIN_BREAKER_MIN_REQUESTS: '1000',
    API_RATE_LIMIT_RPS: '1000',
    API_RATE_LIMIT_BURST: '1000',
    CONNECTION_SMS_PER_AGENCY_PER_HOUR: '100',
  });
  dictionaries = t.app.get(DictionariesService);
  await dictionaries.syncAll();
});

afterAll(async () => {
  await t?.close();
  await fake?.close();
});

beforeEach(async () => {
  await t.app.get(PinClient).circuitBreaker.reset();
});

type Json = Record<string, unknown> & { error?: { code: string } };
const json = (res: { json(): unknown }) => res.json() as Json;

const rentListing = (overrides: Record<string, unknown> = {}) => ({
  external_id: '8842',
  category: 'residential_rent',
  title: '2-bedroom apartment in Valsayn',
  description: 'Fully furnished.',
  price: 3500,
  region: 'central',
  coordinates: { lat: 10.65, lng: -61.41 },
  images: ['https://cdn.example.com/1.jpg'],
  attributes: { type: 'Apartment', bedrooms: 3 },
  ...overrides,
});

const validate = (creds: Credentials, body: unknown) =>
  signedRequest(t.app, creds, { method: 'POST', path: '/v1/listings/validate', body });

async function connect(creds: Credentials): Promise<string> {
  const phone = `+18687${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
  const started = json(
    await signedRequest(t.app, creds, {
      method: 'POST',
      path: '/v1/connections',
      body: { phone, display_name: 'John Doe' },
    }),
  );
  await signedRequest(t.app, creds, {
    method: 'POST',
    path: `/v1/connections/${started.id as string}/confirm`,
    body: { code: fake.control.smsCode() },
  });
  return started.id as string;
}

describe('dictionary sync', () => {
  it('reports unchanged data on a second run', async () => {
    const results = await dictionaries.syncAll();
    expect(results.every((r) => r.status === 'unchanged')).toBe(true);
    expect(results.map((r) => `${r.kind}:${r.key}`)).toEqual(
      expect.arrayContaining([
        'tree:all',
        'regions:all',
        'rubric_form:20',
        'rubric_form:21',
        'districts:17',
      ]),
    );
  });

  it('detects and audits a changed rubric form', async () => {
    const original = RUBRIC_FORMS[21];
    RUBRIC_FORMS[21] = { ...(original as object), name: 'Residential rent (changed)' };
    try {
      const results = await dictionaries.syncAll();
      expect(results.find((r) => r.key === '21')?.status).toBe('changed');
      const audit = await t.prisma.auditLog.findFirst({
        where: { action: 'dictionary.changed', target: 'rubric_form:21' },
        orderBy: { id: 'desc' },
      });
      expect(audit).not.toBeNull();
    } finally {
      RUBRIC_FORMS[21] = original;
      await dictionaries.syncAll();
      await t.prisma.auditLog.deleteMany({ where: { action: 'dictionary.changed' } });
    }
  });

  it('creates a new system device key when Pin forgets the old one', async () => {
    const before = await dictionaries.systemDeviceKey();
    fake.control.reset(); // Pin no longer knows any device key
    const results = await dictionaries.syncAll();
    expect(results.every((r) => r.status !== 'failed')).toBe(true);
    const after = await dictionaries.systemDeviceKey();
    expect(after).not.toBe(before);
    expect(fake.control.state.deviceKeys.has(after)).toBe(true);
  });

  it('falls back to a connection token when Pin refuses the system device key', async () => {
    const { creds } = await t.newAgency();
    await connect(creds);
    // Refused with the old key and again with a renewed one: tokens are apparently required.
    fake.control.failNext({
      route: 'GET /items/all_cities/',
      status: 403,
      body: { detail: 'Authentication credentials were not provided.' },
      times: 2,
    });
    const keysBefore = fake.control.state.deviceKeys.size;
    const results = await dictionaries.syncAll();
    expect(results.every((r) => r.status !== 'failed')).toBe(true);
    // Renewed exactly once, never in a loop.
    expect(fake.control.state.deviceKeys.size).toBe(keysBefore + 1);
    const lastCities = fake.control.state.calls
      .filter((c) => c.route === 'GET /items/all_cities/')
      .at(-1);
    expect(lastCities?.authorization).toMatch(/^Token /);
  });

  it('keeps the previous data when Pin is unreachable', async () => {
    fake.control.cloudflareBlockAll(true);
    try {
      const results = await dictionaries.syncAll();
      expect(results.every((r) => r.status === 'failed')).toBe(true);
      expect((await dictionaries.rubricForm('residential_rent')).fields.length).toBeGreaterThan(0);
    } finally {
      fake.control.cloudflareBlockAll(false);
    }
  });
});

describe('GET /v1/dictionaries', () => {
  it('serves categories, regions, districts and attributes', async () => {
    const { creds } = await t.newAgency();
    const get = (path: string) => signedRequest(t.app, creds, { path });

    expect(json(await get('/v1/dictionaries/categories')).data).toEqual([
      expect.objectContaining({ name: 'residential_sale', pin_rubric: 20 }),
      expect.objectContaining({ name: 'residential_rent', pin_rubric: 21 }),
    ]);
    expect(json(await get('/v1/dictionaries/regions')).data).toContainEqual({
      name: 'tobago',
      title: 'Tobago',
      pin_id: 15,
    });
    expect(json(await get('/v1/dictionaries/regions/central/districts')).data).toHaveLength(2);
    expect(
      json(await get('/v1/dictionaries/categories/residential_rent/attributes')).data,
    ).toContainEqual({
      slug: 'bedrooms',
      title: 'Bedrooms',
      required: true,
      type: 'select',
      values: ['1', '2', '3', '4+'],
      options: [
        { value: '1', label: '1' },
        { value: '2', label: '2' },
        { value: '3', label: '3' },
        { value: '4+', label: '4+' },
      ],
    });
    expect((await get('/v1/dictionaries/categories/boats/attributes')).statusCode).toBe(404);
    expect((await get('/v1/dictionaries/regions/mars/districts')).statusCode).toBe(404);
  });

  it('requires authentication', async () => {
    expect(
      (await t.app.inject({ method: 'GET', url: '/v1/dictionaries/regions' })).statusCode,
    ).toBe(401);
  });
});

describe('POST /v1/listings/validate', () => {
  it('maps a valid listing and shows the Pin payload', async () => {
    const { creds, slug } = await t.newAgency();
    const res = await validate(creds, { listing: rentListing() });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({
      valid: true,
      errors: [],
      checked_by_pin: false,
      pin_payload: {
        rubric: 21,
        city: 17,
        external_id: `${slug}.8842`,
        attrs: { attrs__type: 2, attrs__bedrooms: 10 },
      },
    });
  });

  it('returns field errors with allowed values (200, valid=false)', async () => {
    const { creds } = await t.newAgency();
    const res = await validate(creds, {
      listing: rentListing({ attributes: { bedrooms: 'many' }, title: 'x' }),
    });
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.valid).toBe(false);
    expect(body.errors).toEqual([expect.objectContaining({ field: 'title' })]);

    const mapped = json(
      await validate(creds, { listing: rentListing({ attributes: { bedrooms: 'many' } }) }),
    );
    expect(mapped.errors).toEqual([
      expect.objectContaining({
        field: 'attributes.bedrooms',
        code: 'unknown_value',
        allowed: ['1', '2', '3', '4+'],
      }),
      expect.objectContaining({ field: 'attributes.type', code: 'required' }),
    ]);
  });

  it('requires https photo URLs', async () => {
    const { creds } = await t.newAgency();
    const res = json(
      await validate(creds, { listing: rentListing({ images: ['http://cdn.example.com/1.jpg'] }) }),
    );
    expect(res).toMatchObject({
      valid: false,
      errors: [{ field: 'images.0', code: 'https_required' }],
    });
  });

  it('also asks Pin when a connection is given, using its display name', async () => {
    const { creds } = await t.newAgency();
    const connectionId = await connect(creds);
    const res = json(
      await validate(creds, { connection_id: connectionId, listing: rentListing() }),
    );
    expect(res).toMatchObject({
      valid: true,
      checked_by_pin: true,
      pin_payload: { user: { name: 'John Doe' } },
    });
    expect(fake.control.callCount('POST /items/validate_ad/')).toBeGreaterThan(0);
  });

  it('limits synchronous Pin validations per agency', async () => {
    const { creds } = await t.newAgency();
    const connectionId = await connect(creds);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push(
        (await validate(creds, { connection_id: connectionId, listing: rentListing() })).statusCode,
      );
    }
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it('reports what Pin rejects', async () => {
    const { creds } = await t.newAgency();
    const connectionId = await connect(creds);
    fake.control.failNext({
      route: 'POST /items/validate_ad/',
      status: 400,
      body: { title: ['Forbidden words.'] },
    });
    const res = json(
      await validate(creds, { connection_id: connectionId, listing: rentListing() }),
    );
    expect(res).toMatchObject({
      valid: false,
      checked_by_pin: true,
      errors: [{ field: 'pin.title', code: 'pin_rejected', message: 'Forbidden words.' }],
    });
  });

  it('refuses connections that are not active or not owned', async () => {
    const a = await t.newAgency();
    const b = await t.newAgency();
    const pending = json(
      await signedRequest(t.app, a.creds, {
        method: 'POST',
        path: '/v1/connections',
        body: { phone: '+18687000001', display_name: 'X' },
      }),
    ).id as string;
    const notActive = await validate(a.creds, { connection_id: pending, listing: rentListing() });
    expect(notActive.statusCode).toBe(409);
    expect(json(notActive).error?.code).toBe('connection_not_active');
    expect(
      (await validate(b.creds, { connection_id: pending, listing: rentListing() })).statusCode,
    ).toBe(404);
  });

  it('marks the connection for re-auth when Pin revoked the token', async () => {
    const { creds } = await t.newAgency();
    const connectionId = await connect(creds);
    const row = await t.prisma.connection.findUniqueOrThrow({ where: { id: connectionId } });
    fake.control.revokeToken(row.phoneE164);
    const res = await validate(creds, { connection_id: connectionId, listing: rentListing() });
    expect(res.statusCode).toBe(409);
    expect(
      (await t.prisma.connection.findUniqueOrThrow({ where: { id: connectionId } })).status,
    ).toBe('reauth_required');
  });

  it('answers 503 dictionary_unavailable before the first sync', async () => {
    const { creds } = await t.newAgency();
    const saved = await t.prisma.dictionary.findUniqueOrThrow({
      where: { kind_key: { kind: 'rubric_form', key: '20' } },
    });
    await t.prisma.dictionary.delete({ where: { kind_key: { kind: 'rubric_form', key: '20' } } });
    (dictionaries as unknown as { cache: Map<string, unknown> }).cache.clear();
    try {
      const res = await validate(creds, { listing: rentListing({ category: 'residential_sale' }) });
      expect(res.statusCode).toBe(503);
      expect(json(res).error?.code).toBe('dictionary_unavailable');
    } finally {
      await t.prisma.dictionary.create({ data: { ...saved, data: saved.data as object } });
    }
  });
});
