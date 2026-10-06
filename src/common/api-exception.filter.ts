import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, ApiErrorCode } from './api-error';

const CODE_BY_STATUS: Record<number, ApiErrorCode> = {
  400: 'validation_failed',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'validation_failed',
  422: 'validation_failed',
  429: 'rate_limited',
};

/**
 * Every error leaves as `{ error: { code, message, details?, request_id } }`.
 * Unexpected exceptions become a generic 500: internals never reach agencies.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();

    let status = 500;
    let code: ApiErrorCode = 'internal';
    let message = 'Internal server error.';
    let details: unknown;

    if (exception instanceof ApiError) {
      status = exception.getStatus();
      code = exception.code;
      message = exception.message;
      details = exception.details;
      for (const [name, value] of Object.entries(exception.headers)) {
        void reply.header(name, value);
      }
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = CODE_BY_STATUS[status] ?? (status >= 500 ? 'internal' : 'validation_failed');
      message = status >= 500 ? message : exception.message;
    } else if (isFastifyClientError(exception)) {
      status = exception.statusCode;
      code = CODE_BY_STATUS[status] ?? 'validation_failed';
      message = exception.message;
    }

    if (status >= 500) {
      this.logger.error({ err: exception, requestId: request.id }, 'unhandled error');
    }

    // Routes may preset another content type (e.g. /metrics); errors are always JSON.
    void reply
      .status(status)
      .type('application/json; charset=utf-8')
      .send({
        error: {
          code,
          message,
          ...(details === undefined ? {} : { details }),
          request_id: request.id,
        },
      });
  }
}

// Fastify's own errors (malformed JSON, body too large) carry a 4xx statusCode.
function isFastifyClientError(error: unknown): error is { statusCode: number; message: string } {
  const statusCode = (error as { statusCode?: unknown } | undefined)?.statusCode;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500;
}
