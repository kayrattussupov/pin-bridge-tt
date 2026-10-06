import { describe, expect, it } from 'vitest';
import {
  apiKeyPrefix,
  generateApiKey,
  generateInviteCode,
  hashApiKey,
  invitePrefix,
  verifyApiKey,
} from './api-key';
import { isIpAllowed, validateIpRule } from './ip-allowlist';
import { canonicalString, sign, verifySignature } from './signature';

const PEPPER = 'p'.repeat(32);

describe('api keys', () => {
  it('generates well-formed keys whose prefix is extractable', () => {
    const { apiKey, prefix } = generateApiKey();
    expect(apiKey).toMatch(/^pb_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    expect(apiKeyPrefix(apiKey)).toBe(prefix);
    expect(apiKeyPrefix('pb_short')).toBeUndefined();
  });

  it('verifies only the exact key with the same pepper', () => {
    const { apiKey } = generateApiKey();
    const hash = hashApiKey(apiKey, PEPPER);
    expect(verifyApiKey(apiKey, hash, PEPPER)).toBe(true);
    expect(verifyApiKey(`${apiKey.slice(0, -1)}x`, hash, PEPPER)).toBe(false);
    expect(verifyApiKey(apiKey, hash, 'q'.repeat(32))).toBe(false);
  });
});

describe('invite codes', () => {
  it('generates well-formed codes whose prefix is extractable', () => {
    const { code, prefix } = generateInviteCode();
    expect(code).toMatch(/^pbi_[0-9a-f]{12}_[A-Za-z0-9_-]{32}$/);
    expect(invitePrefix(code)).toBe(prefix);
    expect(invitePrefix(` ${code}`)).toBeUndefined();
    expect(invitePrefix(generateApiKey().apiKey)).toBeUndefined();
  });
});

describe('request signature', () => {
  const input = {
    timestamp: '1791190000',
    nonce: 'nonce-0123456789abcdef',
    method: 'post',
    path: '/v1/connections?x=1',
    body: '{"phone":"+18681234567"}',
  };

  it('builds the documented canonical string', () => {
    expect(canonicalString(input).split('\n')).toEqual([
      '1791190000',
      'nonce-0123456789abcdef',
      'POST',
      '/v1/connections?x=1',
      // sha256 of the body
      expect.stringMatching(/^[0-9a-f]{64}$/),
    ]);
  });

  it('accepts the right signature and rejects any change', () => {
    const signature = sign('secret', input);
    expect(signature).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(verifySignature('secret', input, signature)).toBe(true);
    expect(verifySignature('other', input, signature)).toBe(false);
    for (const change of [
      { body: '{}' },
      { path: '/v1/connections' },
      { method: 'GET' },
      { nonce: 'n'.repeat(16) },
    ]) {
      expect(verifySignature('secret', { ...input, ...change }, signature)).toBe(false);
    }
    expect(verifySignature('secret', input, 'v1=00')).toBe(false);
  });
});

describe('ip allowlist', () => {
  it('validates rules', () => {
    expect(validateIpRule('203.0.113.10')).toBeUndefined();
    expect(validateIpRule('203.0.113.0/24')).toBeUndefined();
    expect(validateIpRule('2001:db8::/32')).toBeUndefined();
    expect(validateIpRule('203.0.113.0/33')).toMatch(/prefix/);
    expect(validateIpRule('example.com')).toMatch(/not an IP/);
  });

  it('matches addresses and ranges, including IPv4-mapped IPv6', () => {
    const rules = ['203.0.113.10', '198.51.100.0/24', '2001:db8::/32'];
    expect(isIpAllowed('203.0.113.10', rules)).toBe(true);
    expect(isIpAllowed('::ffff:198.51.100.77', rules)).toBe(true);
    expect(isIpAllowed('2001:db8::5', rules)).toBe(true);
    expect(isIpAllowed('203.0.113.11', rules)).toBe(false);
    expect(isIpAllowed('not-an-ip', rules)).toBe(false);
  });

  it('allows everything when the list is empty', () => {
    expect(isIpAllowed('192.0.2.1', [])).toBe(true);
  });
});
