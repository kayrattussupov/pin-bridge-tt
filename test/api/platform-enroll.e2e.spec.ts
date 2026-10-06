import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Fastify, { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiModule } from '../../src/api/api.module';
import { ENROLL_PROOF_PATH, enrollProof } from '../../src/enrollment/domain-proof';
import { EnrollmentService } from '../../src/enrollment/enrollment.service';
import { signedRequest } from '../support/signed-request';
import { TestApp, createTestApp } from '../support/test-app';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const json = (res: { json(): unknown }) => res.json() as Json;

const PLATFORM_SECRET = 'platform-secret-platform-secret-123';

/** Stands in for the agency deployments: serves each slug's proof under /<slug>/. */
let deployments: FastifyInstance;
const proofs = new Map<string, string>();
let origin: string;
let t: TestApp;
const slugs: string[] = [];

beforeAll(async () => {
  deployments = Fastify({ logger: false });
  deployments.get(`/:slug${ENROLL_PROOF_PATH}`, async (req, reply) => {
    const proof = proofs.get((req.params as { slug: string }).slug);
    return proof ? reply.type('text/plain').send(`${proof}\n`) : reply.code(404).send('');
  });
  await deployments.listen({ host: '127.0.0.1', port: 0 });
  origin = `http://127.0.0.1:${(deployments.server.address() as AddressInfo).port}`;

  t = await createTestApp(ApiModule, {
    PLATFORM_SIGNING_SECRET: PLATFORM_SECRET,
    PLATFORM_AGENCY_ORIGIN: `${origin}/{slug}`,
    ENROLL_IP_RATE_LIMIT_PER_MIN: '1000',
    UNSAFE_ALLOW_PRIVATE_OUTBOUND_HOSTS: 'true',
  });
});

afterAll(async () => {
  if (t) {
    const agencies = await t.prisma.agency.findMany({ where: { slug: { in: slugs } } });
    const agencyIds = agencies.map((a) => a.id);
    await t.prisma.enrollmentInvite.deleteMany({ where: { agencySlug: { in: slugs } } });
    await t.prisma.auditLog.deleteMany({ where: { agencyId: { in: agencyIds } } });
    await t.prisma.agency.deleteMany({ where: { id: { in: agencyIds } } });
    await t.close();
  }
  await deployments?.close();
});

const newSlug = () => {
  const slug = `p-${randomBytes(4).toString('hex')}`;
  slugs.push(slug);
  return slug;
};
const requestId = () => randomBytes(16).toString('hex');

function provision(body: Record<string, unknown>, secret = PLATFORM_SECRET) {
  return signedRequest(
    t.app,
    { apiKey: 'unused', signingSecret: secret },
    { method: 'POST', path: '/v1/platform/agencies', body },
  );
}

/** What a deployment does: publish the proof for its client_request_id, then call the bridge. */
async function connect(slug: string, id = requestId(), extra: Record<string, unknown> = {}) {
  proofs.set(slug, enrollProof(id));
  return provision({ slug, name: `Agency ${slug}`, client_request_id: id, ...extra });
}

describe('POST /v1/platform/agencies', () => {
  it('creates the agency on its own slug, with a working key and webhook', async () => {
    const slug = newSlug();
    const webhook = `${origin}/${slug}/api/pin-bridge/webhook`;
    const res = await connect(slug, requestId(), { webhook_url: webhook });
    expect(res.statusCode).toBe(201);
    const body = json(res);
    expect(body.agency).toMatchObject({ slug, name: `Agency ${slug}` });
    expect(body.api_key).toMatch(/^pb_/);
    expect(body.webhook).toMatchObject({ url: webhook, signing_secret: expect.any(String) });
    expect(body.retried).toBe(false);

    const creds = { apiKey: body.api_key, signingSecret: body.signing_secret };
    const me = await signedRequest(t.app, creds, { path: '/v1/me' });
    expect(me.statusCode).toBe(200);
    expect(json(me).agency.slug).toBe(slug);
  });

  it('retries a lost response with the same client_request_id', async () => {
    const slug = newSlug();
    const id = requestId();
    const first = json(await connect(slug, id));
    const retry = await connect(slug, id);
    expect(retry.statusCode).toBe(201);
    expect(json(retry)).toMatchObject({ retried: true, agency: { id: first.agency.id } });
    const oldKey = { apiKey: first.api_key, signingSecret: first.signing_secret };
    expect((await signedRequest(t.app, oldKey, { path: '/v1/me' })).statusCode).toBe(401);
  });

  it('re-keys an existing agency when its domain is proven again, without an operator', async () => {
    const slug = newSlug();
    const webhook = `${origin}/${slug}/hook`;
    const first = json(await connect(slug, requestId(), { webhook_url: webhook }));
    // The deployment lost its keys (new server, wiped database) and connects again.
    const again = await connect(slug);
    expect(again.statusCode).toBe(201);
    const body = json(again);
    expect(body).toMatchObject({ retried: true, agency: { id: first.agency.id } });
    expect(body.webhook).toMatchObject({ url: webhook });
    expect(body.webhook.signing_secret).not.toBe(first.webhook.signing_secret);

    const oldKey = { apiKey: first.api_key, signingSecret: first.signing_secret };
    const newKey = { apiKey: body.api_key, signingSecret: body.signing_secret };
    expect((await signedRequest(t.app, oldKey, { path: '/v1/me' })).statusCode).toBe(401);
    expect((await signedRequest(t.app, newKey, { path: '/v1/me' })).statusCode).toBe(200);
    const rekeys = await t.prisma.auditLog.count({
      where: { agencyId: first.agency.id, action: 'enrollment.rekey' },
    });
    expect(rekeys).toBe(1);
  });

  it('refuses a suspended agency', async () => {
    const slug = newSlug();
    await connect(slug);
    await t.agencies.setStatus(slug, 'suspended', 'test');
    const res = await connect(slug);
    expect(res.statusCode).toBe(403);
  });

  it('never hands out keys of an agency created by an operator or an invite', async () => {
    const slug = newSlug();
    await t.agencies.createAgency({ name: 'Operator made', slug }, 'test');
    const res = await connect(slug);
    expect(res.statusCode).toBe(409);
    expect(json(res).error.code).toBe('agency_exists');
  });

  it('requires the proof from the agency domain', async () => {
    const missing = newSlug();
    const res = await provision({ slug: missing, name: 'X', client_request_id: requestId() });
    expect(res.statusCode).toBe(422);
    expect(json(res).error).toMatchObject({
      code: 'domain_not_verified',
      details: { reason: 'HTTP 404' },
    });

    // Deployment A publishes its proof but asks for B's slug: B's domain does not vouch for it.
    const a = newSlug();
    const b = newSlug();
    const id = requestId();
    proofs.set(a, enrollProof(id));
    proofs.set(b, enrollProof(requestId()));
    const stolen = await provision({ slug: b, name: 'B', client_request_id: id });
    expect(json(stolen).error).toMatchObject({
      code: 'domain_not_verified',
      details: { reason: 'proof mismatch' },
    });
    expect(await t.prisma.agency.count({ where: { slug: { in: [missing, b] } } })).toBe(0);
  });

  it('keeps the webhook on the agency domain', async () => {
    const slug = newSlug();
    const res = await connect(slug, requestId(), { webhook_url: `${origin}/someone-else/hook` });
    expect(res.statusCode).toBe(422);
    expect(json(res).error.code).toBe('invalid_webhook_url');
  });

  it('rejects unsigned, wrongly signed and replayed calls', async () => {
    const slug = newSlug();
    const id = requestId();
    proofs.set(slug, enrollProof(id));
    const body = { slug, name: 'X', client_request_id: id };

    const unsigned = await t.app.inject({
      method: 'POST',
      url: '/v1/platform/agencies',
      payload: body,
    });
    expect(unsigned.statusCode).toBe(401);
    expect((await provision(body, 'wrong-secret-wrong-secret-wrong-secret')).statusCode).toBe(401);

    const nonce = randomBytes(16).toString('hex');
    const send = () =>
      signedRequest(
        t.app,
        { apiKey: 'unused', signingSecret: PLATFORM_SECRET },
        { method: 'POST', path: '/v1/platform/agencies', body, nonce },
      );
    expect((await send()).statusCode).toBe(201);
    expect((await send()).statusCode).toBe(401);
  });

  it('validates the body', async () => {
    const res = await provision({ slug: 'Bad Slug', name: '', client_request_id: 'short' });
    expect(res.statusCode).toBe(422);
    expect(json(res).error.code).toBe('validation_failed');
  });

  it('creates one agency when the same slug is enrolled concurrently', async () => {
    const slug = newSlug();
    const id = requestId();
    proofs.set(slug, enrollProof(id));
    const results = await Promise.all(
      [1, 2, 3].map(() => provision({ slug, name: 'Race', client_request_id: id })),
    );
    expect(results.map((r) => r.statusCode)).toEqual([201, 201, 201]);
    const agencyIds = new Set(results.map((r) => json(r).agency.id));
    expect(agencyIds.size).toBe(1);
    expect(results.filter((r) => json(r).retried === false)).toHaveLength(1);
    // Every retry revoked the keys before it: only the last answer's key works.
    const activeKeys = await t.prisma.apiKey.count({
      where: { agencyId: [...agencyIds][0], revokedAt: null },
    });
    expect(activeKeys).toBe(1);
  });

  it('marks its invites as made by the platform', async () => {
    const slug = newSlug();
    await connect(slug);
    const invites = await t.app.get(EnrollmentService).listInvites();
    expect(invites.find((i) => i.agencySlug === slug)).toMatchObject({
      createdBy: 'platform',
      usedAt: expect.any(Date),
    });
  });
});

describe('POST /v1/platform/agencies without PLATFORM_SIGNING_SECRET', () => {
  it('does not exist', async () => {
    delete process.env.PLATFORM_SIGNING_SECRET;
    const plain = await createTestApp(ApiModule);
    try {
      const res = await plain.app.inject({ method: 'POST', url: '/v1/platform/agencies' });
      expect(res.statusCode).toBe(404);
    } finally {
      await plain.close();
    }
  });
});
