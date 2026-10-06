import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import type { Prisma } from '../generated/prisma/client';

export interface AuditEntry {
  /** Who did it: `admin-cli`, `agency:<id>`, `system`. */
  actor: string;
  action: string;
  agencyId?: string;
  target?: string;
  ip?: string;
  /** Never put secrets or full phone numbers here. */
  meta?: Prisma.InputJsonValue;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry, tx: Prisma.TransactionClient = this.prisma): Promise<void> {
    await tx.auditLog.create({ data: entry });
    this.logger.log({ audit: entry }, `audit: ${entry.action}`);
  }
}
