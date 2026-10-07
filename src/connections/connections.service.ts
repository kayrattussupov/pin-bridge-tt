import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { AgencyContext } from '../auth/agency-context';
import { ApiError } from '../common/api-error';
import { withRedisLock } from '../common/redis-lock';
import { TokenBucket } from '../common/token-bucket';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { EncryptionService } from '../crypto/encryption.service';
import { PrismaService } from '../database/prisma.service';
import type { Connection } from '../generated/prisma/client';
import { maskPhone } from '../pin/mask';
import { pinErrorToApiError } from '../pin/pin-api-error';
import { PinClient } from '../pin/pin.client';
import { PinError, isPinError } from '../pin/pin.errors';
import type { PinAuth } from '../pin/pin.types';
import { ListingSyncQueue } from '../queue/listing-sync.queue';
import { RedisService } from '../queue/redis.service';
import { WebhookEvents } from '../webhooks/webhook-events';
import { normalizeTtPhone } from './phone';

/** Pin's own limit: 5 SMS requests per device key per 10 minutes. We stop one step earlier. */
const SMS_WINDOW_MS = 10 * 60 * 1000;
const SMS_PER_WINDOW = 5;
/** Used when Pin does not say how long to wait before the next SMS. */
const DEFAULT_SMS_COOLDOWN_SECONDS = 60;
/** Longer than the slowest Pin call (connect + request timeouts), so the lock never lapses mid-call. */
const LOCK_TTL_MS = 90_000;

import { deviceKeyContext, tokenContext } from './secret-contexts';

export { deviceKeyContext, tokenContext };

/** Pin's own credentials for a connected number, as the agency stores them. */
export interface PinCredentials {
  device_key: string;
  token: string;
}

export interface ConnectionView {
  id: string;
  phone: string;
  display_name: string;
  status: Connection['status'];
  resend_after_seconds: number;
  confirm_attempts_left: number | null;
  created_at: string;
  updated_at: string;
}

/** Raised to job code when a connection cannot be used to call Pin. */
export class ConnectionNotActiveError extends Error {
  constructor(
    readonly connectionId: string,
    readonly status: Connection['status'] | 'missing',
  ) {
    super(`connection ${connectionId} is ${status}`);
  }
}

@Injectable()
export class ConnectionsService {
  private readonly logger = new Logger(ConnectionsService.name);
  private readonly bucket: TokenBucket;

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly pin: PinClient,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly listingSync: ListingSyncQueue,
    private readonly events: WebhookEvents,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.bucket = new TokenBucket(redis);
  }

  // ---------------------------------------------------------------------------
  // Agency-facing flow
  // ---------------------------------------------------------------------------

  /**
   * Starts (or restarts) connecting a Pin account. Idempotent for an already active number:
   * returns it without sending another SMS.
   */
  async start(
    agency: AgencyContext,
    input: { phone: string; displayName: string },
  ): Promise<{ connection: ConnectionView; created: boolean; smsSent: boolean }> {
    const phone = this.requireTtPhone(input.phone);
    const existing = await this.prisma.connection.findUnique({
      where: { agencyId_phoneE164: { agencyId: agency.agencyId, phoneE164: phone } },
    });
    const connection = existing
      ? await this.prisma.connection.update({
          where: { id: existing.id },
          data: { displayName: input.displayName },
        })
      : await this.prisma.connection.create({
          data: { agencyId: agency.agencyId, phoneE164: phone, displayName: input.displayName },
        });

    if (connection.status === 'active') {
      return { connection: this.view(connection), created: false, smsSent: false };
    }
    const updated = await this.sendCode(agency, connection);
    return { connection: this.view(updated), created: !existing, smsSent: true };
  }

  async resend(agency: AgencyContext, connectionId: string): Promise<ConnectionView> {
    const connection = await this.findOwned(agency, connectionId);
    if (connection.status === 'active') {
      throw new ApiError(HttpStatus.CONFLICT, 'conflict', 'The connection is already active.');
    }
    return this.view(await this.sendCode(agency, connection));
  }

  /**
   * Submits the SMS code. When this call is the one that activates the connection, the Pin
   * credentials come back once in `pinCredentials`, so the agency can keep its own copy.
   */
  async confirm(
    agency: AgencyContext,
    connectionId: string,
    code: string,
  ): Promise<{ connection: ConnectionView; pinCredentials?: PinCredentials }> {
    const owned = await this.findOwned(agency, connectionId);
    const result = await withRedisLock(
      this.redis,
      this.lockKey(owned.id),
      LOCK_TTL_MS,
      async () => {
        const connection = await this.prisma.connection.findUniqueOrThrow({
          where: { id: owned.id },
        });
        if (connection.status === 'active') {
          return { connection };
        }
        if (connection.status !== 'pending_code' || !connection.pinDeviceKeyEnc) {
          throw new ApiError(
            HttpStatus.CONFLICT,
            'connection_not_active',
            'No code is pending for this connection. Request a new code first.',
          );
        }
        const max = this.env.CONNECTION_MAX_CONFIRM_ATTEMPTS;
        if (connection.confirmAttempts >= max) {
          throw ApiError.tooManyRequests(
            'sms_code_attempts_exceeded',
            'Too many wrong codes. Request a new code.',
            this.secondsUntil(connection.smsCooldownUntil),
          );
        }
        // Per phone number across every agency and every resent code, so a malicious agency
        // cannot keep guessing someone's code by requesting new SMS.
        const wrongKey = `pin-bridge:sms-wrong-codes:${connection.phoneE164}`;
        const wrongSoFar = Number((await this.redis.get(wrongKey)) ?? 0);
        if (wrongSoFar >= this.env.CONNECTION_MAX_WRONG_CODES_PER_DAY) {
          this.logger.warn(
            { connectionId: connection.id, phone: maskPhone(connection.phoneE164) },
            'sms code guessing limit reached',
          );
          throw ApiError.tooManyRequests(
            'sms_code_attempts_exceeded',
            'Too many wrong codes for this number. Try again tomorrow.',
            Math.max(60, await this.redis.ttl(wrongKey)),
          );
        }
        // Counted before calling Pin, so a crash or timeout cannot hand out free guesses.
        const counted = await this.prisma.connection.update({
          where: { id: connection.id },
          data: { confirmAttempts: { increment: 1 } },
        });
        const deviceKey = this.encryption.decryptString(
          connection.pinDeviceKeyEnc,
          deviceKeyContext(connection.id),
        );

        let token: string;
        try {
          token = await this.pin.confirmSmsCode(deviceKey, connection.phoneE164, code);
        } catch (error) {
          if (isPinError(error) && error.kind === 'validation') {
            await this.redis
              .multi()
              .incr(wrongKey)
              .expire(wrongKey, 24 * 3600, 'NX')
              .exec();
            throw new ApiError(
              HttpStatus.UNPROCESSABLE_ENTITY,
              'invalid_code',
              'The code is wrong or expired.',
              {
                confirm_attempts_left: Math.max(0, max - counted.confirmAttempts),
                pin_errors: error.pinErrors,
              },
            );
          }
          throw this.translate(error);
        }

        await this.redis.del(wrongKey);
        const active = await this.activate(agency, connection.id, token);
        return { connection: active, issued: { device_key: deviceKey, token } };
      },
    );
    if (!result.acquired) {
      throw this.busy();
    }
    const { connection, issued } = result.value;
    if (issued) {
      await this.recordPinUserId(connection.id, {
        deviceKey: issued.device_key,
        token: issued.token,
      });
      await this.resumeListings(connection.id);
    }
    return { connection: this.view(connection), pinCredentials: issued };
  }

  async get(agency: AgencyContext, connectionId: string): Promise<ConnectionView> {
    return this.view(await this.findOwned(agency, connectionId));
  }

  async list(agency: AgencyContext): Promise<ConnectionView[]> {
    const rows = await this.prisma.connection.findMany({
      where: { agencyId: agency.agencyId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.view(row));
  }

  /** Stops publishing for this account and forgets its Pin credentials. */
  async disable(agency: AgencyContext, connectionId: string): Promise<ConnectionView> {
    const connection = await this.findOwned(agency, connectionId);
    const disabled = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.connection.update({
        where: { id: connection.id },
        data: { status: 'disabled', pinTokenEnc: null, pinDeviceKeyEnc: null, confirmAttempts: 0 },
      });
      await this.audit.record(
        {
          actor: `agency:${agency.agencyId}`,
          action: 'connection.disabled',
          agencyId: agency.agencyId,
          target: connection.id,
        },
        tx,
      );
      return updated;
    });
    return this.view(disabled);
  }

  // ---------------------------------------------------------------------------
  // For background jobs
  // ---------------------------------------------------------------------------

  /** Decrypted Pin credentials of an active connection. */
  async authFor(connectionId: string): Promise<PinAuth> {
    const connection = await this.prisma.connection.findUnique({ where: { id: connectionId } });
    if (!connection) {
      throw new ConnectionNotActiveError(connectionId, 'missing');
    }
    if (connection.status !== 'active' || !connection.pinTokenEnc || !connection.pinDeviceKeyEnc) {
      throw new ConnectionNotActiveError(connectionId, connection.status);
    }
    return {
      deviceKey: this.encryption.decryptString(
        connection.pinDeviceKeyEnc,
        deviceKeyContext(connectionId),
      ),
      token: this.encryption.decryptString(connection.pinTokenEnc, tokenContext(connectionId)),
    };
  }

  /**
   * Stores which Pin account the connection's token belongs to (once, while it is unknown) and
   * warns when another active connection uses the same account. Best effort: a failure here never
   * blocks connecting or publishing.
   */
  async recordPinUserId(connectionId: string, auth?: PinAuth): Promise<void> {
    try {
      const connection = await this.prisma.connection.findUnique({ where: { id: connectionId } });
      if (!connection || connection.pinUserId) {
        return;
      }
      const pinUserId = await this.pin.getProfileId(auth ?? (await this.authFor(connectionId)));
      await this.prisma.connection.update({ where: { id: connectionId }, data: { pinUserId } });
      const shared = await this.prisma.connection.findMany({
        where: { pinUserId, status: 'active', id: { not: connectionId } },
        select: { id: true, agencyId: true },
      });
      if (shared.length) {
        this.logger.warn(
          { connectionId, pinUserId, sharedWith: shared },
          'pin account is connected more than once',
        );
      }
    } catch (error) {
      this.logger.warn({ connectionId, err: error }, 'could not read the pin account id');
    }
  }

  /**
   * Pin rejected the token (forced logout). Publishing for this account pauses until the agency
   * runs the SMS flow again. Returns true if the status actually changed.
   */
  async markReauthRequired(connectionId: string, reason: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.connection.updateMany({
        where: { id: connectionId, status: 'active' },
        data: { status: 'reauth_required', pinTokenEnc: null },
      });
      if (count > 0) {
        const connection = await tx.connection.findUniqueOrThrow({ where: { id: connectionId } });
        await this.audit.record(
          {
            actor: 'system',
            action: 'connection.reauth_required',
            agencyId: connection.agencyId,
            target: connectionId,
            meta: { reason },
          },
          tx,
        );
        await this.events.emit(tx, connection.agencyId, 'connection.reauth_required', {
          connection: this.view(connection),
          reason,
        });
      }
      return count > 0;
    });
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private requireTtPhone(raw: string): string {
    const phone = normalizeTtPhone(raw);
    if (!phone) {
      throw new ApiError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'invalid_phone',
        'Pin accepts Trinidad and Tobago numbers only, e.g. +1 868 123 4567.',
      );
    }
    return phone;
  }

  /** Marks a connection active with the token Pin issued for the SMS code. */
  private activate(
    agency: AgencyContext,
    connectionId: string,
    token: string,
  ): Promise<Connection> {
    return this.prisma.$transaction(async (tx) => {
      const active = await tx.connection.update({
        where: { id: connectionId },
        data: {
          status: 'active',
          pinTokenEnc: this.encryption.encrypt(token, tokenContext(connectionId)),
          confirmAttempts: 0,
        },
      });
      await this.audit.record(
        {
          actor: `agency:${agency.agencyId}`,
          action: 'connection.connected',
          agencyId: agency.agencyId,
          target: connectionId,
          // The confirm response hands the agency its copy of the Pin credentials.
          meta: { phone: maskPhone(active.phoneE164), credentialsIssued: true },
        },
        tx,
      );
      await this.events.emit(tx, agency.agencyId, 'connection.connected', {
        connection: this.view(active),
      });
      return active;
    });
  }

  /** Listings that waited for this account (new, or paused by a forced logout) go out now. */
  private async resumeListings(connectionId: string): Promise<void> {
    const resumed = await this.listingSync.enqueueForConnection(connectionId);
    if (resumed) {
      this.logger.log({ connectionId, resumed }, 'resumed listings after connect');
    }
  }

  private async sendCode(agency: AgencyContext, owned: Connection): Promise<Connection> {
    const result = await withRedisLock(
      this.redis,
      this.lockKey(owned.id),
      LOCK_TTL_MS,
      async () => {
        const connection = await this.prisma.connection.findUniqueOrThrow({
          where: { id: owned.id },
        });
        const now = Date.now();
        const cooldown = this.secondsUntil(connection.smsCooldownUntil);
        if (cooldown > 0) {
          throw ApiError.tooManyRequests(
            'sms_rate_limited',
            'A code was sent recently. Wait before requesting another.',
            cooldown,
          );
        }
        const recent = connection.smsRequestsWindow.filter(
          (t) => now - t.getTime() < SMS_WINDOW_MS,
        );
        if (recent.length >= SMS_PER_WINDOW) {
          const oldest = Math.min(...recent.map((t) => t.getTime()));
          throw ApiError.tooManyRequests(
            'sms_rate_limited',
            'Too many codes requested for this number. Try again later.',
            (oldest + SMS_WINDOW_MS - now) / 1000,
          );
        }
        const perHour = this.env.CONNECTION_SMS_PER_AGENCY_PER_HOUR;
        const wait = await this.bucket.take(
          `pin-bridge:sms-rate-limit:${agency.agencyId}`,
          perHour / 3600,
          perHour,
        );
        if (wait > 0) {
          throw ApiError.tooManyRequests(
            'sms_rate_limited',
            'This agency requested too many codes in the last hour.',
            wait / 1000,
          );
        }

        const deviceKey = await this.deviceKeyFor(connection);
        const recordSend = (cooldownSeconds: number) =>
          this.prisma.connection.update({
            where: { id: connection.id },
            data: {
              status: 'pending_code',
              pinTokenEnc: null,
              confirmAttempts: 0,
              smsRequestsWindow: [...recent, new Date(now)],
              smsCooldownUntil: new Date(now + cooldownSeconds * 1000),
            },
          });

        try {
          const { retryAfterSeconds } = await this.pin.requestSmsCode(
            deviceKey,
            connection.phoneE164,
          );
          this.logger.log(
            { connectionId: connection.id, phone: maskPhone(connection.phoneE164) },
            'sms code requested',
          );
          return await recordSend(retryAfterSeconds ?? DEFAULT_SMS_COOLDOWN_SECONDS);
        } catch (error) {
          if (!isPinError(error)) {
            throw error;
          }
          if (
            error.kind === 'validation' &&
            error.smsRetryAfterSeconds !== undefined &&
            error.smsRetryAfterSeconds > 0
          ) {
            await this.prisma.connection.update({
              where: { id: connection.id },
              data: { smsCooldownUntil: new Date(now + error.smsRetryAfterSeconds * 1000) },
            });
            throw ApiError.tooManyRequests(
              'sms_rate_limited',
              'Pin asks to wait before requesting another code.',
              error.smsRetryAfterSeconds,
            );
          }
          if (error.kind === 'validation') {
            throw new ApiError(
              HttpStatus.UNPROCESSABLE_ENTITY,
              'invalid_phone',
              'Pin did not accept this phone number.',
              {
                pin_errors: error.pinErrors,
              },
            );
          }
          if (error.outcomeUnknown) {
            // The SMS may have gone out; count it so a retry cannot double-send or exceed Pin's limit.
            await recordSend(DEFAULT_SMS_COOLDOWN_SECONDS);
          }
          throw this.translate(error);
        }
      },
    );
    if (!result.acquired) {
      throw this.busy();
    }
    return result.value;
  }

  /** One Pin device key per connection, so each number has its own SMS limit at Pin. */
  private async deviceKeyFor(connection: Connection): Promise<string> {
    if (connection.pinDeviceKeyEnc) {
      return this.encryption.decryptString(
        connection.pinDeviceKeyEnc,
        deviceKeyContext(connection.id),
      );
    }
    let deviceKey: string;
    try {
      deviceKey = await this.pin.createDeviceKey();
    } catch (error) {
      throw this.translate(error);
    }
    await this.prisma.connection.update({
      where: { id: connection.id },
      data: {
        pinDeviceKeyEnc: this.encryption.encrypt(deviceKey, deviceKeyContext(connection.id)),
      },
    });
    return deviceKey;
  }

  async findOwned(agency: AgencyContext, connectionId: string): Promise<Connection> {
    // Unknown ids and other agencies' ids look the same: 404.
    const connection = /^[0-9a-f-]{36}$/i.test(connectionId)
      ? await this.prisma.connection.findFirst({
          where: { id: connectionId, agencyId: agency.agencyId },
        })
      : null;
    if (!connection) {
      throw ApiError.notFound('Connection');
    }
    return connection;
  }

  private translate(error: unknown): unknown {
    return error instanceof PinError ? pinErrorToApiError(error) : error;
  }

  private busy(): ApiError {
    return new ApiError(
      HttpStatus.CONFLICT,
      'connection_busy',
      'Another request for this connection is in progress. Retry in a moment.',
    );
  }

  private lockKey(connectionId: string): string {
    return `pin-bridge:lock:connection:${connectionId}`;
  }

  private secondsUntil(date: Date | null): number {
    return date ? Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000)) : 0;
  }

  view(connection: Connection): ConnectionView {
    return {
      id: connection.id,
      phone: connection.phoneE164,
      display_name: connection.displayName,
      status: connection.status,
      resend_after_seconds: this.secondsUntil(connection.smsCooldownUntil),
      confirm_attempts_left:
        connection.status === 'pending_code'
          ? Math.max(0, this.env.CONNECTION_MAX_CONFIRM_ATTEMPTS - connection.confirmAttempts)
          : null,
      created_at: connection.createdAt.toISOString(),
      updated_at: connection.updatedAt.toISOString(),
    };
  }
}
