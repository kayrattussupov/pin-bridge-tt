import { describe, expect, it } from 'vitest';
import { loadEnv } from './env';

const KEY = Buffer.alloc(32, 7).toString('base64');

const required = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/pinbridge',
  REDIS_URL: 'redis://localhost:6379',
  ENCRYPTION_KEY: KEY,
  API_KEY_PEPPER: 'p'.repeat(32),
};

describe('loadEnv', () => {
  it('applies defaults when only required values are set', () => {
    const env = loadEnv(required);
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      API_PORT: 3000,
      WORKER_HEALTH_PORT: 3001,
      TRUST_PROXY: false,
      BODY_LIMIT_BYTES: 1024 * 1024,
      PIN_BASE_URL: 'https://pin.tt',
    });
  });

  it('coerces numbers and booleans from strings', () => {
    const env = loadEnv({ ...required, API_PORT: '8080', TRUST_PROXY: '1' });
    expect(env.API_PORT).toBe(8080);
    expect(env.TRUST_PROXY).toBe(1);
    expect(loadEnv({ ...required, TRUST_PROXY: '172.18.0.0/16, 10.0.0.1' }).TRUST_PROXY).toEqual([
      '172.18.0.0/16',
      '10.0.0.1',
    ]);
  });

  it('refuses to trust every proxy hop', () => {
    expect(() => loadEnv({ ...required, TRUST_PROXY: 'true' })).toThrowError(/TRUST_PROXY/);
  });

  it('enforces production-only rules', () => {
    const prod = { ...required, NODE_ENV: 'production' };
    expect(() => loadEnv(prod)).toThrowError(/METRICS_TOKEN: required in production/);
    expect(() =>
      loadEnv({
        ...prod,
        METRICS_TOKEN: 'x'.repeat(16),
        UNSAFE_ALLOW_PRIVATE_OUTBOUND_HOSTS: 'true',
      }),
    ).toThrowError(/UNSAFE_ALLOW_PRIVATE_OUTBOUND_HOSTS/);
    expect(loadEnv({ ...prod, METRICS_TOKEN: 'x'.repeat(16) }).NODE_ENV).toBe('production');
  });

  it('lists every invalid variable in one error', () => {
    const message = (() => {
      try {
        loadEnv({ REDIS_URL: 'http://not-redis', API_PORT: 'abc' });
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error('expected loadEnv to throw');
    })();
    for (const name of ['DATABASE_URL', 'REDIS_URL', 'API_PORT']) {
      expect(message).toContain(`- ${name}:`);
    }
  });

  it('has safe defaults for talking to Pin', () => {
    expect(loadEnv(required)).toMatchObject({
      PIN_REQUEST_TIMEOUT_MS: 30_000,
      PIN_RATE_LIMIT_RPS: 5,
      PIN_BREAKER_FAILURE_RATIO: 0.5,
    });
  });

  it('rejects a breaker ratio outside (0, 1]', () => {
    expect(() => loadEnv({ ...required, PIN_BREAKER_FAILURE_RATIO: '1.5' })).toThrowError(
      /PIN_BREAKER_FAILURE_RATIO/,
    );
  });

  it('requires a 32-byte encryption key', () => {
    expect(() => loadEnv({ ...required, ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrowError(
      /ENCRYPTION_KEY/,
    );
  });

  it('parses the previous-keys keyring', () => {
    const env = loadEnv({ ...required, ENCRYPTION_PREVIOUS_KEYS: `k0:${KEY}, old:${KEY}` });
    expect(env.ENCRYPTION_PREVIOUS_KEYS.map((k) => k.id)).toEqual(['k0', 'old']);
    expect(() => loadEnv({ ...required, ENCRYPTION_PREVIOUS_KEYS: 'k0:short' })).toThrowError(
      /ENCRYPTION_PREVIOUS_KEYS/,
    );
  });

  it('rejects a non-postgres database url', () => {
    expect(() => loadEnv({ ...required, DATABASE_URL: 'mysql://localhost/db' })).toThrowError(
      /DATABASE_URL/,
    );
  });
});
