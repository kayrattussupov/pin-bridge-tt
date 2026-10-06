import { DynamicModule, Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HEALTH_OPTIONS, HealthController, HealthOptions } from './health.controller';
import { HealthIndicators } from './health.indicators';

@Module({})
export class HealthModule {
  static register(options: HealthOptions): DynamicModule {
    return {
      module: HealthModule,
      imports: [TerminusModule.forRoot({ errorLogStyle: 'json' })],
      controllers: [HealthController],
      providers: [HealthIndicators, { provide: HEALTH_OPTIONS, useValue: options }],
    };
  }
}
