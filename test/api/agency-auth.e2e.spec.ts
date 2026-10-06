import { randomBytes } from 'node:crypto';
import { Body, Controller, Module, Post, UseGuards } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgenciesService } from '../../src/agencies/agencies.service';
import { ApiModule } from '../../src/api/api.module';
import { AgencyAuthGuard } from '../../src/auth/agency-auth.guard';
import { AgencyContext, CurrentAgency } from '../../src/auth/agency-context';
import { AuthModule } from '../../src/auth/auth.module';
import { createHttpApp } from '../../src/bootstrap';
import { PrismaService } from '../../src/database/prisma.service';
import { setTestEnv } from '../support/env';
import { createTestApp } from '../support/test-app';
import { Credentials, signatureHeaders, signedRequest } from '../support/signed-request';

/** Exercises signature checks over a request body; not part of the real API. */
@Controller('test/echo')
@UseGuards(AgencyAuthGuard)
class EchoController {
  @Post()
  echo(@Body() body: unknown, @CurrentAgency() agency: AgencyContext) {
    return { body, agency: agency.agencySlug };
  }
}

@Module({ imports: [ApiModule, AuthModule], controllers: [EchoController] })
class TestApiModule {}

let app: NestFastifyApplication;
let agencies: AgenciesService;
let prisma: PrismaService;
const slugs: string[] = [];

async function newAgency(
  ipAllowlist: string[] = [],
): Promise<{ slug: string; creds: Credentials }> {
  const slug = `t-${randomBytes(5).toString('hex')}`;
  slugs.push(slug);
  await agencies.createAgency({ name: `Test ${slug}`, slug, ipAllowlist }, 'test');
  const issued = await agencies.issueApiKey(slug, 'test');
  return { slug, creds: { apiKey: issued.apiKey, signingSecret: issued.signingSecret } };
}

beforeAll(async () => {
  setTestEnv({ API_RATE_LIMIT_RPS: '1', API_RATE_LIMIT_BURST: '8' });
  app = await createHttpApp(TestApiModule, { trustProxy: false, bodyLimit: 1024 * 1024 });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  agencies = app.get(AgenciesService);
  prisma = app.get(PrismaService);
});

afterAll(async () => {
  if (prisma && slugs.length) {
    await prisma.agency.deleteMany({ where: { slug: { in: slugs } } });
    await prisma.auditLog.deleteMany({ where: { actor: 'test' } });
  }
  await app?.close();
});

const errorCode = (res: { json(): unknown }) =>
  (res.json() as { error: { code: string } }).error.code;

describe('agency authentication', () => {
  it('accepts a correctly signed request and identifies the agency', async () => {
    const { slug, creds } = await newAgency();
    const res = await signedRequest(app, creds, { path: '/v1/me' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ agency: { slug }, api_key: { scopes: ['*'] } });
  });

  it('records when the key was last used', async () => {
    const { slug, creds } = await newAgency();
    await signedRequest(app, creds, { path: '/v1/me' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const [key] = await agencies.listApiKeys(slug);
    expect(key?.lastUsedAt).toBeInstanceOf(Date);
  });

  it('verifies the signature over the exact body', async () => {
    const { creds } = await newAgency();
    const ok = await signedRequest(app, creds, {
      method: 'POST',
      path: '/test/echo',
      body: { a: 1 },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ body: { a: 1 } });

    const tampered = await signedRequest(app, creds, {
      method: 'POST',
      path: '/test/echo',
      body: { a: 2 },
      signedBody: JSON.stringify({ a: 1 }),
    });
    expect(tampered.statusCode).toBe(401);
  });

  it('includes the query string in the signature', async () => {
    const { creds } = await newAgency();
    const res = await signedRequest(app, creds, { path: '/v1/me?x=1' });
    expect(res.statusCode).toBe(200);
  });

  it.each([
    ['no credentials', { headers: {} }],
    ['a malformed key', { headers: { authorization: 'Bearer nope' } }],
  ])('rejects %s with a uniform 401', async (_name, request) => {
    const res = await app.inject({ method: 'GET', url: '/v1/me', ...request });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({
      error: {
        code: 'unauthorized',
        message: 'Invalid or missing credentials.',
        request_id: expect.any(String),
      },
    });
  });

  it('rejects a wrong signing secret', async () => {
    const { creds } = await newAgency();
    const res = await signedRequest(app, creds, { path: '/v1/me', signWith: 'not-the-secret' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a key of another agency combined with its own secret', async () => {
    const a = await newAgency();
    const b = await newAgency();
    const res = await signedRequest(
      app,
      { apiKey: a.creds.apiKey, signingSecret: b.creds.signingSecret },
      { path: '/v1/me' },
    );
    expect(res.statusCode).toBe(401);
  });

  it('rejects stale and future timestamps', async () => {
    const { creds } = await newAgency();
    const now = Math.floor(Date.now() / 1000);
    for (const timestamp of [String(now - 301), String(now + 301), 'yesterday']) {
      expect((await signedRequest(app, creds, { path: '/v1/me', timestamp })).statusCode).toBe(401);
    }
  });

  it('rejects a replayed nonce', async () => {
    const { creds } = await newAgency();
    const nonce = randomBytes(16).toString('hex');
    expect((await signedRequest(app, creds, { path: '/v1/me', nonce })).statusCode).toBe(200);
    expect((await signedRequest(app, creds, { path: '/v1/me', nonce })).statusCode).toBe(401);
  });

  it('does not let forged requests burn a nonce', async () => {
    const { creds } = await newAgency();
    const nonce = randomBytes(16).toString('hex');
    await signedRequest(app, creds, { path: '/v1/me', nonce, signWith: 'forged' });
    expect((await signedRequest(app, creds, { path: '/v1/me', nonce })).statusCode).toBe(200);
  });

  it('stops a revoked key immediately', async () => {
    const { slug, creds } = await newAgency();
    const [key] = await agencies.listApiKeys(slug);
    await agencies.revokeApiKey(key!.keyPrefix, 'test');
    expect((await signedRequest(app, creds, { path: '/v1/me' })).statusCode).toBe(401);
  });

  it('stops every key of a suspended agency, and resumes on activation', async () => {
    const { slug, creds } = await newAgency();
    await agencies.setStatus(slug, 'suspended', 'test');
    expect((await signedRequest(app, creds, { path: '/v1/me' })).statusCode).toBe(401);
    await agencies.setStatus(slug, 'active', 'test');
    expect((await signedRequest(app, creds, { path: '/v1/me' })).statusCode).toBe(200);
  });

  it('enforces the agency IP allowlist', async () => {
    const { creds } = await newAgency(['203.0.113.0/24']);
    const allowed = await signedRequest(app, creds, {
      path: '/v1/me',
      remoteAddress: '203.0.113.9',
    });
    expect(allowed.statusCode).toBe(200);
    const denied = await signedRequest(app, creds, {
      path: '/v1/me',
      remoteAddress: '198.51.100.1',
    });
    expect(denied.statusCode).toBe(403);
    expect(errorCode(denied)).toBe('forbidden');
  });

  it('rate limits per key with Retry-After', async () => {
    const { creds } = await newAgency();
    const other = await newAgency();
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      statuses.push((await signedRequest(app, creds, { path: '/v1/me' })).statusCode);
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(8);
    const limited = await signedRequest(app, creds, { path: '/v1/me' });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('1');
    expect(errorCode(limited)).toBe('rate_limited');
    // Another agency is unaffected.
    expect((await signedRequest(app, other.creds, { path: '/v1/me' })).statusCode).toBe(200);
  });

  it('charges the per-key budget only for authentic requests', async () => {
    const { creds } = await newAgency();
    for (let i = 0; i < 12; i++) {
      await signedRequest(app, creds, { path: '/v1/me', signWith: 'leaked-key-without-secret' });
    }
    expect((await signedRequest(app, creds, { path: '/v1/me' })).statusCode).toBe(200);
  });

  it('refuses a body that is not covered by the signature', async () => {
    const { creds } = await newAgency();
    const res = await app.inject({
      method: 'POST',
      url: '/test/echo',
      payload: 'plain text',
      headers: {
        'content-type': 'text/plain',
        authorization: `Bearer ${creds.apiKey}`,
        ...signatureHeaders(creds, 'POST', '/test/echo', ''),
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('allows two active keys for rotation, not three', async () => {
    const { slug } = await newAgency();
    await agencies.issueApiKey(slug, 'test');
    await expect(agencies.issueApiKey(slug, 'test')).rejects.toThrow(/already has 2 active keys/);
  });

  it('stores only a hash of the key and an encrypted signing secret', async () => {
    const { slug, creds } = await newAgency();
    const [key] = await agencies.listApiKeys(slug);
    expect(key!.keyHash).not.toContain(creds.apiKey);
    expect(Buffer.from(key!.hmacSecretEnc).toString('utf8')).not.toContain(creds.signingSecret);
    expect(agencies.signingSecretOf(key!)).toBe(creds.signingSecret);
  });

  it('writes an audit trail for agency and key changes', async () => {
    const { slug } = await newAgency();
    const agency = await agencies.getBySlug(slug);
    const actions = (await prisma.auditLog.findMany({ where: { agencyId: agency.id } })).map(
      (a) => a.action,
    );
    expect(actions).toEqual(expect.arrayContaining(['agency.create', 'api_key.issue']));
  });

  it('limits requests per client IP before authentication', async () => {
    const previous = process.env.API_IP_RATE_LIMIT_RPS;
    const strict = await createTestApp(ApiModule, { API_IP_RATE_LIMIT_RPS: '1' });
    try {
      const hit = () =>
        strict.app.inject({ method: 'GET', url: '/v1/me', remoteAddress: '198.51.100.250' });
      const statuses = [
        (await hit()).statusCode,
        (await hit()).statusCode,
        (await hit()).statusCode,
      ];
      expect(statuses).toEqual([401, 401, 429]);
      // Another client is not affected.
      expect(
        (await strict.app.inject({ method: 'GET', url: '/v1/me', remoteAddress: '198.51.100.251' }))
          .statusCode,
      ).toBe(401);
    } finally {
      await strict.close();
      process.env.API_IP_RATE_LIMIT_RPS = previous;
    }
  });

  it('answers malformed JSON with the standard error format', async () => {
    const { creds } = await newAgency();
    const res = await app.inject({
      method: 'POST',
      url: '/test/echo',
      payload: '{not json',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${creds.apiKey}` },
    });
    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe('validation_failed');
  });
});
