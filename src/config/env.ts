import { z } from 'zod';

/** 32 random bytes, base64: `openssl rand -base64 32`. */
const aes256Key = z
  .string()
  .refine(
    (value) => Buffer.from(value, 'base64').length === 32,
    'must be 32 bytes, base64-encoded',
  );

/** `id:base64key,id2:base64key` — retired keys still needed to decrypt old rows. */
const keyring = z.string().transform((value, ctx) => {
  const keys: { id: string; key: string }[] = [];
  for (const entry of value
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)) {
    const [id, key] = entry.split(':');
    if (!id || !key || Buffer.from(key, 'base64').length !== 32) {
      ctx.addIssue({ code: 'custom', message: `invalid entry "${id ?? entry}"` });
      return z.NEVER;
    }
    keys.push({ id, key });
  }
  return keys;
});

const booleanFromString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  // Health endpoint of the worker process (used by container healthchecks).
  WORKER_HEALTH_HOST: z.string().default('0.0.0.0'),
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(3001),
  // Set when the API sits behind a reverse proxy (Caddy) so client IPs come from X-Forwarded-For.
  // false; a hop count ("1": only the closest proxy, i.e. Caddy, is trusted); or a list of
  // trusted proxy CIDRs ("172.18.0.0/16"). Never trust every hop: X-Forwarded-For would become
  // client-controlled and the agency IP allowlist could be bypassed.
  TRUST_PROXY: z
    .string()
    .default('false')
    .transform((value, ctx): false | number | string[] => {
      if (value === 'false' || value === '0') {
        return false;
      }
      if (/^\d+$/.test(value)) {
        return Number(value);
      }
      if (value === 'true') {
        ctx.addIssue({
          code: 'custom',
          message: 'use a hop count (e.g. 1) or proxy CIDRs, not "true"',
        });
        return z.NEVER;
      }
      return value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
    }),
  // Max accepted request body for agency calls.
  BODY_LIMIT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(1024 * 1024),

  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),

  // Envelope encryption for secrets at rest (Pin tokens, device keys, HMAC secrets).
  ENCRYPTION_KEY: aes256Key,
  ENCRYPTION_KEY_ID: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,32}$/)
    .default('k1'),
  ENCRYPTION_PREVIOUS_KEYS: keyring.default([]),
  // Server-side secret mixed into API key hashes, so a DB leak alone cannot verify keys.
  API_KEY_PEPPER: z.string().min(32),

  // Agency request signing and per-key budget.
  // Per client IP, before authentication.
  API_IP_RATE_LIMIT_RPS: z.coerce.number().positive().default(50),
  SIGNATURE_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),
  /** POST /v1/enroll attempts per client IP per minute (it is public; codes must not be guessed). */
  ENROLL_IP_RATE_LIMIT_PER_MIN: z.coerce.number().positive().default(5),
  /**
   * Self-service onboarding by the CRM platform (POST /v1/platform/agencies). Every CRM deployment
   * signs with this secret; unset disables the endpoint.
   */
  PLATFORM_SIGNING_SECRET: z.string().min(32).optional(),
  /**
   * Where an agency's CRM deployment lives; `{slug}` is replaced by the agency slug. Pin Bridge
   * proves the caller controls it by reading /.well-known/pin-bridge-enroll there.
   */
  PLATFORM_AGENCY_ORIGIN: z
    .string()
    .refine((value) => value.includes('{slug}'), 'must contain {slug}')
    .default('https://{slug}.duckcrm.one'),
  PLATFORM_VERIFY_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  API_RATE_LIMIT_RPS: z.coerce.number().positive().default(20),
  API_RATE_LIMIT_BURST: z.coerce.number().int().positive().default(40),

  // Account connection (SMS) limits, enforced before anything reaches Pin.
  CONNECTION_SMS_PER_AGENCY_PER_HOUR: z.coerce.number().int().positive().default(30),
  CONNECTION_MAX_CONFIRM_ATTEMPTS: z.coerce.number().int().positive().default(5),
  /** Wrong codes per phone number per 24 h, across all agencies and resent codes. */
  CONNECTION_MAX_WRONG_CODES_PER_DAY: z.coerce.number().int().positive().default(10),

  // Listing publishing.
  LISTING_SYNC_CONCURRENCY: z.coerce.number().int().positive().default(4),
  /** Sync jobs one agency may run at once (of LISTING_SYNC_CONCURRENCY), so it cannot starve others. */
  AGENCY_SYNC_CONCURRENCY: z.coerce.number().int().positive().default(2),
  /** Synchronous Pin calls (validate with a connection) per agency per second. */
  AGENCY_PIN_RPS: z.coerce.number().positive().default(1),
  LISTING_SYNC_ATTEMPTS: z.coerce.number().int().positive().default(8),
  /** First retry delay; doubles each attempt (30 s → ~1 h in total over 8 attempts). */
  LISTING_SYNC_BACKOFF_MS: z.coerce.number().int().positive().default(30_000),
  IMAGE_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  IMAGE_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 1024 * 1024),
  // DANGER: lets photo and webhook URLs point at private networks and plain http. Tests/local dev only.
  UNSAFE_ALLOW_PRIVATE_OUTBOUND_HOSTS: booleanFromString.default(false),

  // Webhooks to agencies.
  WEBHOOK_DISPATCH_INTERVAL_MS: z.coerce.number().int().positive().default(3_000),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /** First retry delay; grows ~3x per attempt (10 s, 30 s, 1.5 min, ...). */
  WEBHOOK_RETRY_BASE_MS: z.coerce.number().int().positive().default(10_000),
  /** After this, an undelivered event is parked as dead. */
  WEBHOOK_MAX_AGE_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(24 * 3600 * 1000),

  // Moderation / payment status polling of Pin's front_my.
  STATUS_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  STATUS_SYNC_CONNECTIONS_PER_TICK: z.coerce.number().int().positive().default(20),

  // Optional bearer token for /metrics (also blocked publicly by Caddy).
  METRICS_TOKEN: z.string().min(16).optional(),

  PIN_BASE_URL: z.url({ protocol: /^https?$/ }).default('https://pin.tt'),
  // Optional forward proxy so every Pin request leaves through the allowlisted egress IP.
  PIN_HTTPS_PROXY: z.url().optional(),

  PIN_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  PIN_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  PIN_UPLOAD_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  // Global budget for outgoing Pin calls, shared by every process through Redis.
  PIN_RATE_LIMIT_RPS: z.coerce.number().positive().default(5),
  PIN_RATE_LIMIT_BURST: z.coerce.number().int().positive().default(10),
  PIN_RATE_LIMIT_MAX_WAIT_MS: z.coerce.number().int().nonnegative().default(10_000),
  // Circuit breaker: stop calling Pin while it is failing, so queues back off instead of hammering.
  PIN_BREAKER_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  PIN_BREAKER_MIN_REQUESTS: z.coerce.number().int().positive().default(20),
  PIN_BREAKER_FAILURE_RATIO: z.coerce.number().gt(0).lte(1).default(0.5),
  PIN_BREAKER_OPEN_MS: z.coerce.number().int().positive().default(30_000),
});

export type Env = z.infer<typeof envSchema>;

/** Rules that span several variables. */
function checkCombinations(env: Env): string[] {
  const problems: string[] = [];
  if (env.NODE_ENV === 'production' && !env.METRICS_TOKEN) {
    problems.push('METRICS_TOKEN: required in production (protects /metrics)');
  }
  if (env.NODE_ENV === 'production' && env.UNSAFE_ALLOW_PRIVATE_OUTBOUND_HOSTS) {
    problems.push(
      'UNSAFE_ALLOW_PRIVATE_OUTBOUND_HOSTS: must not be enabled in production (disables SSRF protection)',
    );
  }
  return problems;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const problems = checkCombinations(result.data);
  if (problems.length) {
    throw new Error(
      `Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }
  return result.data;
}
