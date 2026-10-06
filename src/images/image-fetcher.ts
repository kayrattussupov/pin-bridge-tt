import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { Dispatcher, request } from 'undici';
import { metrics } from '../observability/metrics';
import {
  BLOCKED_HOST_CODE,
  checkOutboundUrl,
  createSafeDispatcher,
  errorCodeOf,
} from '../common/safe-http';

export type ImageErrorCode =
  | 'invalid_url'
  | 'blocked_host'
  | 'too_many_redirects'
  | 'http_error'
  | 'too_large'
  | 'not_an_image'
  | 'image_too_large_dimensions'
  | 'timeout'
  | 'network';

export class ImageFetchError extends Error {
  constructor(
    readonly code: ImageErrorCode,
    message: string,
    /** False for errors worth retrying later (timeouts, 5xx, network). */
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = 'ImageFetchError';
  }
}

export interface PreparedImage {
  /** JPEG ready for Pin: long side at most 1600 px, EXIF orientation applied, metadata stripped. */
  data: Buffer;
  /** Hash of the source bytes: the same photo is uploaded to Pin only once per listing. */
  sha256: string;
  width: number;
  height: number;
}

export interface ImageFetcherOptions {
  timeoutMs: number;
  maxBytes: number;
  /** Tests/local dev only: allow http:// and private addresses. */
  allowPrivateHosts: boolean;
  maxRedirects?: number;
}

/** Pin renders the large preview at 1600 px on the long side. */
const TARGET_LONG_SIDE = 1600;
/** Refuse decompression bombs: 50 megapixels is far above any real listing photo. */
const MAX_INPUT_PIXELS = 50_000_000;
const PHOTO_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'avif', 'heif']);

/**
 * Downloads agency photos without letting a URL reach our internal network (SSRF):
 * https only; every address the hostname resolves to must be public, checked inside the
 * socket's own DNS lookup so a DNS-rebinding answer cannot slip in between check and connect;
 * redirects are followed manually (max 3) and re-checked; size and time are capped.
 */
export class ImageFetcher {
  private readonly dispatcher: Dispatcher;

  constructor(private readonly options: ImageFetcherOptions) {
    this.dispatcher = createSafeDispatcher({
      allowPrivateHosts: options.allowPrivateHosts,
      connectTimeoutMs: options.timeoutMs,
    });
  }

  async fetch(url: string): Promise<Buffer> {
    let current = url;
    const maxRedirects = this.options.maxRedirects ?? 3;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const target = this.checkUrl(current);
      const signal = AbortSignal.timeout(this.options.timeoutMs);
      let res: Dispatcher.ResponseData;
      try {
        res = await request(target, {
          method: 'GET',
          dispatcher: this.dispatcher,
          signal,
          headers: {
            accept: 'image/jpeg,image/png,image/webp,image/*;q=0.8',
            'user-agent': 'PinBridge-ImageFetcher',
          },
        });
      } catch (error) {
        throw this.transportError(error, signal.aborted);
      }

      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.body.resume();
        current = new URL(String(res.headers.location), target).toString();
        continue;
      }
      if (res.statusCode !== 200) {
        res.body.resume();
        const permanent =
          res.statusCode >= 400 &&
          res.statusCode < 500 &&
          res.statusCode !== 408 &&
          res.statusCode !== 429;
        throw new ImageFetchError(
          'http_error',
          `image URL answered HTTP ${res.statusCode}`,
          permanent,
        );
      }
      const declared = Number(res.headers['content-length'] ?? 0);
      if (declared > this.options.maxBytes) {
        res.body.destroy();
        throw new ImageFetchError(
          'too_large',
          `image is larger than ${this.options.maxBytes} bytes`,
          true,
        );
      }
      return this.readCapped(res.body, signal);
    }
    throw new ImageFetchError('too_many_redirects', `more than ${maxRedirects} redirects`, true);
  }

  /** Fetches and converts a photo into what Pin expects. */
  async prepare(url: string): Promise<PreparedImage> {
    try {
      const image = await this.prepareUnmetered(url);
      metrics.imageFetch.inc({ outcome: 'ok' });
      return image;
    } catch (error) {
      metrics.imageFetch.inc({
        outcome: error instanceof ImageFetchError ? error.code : 'internal',
      });
      throw error;
    }
  }

  private async prepareUnmetered(url: string): Promise<PreparedImage> {
    const source = await this.fetch(url);
    const sha256 = createHash('sha256').update(source).digest('hex');
    let data: Buffer;
    let info: sharp.OutputInfo;
    // Only photo formats reach the full decoder (no SVG, TIFF, PDF and other exotic parsers).
    let format: string | undefined;
    try {
      format = (await sharp(source, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()).format;
    } catch {
      throw new ImageFetchError('not_an_image', 'the URL does not contain a supported image', true);
    }
    if (!format || !PHOTO_FORMATS.has(format)) {
      throw new ImageFetchError(
        'not_an_image',
        `unsupported image format${format ? ` "${format}"` : ''}`,
        true,
      );
    }
    try {
      ({ data, info } = await sharp(source, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
        .rotate()
        .resize(TARGET_LONG_SIDE, TARGET_LONG_SIDE, { fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer({ resolveWithObject: true }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/pixel limit/i.test(message)) {
        throw new ImageFetchError('image_too_large_dimensions', 'image has too many pixels', true);
      }
      throw new ImageFetchError('not_an_image', 'the URL does not contain a supported image', true);
    }
    return { data, sha256, width: info.width, height: info.height };
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }

  private checkUrl(raw: string): string {
    const checked = checkOutboundUrl(raw, this.options.allowPrivateHosts);
    if ('problem' in checked) {
      throw checked.problem === 'blocked_host'
        ? new ImageFetchError('blocked_host', 'image URL points at a non-public address', true)
        : new ImageFetchError('invalid_url', 'image URLs must be https without credentials', true);
    }
    return checked.url.toString();
  }

  private async readCapped(
    body: Dispatcher.ResponseData['body'],
    signal: AbortSignal,
  ): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of body) {
        size += (chunk as Buffer).length;
        if (size > this.options.maxBytes) {
          body.destroy();
          throw new ImageFetchError(
            'too_large',
            `image is larger than ${this.options.maxBytes} bytes`,
            true,
          );
        }
        chunks.push(chunk as Buffer);
      }
    } catch (error) {
      if (error instanceof ImageFetchError) {
        throw error;
      }
      throw this.transportError(error, signal.aborted);
    }
    return Buffer.concat(chunks);
  }

  private transportError(error: unknown, timedOut: boolean): ImageFetchError {
    const code = errorCodeOf(error);
    if (code === BLOCKED_HOST_CODE) {
      return new ImageFetchError('blocked_host', 'image URL points at a non-public address', true);
    }
    if (code === 'ENOTFOUND') {
      return new ImageFetchError('network', 'image host does not exist', true);
    }
    if (
      timedOut ||
      code === 'UND_ERR_CONNECT_TIMEOUT' ||
      code === 'UND_ERR_HEADERS_TIMEOUT' ||
      code === 'UND_ERR_BODY_TIMEOUT'
    ) {
      return new ImageFetchError('timeout', 'image download timed out', false);
    }
    return new ImageFetchError(
      'network',
      `image download failed: ${error instanceof Error ? error.message : String(error)}`,
      false,
    );
  }
}
