import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AgenciesService, AgencyAdminError, SLUG_PATTERN } from '../agencies/agencies.service';
import { generateInviteCode, hashApiKey, invitePrefix, verifyApiKey } from '../auth/api-key';
import { AuditService } from '../audit/audit.service';
import { ApiError } from '../common/api-error';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { PrismaService } from '../database/prisma.service';
import type { Agency, EnrollmentInvite, Prisma } from '../generated/prisma/client';
import { metrics } from '../observability/metrics';
import type { WebhookView } from '../webhooks/webhooks.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { slugCandidates, slugFromName } from './slug';

export const DEFAULT_INVITE_TTL_DAYS = 7;
const MAX_INVITE_TTL_DAYS = 90;
/** How long a redeemed code can be redeemed again with the same client_request_id. */
export const ENROLL_RETRY_WINDOW_MS = 60 * 60 * 1000;

/** createdBy of invites made and redeemed by POST /v1/platform/agencies. */
export const PLATFORM_ACTOR = 'platform';

type RejectReason = 'unknown' | 'revoked' | 'used' | 'agency_inactive' | 'expired';

export interface CreatedInvite {
  code: string;
  prefix: string;
  expiresAt: Date;
}

export interface Enrollment {
  agency: Agency;
  apiKey: string;
  signingSecret: string;
  keyPrefix: string;
  webhook?: WebhookView;
  retried: boolean;
}

/**
 * Self-service onboarding: an operator creates a one-time invite code, the agency's server
 * redeems it once and receives its agency, first API key and (optionally) a webhook endpoint.
 */
@Injectable()
export class EnrollmentService {
  private readonly logger = new Logger(EnrollmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly agencies: AgenciesService,
    private readonly webhooks: WebhooksService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async createInvite(
    input: { name: string; slug?: string; ttlDays?: number },
    actor: string,
  ): Promise<CreatedInvite> {
    const name = input.name.trim();
    if (!name || name.length > 100) {
      throw new AgencyAdminError('name is required (up to 100 characters)');
    }
    if (input.slug !== undefined) {
      if (!SLUG_PATTERN.test(input.slug)) {
        throw new AgencyAdminError(`slug must match ${SLUG_PATTERN}`);
      }
      if (await this.prisma.agency.findUnique({ where: { slug: input.slug } })) {
        throw new AgencyAdminError(`agency "${input.slug}" already exists`);
      }
    }
    const ttlDays = input.ttlDays ?? DEFAULT_INVITE_TTL_DAYS;
    if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > MAX_INVITE_TTL_DAYS) {
      throw new AgencyAdminError(`ttl must be 1-${MAX_INVITE_TTL_DAYS} days`);
    }
    const { code, prefix } = generateInviteCode();
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
    await this.prisma.$transaction(async (tx) => {
      await tx.enrollmentInvite.create({
        data: {
          codePrefix: prefix,
          codeHash: hashApiKey(code, this.env.API_KEY_PEPPER),
          agencyName: name,
          agencySlug: input.slug ?? null,
          expiresAt,
          createdBy: actor,
        },
      });
      await this.audit.record(
        {
          actor,
          action: 'invite.create',
          target: prefix,
          meta: { name, slug: input.slug ?? null, expiresAt: expiresAt.toISOString() },
        },
        tx,
      );
    });
    return { code, prefix, expiresAt };
  }

  listInvites(): Promise<(EnrollmentInvite & { agency: Agency | null })[]> {
    return this.prisma.enrollmentInvite.findMany({
      orderBy: { createdAt: 'asc' },
      include: { agency: true },
    });
  }

  async revokeInvite(prefix: string, actor: string): Promise<EnrollmentInvite> {
    const invite = await this.prisma.enrollmentInvite.findUnique({ where: { codePrefix: prefix } });
    if (!invite) {
      throw new AgencyAdminError(`invite "${prefix}" not found`);
    }
    if (invite.revokedAt) {
      return invite;
    }
    return this.prisma.$transaction(async (tx) => {
      const revoked = await tx.enrollmentInvite.update({
        where: { id: invite.id },
        data: { revokedAt: new Date() },
      });
      await this.audit.record({ actor, action: 'invite.revoke', target: prefix }, tx);
      return revoked;
    });
  }

  /**
   * Redeems an invite. A second call with the same code and client_request_id within
   * ENROLL_RETRY_WINDOW_MS (the first response was lost) revokes the keys issued so far and
   * returns fresh credentials; any other reuse is rejected.
   */
  async redeem(input: {
    code: string;
    clientRequestId: string;
    webhookUrl?: string;
    agencyName?: string;
    ip?: string;
  }): Promise<Enrollment> {
    const prefix = invitePrefix(input.code);
    if (!prefix) {
      return this.reject('malformed', input.ip);
    }
    // Before the transaction, so a bad URL does not use up the code.
    if (input.webhookUrl !== undefined) {
      await this.webhooks.checkUrl(input.webhookUrl);
    }
    const requestHash = hashApiKey(input.clientRequestId, this.env.API_KEY_PEPPER);

    const result = await this.prisma.$transaction(async (tx) => {
      // Serializes concurrent redemptions of the same code.
      await tx.$queryRaw`SELECT id FROM enrollment_invites WHERE code_prefix = ${prefix} FOR UPDATE`;
      const invite = await tx.enrollmentInvite.findUnique({ where: { codePrefix: prefix } });
      if (!invite || !verifyApiKey(input.code, invite.codeHash, this.env.API_KEY_PEPPER)) {
        return { rejected: 'unknown' as const };
      }
      return this.redeemLocked(tx, invite, {
        requestHash,
        agencyName: input.agencyName,
        webhookUrl: input.webhookUrl,
        ip: input.ip,
      });
    });

    if (!result.enrollment) {
      return this.reject(result.rejected, input.ip, prefix);
    }
    metrics.enrollments.inc({ result: result.enrollment.retried ? 'retried' : 'created' });
    return result.enrollment;
  }

  /**
   * Enrollment by the CRM platform (POST /v1/platform/agencies): the agency is its subdomain, so
   * the slug is exact, and the caller must prove it serves that subdomain (DomainProofService,
   * checked by the controller before this). Proving the domain again re-keys an existing
   * platform agency (all earlier keys stop working), so a deployment that lost its keys recovers
   * without an operator. Agencies made by an operator or an invite are never reachable here.
   */
  async provision(input: {
    slug: string;
    name: string;
    clientRequestId: string;
    webhookUrl?: string;
    ip?: string;
  }): Promise<Enrollment> {
    if (input.webhookUrl !== undefined) {
      await this.webhooks.checkUrl(input.webhookUrl);
    }
    const requestHash = hashApiKey(input.clientRequestId, this.env.API_KEY_PEPPER);

    const result = await this.prisma.$transaction(async (tx) => {
      // Serializes concurrent platform enrollments of the same slug.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`platform-enroll:${input.slug}`}))`;
      const agency = await tx.agency.findUnique({ where: { slug: input.slug } });
      let invite: EnrollmentInvite | null;
      if (agency) {
        // Only an agency this path created can be retried; invite or operator agencies never.
        invite = await tx.enrollmentInvite.findFirst({
          where: { agencyId: agency.id, createdBy: PLATFORM_ACTOR },
          orderBy: { createdAt: 'desc' },
        });
        if (!invite) {
          return { rejected: 'used' as const };
        }
        const plainRetry =
          invite.clientRequestHash === requestHash &&
          invite.usedAt !== null &&
          invite.usedAt.getTime() > Date.now() - ENROLL_RETRY_WINDOW_MS;
        if (!plainRetry) {
          // A new, domain-proven request from the agency's own deployment (keys lost, server
          // rebuilt): re-arm the retry for this request id, so it re-keys the agency below.
          invite = await tx.enrollmentInvite.update({
            where: { id: invite.id },
            data: { clientRequestHash: requestHash, usedAt: new Date() },
          });
          await this.audit.record(
            {
              actor: `enroll:${invite.id}`,
              action: 'enrollment.rekey',
              agencyId: agency.id,
              target: invite.codePrefix,
              ip: input.ip,
            },
            tx,
          );
        }
      } else {
        // A one-hour invite that is redeemed right away; its code is never shown to anyone.
        const { code, prefix } = generateInviteCode();
        invite = await tx.enrollmentInvite.create({
          data: {
            codePrefix: prefix,
            codeHash: hashApiKey(code, this.env.API_KEY_PEPPER),
            agencyName: input.name,
            agencySlug: input.slug,
            expiresAt: new Date(Date.now() + ENROLL_RETRY_WINDOW_MS),
            createdBy: PLATFORM_ACTOR,
          },
        });
      }
      return this.redeemLocked(tx, invite, {
        requestHash,
        webhookUrl: input.webhookUrl,
        ip: input.ip,
        exactSlug: true,
      });
    });

    if (result.rejected === 'agency_inactive') {
      throw ApiError.forbidden(`Agency "${input.slug}" is suspended.`);
    }
    if (!result.enrollment) {
      metrics.enrollments.inc({ result: 'agency_exists' });
      this.logger.warn(
        { reason: result.rejected, slug: input.slug, ip: input.ip },
        'platform enrollment rejected',
      );
      throw new ApiError(
        HttpStatus.CONFLICT,
        'agency_exists',
        `Agency "${input.slug}" was not created by the platform and cannot be connected this way.`,
      );
    }
    metrics.enrollments.inc({ result: result.enrollment.retried ? 'retried' : 'created' });
    return result.enrollment;
  }

  /** Redeems an invite row the caller has locked, inside the caller's transaction. */
  private async redeemLocked(
    tx: Prisma.TransactionClient,
    invite: EnrollmentInvite,
    input: {
      requestHash: string;
      agencyName?: string;
      webhookUrl?: string;
      ip?: string;
      /** Use the invite's slug as is; fail instead of picking a free variant. */
      exactSlug?: boolean;
    },
  ): Promise<
    { enrollment: Enrollment; rejected?: never } | { rejected: RejectReason; enrollment?: never }
  > {
    if (invite.revokedAt) {
      return { rejected: 'revoked' };
    }
    const actor = `enroll:${invite.id}`;

    let agency: Agency;
    let retried = false;
    if (invite.usedAt) {
      const retryable =
        invite.agencyId !== null &&
        invite.clientRequestHash === input.requestHash &&
        invite.usedAt.getTime() > Date.now() - ENROLL_RETRY_WINDOW_MS;
      if (!retryable) {
        return { rejected: 'used' };
      }
      const existing = await tx.agency.findUnique({ where: { id: invite.agencyId! } });
      if (!existing || existing.status !== 'active') {
        return { rejected: 'agency_inactive' };
      }
      agency = existing;
      retried = true;
      await this.revokeActiveKeys(tx, agency.id, actor);
    } else {
      if (invite.expiresAt.getTime() <= Date.now()) {
        return { rejected: 'expired' };
      }
      const name = input.agencyName?.trim() || invite.agencyName;
      const slug = input.exactSlug
        ? invite.agencySlug!
        : await this.freeSlug(tx, invite.agencySlug ?? slugFromName(invite.agencyName));
      agency = await this.agencies.insertAgency(tx, { name, slug }, actor);
      await tx.enrollmentInvite.update({
        where: { id: invite.id },
        data: { usedAt: new Date(), clientRequestHash: input.requestHash, agencyId: agency.id },
      });
    }

    const key = await this.agencies.insertApiKey(tx, agency.id, actor);
    const webhook = await this.setUpWebhook(tx, agency.id, input.webhookUrl, retried, actor);
    await this.audit.record(
      {
        actor,
        action: 'enrollment.redeem',
        agencyId: agency.id,
        target: invite.codePrefix,
        ip: input.ip,
        meta: { retried, keyPrefix: key.prefix, webhook: Boolean(webhook), by: invite.createdBy },
      },
      tx,
    );
    return {
      enrollment: {
        agency,
        apiKey: key.apiKey,
        signingSecret: key.signingSecret,
        keyPrefix: key.prefix,
        webhook,
        retried,
      },
    };
  }

  /**
   * New enrollment: create the endpoint when a URL is given. Retry: the caller lost the previous
   * webhook secret too, so an existing endpoint always gets a new one.
   */
  private async setUpWebhook(
    tx: Prisma.TransactionClient,
    agencyId: string,
    url: string | undefined,
    retried: boolean,
    actor: string,
  ): Promise<WebhookView | undefined> {
    const existing = retried ? await tx.webhookEndpoint.findFirst({ where: { agencyId } }) : null;
    const target = url ?? existing?.url;
    if (!target) {
      return undefined;
    }
    const { webhook } = await this.webhooks.upsert(
      tx,
      agencyId,
      { url: target, events: [], rotateSecret: true },
      actor,
    );
    return webhook;
  }

  private async revokeActiveKeys(
    tx: Prisma.TransactionClient,
    agencyId: string,
    actor: string,
  ): Promise<void> {
    const keys = await tx.apiKey.findMany({ where: { agencyId, revokedAt: null } });
    for (const key of keys) {
      await tx.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
      await this.audit.record(
        {
          actor,
          action: 'api_key.revoke',
          agencyId,
          target: key.keyPrefix,
          meta: { reason: 'enrollment_retry' },
        },
        tx,
      );
    }
  }

  private async freeSlug(tx: Prisma.TransactionClient, base: string): Promise<string> {
    for (const slug of slugCandidates(base)) {
      if (!(await tx.agency.findUnique({ where: { slug } }))) {
        return slug;
      }
    }
    return `agency-${randomUUID().slice(0, 8)}`;
  }

  private reject(reason: string, ip?: string, prefix?: string): never {
    metrics.enrollments.inc({ result: 'invalid_invite' });
    this.logger.warn({ reason, ip, prefix }, 'enrollment rejected');
    throw ApiError.invalidInvite();
  }
}
