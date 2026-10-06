import { HttpStatus, Logger } from '@nestjs/common';
import { ApiError } from '../common/api-error';
import { PinError } from './pin.errors';

const logger = new Logger('PinApiError');

/**
 * Translates a PinError raised during a synchronous agency request (only the SMS connection
 * flow calls Pin synchronously) into an agency-facing error.
 */
export function pinErrorToApiError(error: PinError): ApiError {
  const retryAfterSeconds =
    error.retryAfterMs !== undefined ? Math.ceil(error.retryAfterMs / 1000) : undefined;
  switch (error.kind) {
    case 'validation':
    case 'client':
    case 'forbidden':
      return new ApiError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'pin_rejected',
        'Pin rejected the request.',
        { pin_errors: error.pinErrors },
      );
    case 'unexpected_response':
      return new ApiError(
        HttpStatus.BAD_GATEWAY,
        'pin_bad_response',
        'Pin returned an unexpected response.',
      );
    case 'cloudflare_blocked':
    case 'missing_device_key':
      // Our setup is broken (egress IP not allowlisted, device key lost), not the agency's.
      logger.error({ kind: error.kind, endpoint: error.endpoint }, 'Pin refused our server');
      return unavailable(undefined);
    default:
      return unavailable(retryAfterSeconds);
  }
}

function unavailable(retryAfterSeconds: number | undefined): ApiError {
  const seconds = Math.max(1, retryAfterSeconds ?? 30);
  return new ApiError(
    HttpStatus.SERVICE_UNAVAILABLE,
    'pin_unavailable',
    'Pin is temporarily unavailable. Try again later.',
    { retry_after_seconds: seconds },
    { 'retry-after': String(seconds) },
  );
}
