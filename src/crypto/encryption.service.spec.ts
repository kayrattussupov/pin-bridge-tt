import { describe, expect, it } from 'vitest';
import { loadEnv } from '../config/env';
import { EncryptionService } from './encryption.service';

const key = (fill: number) => Buffer.alloc(32, fill).toString('base64');
const env = (overrides: Record<string, string> = {}) =>
  loadEnv({
    DATABASE_URL: 'postgresql://localhost/db',
    REDIS_URL: 'redis://localhost',
    ENCRYPTION_KEY: key(1),
    API_KEY_PEPPER: 'p'.repeat(32),
    ...overrides,
  });

describe('EncryptionService', () => {
  it('round-trips and never produces the same ciphertext twice', () => {
    const service = new EncryptionService(env());
    const a = service.encrypt('pin-token-123', 'connection:1:token');
    const b = service.encrypt('pin-token-123', 'connection:1:token');
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(service.decryptString(a, 'connection:1:token')).toBe('pin-token-123');
  });

  it('refuses a ciphertext moved to another row (AAD mismatch)', () => {
    const service = new EncryptionService(env());
    const sealed = service.encrypt('secret', 'connection:1:token');
    expect(() => service.decrypt(sealed, 'connection:2:token')).toThrow();
  });

  it('detects tampering', () => {
    const service = new EncryptionService(env());
    const sealed = service.encrypt('secret', 'ctx');
    sealed[sealed.length - 1]! ^= 1;
    expect(() => service.decrypt(sealed, 'ctx')).toThrow();
  });

  it('decrypts rows written with a retired key after rotation', () => {
    const before = new EncryptionService(env({ ENCRYPTION_KEY_ID: 'k1', ENCRYPTION_KEY: key(1) }));
    const old = before.encrypt('secret', 'ctx');

    const after = new EncryptionService(
      env({
        ENCRYPTION_KEY_ID: 'k2',
        ENCRYPTION_KEY: key(2),
        ENCRYPTION_PREVIOUS_KEYS: `k1:${key(1)}`,
      }),
    );
    expect(after.decryptString(old, 'ctx')).toBe('secret');
    expect(after.needsRotation(old)).toBe(true);
    expect(after.needsRotation(after.encrypt('secret', 'ctx'))).toBe(false);
  });

  it('fails clearly when the key is gone', () => {
    const before = new EncryptionService(env({ ENCRYPTION_KEY_ID: 'k1' }));
    const after = new EncryptionService(env({ ENCRYPTION_KEY_ID: 'k2', ENCRYPTION_KEY: key(2) }));
    expect(() => after.decrypt(before.encrypt('secret', 'ctx'), 'ctx')).toThrow(
      /unknown encryption key id "k1"/,
    );
  });
});
