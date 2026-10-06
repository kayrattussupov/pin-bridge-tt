import { Agent, Dispatcher, FormData, ProxyAgent, request } from 'undici';
import type { PinRawResponse } from './classify';

export interface TransportOptions {
  baseUrl: string;
  proxyUrl?: string;
  connectTimeoutMs: number;
  userAgent: string;
  /** Hard cap on response size so a broken proxy page cannot exhaust memory. */
  maxResponseBytes: number;
}

export interface TransportRequest {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  query?: Record<string, string | number | undefined>;
  json?: unknown;
  form?: FormData;
  headers: Record<string, string>;
  timeoutMs: number;
}

export interface TransportResult {
  response?: PinRawResponse;
  error?: unknown;
  timedOut: boolean;
}

/** Thin HTTP layer over a keep-alive undici pool. Never throws: errors come back as values. */
export class PinTransport {
  private readonly dispatcher: Dispatcher;
  private readonly apiRoot: string;

  constructor(private readonly options: TransportOptions) {
    const connect = { timeout: options.connectTimeoutMs };
    this.dispatcher = options.proxyUrl
      ? new ProxyAgent({ uri: options.proxyUrl, connect, keepAliveTimeout: 30_000 })
      : new Agent({ connect, keepAliveTimeout: 30_000, connections: 32 });
    this.apiRoot = `${options.baseUrl.replace(/\/+$/, '')}/api/v1.6`;
  }

  url(path: string, query?: TransportRequest['query']): string {
    const url = new URL(`${this.apiRoot}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  async send(req: TransportRequest): Promise<TransportResult> {
    const signal = AbortSignal.timeout(req.timeoutMs);
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': this.options.userAgent,
      ...req.headers,
    };
    let body: string | FormData | undefined;
    if (req.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(req.json);
    } else if (req.form) {
      body = req.form;
    }
    try {
      const res = await request(this.url(req.path, req.query), {
        method: req.method,
        headers,
        body,
        signal,
        dispatcher: this.dispatcher,
        headersTimeout: req.timeoutMs,
        bodyTimeout: req.timeoutMs,
      });
      const text = await this.readBody(res.body);
      const contentType = String(res.headers['content-type'] ?? '');
      let parsed: unknown = text;
      let isJson = false;
      if (contentType.includes('json') && text.length > 0) {
        try {
          parsed = JSON.parse(text);
          isJson = true;
        } catch {
          // Leave as text; classification treats it like a non-JSON page.
        }
      } else if (contentType.includes('json')) {
        parsed = null;
        isJson = true;
      }
      return {
        response: { status: res.statusCode, headers: res.headers, body: parsed, isJson },
        timedOut: false,
      };
    } catch (error) {
      return { error, timedOut: signal.aborted };
    }
  }

  private async readBody(body: Dispatcher.ResponseData['body']): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of body) {
      size += (chunk as Buffer).length;
      if (size > this.options.maxResponseBytes) {
        body.destroy();
        throw new Error(`Pin response exceeded ${this.options.maxResponseBytes} bytes`);
      }
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }
}
