import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiModule } from '../../src/api/api.module';
import { EnrollmentService } from '../../src/enrollment/enrollment.service';
import { signedRequest } from '../support/signed-request';
import { TestApp, createTestApp } from '../support/test-app';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const json = (res: { json(): unknown }) => res.json() as Json;

let t: TestApp;
let enrollment: EnrollmentService;
const invitePrefixes: string[] = [];

beforeAll(async () => {
  t = await createTestApp(ApiModule, {
    ENROLL_IP_RATE_LIMIT_PER_MIN: '3',
    // Lets tests use made-up webhook hosts without DNS.
    UNSAFE_ALLOW_PRIVATE_OUTBOUND_HOSTS: 'true',
  });
  enrollment = t.app.get(EnrollmentService);
});

afterAll(async () => {
  if (t) {
    const invites = await t.prisma.enrollmentInvite.findMany({
      where: { codePrefix: { in: invitePrefixes } },
    });
    const agencyIds = invites.map((i) => i.agencyId).filter((id): id is string => Boolean(id));
    await t.prisma.enrollmentInvite.deleteMany({ where: { codePrefix: { in: invitePrefixes } } });
    await t.prisma.auditLog.deleteMany({
      where: {
        OR: [
          { agencyId: { in: agencyIds } },
          { target: { in: invitePrefixes }, action: { startsWith: 'invite.' } },
        ],
      },
    });
    await t.prisma.agency.deleteMany({ where: { id: { in: agencyIds } } });
    await t.close();
  }
});

// Each request gets its own client IP (fresh per run: the budget lives in Redis), so the per-IP
// limit only matters where it is tested.
const ipBase = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
let ipSeq = 0;
const nextIp = () => `${ipBase}.${++ipSeq}`;

async function invite(input: { name?: string; slug?: string; ttlDays?: number } = {}) {
  const created = await enrollment.createInvite(
    { name: input.name ?? `Enroll ${randomBytes(3).toString('hex')}`, ...input },
    'test',
  );
  invitePrefixes.push(created.prefix);
  return created;
}

const requestId = () => randomBytes(16).toString('hex');

function enroll(body: Record<string, unknown>, remoteAddress = nextIp()) {
  return t.app.inject({ method: 'POST', url: '/v1/enroll', payload: body, remoteAddress });
}

describe('POST /v1/enroll', () => {
  it('creates the agency, a working key and the webhook endpoint', async () => {
    const { code } = await invite({ name: 'Duck Realty Enroll' });
    const res = await enroll({
      invite_code: code,
      client_request_id: requestId(),
      webhook_url: 'https://agency.example/api/pin-bridge/webhook',
    });
    expect(res.statusCode).toBe(201);
    const body = json(res);
    expect(body.agency.name).toBe('Duck Realty Enroll');
    expect(body.agency.slug).toMatch(/^duck-realty-enroll(-\d+)?$/);
    expect(body.api_key).toMatch(/^pb_/);
    expect(body.webhook.url).toBe('https://agency.example/api/pin-bridge/webhook');
    expect(body.webhook.signing_secret).toBeTruthy();
    expect(body.retried).toBe(false);

    const creds = { apiKey: body.api_key, signingSecret: body.signing_secret };
    const me = await signedRequest(t.app, creds, { path: '/v1/me' });
    expect(me.statusCode).toBe(200);
    expect(json(me).agency.id).toBe(body.agency.id);
    expect(json(me).setup).toMatchObject({
      webhook: { url: 'https://agency.example/api/pin-bridge/webhook', last_delivery: null },
      connections: { active: 0, pending_code: 0, reauth_required: 0 },
      dictionaries_ready: expect.any(Boolean),
    });
  });

  it('works without a webhook and honours the invite slug and agency_name', async () => {
    const slug = `e-${randomBytes(4).toString('hex')}`;
    const { code } = await invite({ slug });
    const res = await enroll({
      invite_code: code,
      client_request_id: requestId(),
      agency_name: 'Renamed Agency',
    });
    expect(res.statusCode).toBe(201);
    expect(json(res).agency).toMatchObject({ slug, name: 'Renamed Agency' });
    expect(json(res).webhook).toBeNull();
  });

  it('lets a lost response be retried with the same client_request_id', async () => {
    const { code } = await invite();
    const id = requestId();
    const first = json(
      await enroll({
        invite_code: code,
        client_request_id: id,
        webhook_url: 'https://a.example/h',
      }),
    );
    const second = await enroll({ invite_code: code, client_request_id: id });
    expect(second.statusCode).toBe(201);
    const retry = json(second);
    expect(retry.retried).toBe(true);
    expect(retry.agency.id).toBe(first.agency.id);
    expect(retry.api_key).not.toBe(first.api_key);
    // The webhook kept its URL but got a new secret: the old one was lost with the response.
    expect(retry.webhook.url).toBe('https://a.example/h');
    expect(retry.webhook.signing_secret).not.toBe(first.webhook.signing_secret);

    const oldKey = { apiKey: first.api_key, signingSecret: first.signing_secret };
    const newKey = { apiKey: retry.api_key, signingSecret: retry.signing_secret };
    expect((await signedRequest(t.app, oldKey, { path: '/v1/me' })).statusCode).toBe(401);
    expect((await signedRequest(t.app, newKey, { path: '/v1/me' })).statusCode).toBe(200);
  });

  it('rejects reuse with another client_request_id, revoked, expired and unknown codes alike', async () => {
    const used = await invite();
    await enroll({ invite_code: used.code, client_request_id: requestId() });

    const revoked = await invite();
    await enrollment.revokeInvite(revoked.prefix, 'test');

    const expired = await invite();
    await t.prisma.enrollmentInvite.update({
      where: { codePrefix: expired.prefix },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const wrongSecret = `${used.prefix}_${'A'.repeat(32)}`;
    for (const code of [used.code, revoked.code, expired.code, wrongSecret, 'nonsense']) {
      const res = await enroll({ invite_code: code, client_request_id: requestId() });
      expect(res.statusCode, code).toBe(401);
      expect(json(res).error.code).toBe('invalid_invite');
    }
  });

  it('does not use up the code when the webhook URL is refused', async () => {
    const { code } = await invite();
    const bad = await enroll({
      invite_code: code,
      client_request_id: requestId(),
      webhook_url: 'https://user:secret@agency.example/hook',
    });
    expect(bad.statusCode).toBe(422);
    expect(json(bad).error.code).toBe('invalid_webhook_url');

    const good = await enroll({ invite_code: code, client_request_id: requestId() });
    expect(good.statusCode).toBe(201);
  });

  it('validates the body', async () => {
    const res = await enroll({ invite_code: 'x', client_request_id: 'short', extra: 1 });
    expect(res.statusCode).toBe(422);
    expect(json(res).error.code).toBe('validation_failed');
  });

  it('creates exactly one agency when the same code is redeemed concurrently', async () => {
    const { code, prefix } = await invite();
    const results = await Promise.all(
      [1, 2, 3].map(() => enroll({ invite_code: code, client_request_id: requestId() })),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 401, 401]);
    const row = await t.prisma.enrollmentInvite.findUnique({ where: { codePrefix: prefix } });
    expect(row?.agencyId).toBe(json(results.find((r) => r.statusCode === 201)!).agency.id);
  });

  it('limits attempts per IP', async () => {
    const ip = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await enroll({ invite_code: 'nonsense', client_request_id: requestId() }, ip);
      statuses.push(res.statusCode);
    }
    expect(statuses).toEqual([401, 401, 401, 429]);
  });
});
