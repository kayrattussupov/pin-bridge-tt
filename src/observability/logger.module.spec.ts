import { describe, expect, it } from 'vitest';
import { resolveRequestId } from './logger.module';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('resolveRequestId', () => {
  it('reuses a well-formed caller id', () => {
    expect(resolveRequestId({ headers: { 'x-request-id': 'agency-42.req_1' } })).toBe(
      'agency-42.req_1',
    );
  });

  it('generates a uuid when the header is missing', () => {
    expect(resolveRequestId({ headers: {} })).toMatch(UUID);
  });

  it.each(['has space', 'a'.repeat(129), 'new\nline', ''])('replaces unsafe id %j', (value) => {
    expect(resolveRequestId({ headers: { 'x-request-id': value } })).toMatch(UUID);
  });
});
