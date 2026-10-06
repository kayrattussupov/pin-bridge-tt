import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// pb_<12 hex prefix>_<43 char base64url secret>. The prefix is public (stored and logged) and
// is how a key is looked up; only an HMAC of the full key is stored.
const API_KEY_PATTERN = /^(pb_[0-9a-f]{12})_[A-Za-z0-9_-]{43}$/;

export interface GeneratedApiKey {
  apiKey: string;
  prefix: string;
}

export function generateApiKey(): GeneratedApiKey {
  const prefix = `pb_${randomBytes(6).toString('hex')}`;
  return { apiKey: `${prefix}_${randomBytes(32).toString('base64url')}`, prefix };
}

/** Returns the lookup prefix of a well-formed key, else undefined. */
export function apiKeyPrefix(apiKey: string): string | undefined {
  return API_KEY_PATTERN.exec(apiKey)?.[1];
}

/** Keys carry 256 bits of entropy, so a peppered HMAC is enough (no slow KDF needed). */
export function hashApiKey(apiKey: string, pepper: string): string {
  return createHmac('sha256', pepper).update(apiKey).digest('hex');
}

export function verifyApiKey(apiKey: string, storedHash: string, pepper: string): boolean {
  const actual = Buffer.from(hashApiKey(apiKey, pepper), 'hex');
  const expected = Buffer.from(storedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Per-key secret for request signatures. Shown once, stored encrypted. */
export function generateSigningSecret(): string {
  return randomBytes(32).toString('base64url');
}

// pbi_<12 hex prefix>_<32 char base64url secret>: an enrollment invite. Stored like API keys
// (prefix plus peppered HMAC), shorter because it is single-use and expires.
const INVITE_CODE_PATTERN = /^(pbi_[0-9a-f]{12})_[A-Za-z0-9_-]{32}$/;

export function generateInviteCode(): { code: string; prefix: string } {
  const prefix = `pbi_${randomBytes(6).toString('hex')}`;
  return { code: `${prefix}_${randomBytes(24).toString('base64url')}`, prefix };
}

/** Returns the lookup prefix of a well-formed invite code, else undefined. */
export function invitePrefix(code: string): string | undefined {
  return INVITE_CODE_PATTERN.exec(code)?.[1];
}
