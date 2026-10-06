import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

export interface AgencyContext {
  agencyId: string;
  agencySlug: string;
  agencyName: string;
  apiKeyId: string;
  apiKeyPrefix: string;
  scopes: string[];
}

export type AuthenticatedRequest = FastifyRequest & {
  rawBody?: Buffer;
  agency?: AgencyContext;
};

/** The agency resolved by AgencyAuthGuard. Only valid on guarded routes. */
export const CurrentAgency = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const agency = ctx.switchToHttp().getRequest<AuthenticatedRequest>().agency;
  if (!agency) {
    throw new Error('CurrentAgency used on a route without AgencyAuthGuard');
  }
  return agency;
});
