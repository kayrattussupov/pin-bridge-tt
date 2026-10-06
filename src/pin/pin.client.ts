import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { FormData } from 'undici';
import { z, type ZodType } from 'zod';
import { CircuitBreaker, CircuitBreakerOptions } from './circuit-breaker';
import { classifyResponse, classifyTransportError } from './classify';
import { PinError, isPinError } from './pin.errors';
import { PinTransport, TransportOptions, TransportRequest } from './pin-transport';
import {
  CreateItemPayload,
  PinAuth,
  PinItem,
  PinItemList,
  UploadPictureInput,
  deviceKeySchema,
  phoneVerifyConfirmSchema,
  phoneVerifyRequestSchema,
  picSchema,
  pinItemListSchema,
  pinItemSchema,
} from './pin.types';
import { metrics } from '../observability/metrics';
import { RateLimiter, RateLimiterOptions } from './rate-limiter';
import { BackoffOptions, RetryPolicy, retryDelayMs, shouldRetry, sleep } from './retry';

export interface PinClientOptions {
  transport: TransportOptions;
  requestTimeoutMs: number;
  uploadTimeoutMs: number;
  breaker: CircuitBreakerOptions;
  rateLimit: RateLimiterOptions;
  backoff: BackoffOptions;
}

export interface PinLogger {
  debug(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

interface CallSpec<T> {
  /** Stable name for logs and metrics, e.g. `items.create`. */
  endpoint: string;
  method: TransportRequest['method'];
  path: string;
  query?: TransportRequest['query'];
  json?: unknown;
  form?: () => FormData;
  deviceKey?: string;
  token?: string;
  timeoutMs?: number;
  retry: RetryPolicy;
  /** False when resending could apply the call twice (create, toggle, SMS). */
  idempotent: boolean;
  statusEnvelope?: boolean;
  schema: ZodType<T>;
}

const anyJson = z.unknown();

/**
 * `+18681234567` → `+1 868 123 4567`, the format verified against prod phone_verify (06.10).
 * Pin Bridge stores E.164; anything else is passed through unchanged.
 */
export const toPinPhone = (phone: string): string => {
  const match = /^\+1868(\d{3})(\d{4})$/.exec(phone);
  return match ? `+1 868 ${match[1]} ${match[2]}` : phone;
};

/** Dictionaries need only a device key; a connection's full auth is the fallback. */
export type DictionaryAuth = string | PinAuth;

/** `{uuid: 'x', n: 1}` → `{uuid: 'string', n: 'number'}`; never includes values. */
const shapeOf = (body: unknown): unknown => {
  if (Array.isArray(body)) {
    return `array(${body.length})`;
  }
  if (body && typeof body === 'object') {
    return Object.fromEntries(
      Object.entries(body).map(([k, v]) => [
        k,
        v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v,
      ]),
    );
  }
  return typeof body;
};

/**
 * The only component allowed to talk to pin.tt. Every call goes:
 * circuit breaker → global rate limit → HTTP → classification → (safe) retry.
 * Credentials never reach the logs; phone numbers are not logged by this class at all.
 */
export class PinClient {
  private readonly transport: PinTransport;
  private readonly breaker: CircuitBreaker;
  private readonly limiter: RateLimiter;

  constructor(
    private readonly options: PinClientOptions,
    redis: Redis,
    private readonly logger: PinLogger = new Logger('PinClient') as unknown as PinLogger,
  ) {
    this.transport = new PinTransport(options.transport);
    this.breaker = new CircuitBreaker(redis, options.breaker);
    this.limiter = new RateLimiter(redis, options.rateLimit);
  }

  get circuitBreaker(): CircuitBreaker {
    return this.breaker;
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  // ---------------------------------------------------------------------------
  // Device key and phone_verify (one-time account connection)
  // ---------------------------------------------------------------------------

  /** The only endpoint Pin serves without a Device-Api-Key. Extra keys are harmless. */
  async createDeviceKey(): Promise<string> {
    const body = await this.call({
      endpoint: 'items.device_api_key',
      method: 'POST',
      path: '/items/device_api_key/',
      json: {},
      retry: 'safe',
      idempotent: true,
      schema: deviceKeySchema,
    });
    return body.uuid;
  }

  /**
   * Sends the SMS code. Pin allows 5 requests per device key per 10 minutes; the response
   * (and the `validation` error on refusal) carries `end_date`, seconds until the next request.
   */
  async requestSmsCode(deviceKey: string, phone: string): Promise<{ retryAfterSeconds?: number }> {
    const body = await this.call({
      endpoint: 'users.phone_verify.request',
      method: 'GET',
      path: '/users/phone_verify/',
      query: { phone: toPinPhone(phone), check_type: 'sms' },
      deviceKey,
      retry: 'none',
      idempotent: false,
      statusEnvelope: true,
      schema: phoneVerifyRequestSchema,
    });
    const seconds = body.end_date === '' ? undefined : Number(body.end_date);
    return { retryAfterSeconds: Number.isFinite(seconds) ? seconds : undefined };
  }

  /** Exchanges the SMS code for the user token. Pin creates the user on first success. */
  async confirmSmsCode(deviceKey: string, phone: string, code: string): Promise<string> {
    const body = await this.call({
      endpoint: 'users.phone_verify.confirm',
      method: 'POST',
      path: '/users/phone_verify/',
      // token=1 is what makes Pin return the token at all.
      query: { token: 1 },
      json: { phone: toPinPhone(phone), code, check_type: 'sms' },
      deviceKey,
      retry: 'none',
      idempotent: false,
      statusEnvelope: true,
      schema: phoneVerifyConfirmSchema,
    });
    return body.token;
  }

  // ---------------------------------------------------------------------------
  // Items
  // ---------------------------------------------------------------------------

  /** Uploads one picture; returns the id to put into `images`. A re-upload only leaves an orphan. */
  async uploadPicture(auth: PinAuth, input: UploadPictureInput): Promise<string> {
    const body = await this.call({
      endpoint: 'items.pics',
      method: 'POST',
      path: '/items/pics/',
      form: () => {
        const form = new FormData();
        form.append('img', new Blob([input.data], { type: input.contentType }), input.filename);
        return form;
      },
      ...this.authOf(auth),
      timeoutMs: this.options.uploadTimeoutMs,
      retry: 'safe',
      idempotent: true,
      schema: picSchema,
    });
    return body.id;
  }

  /** Dry run: throws `validation` with Pin's field errors, creates nothing. */
  async validateAd(auth: PinAuth, payload: CreateItemPayload): Promise<unknown> {
    return this.call({
      endpoint: 'items.validate_ad',
      method: 'POST',
      path: '/items/validate_ad/',
      json: payload,
      ...this.authOf(auth),
      retry: 'safe',
      idempotent: true,
      schema: anyJson,
    });
  }

  /**
   * Not retried here: on `timeout`/`network` with `outcomeUnknown`, the caller must look the
   * item up by external_id in `listMyItems` before creating it again.
   */
  async createItem(auth: PinAuth, payload: CreateItemPayload): Promise<PinItem> {
    return this.call({
      endpoint: 'items.create',
      method: 'POST',
      path: '/items/',
      json: payload,
      ...this.authOf(auth),
      retry: 'none',
      idempotent: false,
      schema: pinItemSchema,
    });
  }

  /** Full edit; sending the same body twice gives the same result. */
  async updateItem(auth: PinAuth, itemId: string, payload: CreateItemPayload): Promise<PinItem> {
    return this.call({
      endpoint: 'items.update',
      method: 'POST',
      path: `/items/${encodeURIComponent(itemId)}/`,
      json: payload,
      ...this.authOf(auth),
      retry: 'safe',
      idempotent: true,
      schema: pinItemSchema,
    });
  }

  async partialUpdateItem(
    auth: PinAuth,
    itemId: string,
    patch: Partial<CreateItemPayload>,
  ): Promise<PinItem> {
    return this.call({
      endpoint: 'items.partial_update',
      method: 'PATCH',
      path: `/items/${encodeURIComponent(itemId)}/partial_update/`,
      json: patch,
      ...this.authOf(auth),
      retry: 'safe',
      idempotent: true,
      schema: pinItemSchema,
    });
  }

  /** Flips published/hidden. Not idempotent: check the current status before calling. */
  async toggleActive(auth: PinAuth, itemId: string): Promise<unknown> {
    return this.call({
      endpoint: 'items.toggle_active',
      method: 'POST',
      path: `/items/toggle_active/${encodeURIComponent(itemId)}/`,
      ...this.authOf(auth),
      retry: 'none',
      idempotent: false,
      schema: anyJson,
    });
  }

  async removeItem(auth: PinAuth, itemId: string): Promise<unknown> {
    return this.call({
      endpoint: 'items.to_remove',
      method: 'POST',
      path: `/items/to_remove/${encodeURIComponent(itemId)}/`,
      ...this.authOf(auth),
      retry: 'none',
      idempotent: false,
      schema: anyJson,
    });
  }

  /** Items of the token's user with their moderation status and not_paid flag. */
  async listMyItems(auth: PinAuth, options: { page?: number } = {}): Promise<PinItemList> {
    return this.call({
      endpoint: 'items.front_my',
      method: 'GET',
      path: '/items/front_my/',
      query: { page: options.page },
      ...this.authOf(auth),
      retry: 'safe',
      idempotent: true,
      schema: pinItemListSchema,
    });
  }

  // ---------------------------------------------------------------------------
  // Dictionaries (a Device-Api-Key is enough so far; a user token is accepted too)
  // ---------------------------------------------------------------------------

  async getRubricTree(auth: DictionaryAuth): Promise<unknown> {
    return this.dictionary('items.tree_v2', '/items/tree_v2/', auth);
  }

  async getRubricForm(auth: DictionaryAuth, rubricId: number): Promise<unknown> {
    return this.dictionary('items.rubric_form', `/items/rubric_form/${rubricId}/`, auth);
  }

  async getAllCities(auth: DictionaryAuth): Promise<unknown> {
    return this.dictionary('items.all_cities', '/items/all_cities/', auth);
  }

  async getCityDistricts(auth: DictionaryAuth, cityId: number): Promise<unknown> {
    return this.dictionary('items.city_districts', `/items/city_districts/${cityId}/`, auth);
  }

  private dictionary(endpoint: string, path: string, auth: DictionaryAuth): Promise<unknown> {
    return this.call({
      endpoint,
      method: 'GET',
      path,
      ...(typeof auth === 'string' ? { deviceKey: auth } : this.authOf(auth)),
      retry: 'safe',
      idempotent: true,
      schema: anyJson,
    });
  }

  private authOf(auth: PinAuth): { deviceKey: string; token: string } {
    return { deviceKey: auth.deviceKey, token: auth.token };
  }

  // ---------------------------------------------------------------------------
  // Pipeline
  // ---------------------------------------------------------------------------

  private async call<T>(spec: CallSpec<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.attempt(spec, attempt);
      } catch (error) {
        if (!isPinError(error) || !shouldRetry(error, spec.retry, attempt, this.options.backoff)) {
          throw error;
        }
        const delay = retryDelayMs(error, attempt, this.options.backoff);
        this.logger.warn(
          { endpoint: spec.endpoint, attempt, kind: error.kind, retryInMs: delay },
          'pin call failed, retrying',
        );
        await sleep(delay);
      }
    }
  }

  private async attempt<T>(spec: CallSpec<T>, attempt: number): Promise<T> {
    let ticket;
    try {
      ticket = await this.breaker.beforeRequest(spec.endpoint);
      await this.limiter.acquire(spec.endpoint);
    } catch (error) {
      if (isPinError(error)) {
        metrics.pinRequests.inc({ endpoint: spec.endpoint, outcome: error.kind });
      }
      throw error;
    }

    const headers: Record<string, string> = {};
    if (spec.deviceKey) {
      headers['device-api-key'] = spec.deviceKey;
    }
    if (spec.token) {
      headers.authorization = `Token ${spec.token}`;
    }

    const started = performance.now();
    const result = await this.transport.send({
      method: spec.method,
      path: spec.path,
      query: spec.query,
      json: spec.json,
      form: spec.form?.(),
      headers,
      timeoutMs: spec.timeoutMs ?? this.options.requestTimeoutMs,
    });
    const durationMs = Math.round(performance.now() - started);
    metrics.pinDuration.observe({ endpoint: spec.endpoint }, durationMs / 1000);

    let error: PinError | undefined;
    if (!result.response) {
      error = classifyTransportError(result.error, {
        endpoint: spec.endpoint,
        idempotent: spec.idempotent,
        timedOut: result.timedOut,
      });
    } else {
      error = classifyResponse(result.response, {
        endpoint: spec.endpoint,
        sentDeviceKey: Boolean(spec.deviceKey),
        sentToken: Boolean(spec.token),
        statusEnvelope: spec.statusEnvelope ?? false,
      });
    }

    metrics.pinRequests.inc({ endpoint: spec.endpoint, outcome: error?.kind ?? 'ok' });
    if (error) {
      await (error.isUpstreamFailure
        ? this.breaker.recordFailure(ticket)
        : this.breaker.recordSuccess(ticket));
      this.logger.warn(
        {
          endpoint: spec.endpoint,
          attempt,
          durationMs,
          httpStatus: error.httpStatus,
          kind: error.kind,
          outcomeUnknown: error.outcomeUnknown,
          pinErrors: error.pinErrors,
        },
        'pin call failed',
      );
      throw error;
    }

    await this.breaker.recordSuccess(ticket);
    const parsed = spec.schema.safeParse(result.response!.body);
    if (!parsed.success) {
      this.logger.warn(
        {
          endpoint: spec.endpoint,
          issues: parsed.error.issues.slice(0, 5),
          // Field names and value types only: values may hold credentials.
          shape: shapeOf(result.response!.body),
        },
        'pin response has an unexpected shape',
      );
      throw new PinError({
        kind: 'unexpected_response',
        endpoint: spec.endpoint,
        httpStatus: result.response!.status,
        cause: parsed.error,
      });
    }
    this.logger.debug(
      { endpoint: spec.endpoint, attempt, durationMs, httpStatus: result.response!.status },
      'pin call ok',
    );
    return parsed.data;
  }
}
