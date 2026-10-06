export type PinErrorKind =
  /** Cloudflare refused the request before it reached Pin: our egress IP is not allowlisted. */
  | 'cloudflare_blocked'
  /** Pin rejected the Device-Api-Key: missing, or unknown to Pin (create a new one). */
  | 'missing_device_key'
  /** The user token is invalid or was revoked (forced logout). Needs a new phone_verify. */
  | 'unauthorized'
  /** Authenticated but not allowed (e.g. editing someone else's item). */
  | 'forbidden'
  | 'rate_limited'
  /** Pin understood the request and refused its content; `pinErrors` says why. */
  | 'validation'
  | 'not_found'
  /** Any other 4xx. */
  | 'client'
  | 'server'
  /** 2xx, but the body does not have the shape we rely on (Pin changed its API?). */
  | 'unexpected_response'
  | 'timeout'
  | 'network'
  /** Not sent: the circuit breaker is open because Pin has been failing. */
  | 'breaker_open'
  /** Not sent: our own outgoing rate budget is exhausted for longer than allowed to wait. */
  | 'local_rate_limit';

export interface PinFieldError {
  field?: string;
  message: string;
}

export interface PinErrorInit {
  kind: PinErrorKind;
  endpoint: string;
  httpStatus?: number;
  pinErrors?: PinFieldError[];
  retryAfterMs?: number;
  /** The request never left this process (or never reached the server), so it is safe to resend. */
  notSent?: boolean;
  /** A non-idempotent call may or may not have been applied by Pin. The caller must reconcile. */
  outcomeUnknown?: boolean;
  /** Seconds until Pin allows another SMS request (phone_verify `end_date`). */
  smsRetryAfterSeconds?: number;
  cause?: unknown;
}

const RETRYABLE: ReadonlySet<PinErrorKind> = new Set([
  'rate_limited',
  'server',
  'timeout',
  'network',
  'breaker_open',
  'local_rate_limit',
]);

/** Outcomes that mean Pin (or the path to it) is unhealthy. Feed the circuit breaker. */
const UPSTREAM_FAILURES: ReadonlySet<PinErrorKind> = new Set([
  'cloudflare_blocked',
  'rate_limited',
  'server',
  'timeout',
  'network',
]);

export class PinError extends Error {
  readonly kind: PinErrorKind;
  readonly endpoint: string;
  readonly httpStatus?: number;
  readonly pinErrors: PinFieldError[];
  readonly retryAfterMs?: number;
  readonly notSent: boolean;
  readonly outcomeUnknown: boolean;
  readonly smsRetryAfterSeconds?: number;

  constructor(init: PinErrorInit) {
    const details = init.pinErrors?.map((e) => (e.field ? `${e.field}: ${e.message}` : e.message));
    super(
      `Pin ${init.endpoint} failed: ${init.kind}` +
        (init.httpStatus ? ` (HTTP ${init.httpStatus})` : '') +
        (details?.length ? ` - ${details.join('; ')}` : ''),
      { cause: init.cause },
    );
    this.name = 'PinError';
    this.kind = init.kind;
    this.endpoint = init.endpoint;
    this.httpStatus = init.httpStatus;
    this.pinErrors = init.pinErrors ?? [];
    this.retryAfterMs = init.retryAfterMs;
    this.notSent = init.notSent ?? false;
    this.outcomeUnknown = init.outcomeUnknown ?? false;
    this.smsRetryAfterSeconds = init.smsRetryAfterSeconds;
  }

  /** Worth trying again later (by the client for safe calls, or by the job queue). */
  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }

  get isUpstreamFailure(): boolean {
    return UPSTREAM_FAILURES.has(this.kind);
  }
}

export function isPinError(error: unknown): error is PinError {
  return error instanceof PinError;
}
