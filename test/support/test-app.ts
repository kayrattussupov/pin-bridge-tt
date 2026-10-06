import { randomBytes } from 'node:crypto';
import type { Type } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AgenciesService } from '../../src/agencies/agencies.service';
import { createHttpApp } from '../../src/bootstrap';
import { PrismaService } from '../../src/database/prisma.service';
import { setTestEnv } from './env';
import type { Credentials } from './signed-request';

export interface TestApp {
  app: NestFastifyApplication;
  prisma: PrismaService;
  agencies: AgenciesService;
  newAgency(
    ipAllowlist?: string[],
  ): Promise<{ slug: string; agencyId: string; creds: Credentials }>;
  /** Waits until this app's own listings are no longer queued or processing. */
  waitForIdleListings(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

/** Boots a real API module against the test Postgres/Redis and cleans up its agencies. */
export async function createTestApp(
  rootModule: Type<unknown>,
  env: Record<string, string> = {},
): Promise<TestApp> {
  setTestEnv(env);
  const app = await createHttpApp(rootModule, { trustProxy: false, bodyLimit: 1024 * 1024 });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const prisma = app.get(PrismaService);
  const agencies = app.get(AgenciesService);
  const slugs: string[] = [];
  const agencyIds: string[] = [];

  return {
    app,
    prisma,
    agencies,
    async newAgency(ipAllowlist = []) {
      const slug = `t-${randomBytes(5).toString('hex')}`;
      slugs.push(slug);
      const agency = await agencies.createAgency(
        { name: `Test ${slug}`, slug, ipAllowlist },
        'test',
      );
      agencyIds.push(agency.id);
      const issued = await agencies.issueApiKey(slug, 'test');
      return {
        slug,
        agencyId: agency.id,
        creds: { apiKey: issued.apiKey, signingSecret: issued.signingSecret },
      };
    },
    async waitForIdleListings(timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const busy = await prisma.listing.count({
          where: { agencyId: { in: agencyIds }, syncState: { in: ['queued', 'processing'] } },
        });
        if (busy === 0) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    async close() {
      if (slugs.length) {
        const agencyIds = (await prisma.agency.findMany({ where: { slug: { in: slugs } } })).map(
          (a) => a.id,
        );
        await prisma.auditLog.deleteMany({ where: { agencyId: { in: agencyIds } } });
        await prisma.agency.deleteMany({ where: { id: { in: agencyIds } } });
      }
      await app.close();
    },
  };
}
