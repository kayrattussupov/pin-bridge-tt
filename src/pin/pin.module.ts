import { Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { RedisService } from '../queue/redis.service';
import { version } from '../../package.json';
import { PinClient } from './pin.client';
import { pinClientOptionsFromEnv } from './pin.options';
import { PinResponseStore } from './pin-response.store';

@Injectable()
class PinClientLifecycle implements OnModuleDestroy {
  constructor(@Inject(PinClient) private readonly client: PinClient) {}

  async onModuleDestroy(): Promise<void> {
    await this.client.close();
  }
}

@Module({
  providers: [
    PinResponseStore,
    {
      provide: PinClient,
      inject: [ENV, RedisService, PinResponseStore],
      useFactory: (env: Env, redis: RedisService, responses: PinResponseStore) =>
        new PinClient(
          pinClientOptionsFromEnv(env, `PinBridge/${version}`),
          redis,
          undefined,
          env.PIN_RESPONSE_RETENTION_DAYS > 0 ? responses : undefined,
        ),
    },
    PinClientLifecycle,
  ],
  exports: [PinClient, PinResponseStore],
})
export class PinModule {}
