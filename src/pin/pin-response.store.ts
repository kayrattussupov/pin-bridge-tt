import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { Prisma } from '../generated/prisma/client';
import type { PinResponseRecord, PinResponseRecorder } from './pin.client';

/** Keeps Pin's answers in `pin_responses` (see PinClient) and drops old ones. */
@Injectable()
export class PinResponseStore implements PinResponseRecorder {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: PinResponseRecord): Promise<void> {
    await this.prisma.pinResponse.create({
      data: {
        endpoint: entry.endpoint,
        method: entry.method,
        path: entry.path,
        connectionId: entry.connectionId ?? null,
        itemId: entry.itemId ?? null,
        attempt: entry.attempt,
        httpStatus: entry.httpStatus ?? null,
        outcome: entry.outcome,
        durationMs: entry.durationMs,
        body:
          entry.body === null || entry.body === undefined
            ? Prisma.DbNull
            : (entry.body as Prisma.InputJsonValue),
      },
    });
  }

  /** Deletes answers recorded before `cutoff`; returns how many. */
  async prune(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.pinResponse.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return count;
  }
}
