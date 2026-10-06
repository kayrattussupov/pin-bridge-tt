import { randomUUID } from 'node:crypto';
import { Global, Injectable, Module } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';

export const WEBHOOK_EVENT_TYPES = [
  'listing.synced',
  'listing.failed',
  'listing.status_changed',
  'listing.awaiting_payment',
  'connection.connected',
  'connection.reauth_required',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number] | 'ping';

export interface WebhookEnvelope {
  id: string;
  type: WebhookEventType;
  created_at: string;
  data: unknown;
}

/**
 * Transactional outbox: call `emit` with the same transaction client that changes the state the
 * event describes. Either both are committed or neither, so no event is lost or invented.
 */
@Injectable()
export class WebhookEvents {
  async emit(
    tx: Prisma.TransactionClient,
    agencyId: string,
    type: WebhookEventType,
    data: unknown,
  ): Promise<string | undefined> {
    const endpoints = await tx.webhookEndpoint.findMany({ where: { agencyId, enabled: true } });
    const subscribed = endpoints.filter(
      (e) => type === 'ping' || e.events.length === 0 || e.events.includes(type),
    );
    if (subscribed.length === 0) {
      return undefined;
    }
    const eventId = randomUUID();
    const envelope: WebhookEnvelope = {
      id: eventId,
      type,
      created_at: new Date().toISOString(),
      data,
    };
    await tx.webhookOutbox.createMany({
      data: subscribed.map((endpoint) => ({
        endpointId: endpoint.id,
        eventId,
        event: type,
        payload: envelope as unknown as Prisma.InputJsonValue,
      })),
    });
    return eventId;
  }
}

@Global()
@Module({ providers: [WebhookEvents], exports: [WebhookEvents] })
export class WebhookEventsModule {}
