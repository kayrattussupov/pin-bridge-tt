import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImageFetchError, ImageFetcher } from '../../src/images/image-fetcher';
import { isPublicAddress } from '../../src/images/ip-safety';
import { ImageServer, startImageServer } from '../support/image-server';

let server: ImageServer;
let local: ImageFetcher;
let strict: ImageFetcher;

beforeAll(async () => {
  server = await startImageServer();
  local = new ImageFetcher({ timeoutMs: 1_000, maxBytes: 1024 * 1024, allowPrivateHosts: true });
  strict = new ImageFetcher({ timeoutMs: 1_000, maxBytes: 1024 * 1024, allowPrivateHosts: false });
});

afterAll(async () => {
  await Promise.all([local.close(), strict.close(), server.close()]);
});

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected failure');
    },
    (error: unknown) => error as ImageFetchError,
  );

describe('isPublicAddress', () => {
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('allows %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:7f00:1',
    '::7f00:1',
    '::ffff:0:7f00:1',
    '2002:7f00:1::1',
    '64:ff9b:1::1',
    'not-an-ip',
  ])('blocks %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
});

describe('ImageFetcher SSRF protection', () => {
  it.each([
    ['a hostname resolving to loopback', 'https://localhost/x.jpg'],
    ['a loopback literal', 'https://127.0.0.1/x.jpg'],
    ['cloud metadata', 'https://169.254.169.254/latest/meta-data/'],
    ['a private range', 'https://10.0.0.5/x.jpg'],
    ['IPv6 loopback', 'https://[::1]/x.jpg'],
    ['IPv4-mapped IPv6', 'https://[::ffff:127.0.0.1]/x.jpg'],
    ['IPv4-compatible IPv6', 'https://[::127.0.0.1]/x.jpg'],
    ['6to4 wrapping loopback', 'https://[2002:7f00:1::1]/x.jpg'],
  ])('blocks %s', async (_name, url) => {
    const error = await failure(strict.fetch(url));
    expect(error).toBeInstanceOf(ImageFetchError);
    expect(error.code).toBe('blocked_host');
    expect(error.permanent).toBe(true);
  });

  it.each([
    'http://example.com/a.jpg',
    'ftp://example.com/a.jpg',
    'https://user:pw@example.com/a.jpg',
    'nonsense',
  ])('rejects %s', async (url) => {
    expect((await failure(strict.fetch(url))).code).toBe('invalid_url');
  });

  it('re-checks redirects (a public URL cannot bounce to a private one)', async () => {
    // The local server redirects; with strict checks even the first hop is refused, and a
    // redirect target is validated exactly like the original URL.
    expect((await failure(strict.fetch(`${server.url}/redirect/1`))).code).toBe('invalid_url');
  });
});

describe('ImageFetcher downloads and preparation', () => {
  it('scales a large photo to 1600 px on the long side as JPEG', async () => {
    const image = await local.prepare(`${server.url}/big.jpg`);
    expect([image.width, image.height]).toEqual([1600, 1200]);
    expect((await sharp(image.data).metadata()).format).toBe('jpeg');
    expect(image.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never enlarges small photos', async () => {
    const image = await local.prepare(`${server.url}/small.jpg`);
    expect([image.width, image.height]).toEqual([640, 480]);
  });

  it('refuses non-photo formats such as SVG', async () => {
    const error = await failure(local.prepare(`${server.url}/vector.svg`));
    expect(error).toMatchObject({ code: 'not_an_image', permanent: true });
  });

  it('converts PNG (with transparency) to JPEG', async () => {
    const image = await local.prepare(`${server.url}/transparent.png`);
    expect((await sharp(image.data).metadata()).format).toBe('jpeg');
  });

  it('follows up to 3 redirects', async () => {
    await expect(local.prepare(`${server.url}/redirect/2`)).resolves.toMatchObject({ width: 640 });
    expect((await failure(local.fetch(`${server.url}/redirect/5`))).code).toBe(
      'too_many_redirects',
    );
  });

  it('classifies failures as permanent or retryable', async () => {
    expect(await failure(local.fetch(`${server.url}/missing.jpg`))).toMatchObject({
      code: 'http_error',
      permanent: true,
    });
    expect(await failure(local.fetch(`${server.url}/broken.jpg`))).toMatchObject({
      code: 'http_error',
      permanent: false,
    });
    expect(await failure(local.prepare(`${server.url}/text.jpg`))).toMatchObject({
      code: 'not_an_image',
      permanent: true,
    });
    expect(await failure(local.fetch(`${server.url}/huge.bin`))).toMatchObject({
      code: 'too_large',
      permanent: true,
    });
    expect(await failure(local.fetch(`${server.url}/slow.jpg`))).toMatchObject({
      code: 'timeout',
      permanent: false,
    });
  });
});
