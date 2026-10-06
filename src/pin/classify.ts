import { PinError, PinFieldError } from './pin.errors';

export interface PinRawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  /** Parsed JSON when the body was JSON, otherwise the raw text. */
  body: unknown;
  isJson: boolean;
}

export interface ClassifyContext {
  endpoint: string;
  sentDeviceKey: boolean;
  sentToken: boolean;
  /**
   * Endpoints like phone_verify answer HTTP 200 with `{status: 1, errors: [...]}` on failure.
   * Never enable this for item endpoints: there `status` is the moderation state.
   */
  statusEnvelope: boolean;
}

function header(res: PinRawResponse, name: string): string | undefined {
  const value = res.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function parseRetryAfterMs(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function messagesOf(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(messagesOf);
  }
  const record = asRecord(value);
  if (record) {
    return Object.values(record).flatMap(messagesOf);
  }
  return value === undefined || value === null ? [] : [String(value)];
}

/**
 * Normalizes the error shapes Pin (Django REST Framework) uses:
 * `{errors: ["..."]}`, `{errors: {field: ["..."]}}`, `{detail: "..."}`, `{field: ["..."]}`.
 */
export function extractPinErrors(body: unknown): PinFieldError[] {
  if (typeof body === 'string') {
    const text = body.trim();
    return text && !text.startsWith('<') ? [{ message: text.slice(0, 500) }] : [];
  }
  const record = asRecord(body);
  if (!record) {
    return messagesOf(body).map((message) => ({ message }));
  }
  const errors = record.errors ?? record.non_field_errors;
  if (errors !== undefined) {
    const nested = asRecord(errors);
    if (nested) {
      return Object.entries(nested).flatMap(([field, value]) =>
        messagesOf(value).map((message) => ({ field, message })),
      );
    }
    return messagesOf(errors).map((message) => ({ message }));
  }
  if (typeof record.detail === 'string') {
    return [{ message: record.detail }];
  }
  return Object.entries(record)
    .filter(([key]) => key !== 'status' && key !== 'end_date')
    .flatMap(([field, value]) => messagesOf(value).map((message) => ({ field, message })));
}

/** phone_verify reports the SMS cooldown in `end_date` (seconds); it is "" when there is none. */
function smsRetryAfter(body: unknown): number | undefined {
  const endDate = asRecord(body)?.end_date;
  if (endDate === undefined || endDate === null || endDate === '') {
    return undefined;
  }
  const seconds = Number(endDate);
  return Number.isFinite(seconds) ? seconds : undefined;
}

const AUTH_MESSAGE = /token|credential|authenticat|logged/i;

/** Returns a PinError for an unsuccessful response, or undefined when the call succeeded. */
export function classifyResponse(res: PinRawResponse, ctx: ClassifyContext): PinError | undefined {
  const base = {
    endpoint: ctx.endpoint,
    httpStatus: res.status,
    smsRetryAfterSeconds: smsRetryAfter(res.body),
  };

  if (res.status >= 200 && res.status < 300) {
    const record = asRecord(res.body);
    if (ctx.statusEnvelope && record && record.status !== undefined && record.status !== 0) {
      return new PinError({ ...base, kind: 'validation', pinErrors: extractPinErrors(res.body) });
    }
    return undefined;
  }

  const pinErrors = extractPinErrors(res.body);

  if (res.status === 403 && !res.isJson) {
    // Pin itself always answers JSON; an HTML 403 is the Cloudflare block page.
    return new PinError({ ...base, kind: 'cloudflare_blocked', pinErrors: [] });
  }
  if (res.status === 401) {
    return new PinError({ ...base, kind: 'unauthorized', pinErrors });
  }
  if (res.status === 403) {
    // Without a user token, the only credential Pin can refuse is the device key: either it was
    // not sent or Pin no longer knows it. Callers react by creating a new one.
    if (!ctx.sentDeviceKey || !ctx.sentToken) {
      return new PinError({ ...base, kind: 'missing_device_key', pinErrors });
    }
    if (ctx.sentToken && pinErrors.some((e) => AUTH_MESSAGE.test(e.message))) {
      return new PinError({ ...base, kind: 'unauthorized', pinErrors });
    }
    return new PinError({ ...base, kind: 'forbidden', pinErrors });
  }
  if (res.status === 429) {
    return new PinError({
      ...base,
      kind: 'rate_limited',
      pinErrors,
      retryAfterMs: parseRetryAfterMs(header(res, 'retry-after')),
    });
  }
  if (res.status === 404) {
    return new PinError({ ...base, kind: 'not_found', pinErrors });
  }
  if (res.status === 400 || res.status === 409 || res.status === 413 || res.status === 422) {
    return new PinError({ ...base, kind: 'validation', pinErrors });
  }
  if (res.status >= 500) {
    return new PinError({ ...base, kind: 'server', pinErrors: res.isJson ? pinErrors : [] });
  }
  return new PinError({ ...base, kind: 'client', pinErrors });
}

// Failures where the request provably did not reach Pin, so resending cannot duplicate anything.
const NOT_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);
const TIMEOUT_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ETIMEDOUT']);

function errorCode(error: unknown): string | undefined {
  const own = (error as { code?: unknown } | undefined)?.code;
  if (typeof own === 'string') {
    return own;
  }
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  return cause && cause !== error ? errorCode(cause) : undefined;
}

/** Maps a thrown transport error (no HTTP response) to a PinError. */
export function classifyTransportError(
  error: unknown,
  ctx: { endpoint: string; idempotent: boolean; timedOut: boolean },
): PinError {
  const code = errorCode(error);
  const notSent = code !== undefined && NOT_SENT_CODES.has(code);
  const isTimeout =
    ctx.timedOut ||
    (code !== undefined && TIMEOUT_CODES.has(code)) ||
    (error as { name?: string } | undefined)?.name === 'TimeoutError';
  return new PinError({
    endpoint: ctx.endpoint,
    kind: isTimeout && !notSent ? 'timeout' : 'network',
    notSent,
    // A call with side effects may have been applied before the connection died.
    outcomeUnknown: !notSent && !ctx.idempotent,
    cause: error,
  });
}
