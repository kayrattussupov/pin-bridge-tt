import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { apiKeyPrefix, generateApiKey, generateSigningSecret, hashApiKey } from '../auth/api-key';
import { validateIpRule } from '../auth/ip-allowlist';
import { AuditService } from '../audit/audit.service';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { EncryptionService } from '../crypto/encryption.service';
import { PrismaService } from '../database/prisma.service';
import type { Agency, AgencyStatus, ApiKey, Prisma } from '../generated/prisma/client';

/** Lowercase slug, used to namespace external_id values sent to Pin. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}$/;
/** Two active keys at once allow rotation without downtime. */
export const MAX_ACTIVE_KEYS = 2;
export const ALL_SCOPES = ['*'] as const;

export class AgencyAdminError extends Error {}

export interface IssuedApiKey {
  apiKey: string;
  signingSecret: string;
  prefix: string;
}

export interface ApiKeyWithAgency extends ApiKey {
  agency: Agency;
}

export const signingSecretContext = (apiKeyId: string) => `api_key:${apiKeyId}:hmac`;

@Injectable()
export class AgenciesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async createAgency(
    input: { name: string; slug: string; ipAllowlist?: string[] },
    actor: string,
  ): Promise<Agency> {
    if (!SLUG_PATTERN.test(input.slug)) {
      throw new AgencyAdminError(`slug must match ${SLUG_PATTERN}`);
    }
    if (!input.name.trim()) {
      throw new AgencyAdminError('name is required');
    }
    const ipAllowlist = this.checkIpRules(input.ipAllowlist ?? []);
    if (await this.prisma.agency.findUnique({ where: { slug: input.slug } })) {
      throw new AgencyAdminError(`agency "${input.slug}" already exists`);
    }
    return this.prisma.$transaction((tx) =>
      this.insertAgency(tx, { name: input.name.trim(), slug: input.slug, ipAllowlist }, actor),
    );
  }

  /** Inserts a validated agency inside the caller's transaction. */
  async insertAgency(
    tx: Prisma.TransactionClient,
    input: { name: string; slug: string; ipAllowlist?: string[] },
    actor: string,
  ): Promise<Agency> {
    const ipAllowlist = input.ipAllowlist ?? [];
    const agency = await tx.agency.create({
      data: { name: input.name, slug: input.slug, ipAllowlist },
    });
    await this.audit.record(
      {
        actor,
        action: 'agency.create',
        agencyId: agency.id,
        target: agency.slug,
        meta: { ipAllowlist },
      },
      tx,
    );
    return agency;
  }

  listAgencies(): Promise<(Agency & { _count: { apiKeys: number } })[]> {
    return this.prisma.agency.findMany({
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { apiKeys: { where: { revokedAt: null } } } } },
    });
  }

  async getBySlug(slug: string): Promise<Agency> {
    const agency = await this.prisma.agency.findUnique({ where: { slug } });
    if (!agency) {
      throw new AgencyAdminError(`agency "${slug}" not found`);
    }
    return agency;
  }

  async setStatus(slug: string, status: AgencyStatus, actor: string): Promise<Agency> {
    const agency = await this.getBySlug(slug);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.agency.update({ where: { id: agency.id }, data: { status } });
      await this.audit.record(
        {
          actor,
          action: `agency.${status === 'active' ? 'activate' : 'suspend'}`,
          agencyId: agency.id,
          target: slug,
        },
        tx,
      );
      return updated;
    });
  }

  async setIpAllowlist(slug: string, rules: string[], actor: string): Promise<Agency> {
    const agency = await this.getBySlug(slug);
    const ipAllowlist = this.checkIpRules(rules);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.agency.update({ where: { id: agency.id }, data: { ipAllowlist } });
      await this.audit.record(
        {
          actor,
          action: 'agency.set_ip_allowlist',
          agencyId: agency.id,
          target: slug,
          meta: { ipAllowlist },
        },
        tx,
      );
      return updated;
    });
  }

  /** The key and signing secret are returned once and never stored in clear. */
  async issueApiKey(
    slug: string,
    actor: string,
    scopes: string[] = [...ALL_SCOPES],
  ): Promise<IssuedApiKey> {
    const agency = await this.getBySlug(slug);
    const active = await this.prisma.apiKey.count({
      where: { agencyId: agency.id, revokedAt: null },
    });
    if (active >= MAX_ACTIVE_KEYS) {
      throw new AgencyAdminError(
        `agency "${slug}" already has ${active} active keys; revoke one before issuing another`,
      );
    }
    return this.prisma.$transaction((tx) => this.insertApiKey(tx, agency.id, actor, scopes));
  }

  /** Creates a key inside the caller's transaction; the caller enforces MAX_ACTIVE_KEYS. */
  async insertApiKey(
    tx: Prisma.TransactionClient,
    agencyId: string,
    actor: string,
    scopes: string[] = [...ALL_SCOPES],
  ): Promise<IssuedApiKey> {
    const { apiKey, prefix } = generateApiKey();
    const signingSecret = generateSigningSecret();
    const id = randomUUID();
    await tx.apiKey.create({
      data: {
        id,
        agencyId,
        keyPrefix: prefix,
        keyHash: hashApiKey(apiKey, this.env.API_KEY_PEPPER),
        hmacSecretEnc: this.encryption.encrypt(signingSecret, signingSecretContext(id)),
        scopes,
      },
    });
    await this.audit.record(
      { actor, action: 'api_key.issue', agencyId, target: prefix, meta: { scopes } },
      tx,
    );
    return { apiKey, signingSecret, prefix };
  }

  listApiKeys(slug: string): Promise<ApiKey[]> {
    return this.prisma.apiKey.findMany({
      where: { agency: { slug } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async revokeApiKey(prefix: string, actor: string): Promise<ApiKey> {
    const key = await this.prisma.apiKey.findUnique({ where: { keyPrefix: prefix } });
    if (!key) {
      throw new AgencyAdminError(`api key "${prefix}" not found`);
    }
    if (key.revokedAt) {
      return key;
    }
    return this.prisma.$transaction(async (tx) => {
      const revoked = await tx.apiKey.update({
        where: { id: key.id },
        data: { revokedAt: new Date() },
      });
      await this.audit.record(
        { actor, action: 'api_key.revoke', agencyId: key.agencyId, target: prefix },
        tx,
      );
      return revoked;
    });
  }

  /** Used by the auth guard: the key row with its agency, if the key is well-formed and known. */
  async findKeyForAuth(apiKey: string): Promise<ApiKeyWithAgency | undefined> {
    const prefix = apiKeyPrefix(apiKey);
    if (!prefix) {
      return undefined;
    }
    const key = await this.prisma.apiKey.findUnique({
      where: { keyPrefix: prefix },
      include: { agency: true },
    });
    return key ?? undefined;
  }

  signingSecretOf(key: ApiKey): string {
    return this.encryption.decryptString(key.hmacSecretEnc, signingSecretContext(key.id));
  }

  /** Throttled so a busy key does not turn every request into a write. */
  async touchApiKey(keyId: string): Promise<void> {
    await this.prisma.apiKey.updateMany({
      where: {
        id: keyId,
        OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(Date.now() - 60_000) } }],
      },
      data: { lastUsedAt: new Date() },
    });
  }

  private checkIpRules(rules: string[]): string[] {
    const cleaned = [...new Set(rules.map((r) => r.trim()).filter(Boolean))];
    const errors = cleaned.map(validateIpRule).filter((e): e is string => Boolean(e));
    if (errors.length) {
      throw new AgencyAdminError(errors.join('; '));
    }
    return cleaned;
  }
}
