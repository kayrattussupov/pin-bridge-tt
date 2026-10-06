import type { Redis } from 'ioredis';
import { PinError } from './pin.errors';

export interface CircuitBreakerOptions {
  /** Redis key prefix; lets tests and environments share one Redis without interfering. */
  keyPrefix: string;
  windowMs: number;
  bucketMs: number;
  minRequests: number;
  failureRatio: number;
  openMs: number;
  /** How long a single half-open probe may take before another caller may probe. */
  probeTimeoutMs: number;
  now?: () => number;
}

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerTicket {
  /** True when this call is the single probe allowed while half-open. */
  probe: boolean;
}

/**
 * Circuit breaker shared by every process through Redis (api and workers all call Pin).
 *
 * closed → counts outcomes in a sliding window of buckets; trips when enough calls fail.
 * open → every call is refused locally (`breaker_open`) for `openMs`.
 * half_open → one probe call goes through; success closes the breaker, failure re-opens it.
 */
export class CircuitBreaker {
  private readonly now: () => number;
  private readonly openKey: string;
  private readonly halfOpenKey: string;
  private readonly probeKey: string;

  constructor(
    private readonly redis: Redis,
    private readonly options: CircuitBreakerOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.openKey = `${options.keyPrefix}:open`;
    this.halfOpenKey = `${options.keyPrefix}:half-open`;
    this.probeKey = `${options.keyPrefix}:probe`;
  }

  private bucketKey(start: number): string {
    return `${this.options.keyPrefix}:bucket:${start}`;
  }

  private bucketStarts(): number[] {
    const { windowMs, bucketMs } = this.options;
    const current = Math.floor(this.now() / bucketMs) * bucketMs;
    const count = Math.ceil(windowMs / bucketMs);
    return Array.from({ length: count }, (_, i) => current - i * bucketMs);
  }

  async state(): Promise<BreakerState> {
    const [open, halfOpen] = await this.redis.mget(this.openKey, this.halfOpenKey);
    if (open) {
      return 'open';
    }
    return halfOpen ? 'half_open' : 'closed';
  }

  /** Throws `breaker_open` when the call must not be sent. */
  async beforeRequest(endpoint: string): Promise<BreakerTicket> {
    const state = await this.state();
    if (state === 'closed') {
      return { probe: false };
    }
    if (state === 'half_open') {
      const acquired = await this.redis.set(
        this.probeKey,
        '1',
        'PX',
        this.options.probeTimeoutMs,
        'NX',
      );
      if (acquired === 'OK') {
        return { probe: true };
      }
    }
    const ttl = await this.redis.pttl(this.openKey);
    throw new PinError({
      kind: 'breaker_open',
      endpoint,
      notSent: true,
      retryAfterMs: ttl > 0 ? ttl : this.options.probeTimeoutMs,
    });
  }

  async recordSuccess(ticket: BreakerTicket): Promise<void> {
    if (ticket.probe) {
      await this.reset();
      return;
    }
    await this.count(false);
  }

  async recordFailure(ticket: BreakerTicket): Promise<void> {
    if (ticket.probe) {
      await this.trip();
      return;
    }
    const { total, failed } = await this.count(true);
    if (total >= this.options.minRequests && failed / total >= this.options.failureRatio) {
      await this.trip();
    }
  }

  private async count(failed: boolean): Promise<{ total: number; failed: number }> {
    const starts = this.bucketStarts();
    const currentKey = this.bucketKey(starts[0]!);
    const ttl = this.options.windowMs + this.options.bucketMs;
    const tx = this.redis.multi().hincrby(currentKey, 't', 1);
    if (failed) {
      tx.hincrby(currentKey, 'f', 1);
    }
    tx.pexpire(currentKey, ttl);
    for (const start of starts) {
      tx.hmget(this.bucketKey(start), 't', 'f');
    }
    const results = (await tx.exec()) ?? [];
    let total = 0;
    let failures = 0;
    for (const [, value] of results.slice(-starts.length)) {
      const [t, f] = (value as (string | null)[] | null) ?? [];
      total += Number(t ?? 0);
      failures += Number(f ?? 0);
    }
    return { total, failed: failures };
  }

  private async trip(): Promise<void> {
    await this.redis
      .multi()
      .set(this.openKey, String(this.now()), 'PX', this.options.openMs)
      // Half-open outlives "open" so the first call after the pause becomes the probe.
      .set(this.halfOpenKey, '1')
      .del(this.probeKey)
      .exec();
  }

  async reset(): Promise<void> {
    const keys = [
      this.openKey,
      this.halfOpenKey,
      this.probeKey,
      ...this.bucketStarts().map((s) => this.bucketKey(s)),
    ];
    await this.redis.del(...keys);
  }
}
