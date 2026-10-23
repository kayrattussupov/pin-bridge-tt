import { describe, expect, it } from 'vitest';
import { REDACTED, redactSecrets } from './redact';

describe('redactSecrets', () => {
  it('replaces credential fields at any depth and keeps the rest', () => {
    expect(
      redactSecrets({
        id: 658143,
        token: 'abc',
        user: { name: 'Illia', device_api_key: 'k', 'Device-Api-Key': 'k2' },
        results: [{ id: 1, access_token: 't', status: { code: 'status_check', comment: '' } }],
      }),
    ).toEqual({
      id: 658143,
      token: REDACTED,
      user: { name: 'Illia', device_api_key: REDACTED, 'Device-Api-Key': REDACTED },
      results: [{ id: 1, access_token: REDACTED, status: { code: 'status_check', comment: '' } }],
    });
  });

  it('keeps empty credential fields as they are, so their absence stays visible', () => {
    expect(redactSecrets({ token: null, api_key: '' })).toEqual({ token: null, api_key: '' });
  });

  it('passes scalars and strings through', () => {
    expect(redactSecrets('<html>500</html>')).toBe('<html>500</html>');
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(3)).toBe(3);
  });
});
