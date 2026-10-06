import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AES-256-GCM for secrets at rest. Ciphertext layout:
 * `version(1) | keyIdLength(1) | keyId | iv(12) | tag(16) | ciphertext`.
 *
 * The key id travels with the data, so the active key can be rotated: new writes use
 * ENCRYPTION_KEY, old rows still decrypt with ENCRYPTION_PREVIOUS_KEYS until re-encrypted.
 * `context` is bound as AAD (e.g. `api_key:<id>`): a ciphertext copied into another row or
 * column fails to decrypt instead of silently yielding someone else's secret.
 */
@Injectable()
export class EncryptionService {
  private readonly activeKeyId: string;
  private readonly keys = new Map<string, Buffer>();

  constructor(@Inject(ENV) env: Env) {
    this.activeKeyId = env.ENCRYPTION_KEY_ID;
    for (const { id, key } of env.ENCRYPTION_PREVIOUS_KEYS) {
      this.keys.set(id, Buffer.from(key, 'base64'));
    }
    this.keys.set(env.ENCRYPTION_KEY_ID, Buffer.from(env.ENCRYPTION_KEY, 'base64'));
  }

  /** Returns a plain Uint8Array (what Prisma expects for `Bytes` columns). */
  encrypt(plaintext: string | Buffer, context: string): Uint8Array<ArrayBuffer> {
    const keyId = Buffer.from(this.activeKeyId, 'utf8');
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.activeKeyId)!, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return new Uint8Array(
      Buffer.concat([Buffer.from([VERSION, keyId.length]), keyId, iv, cipher.getAuthTag(), data]),
    );
  }

  decrypt(payload: Uint8Array, context: string): Buffer {
    const buf = Buffer.from(payload);
    if (buf[0] !== VERSION) {
      throw new Error('unsupported ciphertext version');
    }
    const keyIdLength = buf[1]!;
    const keyId = buf.subarray(2, 2 + keyIdLength).toString('utf8');
    const key = this.keys.get(keyId);
    if (!key) {
      throw new Error(`unknown encryption key id "${keyId}"`);
    }
    let offset = 2 + keyIdLength;
    const iv = buf.subarray(offset, (offset += IV_BYTES));
    const tag = buf.subarray(offset, (offset += TAG_BYTES));
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(buf.subarray(offset)), decipher.final()]);
  }

  decryptString(payload: Uint8Array, context: string): string {
    return this.decrypt(payload, context).toString('utf8');
  }

  /** True when the row was written with a retired key and should be re-encrypted. */
  needsRotation(payload: Uint8Array): boolean {
    const buf = Buffer.from(payload);
    return buf.subarray(2, 2 + buf[1]!).toString('utf8') !== this.activeKeyId;
  }
}
