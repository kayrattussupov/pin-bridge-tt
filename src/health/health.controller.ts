import { Controller, Get, Inject } from '@nestjs/common';
import { HealthCheck, HealthCheckService, HealthIndicatorFunction } from '@nestjs/terminus';
import { HealthIndicators } from './health.indicators';

export const HEALTH_OPTIONS = Symbol('HEALTH_OPTIONS');

export interface HealthOptions {
  /** Also require a fresh worker heartbeat for readiness (only meaningful in the worker). */
  workerHeartbeat: boolean;
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicators: HealthIndicators,
    @Inject(HEALTH_OPTIONS) private readonly options: HealthOptions,
  ) {}

  /** Liveness: the process is up and the event loop responds. No dependencies are checked. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: dependencies needed to serve traffic are reachable. */
  @Get('ready')
  @HealthCheck()
  ready() {
    const checks: HealthIndicatorFunction[] = [
      () => this.indicators.database(),
      () => this.indicators.redisPing(),
    ];
    if (this.options.workerHeartbeat) {
      checks.push(() => this.indicators.workerHeartbeat());
    }
    return this.health.check(checks);
  }
}
