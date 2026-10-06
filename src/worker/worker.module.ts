import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CryptoModule } from '../crypto/crypto.module';
import { ConfigModule } from '../config/config.module';
import { DatabaseModule } from '../database/database.module';
import { DictionariesModule } from '../dictionaries/dictionaries.module';
import { ListingSyncModule } from '../listing-sync/listing-sync.module';
import { HealthModule } from '../health/health.module';
import { LoggerModule } from '../observability/logger.module';
import { MetricsModule } from '../observability/metrics.module';
import { PinModule } from '../pin/pin.module';
import { QueueModule } from '../queue/queue.module';
import { StatusSyncModule } from '../status-sync/status-sync.module';
import { WebhookEventsModule } from '../webhooks/webhook-events';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { DictionarySyncProcessor } from './dictionary-sync.processor';
import { HeartbeatProcessor } from './heartbeat.processor';
import { StatusSyncProcessor, WebhookDispatchProcessor } from './periodic.processors';

@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    DatabaseModule,
    QueueModule,
    HealthModule.register({ workerHeartbeat: true }),
    PinModule,
    CryptoModule,
    AuditModule,
    DictionariesModule,
    ListingSyncModule,
    StatusSyncModule,
    WebhookEventsModule,
    WebhooksModule,
    MetricsModule.register({ state: true }),
  ],
  providers: [
    HeartbeatProcessor,
    DictionarySyncProcessor,
    WebhookDispatchProcessor,
    StatusSyncProcessor,
  ],
})
export class WorkerModule {}
