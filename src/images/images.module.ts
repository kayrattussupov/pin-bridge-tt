import { Inject, Injectable, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { ImageFetcher } from './image-fetcher';

@Injectable()
class ImageFetcherLifecycle implements OnModuleDestroy {
  constructor(@Inject(ImageFetcher) private readonly fetcher: ImageFetcher) {}

  async onModuleDestroy(): Promise<void> {
    await this.fetcher.close();
  }
}

@Module({
  providers: [
    {
      provide: ImageFetcher,
      inject: [ENV],
      useFactory: (env: Env) => {
        if (env.UNSAFE_ALLOW_PRIVATE_OUTBOUND_HOSTS && env.NODE_ENV === 'production') {
          new Logger('ImageFetcher').error(
            'UNSAFE_ALLOW_PRIVATE_OUTBOUND_HOSTS is on in production: SSRF protection is disabled',
          );
        }
        return new ImageFetcher({
          timeoutMs: env.IMAGE_FETCH_TIMEOUT_MS,
          maxBytes: env.IMAGE_MAX_BYTES,
          allowPrivateHosts: env.UNSAFE_ALLOW_PRIVATE_OUTBOUND_HOSTS,
        });
      },
    },
    ImageFetcherLifecycle,
  ],
  exports: [ImageFetcher],
})
export class ImagesModule {}
