import { Module } from '@nestjs/common';
import { WebhookDispatcher } from './webhook-dispatcher';
import { WebhooksService } from './webhooks.service';

/** Services only; the controller is mounted by ApiModule, the dispatcher runs in the worker. */
@Module({
  providers: [WebhooksService, WebhookDispatcher],
  exports: [WebhooksService, WebhookDispatcher],
})
export class WebhooksModule {}
