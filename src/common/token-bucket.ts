import type { Redis } from 'ioredis';

// Token bucket kept in a Redis hash. Uses Redis TIME so every process shares one clock.
// Returns 0 when a token was taken, otherwise the milliseconds until one is available.
const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1]) or burst
local ts = tonumber(data[2]) or now
tokens = math.min(burst, tokens + math.max(0, now - ts) * rate / 1000)
local wait = 0
if tokens >= 1 then
  tokens = tokens - 1
else
  wait = math.ceil((1 - tokens) * 1000 / rate)
end
redis.call('HSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, math.ceil(burst / rate * 1000) + 1000)
return wait
`;

type RedisWithBucket = Redis & {
  tokenBucketTake(key: string, rate: number, burst: number): Promise<number>;
};

/** Distributed token bucket: shared by every process that uses the same Redis and key. */
export class TokenBucket {
  private readonly redis: RedisWithBucket;

  constructor(redis: Redis) {
    if (!('tokenBucketTake' in redis)) {
      redis.defineCommand('tokenBucketTake', { numberOfKeys: 1, lua: TOKEN_BUCKET_SCRIPT });
    }
    this.redis = redis as RedisWithBucket;
  }

  /** Takes one token. Resolves 0 on success, or the wait in ms until a token frees up. */
  take(key: string, ratePerSecond: number, burst: number): Promise<number> {
    return this.redis.tokenBucketTake(key, ratePerSecond, burst);
  }
}
