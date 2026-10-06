import 'reflect-metadata';
import { INestApplication, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { ApiExceptionFilter } from './common/api-exception.filter';
import type { Env } from './config/env';
import { REQUEST_ID_HEADER, resolveRequestId } from './observability/logger.module';
import { metrics } from './observability/metrics';

export interface HttpAppOptions {
  trustProxy: false | number | string[];
  bodyLimit: number;
}

/** Trusts only the `hops` proxies closest to us (proxy-addr calls this per hop, nearest first). */
function trustHops(hops: number) {
  return (_address: string, hop: number) => hop < hops;
}

export async function createHttpApp(
  rootModule: Type<unknown>,
  options: HttpAppOptions,
): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    rootModule,
    new FastifyAdapter({
      trustProxy:
        typeof options.trustProxy === 'number' ? trustHops(options.trustProxy) : options.trustProxy,
      bodyLimit: options.bodyLimit,
      // Logging goes through pino-http (nestjs-pino), which reuses the Fastify request id.
      logger: false,
      genReqId: resolveRequestId,
    }),
    // rawBody: request signatures are computed over the exact bytes the agency sent.
    { bufferLogs: true, rawBody: true },
  );
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onRequest', (request, reply, done) => {
    reply.header(REQUEST_ID_HEADER, request.id);
    done();
  });
  fastify.addHook('onResponse', (request, reply, done) => {
    // Route templates (/v1/connections/:id), never raw URLs, to keep label cardinality bounded.
    const route = request.routeOptions.url ?? 'unmatched';
    if (route !== '/metrics' && !route.startsWith('/health')) {
      metrics.httpDuration.observe(
        { method: request.method, route, status_code: String(reply.statusCode) },
        reply.elapsedTime / 1000,
      );
    }
    done();
  });
  app.useLogger(app.get(Logger));
  app.useGlobalFilters(new ApiExceptionFilter());
  // Lets SIGTERM drain in-flight requests and jobs before the process exits.
  app.enableShutdownHooks();
  return app;
}

export async function listen(app: INestApplication, host: string, port: number): Promise<void> {
  await app.listen(port, host);
  app.get(Logger).log(`listening on http://${host}:${port}`);
}

export function apiOptions(env: Env): HttpAppOptions {
  return { trustProxy: env.TRUST_PROXY, bodyLimit: env.BODY_LIMIT_BYTES };
}
