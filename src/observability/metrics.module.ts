import {
  Controller,
  DynamicModule,
  Get,
  Header,
  Headers,
  Inject,
  Module,
  Optional,
  Provider,
} from '@nestjs/common';
import { Registry } from 'prom-client';
import { timingSafeEqual } from 'node:crypto';
import { ApiError } from '../common/api-error';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { PinModule } from '../pin/pin.module';
import { registry } from './metrics';
import { MetricsCollector } from './metrics.collector';

@Controller('metrics')
class MetricsController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Optional() private readonly collector?: MetricsCollector,
  ) {}

  @Get()
  @Header('content-type', registry.contentType)
  @Header('cache-control', 'no-store')
  async metrics(@Headers('authorization') authorization?: string): Promise<string> {
    if (this.env.METRICS_TOKEN) {
      const expected = Buffer.from(`Bearer ${this.env.METRICS_TOKEN}`);
      const actual = Buffer.from(authorization ?? '');
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        throw ApiError.unauthorized();
      }
    }
    const registries = this.collector ? [registry, this.collector.registry] : [registry];
    return Registry.merge(registries).metrics();
  }
}

/** `/metrics`. With `{ state: true }` (worker) also queue and database gauges. */
@Module({})
export class MetricsModule {
  static register(options: { state: boolean }): DynamicModule {
    const providers: Provider[] = options.state ? [MetricsCollector] : [];
    return {
      module: MetricsModule,
      imports: options.state ? [PinModule] : [],
      controllers: [MetricsController],
      providers,
    };
  }
}
