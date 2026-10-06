/**
 * Operator CLI for agencies and API keys. In production:
 *
 *   docker compose run --rm worker node dist/cli/admin.js <command> [options]
 *
 *   agency:create   --name "Duck Realty" --slug duck [--ip 203.0.113.10 --ip 198.51.100.0/24]
 *   agency:list
 *   agency:suspend  --slug duck          (all its keys stop working immediately)
 *   agency:activate --slug duck
 *   agency:set-ips  --slug duck [--ip ...] (no --ip = allow any IP)
 *   key:issue       --slug duck          (prints the key and signing secret ONCE)
 *   key:list        --slug duck
 *   key:revoke      --prefix pb_0123456789ab
 *   invite:create   --name "Duck Realty" [--slug duck] [--ttl-days 7]
 *                                       (prints a one-time code; the agency's "Connect" button
 *                                        redeems it via POST /v1/enroll and gets its own keys)
 *   invite:list
 *   invite:revoke   --prefix pbi_0123456789ab
 *   dict:sync                            (refresh Pin reference data now)
 *   dict:show       --kind rubric_form --key 21   (raw Pin response as stored)
 */
import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { INestApplicationContext, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AgenciesModule } from '../agencies/agencies.module';
import { AgenciesService, AgencyAdminError } from '../agencies/agencies.service';
import { AuditModule } from '../audit/audit.module';
import { ConfigModule } from '../config/config.module';
import { CryptoModule } from '../crypto/crypto.module';
import { DatabaseModule } from '../database/database.module';
import { DictionariesModule } from '../dictionaries/dictionaries.module';
import { DictionariesService, DictionaryKind } from '../dictionaries/dictionaries.service';
import { EnrollmentModule } from '../enrollment/enrollment.module';
import { EnrollmentService } from '../enrollment/enrollment.service';
import { QueueModule } from '../queue/queue.module';
import { WebhookEventsModule } from '../webhooks/webhook-events';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    CryptoModule,
    AuditModule,
    AgenciesModule,
    QueueModule,
    DictionariesModule,
    WebhookEventsModule,
    EnrollmentModule,
  ],
})
class AdminModule {}

const ACTOR = `admin-cli:${process.env.USER ?? 'unknown'}`;

function required(value: string | undefined, flag: string): string {
  if (!value) {
    throw new AgencyAdminError(`--${flag} is required`);
  }
  return value;
}

const date = (value: Date | null) =>
  value ? value.toISOString().slice(0, 19).replace('T', ' ') : '-';

async function run(app: INestApplicationContext, command: string, args: string[]): Promise<void> {
  const agencies = app.get(AgenciesService);
  const { values } = parseArgs({
    args,
    options: {
      name: { type: 'string' },
      slug: { type: 'string' },
      ip: { type: 'string', multiple: true },
      prefix: { type: 'string' },
      kind: { type: 'string' },
      key: { type: 'string' },
      'ttl-days': { type: 'string' },
    },
  });

  switch (command) {
    case 'agency:create': {
      const agency = await agencies.createAgency(
        {
          name: required(values.name, 'name'),
          slug: required(values.slug, 'slug'),
          ipAllowlist: values.ip,
        },
        ACTOR,
      );
      console.log(`created agency ${agency.slug} (${agency.id})`);
      console.log(`next: key:issue --slug ${agency.slug}`);
      return;
    }
    case 'agency:list': {
      const rows = await agencies.listAgencies();
      console.table(
        rows.map((a) => ({
          slug: a.slug,
          name: a.name,
          status: a.status,
          active_keys: a._count.apiKeys,
          ip_allowlist: a.ipAllowlist.join(', ') || 'any',
          created: date(a.createdAt),
        })),
      );
      return;
    }
    case 'agency:suspend':
    case 'agency:activate': {
      const status = command === 'agency:suspend' ? 'suspended' : 'active';
      const agency = await agencies.setStatus(required(values.slug, 'slug'), status, ACTOR);
      console.log(`agency ${agency.slug} is now ${agency.status}`);
      return;
    }
    case 'agency:set-ips': {
      const agency = await agencies.setIpAllowlist(
        required(values.slug, 'slug'),
        values.ip ?? [],
        ACTOR,
      );
      console.log(`agency ${agency.slug} ip allowlist: ${agency.ipAllowlist.join(', ') || 'any'}`);
      return;
    }
    case 'key:issue': {
      const issued = await agencies.issueApiKey(required(values.slug, 'slug'), ACTOR);
      console.log('Send these to the agency over a secure channel. They are shown only once.\n');
      console.log(`  API key:        ${issued.apiKey}`);
      console.log(`  Signing secret: ${issued.signingSecret}\n`);
      console.log(`Key prefix (safe to share and log): ${issued.prefix}`);
      return;
    }
    case 'key:list': {
      const keys = await agencies.listApiKeys(required(values.slug, 'slug'));
      console.table(
        keys.map((k) => ({
          prefix: k.keyPrefix,
          scopes: k.scopes.join(','),
          created: date(k.createdAt),
          last_used: date(k.lastUsedAt),
          revoked: date(k.revokedAt),
        })),
      );
      return;
    }
    case 'key:revoke': {
      const key = await agencies.revokeApiKey(required(values.prefix, 'prefix'), ACTOR);
      console.log(`key ${key.keyPrefix} revoked at ${date(key.revokedAt)}`);
      return;
    }
    case 'invite:create': {
      const ttl = values['ttl-days'];
      const invite = await app.get(EnrollmentService).createInvite(
        {
          name: required(values.name, 'name'),
          slug: values.slug,
          ttlDays: ttl === undefined ? undefined : Number(ttl),
        },
        ACTOR,
      );
      console.log('Give this code to the agency. It is shown only once and works once.\n');
      console.log(`  Invite code: ${invite.code}\n`);
      console.log(`Expires: ${date(invite.expiresAt)} UTC. Prefix (safe to log): ${invite.prefix}`);
      return;
    }
    case 'invite:list': {
      const invites = await app.get(EnrollmentService).listInvites();
      const now = Date.now();
      console.table(
        invites.map((i) => ({
          prefix: i.codePrefix,
          name: i.agencyName,
          status: i.revokedAt
            ? 'revoked'
            : i.usedAt
              ? 'used'
              : i.expiresAt.getTime() <= now
                ? 'expired'
                : 'open',
          agency: i.agency?.slug ?? '-',
          expires: date(i.expiresAt),
          used: date(i.usedAt),
        })),
      );
      return;
    }
    case 'invite:revoke': {
      const invite = await app
        .get(EnrollmentService)
        .revokeInvite(required(values.prefix, 'prefix'), ACTOR);
      console.log(`invite ${invite.codePrefix} revoked at ${date(invite.revokedAt)}`);
      return;
    }
    case 'dict:sync': {
      const results = await app.get(DictionariesService).syncAll();
      console.table(results);
      if (results.some((r) => r.status === 'failed')) {
        throw new AgencyAdminError('some dictionaries failed to sync (previous data kept)');
      }
      return;
    }
    case 'dict:show': {
      const kind = required(values.kind, 'kind') as DictionaryKind;
      const row = await app.get(DictionariesService).raw(kind, values.key ?? 'all');
      if (!row) {
        throw new AgencyAdminError(`no ${kind}:${values.key ?? 'all'} stored yet; run dict:sync`);
      }
      console.log(`# ${kind}:${values.key ?? 'all'} fetched ${row.fetchedAt.toISOString()}`);
      console.log(JSON.stringify(row.data, null, 2));
      return;
    }
    default:
      throw new AgencyAdminError(
        `unknown command "${command}". Commands: agency:create, agency:list, agency:suspend, ` +
          'agency:activate, agency:set-ips, key:issue, key:list, key:revoke, invite:create, ' +
          'invite:list, invite:revoke, dict:sync, dict:show',
      );
  }
}

async function main(): Promise<number> {
  const [command = '', ...args] = process.argv.slice(2);
  const app = await NestFactory.createApplicationContext(AdminModule, { logger: ['error'] });
  try {
    await run(app, command, args);
    return 0;
  } catch (error) {
    if (
      error instanceof AgencyAdminError ||
      (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')
    ) {
      console.error(`error: ${(error as Error).message}`);
      return 2;
    }
    throw error;
  } finally {
    await app.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
