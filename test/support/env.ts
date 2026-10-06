/** Fills the env the app needs in tests. CI provides DATABASE_URL/REDIS_URL; keys are fixed. */
export function setTestEnv(overrides: Record<string, string> = {}): void {
  const defaults: Record<string, string> = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    DATABASE_URL: 'postgresql://pinbridge:pinbridge@localhost:5432/pinbridge',
    REDIS_URL: 'redis://localhost:6379',
    ENCRYPTION_KEY: Buffer.alloc(32, 42).toString('base64'),
    API_KEY_PEPPER: 'test-pepper-test-pepper-test-pepper',
    API_IP_RATE_LIMIT_RPS: '100000',
  };
  for (const [name, value] of Object.entries(defaults)) {
    process.env[name] ??= value;
  }
  Object.assign(process.env, overrides);
}
