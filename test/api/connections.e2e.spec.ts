import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiModule } from '../../src/api/api.module';
import {
  ConnectionNotActiveError,
  ConnectionsService,
  tokenContext,
} from '../../src/connections/connections.service';
import { EncryptionService } from '../../src/crypto/encryption.service';
import { PinClient } from '../../src/pin/pin.client';
import { RedisService } from '../../src/queue/redis.service';
import { FakePin, startFakePin } from '../fake-pin/fake-pin';
import { Credentials, signedRequest } from '../support/signed-request';
import { TestApp, createTestApp } from '../support/test-app';

let fake: FakePin;
let t: TestApp;

beforeAll(async () => {
  fake = await startFakePin();
  t = await createTestApp(ApiModule, {
    PIN_BASE_URL: fake.url,
    PIN_REQUEST_TIMEOUT_MS: '500',
    PIN_RATE_LIMIT_RPS: '1000',
    PIN_RATE_LIMIT_BURST: '1000',
    PIN_BREAKER_MIN_REQUESTS: '1000',
    API_RATE_LIMIT_RPS: '1000',
    API_RATE_LIMIT_BURST: '1000',
    CONNECTION_SMS_PER_AGENCY_PER_HOUR: '100',
  });
});

afterAll(async () => {
  await t?.close();
  await fake?.close();
});

beforeEach(async () => {
  fake.control.reset();
  await t.app.get(PinClient).circuitBreaker.reset();
});

let phoneSeq = 2_000_000;
/** Unique TT number per test so rows never collide across runs. */
const nextPhone = () => `+1868${phoneSeq++ + Math.floor(Math.random() * 7_000_000)}`.slice(0, 12);

const api = (creds: Credentials) => ({
  start: (body: unknown) =>
    signedRequest(t.app, creds, { method: 'POST', path: '/v1/connections', body }),
  confirm: (id: string, code: string) =>
    signedRequest(t.app, creds, {
      method: 'POST',
      path: `/v1/connections/${id}/confirm`,
      body: { code },
    }),
  resend: (id: string) =>
    signedRequest(t.app, creds, { method: 'POST', path: `/v1/connections/${id}/resend` }),
  get: (id: string) => signedRequest(t.app, creds, { path: `/v1/connections/${id}` }),
  list: () => signedRequest(t.app, creds, { path: '/v1/connections' }),
  remove: (id: string) =>
    signedRequest(t.app, creds, { method: 'DELETE', path: `/v1/connections/${id}` }),
});

type Json = Record<string, unknown> & {
  error?: { code: string; details?: Record<string, unknown> };
};
const json = (res: { json(): unknown }) => res.json() as Json;

/** Lets the next SMS go out immediately (skips our cooldown) without waiting in the test. */
async function expireCooldown(id: string): Promise<void> {
  await t.prisma.connection.update({ where: { id }, data: { smsCooldownUntil: null } });
}

async function connected(creds: Credentials, phone = nextPhone()) {
  const started = json(await api(creds).start({ phone, display_name: 'John Doe' }));
  const confirmed = await api(creds).confirm(started.id as string, fake.control.smsCode());
  expect(confirmed.statusCode).toBe(200);
  return { id: started.id as string, phone };
}

describe('POST /v1/connections (SMS flow)', () => {
  it('connects an account: SMS, wrong code, right code', async () => {
    const { creds } = await t.newAgency();
    const phone = nextPhone();

    const started = await api(creds).start({
      phone: phone.replace('+1868', '(868) '),
      display_name: 'John Doe',
    });
    expect(started.statusCode).toBe(201);
    const body = json(started);
    expect(body).toMatchObject({
      phone,
      display_name: 'John Doe',
      status: 'pending_code',
      resend_after_seconds: 60,
      confirm_attempts_left: 5,
      sms_sent: true,
    });
    expect(fake.control.callCount('GET /users/phone_verify/')).toBe(1);

    const wrong = await api(creds).confirm(body.id as string, '0000');
    expect(wrong.statusCode).toBe(422);
    expect(json(wrong).error).toMatchObject({
      code: 'invalid_code',
      details: { confirm_attempts_left: 4 },
    });

    const ok = await api(creds).confirm(body.id as string, fake.control.smsCode());
    expect(ok.statusCode).toBe(200);
    expect(json(ok)).toMatchObject({ status: 'active', confirm_attempts_left: null });
    // The activating confirm hands the agency its own copy of the Pin credentials, once.
    const pinUser = fake.control.state.users.get(phone.slice(1))!;
    expect(json(ok).pin_credentials).toEqual({
      device_key: expect.any(String),
      token: pinUser.token,
    });
    expect(
      fake.control.state.deviceKeys.has((json(ok).pin_credentials as Json).device_key as string),
    ).toBe(true);
    const again = await api(creds).confirm(body.id as string, fake.control.smsCode());
    expect(again.statusCode).toBe(200);
    expect(JSON.stringify(json(again))).not.toMatch(/token|device_key/i);
    expect(JSON.stringify(json(await api(creds).get(body.id as string)))).not.toMatch(/token/i);
  });

  it('stores the Pin token encrypted and hands it to jobs', async () => {
    const { creds } = await t.newAgency();
    const { id, phone } = await connected(creds);
    const row = await t.prisma.connection.findUniqueOrThrow({ where: { id } });
    const pinUser = fake.control.state.users.get(phone.slice(1))!;

    expect(Buffer.from(row.pinTokenEnc!).toString('utf8')).not.toContain(pinUser.token);
    expect(t.app.get(EncryptionService).decryptString(row.pinTokenEnc!, tokenContext(id))).toBe(
      pinUser.token,
    );
    const auth = await t.app.get(ConnectionsService).authFor(id);
    expect(auth.token).toBe(pinUser.token);
    expect(fake.control.state.deviceKeys.has(auth.deviceKey)).toBe(true);
  });

  it('is idempotent for an active number: no second SMS', async () => {
    const { creds } = await t.newAgency();
    const { id, phone } = await connected(creds);
    const sms = fake.control.callCount('GET /users/phone_verify/');

    const again = await api(creds).start({ phone, display_name: 'Jane Doe' });
    expect(again.statusCode).toBe(200);
    expect(json(again)).toMatchObject({
      id,
      status: 'active',
      display_name: 'Jane Doe',
      sms_sent: false,
    });
    expect(fake.control.callCount('GET /users/phone_verify/')).toBe(sms);
  });

  it('rejects non-TT numbers before calling Pin', async () => {
    const { creds } = await t.newAgency();
    const res = await api(creds).start({ phone: '+7 701 123 4567', display_name: 'X' });
    expect(res.statusCode).toBe(422);
    expect(json(res).error?.code).toBe('invalid_phone');
    expect(fake.control.state.calls).toHaveLength(0);
  });

  it('validates the body', async () => {
    const { creds } = await t.newAgency();
    const res = await api(creds).start({ phone: nextPhone() });
    expect(res.statusCode).toBe(422);
    expect(json(res).error).toMatchObject({
      code: 'validation_failed',
      details: [{ field: 'display_name', message: expect.any(String) }],
    });
    const badCode = await api(creds).confirm('00000000-0000-0000-0000-000000000000', 'abc');
    expect(badCode.statusCode).toBe(422);
  });

  it('enforces the resend cooldown from Pin', async () => {
    const { creds } = await t.newAgency();
    const { id } = json(await api(creds).start({ phone: nextPhone(), display_name: 'X' })) as {
      id: string;
    };
    const early = await api(creds).resend(id);
    expect(early.statusCode).toBe(429);
    expect(json(early).error?.code).toBe('sms_rate_limited');
    expect(Number(early.headers['retry-after'])).toBeGreaterThan(50);
    expect(fake.control.callCount('GET /users/phone_verify/')).toBe(1);

    await expireCooldown(id);
    const later = await api(creds).resend(id);
    expect(later.statusCode).toBe(200);
    expect(json(later)).toMatchObject({ status: 'pending_code', confirm_attempts_left: 5 });
  });

  it('stops at 5 SMS per number per 10 minutes, before Pin would', async () => {
    const { creds } = await t.newAgency();
    const { id } = json(await api(creds).start({ phone: nextPhone(), display_name: 'X' })) as {
      id: string;
    };
    for (let i = 0; i < 4; i++) {
      await expireCooldown(id);
      expect((await api(creds).resend(id)).statusCode).toBe(200);
    }
    await expireCooldown(id);
    const sixth = await api(creds).resend(id);
    expect(sixth.statusCode).toBe(429);
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(500);
    expect(fake.control.callCount('GET /users/phone_verify/')).toBe(5);
  });

  it('limits SMS per agency per hour', async () => {
    const previous = process.env.CONNECTION_SMS_PER_AGENCY_PER_HOUR;
    const limited = await createTestApp(ApiModule, { CONNECTION_SMS_PER_AGENCY_PER_HOUR: '2' });
    try {
      const { creds } = await limited.newAgency();
      const start = (phone: string) =>
        signedRequest(limited.app, creds, {
          method: 'POST',
          path: '/v1/connections',
          body: { phone, display_name: 'X' },
        });
      expect((await start(nextPhone())).statusCode).toBe(201);
      expect((await start(nextPhone())).statusCode).toBe(201);
      const third = await start(nextPhone());
      expect(third.statusCode).toBe(429);
      expect(json(third).error?.code).toBe('sms_rate_limited');
      expect(fake.control.callCount('GET /users/phone_verify/')).toBe(2);
    } finally {
      await limited.close();
      process.env.CONNECTION_SMS_PER_AGENCY_PER_HOUR = previous;
    }
  });

  it('locks out after too many wrong codes until a new code is requested', async () => {
    const { creds } = await t.newAgency();
    const { id } = json(await api(creds).start({ phone: nextPhone(), display_name: 'X' })) as {
      id: string;
    };
    for (let i = 0; i < 5; i++) {
      expect((await api(creds).confirm(id, '0000')).statusCode).toBe(422);
    }
    const locked = await api(creds).confirm(id, fake.control.smsCode());
    expect(locked.statusCode).toBe(429);
    expect(json(locked).error?.code).toBe('sms_code_attempts_exceeded');
    expect(fake.control.callCount('POST /users/phone_verify/')).toBe(5);

    await expireCooldown(id);
    await api(creds).resend(id);
    expect((await api(creds).confirm(id, fake.control.smsCode())).statusCode).toBe(200);
  });

  it('caps wrong codes per phone number across agencies and resent codes', async () => {
    const a = await t.newAgency();
    const b = await t.newAgency();
    const phone = nextPhone();
    const ids = [] as string[];
    for (const creds of [a.creds, b.creds]) {
      ids.push((json(await api(creds).start({ phone, display_name: 'X' })) as { id: string }).id);
    }
    // 10 wrong codes in total: 5 per agency (each within its own per-code limit).
    for (const [i, creds] of [a.creds, b.creds].entries()) {
      for (let n = 0; n < 5; n++) {
        expect((await api(creds).confirm(ids[i]!, '0000')).statusCode).toBe(422);
      }
    }
    await expireCooldown(ids[0]!);
    await api(a.creds).resend(ids[0]!);
    const locked = await api(a.creds).confirm(ids[0]!, fake.control.smsCode());
    expect(locked.statusCode).toBe(429);
    expect(json(locked).error?.code).toBe('sms_code_attempts_exceeded');
    await t.app.get(RedisService).del(`pin-bridge:sms-wrong-codes:${phone}`);
  });

  it('rejects a second concurrent request for the same connection', async () => {
    const { creds } = await t.newAgency();
    const { id } = json(await api(creds).start({ phone: nextPhone(), display_name: 'X' })) as {
      id: string;
    };
    await expireCooldown(id);
    fake.control.failNext({ route: 'GET /users/phone_verify/', delayMs: 300 });
    const [a, b] = await Promise.all([api(creds).resend(id), api(creds).resend(id)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect([json(a).error?.code, json(b).error?.code]).toContain('connection_busy');
  });

  it('answers 503 pin_unavailable when Pin is down, and does not resend the SMS', async () => {
    const { creds } = await t.newAgency();
    fake.control.failNext({ route: 'GET /users/phone_verify/', status: 503 });
    const res = await api(creds).start({ phone: nextPhone(), display_name: 'X' });
    expect(res.statusCode).toBe(503);
    expect(json(res).error?.code).toBe('pin_unavailable');
    expect(res.headers['retry-after']).toBeDefined();
    expect(fake.control.callCount('GET /users/phone_verify/')).toBe(1);
  });

  it('counts an SMS whose outcome is unknown (timeout) against the cooldown', async () => {
    const { creds } = await t.newAgency();
    fake.control.failNext({ route: 'GET /users/phone_verify/', delayMs: 800 });
    const phone = nextPhone();
    const res = await api(creds).start({ phone, display_name: 'X' });
    expect(res.statusCode).toBe(503);
    const row = await t.prisma.connection.findFirstOrThrow({ where: { phoneE164: phone } });
    expect(row.smsRequestsWindow).toHaveLength(1);
    expect((await api(creds).resend(row.id)).statusCode).toBe(429);
  });

  it('hides our Cloudflare problem from the agency as 503', async () => {
    const { creds } = await t.newAgency();
    fake.control.cloudflareBlockAll(true);
    const res = await api(creds).start({ phone: nextPhone(), display_name: 'X' });
    expect(res.statusCode).toBe(503);
    expect(json(res).error?.code).toBe('pin_unavailable');
  });
});

describe('connection lifecycle', () => {
  it('lists and reads only the agency’s own connections', async () => {
    const a = await t.newAgency();
    const b = await t.newAgency();
    const { id } = await connected(a.creds);

    expect(json(await api(a.creds).list()).data).toEqual([
      expect.objectContaining({ id, status: 'active' }),
    ]);
    expect(json(await api(b.creds).list()).data).toEqual([]);
    expect((await api(b.creds).get(id)).statusCode).toBe(404);
    expect((await api(b.creds).confirm(id, '1234')).statusCode).toBe(404);
    expect((await api(b.creds).remove(id)).statusCode).toBe(404);
    expect((await api(a.creds).get('not-a-uuid')).statusCode).toBe(404);
  });

  it('disables a connection and forgets its credentials', async () => {
    const { creds } = await t.newAgency();
    const { id } = await connected(creds);
    const res = await api(creds).remove(id);
    expect(res.statusCode).toBe(200);
    expect(json(res).status).toBe('disabled');
    const row = await t.prisma.connection.findUniqueOrThrow({ where: { id } });
    expect(row.pinTokenEnc).toBeNull();
    expect(row.pinDeviceKeyEnc).toBeNull();
    await expect(t.app.get(ConnectionsService).authFor(id)).rejects.toBeInstanceOf(
      ConnectionNotActiveError,
    );
  });

  it('can reconnect after Pin revoked the token', async () => {
    const { creds } = await t.newAgency();
    const { id, phone } = await connected(creds);
    const service = t.app.get(ConnectionsService);

    expect(await service.markReauthRequired(id, 'pin_unauthorized')).toBe(true);
    expect(await service.markReauthRequired(id, 'pin_unauthorized')).toBe(false);
    expect(json(await api(creds).get(id)).status).toBe('reauth_required');
    await expect(service.authFor(id)).rejects.toBeInstanceOf(ConnectionNotActiveError);

    await expireCooldown(id);
    const restarted = await api(creds).start({ phone, display_name: 'John Doe' });
    expect(json(restarted)).toMatchObject({ id, status: 'pending_code', sms_sent: true });
    expect((await api(creds).confirm(id, fake.control.smsCode())).statusCode).toBe(200);
    await expect(service.authFor(id)).resolves.toMatchObject({ token: expect.any(String) });
  });

  it('audits connect, reauth and disable', async () => {
    const { creds, agencyId } = await t.newAgency();
    const { id } = await connected(creds);
    await t.app.get(ConnectionsService).markReauthRequired(id, 'test');
    await api(creds).remove(id);
    const actions = (
      await t.prisma.auditLog.findMany({ where: { target: id }, orderBy: { id: 'asc' } })
    ).map((a) => [a.action, a.agencyId]);
    expect(actions).toEqual([
      ['connection.connected', agencyId],
      ['connection.reauth_required', agencyId],
      ['connection.disabled', agencyId],
    ]);
  });
});
