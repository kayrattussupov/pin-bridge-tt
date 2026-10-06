import { describe, expect, it } from 'vitest';
import {
  ClassifyContext,
  PinRawResponse,
  classifyResponse,
  classifyTransportError,
  extractPinErrors,
  parseRetryAfterMs,
} from './classify';

const ctx: ClassifyContext = {
  endpoint: 'items.create',
  sentDeviceKey: true,
  sentToken: true,
  statusEnvelope: false,
};

const json = (status: number, body: unknown, headers: PinRawResponse['headers'] = {}) => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body,
  isJson: true,
});

describe('classifyResponse', () => {
  it('accepts 2xx', () => {
    expect(classifyResponse(json(201, { id: 1, status: 1 }), ctx)).toBeUndefined();
  });

  it('does not treat the item moderation status as an error', () => {
    expect(classifyResponse(json(200, { id: 1, status: 3 }), ctx)).toBeUndefined();
  });

  it('reads the phone_verify envelope when asked to', () => {
    const error = classifyResponse(
      json(200, { status: 1, errors: ['Could not determine the country by number'], end_date: '' }),
      { ...ctx, statusEnvelope: true },
    );
    expect(error?.kind).toBe('validation');
    expect(error?.pinErrors).toEqual([{ message: 'Could not determine the country by number' }]);
    expect(error?.smsRetryAfterSeconds).toBeUndefined();
  });

  it('exposes the SMS cooldown from end_date', () => {
    const error = classifyResponse(json(200, { status: 1, errors: ['Too many'], end_date: 420 }), {
      ...ctx,
      statusEnvelope: true,
    });
    expect(error?.smsRetryAfterSeconds).toBe(420);
  });

  it('recognizes the Cloudflare block page', () => {
    const error = classifyResponse(
      {
        status: 403,
        headers: { 'content-type': 'text/html', server: 'cloudflare', 'cf-ray': 'abc' },
        body: '<!DOCTYPE html><title>Attention Required! | Cloudflare</title>',
        isJson: false,
      },
      ctx,
    );
    expect(error?.kind).toBe('cloudflare_blocked');
    expect(error?.isUpstreamFailure).toBe(true);
    expect(error?.retryable).toBe(false);
  });

  it('tells a missing device key from a revoked token', () => {
    const body = { detail: 'Authentication credentials were not provided.' };
    expect(classifyResponse(json(403, body), { ...ctx, sentDeviceKey: false })?.kind).toBe(
      'missing_device_key',
    );
    // A device key Pin no longer knows, on a call without a user token (e.g. dictionaries).
    expect(classifyResponse(json(403, body), { ...ctx, sentToken: false })?.kind).toBe(
      'missing_device_key',
    );
    expect(classifyResponse(json(403, { detail: 'Invalid token.' }), ctx)?.kind).toBe(
      'unauthorized',
    );
    expect(classifyResponse(json(401, { detail: 'Invalid token.' }), ctx)?.kind).toBe(
      'unauthorized',
    );
    expect(
      classifyResponse(
        json(403, { detail: 'You do not have permission to perform this action.' }),
        ctx,
      )?.kind,
    ).toBe('forbidden');
  });

  it('maps 429 with Retry-After', () => {
    const error = classifyResponse(json(429, { detail: 'Throttled' }, { 'retry-after': '7' }), ctx);
    expect(error?.kind).toBe('rate_limited');
    expect(error?.retryAfterMs).toBe(7_000);
    expect(error?.retryable).toBe(true);
  });

  it('maps DRF field errors on 400', () => {
    const error = classifyResponse(
      json(400, { coordinates: ['Expected an object.'], user: { name: ['Required.'] } }),
      ctx,
    );
    expect(error?.kind).toBe('validation');
    expect(error?.pinErrors).toEqual([
      { field: 'coordinates', message: 'Expected an object.' },
      { field: 'user', message: 'Required.' },
    ]);
  });

  it.each([
    [404, 'not_found'],
    [418, 'client'],
    [500, 'server'],
    [502, 'server'],
    [522, 'server'],
  ])('maps HTTP %i to %s', (status, kind) => {
    expect(classifyResponse(json(status, {}), ctx)?.kind).toBe(kind);
  });
});

describe('extractPinErrors', () => {
  it('handles the shapes Pin uses', () => {
    expect(extractPinErrors({ errors: ['a', 'b'] })).toEqual([{ message: 'a' }, { message: 'b' }]);
    expect(extractPinErrors({ errors: { price: ['bad'] } })).toEqual([
      { field: 'price', message: 'bad' },
    ]);
    expect(extractPinErrors({ detail: 'Nope' })).toEqual([{ message: 'Nope' }]);
    expect(extractPinErrors('<html>')).toEqual([]);
  });
});

describe('parseRetryAfterMs', () => {
  it('parses seconds and HTTP dates', () => {
    expect(parseRetryAfterMs('2')).toBe(2_000);
    expect(parseRetryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
    expect(parseRetryAfterMs('soon')).toBeUndefined();
  });
});

describe('classifyTransportError', () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

  it('marks connection failures as not sent', () => {
    const error = classifyTransportError(refused, {
      endpoint: 'items.create',
      idempotent: false,
      timedOut: false,
    });
    expect(error).toMatchObject({ kind: 'network', notSent: true, outcomeUnknown: false });
  });

  it('marks a timed out non-idempotent call as outcome unknown', () => {
    const error = classifyTransportError(new Error('aborted'), {
      endpoint: 'items.create',
      idempotent: false,
      timedOut: true,
    });
    expect(error).toMatchObject({ kind: 'timeout', notSent: false, outcomeUnknown: true });
  });

  it('finds the code on a nested cause', () => {
    const wrapped = new Error('fetch failed', { cause: refused });
    expect(
      classifyTransportError(wrapped, { endpoint: 'x', idempotent: true, timedOut: false }).notSent,
    ).toBe(true);
  });
});
