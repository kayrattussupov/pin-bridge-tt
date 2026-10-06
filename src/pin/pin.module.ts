import { Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { RedisService } from '../queue/redis.service';
import { version } from '../../package.json';
import { PinClient } from './pin.client';
import { pinClientOptionsFromEnv } from './pin.options';

@Injectable()
class PinClientLifecycle implements OnModuleDestroy {
  constructor(@Inject(PinClient) private readonly client: PinClient) {}

  async onModuleDestroy(): Promise<void> {
    await this.client.close();
  }
}

@Module({
  providers: [
    {
      provide: PinClient,
      inject: [ENV, RedisService],
      useFactory: (env: Env, redis: RedisService) =>
        new PinClient(pinClientOptionsFromEnv(env, `PinBridge/${version}`), redis),
    },
    PinClientLifecycle,
  ],
  exports: [PinClient],
})
export class PinModule {}
