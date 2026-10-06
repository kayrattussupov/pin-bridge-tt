import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { AgencyAuthGuard } from '../auth/agency-auth.guard';
import { AgencyContext, AuthenticatedRequest, CurrentAgency } from '../auth/agency-context';
import { PrismaService } from '../database/prisma.service';
import { DictionariesService } from '../dictionaries/dictionaries.service';

/**
 * Lets an agency check that its key, signature and IP setup work before sending real data.
 * `setup` is a checklist for onboarding screens: webhook, Pin accounts, reference data.
 */
@Controller('v1/me')
@UseGuards(AgencyAuthGuard)
export class MeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dictionaries: DictionariesService,
  ) {}

  @Get()
  async me(@CurrentAgency() agency: AgencyContext, @Req() req: AuthenticatedRequest) {
    const [endpoint, connections, dictionariesReady] = await Promise.all([
      this.prisma.webhookEndpoint.findFirst({ where: { agencyId: agency.agencyId } }),
      this.prisma.connection.groupBy({
        by: ['status'],
        where: { agencyId: agency.agencyId },
        _count: { _all: true },
      }),
      this.dictionaries.isReady(),
    ]);
    const lastDelivery = endpoint
      ? await this.prisma.webhookOutbox.findFirst({
          where: { endpointId: endpoint.id },
          orderBy: { createdAt: 'desc' },
        })
      : null;
    const count = (status: string) =>
      connections.find((c) => c.status === status)?._count._all ?? 0;

    return {
      agency: { id: agency.agencyId, slug: agency.agencySlug, name: agency.agencyName },
      api_key: { prefix: agency.apiKeyPrefix, scopes: agency.scopes },
      request_ip: req.ip,
      setup: {
        webhook: endpoint
          ? {
              url: endpoint.url,
              enabled: endpoint.enabled,
              last_delivery: lastDelivery && {
                type: lastDelivery.event,
                status: lastDelivery.deliveredAt
                  ? 'delivered'
                  : lastDelivery.deadAt
                    ? 'dead'
                    : 'pending',
                attempts: lastDelivery.attempts,
                last_status: lastDelivery.lastStatus,
                last_error: lastDelivery.lastError,
                created_at: lastDelivery.createdAt.toISOString(),
              },
            }
          : null,
        connections: {
          active: count('active'),
          pending_code: count('pending_code'),
          reauth_required: count('reauth_required'),
        },
        dictionaries_ready: dictionariesReady,
      },
    };
  }
}
