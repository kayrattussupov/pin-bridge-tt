import { describe, expect, it } from 'vitest';
import { agencyOrigin, enrollProof, isUnderOrigin } from './domain-proof';

describe('agencyOrigin', () => {
  it('puts the slug into the template', () => {
    expect(agencyOrigin('https://{slug}.duckcrm.one', 'morelli-realty')).toBe(
      'https://morelli-realty.duckcrm.one',
    );
    expect(agencyOrigin('http://127.0.0.1:8080/{slug}/', 'a1')).toBe('http://127.0.0.1:8080/a1');
  });
});

describe('isUnderOrigin', () => {
  const origin = 'https://morelli-realty.duckcrm.one';

  it('accepts URLs on the agency host', () => {
    expect(isUnderOrigin(`${origin}/api/pin-bridge/webhook`, origin)).toBe(true);
    expect(isUnderOrigin(`${origin}/`, origin)).toBe(true);
  });

  it('refuses other hosts, schemes, ports and look-alikes', () => {
    for (const url of [
      'https://nova-caribbean.duckcrm.one/api/pin-bridge/webhook',
      'http://morelli-realty.duckcrm.one/hook',
      'https://morelli-realty.duckcrm.one:8443/hook',
      'https://morelli-realty.duckcrm.one.evil.example/hook',
      'https://evil.example/https://morelli-realty.duckcrm.one/hook',
      'not a url',
    ]) {
      expect(isUnderOrigin(url, origin), url).toBe(false);
    }
  });

  it('respects a path in the origin', () => {
    const base = 'http://127.0.0.1:8080/a1';
    expect(isUnderOrigin('http://127.0.0.1:8080/a1/hook', base)).toBe(true);
    expect(isUnderOrigin('http://127.0.0.1:8080/a10/hook', base)).toBe(false);
  });
});

describe('enrollProof', () => {
  it('is the hex SHA-256 of the client_request_id', () => {
    expect(enrollProof('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
