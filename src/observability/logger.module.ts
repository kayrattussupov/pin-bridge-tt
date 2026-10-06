import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';

// Never let credentials reach the logs: agency keys and signatures, Pin tokens and device keys,
// SMS codes. Phone numbers are masked at the call site.
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-signature"]',
  'req.headers["device-api-key"]',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.token',
  '*.code',
  '*.pinToken',
  '*.deviceApiKey',
  '*.apiKey',
  '*.secret',
];

export const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** Reuses a well-formed X-Request-Id from the caller so agencies can correlate, else a UUID. */
export function resolveRequestId(req: { headers: IncomingHttpHeaders }): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  return typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
    ? incoming
    : randomUUID();
}

// Nest mounts middleware through @fastify/middie, which rewrites req.url relative to the mount
// point; the full path is in originalUrl.
function isHealthRequest(req: IncomingMessage): boolean {
  const url = (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? '';
  return url === '/health' || url.startsWith('/health/');
}

@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        pinoHttp: {
          level: env.LOG_LEVEL,
          redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
          autoLogging: {
            ignore: (req: IncomingMessage) => isHealthRequest(req),
          },
          transport:
            env.NODE_ENV === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
        },
      }),
    }),
  ],
})
export class LoggerModule {}
