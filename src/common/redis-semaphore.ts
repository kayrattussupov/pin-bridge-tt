import type { Redis } from 'ioredis';

// Counting semaphore in a sorted set: member = holder, score = lease expiry (Redis clock).
// Expired leases (crashed holders) are dropped before counting.
const ACQUIRE = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[2]) then
  redis.call('ZADD', KEYS[1], now + tonumber(ARGV[3]), ARGV[1])
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
  return 1
end
return 0
`;

type RedisWithSemaphore = Redis & {
  semaphoreAcquire(key: string, holder: string, limit: number, leaseMs: number): Promise<number>;
};

/** At most `limit` concurrent holders per key, shared by every process using the same Redis. */
export class RedisSemaphore {
  private readonly redis: RedisWithSemaphore;

  constructor(redis: Redis) {
    if (!('semaphoreAcquire' in redis)) {
      redis.defineCommand('semaphoreAcquire', { numberOfKeys: 1, lua: ACQUIRE });
    }
    this.redis = redis as RedisWithSemaphore;
  }

  async acquire(key: string, holder: string, limit: number, leaseMs: number): Promise<boolean> {
    return (await this.redis.semaphoreAcquire(key, holder, limit, leaseMs)) === 1;
  }

  async release(key: string, holder: string): Promise<void> {
    await this.redis.zrem(key, holder);
  }
}
