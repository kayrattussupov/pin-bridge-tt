import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { AgencyContext } from '../auth/agency-context';
import { generateSigningSecret } from '../auth/api-key';
import { ApiError } from '../common/api-error';
import { checkOutboundUrl } from '../common/safe-http';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { EncryptionService } from '../crypto/encryption.service';
import { PrismaService } from '../database/prisma.service';
import type { Prisma, WebhookEndpoint } from '../generated/prisma/client';
import { isPublicAddress } from '../images/ip-safety';
import { webhookSecretContext } from './webhook-dispatcher';
import { WebhookEvents, WebhookEventType } from './webhook-events';

export interface WebhookView {
  url: string;
  events: string[];
  enabled: boolean;
  created_at: string;
  updated_at: string;
  /** Present only when the endpoint is created or the secret rotated. */
  signing_secret?: string;
}

/** One webhook endpoint per agency (PUT replaces it). */
@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly events: WebhookEvents,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async put(
    agency: AgencyContext,
    input: { url: string; events: WebhookEventType[]; rotateSecret: boolean },
  ): Promise<{ created: boolean; webhook: WebhookView }> {
    await this.checkUrl(input.url);
    return this.prisma.$transaction((tx) =>
      this.upsert(tx, agency.agencyId, input, `agency:${agency.agencyId}`),
    );
  }

  /**
   * Creates or replaces the agency's endpoint inside the caller's transaction. The URL must
   * already have passed checkUrl().
   */
  async upsert(
    tx: Prisma.TransactionClient,
    agencyId: string,
    input: { url: string; events: WebhookEventType[]; rotateSecret: boolean },
    actor: string,
  ): Promise<{ created: boolean; webhook: WebhookView }> {
    const existing = await tx.webhookEndpoint.findFirst({ where: { agencyId } });
    const secret = !existing || input.rotateSecret ? generateSigningSecret() : undefined;
    const id = existing?.id ?? randomUUID();
    const secretEnc = secret
      ? this.encryption.encrypt(secret, webhookSecretContext(id))
      : undefined;
    const row = existing
      ? await tx.webhookEndpoint.update({
          where: { id },
          data: {
            url: input.url,
            events: input.events,
            enabled: true,
            ...(secretEnc ? { secretEnc } : {}),
          },
        })
      : await tx.webhookEndpoint.create({
          data: { id, agencyId, url: input.url, events: input.events, secretEnc: secretEnc! },
        });
    await this.audit.record(
      {
        actor,
        action: existing ? (secret ? 'webhook.rotate_secret' : 'webhook.update') : 'webhook.create',
        agencyId,
        target: row.id,
        meta: { url: input.url, events: input.events },
      },
      tx,
    );
    return { created: !existing, webhook: this.view(row, secret) };
  }

  async get(agency: AgencyContext): Promise<WebhookView> {
    return this.view(await this.find(agency));
  }

  async remove(agency: AgencyContext): Promise<void> {
    const endpoint = await this.find(agency);
    await this.prisma.$transaction(async (tx) => {
      await tx.webhookEndpoint.delete({ where: { id: endpoint.id } });
      await this.audit.record(
        {
          actor: `agency:${agency.agencyId}`,
          action: 'webhook.delete',
          agencyId: agency.agencyId,
          target: endpoint.id,
        },
        tx,
      );
    });
  }

  async ping(agency: AgencyContext): Promise<{ event_id: string }> {
    await this.find(agency);
    const eventId = await this.prisma.$transaction((tx) =>
      this.events.emit(tx, agency.agencyId, 'ping', {
        agency: { id: agency.agencyId, slug: agency.agencySlug },
      }),
    );
    return { event_id: eventId! };
  }

  /** Recent deliveries, newest first, for debugging an integration. */
  async deliveries(agency: AgencyContext, limit: number) {
    const endpoint = await this.find(agency);
    const rows = await this.prisma.webhookOutbox.findMany({
      where: { endpointId: endpoint.id },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return {
      data: rows.map((row) => ({
        event_id: row.eventId,
        type: row.event,
        status: row.deliveredAt ? 'delivered' : row.deadAt ? 'dead' : 'pending',
        attempts: row.attempts,
        last_status: row.lastStatus,
        last_error: row.lastError,
        next_attempt_at: row.deliveredAt || row.deadAt ? null : row.nextAttemptAt.toISOString(),
        created_at: row.createdAt.toISOString(),
        delivered_at: row.deliveredAt?.toISOString() ?? null,
      })),
    };
  }

  private async find(agency: AgencyContext): Promise<WebhookEndpoint> {
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { agencyId: agency.agencyId },
    });
    if (!endpoint) {
      throw ApiError.notFound('Webhook');
    }
    return endpoint;
  }

  /** Friendly early check; the dispatcher re-checks every address at delivery time. */
  async checkUrl(raw: string): Promise<void> {
    const allowPrivate = this.env.UNSAFE_ALLOW_PRIVATE_OUTBOUND_HOSTS;
    const fail = (message: string) =>
      new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, 'invalid_webhook_url', message);
    const checked = checkOutboundUrl(raw, allowPrivate);
    if ('problem' in checked) {
      throw fail(
        checked.problem === 'blocked_host'
          ? 'The webhook URL points at a private or local address.'
          : 'The webhook URL must be https, without credentials.',
      );
    }
    if (allowPrivate) {
      return;
    }
    let addresses: { address: string }[];
    try {
      addresses = await lookup(checked.url.hostname, { all: true });
    } catch {
      throw fail(`The host ${checked.url.hostname} cannot be resolved.`);
    }
    if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) {
      throw fail('The webhook URL resolves to a private or local address.');
    }
  }

  private view(endpoint: WebhookEndpoint, secret?: string): WebhookView {
    return {
      url: endpoint.url,
      events: endpoint.events,
      enabled: endpoint.enabled,
      created_at: endpoint.createdAt.toISOString(),
      updated_at: endpoint.updatedAt.toISOString(),
      ...(secret ? { signing_secret: secret } : {}),
    };
  }
}
