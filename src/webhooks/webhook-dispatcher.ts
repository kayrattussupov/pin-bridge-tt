import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Dispatcher, request } from 'undici';
import {
  BLOCKED_HOST_CODE,
  checkOutboundUrl,
  createSafeDispatcher,
  errorCodeOf,
} from '../common/safe-http';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { EncryptionService } from '../crypto/encryption.service';
import { metrics } from '../observability/metrics';
import { PrismaService } from '../database/prisma.service';
import type { WebhookEndpoint, WebhookOutbox } from '../generated/prisma/client';
import { signWebhook, webhookRetryDelayMs } from './webhook-signature';

export const webhookSecretContext = (endpointId: string) => `webhook:${endpointId}:secret`;

const BATCH = 50;
const PARALLEL = 10;
/** A claimed row is invisible to other workers this long (longer than one delivery). */
const LEASE_SECONDS = 120;
const KEEP_DELIVERED_DAYS = 7;
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface DispatchResult {
  delivered: number;
  failed: number;
  dead: number;
}

/**
 * Delivers outbox rows. Rows are claimed with FOR UPDATE SKIP LOCKED, so any number of workers can
 * dispatch without sending an event twice at the same time. Delivery is at-least-once: receivers
 * de-duplicate by the event `id`.
 */
@Injectable()
export class WebhookDispatcher implements OnModuleDestroy {
  private readonly logger = new Logger(WebhookDispatcher.name);
  private readonly dispatcher: Dispatcher;

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.dispatcher = createSafeDispatcher({
      allowPrivateHosts: env.UNSAFE_ALLOW_PRIVATE_OUTBOUND_HOSTS,
      connectTimeoutMs: env.WEBHOOK_TIMEOUT_MS,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.dispatcher.close();
  }

  async dispatchDue(): Promise<DispatchResult> {
    const claimed = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE webhook_outbox
         SET next_attempt_at = now() + make_interval(secs => ${LEASE_SECONDS})
       WHERE id IN (
         SELECT id FROM webhook_outbox
          WHERE delivered_at IS NULL AND dead_at IS NULL AND next_attempt_at <= now()
          ORDER BY next_attempt_at
          LIMIT ${BATCH}
          FOR UPDATE SKIP LOCKED)
      RETURNING id`;
    const result: DispatchResult = { delivered: 0, failed: 0, dead: 0 };
    if (claimed.length) {
      const rows = await this.prisma.webhookOutbox.findMany({
        where: { id: { in: claimed.map((r) => r.id) } },
        include: { endpoint: true },
        orderBy: { createdAt: 'asc' },
      });
      for (let i = 0; i < rows.length; i += PARALLEL) {
        const outcomes = await Promise.all(
          rows.slice(i, i + PARALLEL).map((row) => this.deliver(row)),
        );
        for (const outcome of outcomes) {
          result[outcome] += 1;
          metrics.webhookDeliveries.inc({ outcome });
        }
      }
    }
    await this.prisma.$executeRaw`
      DELETE FROM webhook_outbox WHERE id IN (
        SELECT id FROM webhook_outbox
         WHERE delivered_at < now() - make_interval(days => ${KEEP_DELIVERED_DAYS})
         LIMIT 500)`;
    return result;
  }

  private async deliver(
    row: WebhookOutbox & { endpoint: WebhookEndpoint },
  ): Promise<keyof DispatchResult> {
    const attempts = row.attempts + 1;
    if (!row.endpoint.enabled) {
      await this.prisma.webhookOutbox.update({
        where: { id: row.id },
        data: { deadAt: new Date(), lastError: 'endpoint disabled' },
      });
      return 'dead';
    }

    const body = JSON.stringify(row.payload);
    let status: number | undefined;
    let error: string | undefined;
    const checked = checkOutboundUrl(
      row.endpoint.url,
      this.env.UNSAFE_ALLOW_PRIVATE_OUTBOUND_HOSTS,
    );
    if ('problem' in checked) {
      error = `webhook URL refused: ${checked.problem}`;
    } else {
      const secret = this.encryption.decryptString(
        row.endpoint.secretEnc,
        webhookSecretContext(row.endpoint.id),
      );
      try {
        const res = await request(checked.url, {
          method: 'POST',
          dispatcher: this.dispatcher,
          signal: AbortSignal.timeout(this.env.WEBHOOK_TIMEOUT_MS),
          headers: {
            'content-type': 'application/json',
            'user-agent': 'PinBridge-Webhooks/1',
            'x-pinbridge-event': row.event,
            'x-pinbridge-event-id': row.eventId,
            'x-pinbridge-delivery': row.id,
            'x-pinbridge-signature': signWebhook(secret, body),
          },
          // undici's request() does not follow redirects, so a 3xx counts as a failed delivery.
          body,
        });
        status = res.statusCode;
        await this.drain(res.body);
        if (status < 200 || status >= 300) {
          error = `HTTP ${status}`;
        }
      } catch (e) {
        error =
          errorCodeOf(e) === BLOCKED_HOST_CODE
            ? 'webhook host resolves to a non-public address'
            : `delivery failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    if (!error) {
      await this.prisma.webhookOutbox.update({
        where: { id: row.id },
        data: { deliveredAt: new Date(), attempts, lastStatus: status ?? null, lastError: null },
      });
      return 'delivered';
    }

    const next = new Date(
      Date.now() + webhookRetryDelayMs(attempts, this.env.WEBHOOK_RETRY_BASE_MS),
    );
    const expired = next.getTime() > row.createdAt.getTime() + this.env.WEBHOOK_MAX_AGE_MS;
    await this.prisma.webhookOutbox.update({
      where: { id: row.id },
      data: {
        attempts,
        lastStatus: status ?? null,
        lastError: error.slice(0, 500),
        ...(expired ? { deadAt: new Date() } : { nextAttemptAt: next }),
      },
    });
    if (expired) {
      this.logger.warn(
        { outboxId: row.id, endpointId: row.endpointId, event: row.event, attempts },
        'webhook dead',
      );
      return 'dead';
    }
    return 'failed';
  }

  private async drain(body: Dispatcher.ResponseData['body']): Promise<void> {
    let size = 0;
    for await (const chunk of body) {
      size += (chunk as Buffer).length;
      if (size > MAX_RESPONSE_BYTES) {
        body.destroy();
        return;
      }
    }
  }
}
