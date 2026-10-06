import { createHash } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { ApiError } from '../common/api-error';
import { EncryptionService } from '../crypto/encryption.service';
import { PrismaService } from '../database/prisma.service';
import type { Prisma } from '../generated/prisma/client';
import { metrics } from '../observability/metrics';
import { deviceKeyContext, tokenContext } from '../connections/secret-contexts';
import { DictionaryAuth, PinClient } from '../pin/pin.client';
import { isPinError } from '../pin/pin.errors';
import { CATEGORIES, Category, REGIONS, Region } from './catalog';
import { RubricForm, RubricFormParseError, parseRubricForm } from './rubric-form';

export type DictionaryKind = 'tree' | 'regions' | 'rubric_form' | 'districts';

export interface SyncResult {
  kind: DictionaryKind;
  key: string;
  status: 'new' | 'changed' | 'unchanged' | 'failed';
  error?: string;
}

export interface District {
  id: number;
  name: string;
}

const SYSTEM_DEVICE_KEY = 'pin_device_key';
const CACHE_TTL_MS = 60_000;

/** What we keep a local copy of: everything needed to validate and map real estate listings. */
function syncTargets(): { kind: DictionaryKind; key: string }[] {
  return [
    { kind: 'tree', key: 'all' },
    { kind: 'regions', key: 'all' },
    ...Object.values(CATEGORIES).map((c) => ({
      kind: 'rubric_form' as const,
      key: String(c.rubric),
    })),
    ...Object.values(REGIONS).map((r) => ({ kind: 'districts' as const, key: String(r.id) })),
  ];
}

export class DictionaryUnavailableError extends ApiError {
  constructor(what: string) {
    super(
      HttpStatus.SERVICE_UNAVAILABLE,
      'dictionary_unavailable',
      `Pin reference data (${what}) is not available yet. Try again later.`,
      undefined,
      { 'retry-after': '60' },
    );
  }
}

/**
 * Local copy of Pin's reference data (rubric tree, regions, districts, rubric forms).
 * Refreshed by the worker; agency requests only ever read the local copy.
 */
@Injectable()
export class DictionariesService {
  private readonly logger = new Logger(DictionariesService.name);
  private readonly cache = new Map<string, { data: unknown; expires: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly pin: PinClient,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Sync (worker / CLI)
  // ---------------------------------------------------------------------------

  /**
   * Fetches every dictionary with Pin Bridge's own device key. If Pin refuses that key, it is
   * renewed once per run (each new key is a new empty user on Pin, so never in a loop). If Pin
   * still refuses, dictionaries apparently need a user token, and the run switches to the
   * credentials of any active connection.
   */
  async syncAll(): Promise<SyncResult[]> {
    let auth: DictionaryAuth = await this.systemDeviceKey();
    let renewed = false;
    let usingConnection = false;
    const results: SyncResult[] = [];
    for (const target of syncTargets()) {
      for (;;) {
        try {
          results.push(await this.syncOne(target.kind, target.key, auth));
          break;
        } catch (error) {
          const refused =
            isPinError(error) &&
            (error.kind === 'missing_device_key' || error.kind === 'unauthorized');
          if (refused && !renewed && !usingConnection) {
            renewed = true;
            auth = await this.systemDeviceKey({ renew: true });
            continue;
          }
          if (refused && !usingConnection) {
            const fallback = await this.connectionAuth();
            if (fallback) {
              usingConnection = true;
              this.logger.warn(
                { connectionId: fallback.connectionId, kind: target.kind },
                'pin refused the system device key for dictionaries; using a connection token',
              );
              auth = fallback.auth;
              continue;
            }
          }
          results.push(this.failed(target, error));
          break;
        }
      }
    }
    this.cache.clear();
    for (const r of results) {
      metrics.dictionarySync.inc({ status: r.status });
    }
    const failed = results.filter((r) => r.status === 'failed');
    this.logger[failed.length ? 'warn' : 'log'](
      { results: results.map((r) => `${r.kind}:${r.key}=${r.status}`) },
      'pin dictionaries synced',
    );
    return results;
  }

  /** Credentials of the most recently updated active connection, if there is one. */
  private async connectionAuth(): Promise<
    { connectionId: string; auth: { deviceKey: string; token: string } } | undefined
  > {
    const connection = await this.prisma.connection.findFirst({
      where: { status: 'active', pinTokenEnc: { not: null }, pinDeviceKeyEnc: { not: null } },
      orderBy: { updatedAt: 'desc' },
    });
    if (!connection?.pinTokenEnc || !connection.pinDeviceKeyEnc) {
      return undefined;
    }
    return {
      connectionId: connection.id,
      auth: {
        deviceKey: this.encryption.decryptString(
          connection.pinDeviceKeyEnc,
          deviceKeyContext(connection.id),
        ),
        token: this.encryption.decryptString(connection.pinTokenEnc, tokenContext(connection.id)),
      },
    };
  }

  private failed(target: { kind: DictionaryKind; key: string }, error: unknown): SyncResult {
    this.logger.error({ ...target, err: error }, 'pin dictionary sync failed');
    return {
      ...target,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  private async syncOne(
    kind: DictionaryKind,
    key: string,
    auth: DictionaryAuth,
  ): Promise<SyncResult> {
    const data = await this.fetch(kind, key, auth);
    if (kind === 'rubric_form') {
      // Fail loudly now rather than at the first agency request.
      parseRubricForm(Number(key), data);
    }
    const dataHash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    const previous = await this.prisma.dictionary.findUnique({
      where: { kind_key: { kind, key } },
    });
    await this.prisma.dictionary.upsert({
      where: { kind_key: { kind, key } },
      create: { kind, key, data: data as Prisma.InputJsonValue, dataHash, fetchedAt: new Date() },
      update: { data: data as Prisma.InputJsonValue, dataHash, fetchedAt: new Date() },
    });
    if (!previous) {
      return { kind, key, status: 'new' };
    }
    if (previous.dataHash === dataHash) {
      return { kind, key, status: 'unchanged' };
    }
    // A changed rubric form can break attribute mapping for agencies: make it visible.
    this.logger.warn({ kind, key }, 'pin dictionary changed');
    await this.audit.record({
      actor: 'system',
      action: 'dictionary.changed',
      target: `${kind}:${key}`,
    });
    return { kind, key, status: 'changed' };
  }

  private fetch(kind: DictionaryKind, key: string, auth: DictionaryAuth): Promise<unknown> {
    switch (kind) {
      case 'tree':
        return this.pin.getRubricTree(auth);
      case 'regions':
        return this.pin.getAllCities(auth);
      case 'rubric_form':
        return this.pin.getRubricForm(auth, Number(key));
      case 'districts':
        return this.pin.getCityDistricts(auth, Number(key));
    }
  }

  /** Device key Pin Bridge itself uses for calls that need no user (dictionaries). */
  async systemDeviceKey(options: { renew?: boolean } = {}): Promise<string> {
    const context = `system_secret:${SYSTEM_DEVICE_KEY}`;
    if (!options.renew) {
      const stored = await this.prisma.systemSecret.findUnique({
        where: { name: SYSTEM_DEVICE_KEY },
      });
      if (stored) {
        return this.encryption.decryptString(stored.valueEnc, context);
      }
    }
    const deviceKey = await this.pin.createDeviceKey();
    const valueEnc = this.encryption.encrypt(deviceKey, context);
    await this.prisma.systemSecret.upsert({
      where: { name: SYSTEM_DEVICE_KEY },
      create: { name: SYSTEM_DEVICE_KEY, valueEnc },
      update: { valueEnc },
    });
    return deviceKey;
  }

  // ---------------------------------------------------------------------------
  // Reads (API)
  // ---------------------------------------------------------------------------

  /** True when every dictionary listing mapping needs has been loaded at least once. */
  async isReady(): Promise<boolean> {
    const targets = syncTargets();
    const stored = await this.prisma.dictionary.count({ where: { OR: targets } });
    return stored === targets.length;
  }

  async raw(
    kind: DictionaryKind,
    key: string,
  ): Promise<{ data: unknown; fetchedAt: Date } | undefined> {
    const row = await this.prisma.dictionary.findUnique({ where: { kind_key: { kind, key } } });
    return row ? { data: row.data, fetchedAt: row.fetchedAt } : undefined;
  }

  private async cached(kind: DictionaryKind, key: string): Promise<unknown> {
    const cacheKey = `${kind}:${key}`;
    const hit = this.cache.get(cacheKey);
    if (hit && hit.expires > Date.now()) {
      return hit.data;
    }
    const row = await this.raw(kind, key);
    if (!row) {
      throw new DictionaryUnavailableError(cacheKey);
    }
    this.cache.set(cacheKey, { data: row.data, expires: Date.now() + CACHE_TTL_MS });
    return row.data;
  }

  async rubricForm(category: Category): Promise<RubricForm> {
    const rubric = CATEGORIES[category].rubric;
    const data = await this.cached('rubric_form', String(rubric));
    try {
      return parseRubricForm(rubric, data);
    } catch (error) {
      if (error instanceof RubricFormParseError) {
        this.logger.error({ rubric }, error.message);
        throw new DictionaryUnavailableError(`rubric_form:${rubric}`);
      }
      throw error;
    }
  }

  async districts(region: Region): Promise<District[]> {
    const data = await this.cached('districts', String(REGIONS[region].id));
    const list = Array.isArray(data) ? data : ((data as { results?: unknown[] })?.results ?? []);
    return list
      .map((d) => d as { id?: unknown; name?: unknown; title?: unknown })
      .filter((d) => typeof d.id === 'number')
      .map((d) => ({ id: d.id as number, name: String(d.name ?? d.title ?? d.id) }));
  }
}
