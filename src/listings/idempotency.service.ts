import { createHash } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error';
import { PrismaService } from '../database/prisma.service';
import type { Prisma } from '../generated/prisma/client';

const TTL_MS = 24 * 3600 * 1000;
const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface StoredResponse {
  status: number;
  body: unknown;
}

/**
 * `Idempotency-Key` support: the first response for a key is stored for 24 h and replayed for
 * retries of the same request. Reusing a key for a different request is an error.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async run(
    agencyId: string,
    key: string | undefined,
    request: { method: string; path: string; body: unknown },
    execute: () => Promise<StoredResponse>,
  ): Promise<StoredResponse & { replayed: boolean }> {
    if (!key) {
      return { ...(await execute()), replayed: false };
    }
    if (!KEY_PATTERN.test(key)) {
      throw new ApiError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'validation_failed',
        'Idempotency-Key must be 1-128 characters of A-Z a-z 0-9 . _ : -',
      );
    }
    const requestHash = createHash('sha256')
      .update(`${request.method}\n${request.path}\n${JSON.stringify(request.body ?? null)}`)
      .digest('hex');
    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { agencyId_key: { agencyId, key } },
    });
    if (existing && existing.expiresAt > new Date()) {
      if (existing.requestHash !== requestHash) {
        throw new ApiError(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'idempotency_key_reused',
          'This Idempotency-Key was already used for a different request.',
        );
      }
      return { status: existing.responseStatus, body: existing.responseBody, replayed: true };
    }

    const response = await execute();
    if (response.status < 500) {
      const data = {
        requestHash,
        responseStatus: response.status,
        responseBody: response.body as Prisma.InputJsonValue,
        expiresAt: new Date(Date.now() + TTL_MS),
      };
      await this.prisma.idempotencyKey.upsert({
        where: { agencyId_key: { agencyId, key } },
        create: { agencyId, key, ...data },
        update: data,
      });
    }
    return { ...response, replayed: false };
  }
}
