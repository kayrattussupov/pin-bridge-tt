import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { ConfigModule } from '../config/config.module';
import { ConnectionsController } from '../connections/connections.controller';
import { ConnectionsModule } from '../connections/connections.module';
import { CryptoModule } from '../crypto/crypto.module';
import { DatabaseModule } from '../database/database.module';
import { DictionariesController } from '../dictionaries/dictionaries.controller';
import { DictionariesModule } from '../dictionaries/dictionaries.module';
import { EnrollmentController } from '../enrollment/enrollment.controller';
import { EnrollmentModule } from '../enrollment/enrollment.module';
import { PlatformController } from '../enrollment/platform.controller';
import { HealthModule } from '../health/health.module';
import { ListingsController } from '../listings/listings.controller';
import { ListingsModule } from '../listings/listings.module';
import { LoggerModule } from '../observability/logger.module';
import { MetricsModule } from '../observability/metrics.module';
import { PinModule } from '../pin/pin.module';
import { QueueModule } from '../queue/queue.module';
import { WebhookEventsModule } from '../webhooks/webhook-events';
import { WebhooksController } from '../webhooks/webhooks.controller';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { MeController } from './me.controller';

/** The agency-facing HTTP surface. All agency routes are declared here. */
@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    DatabaseModule,
    QueueModule,
    HealthModule.register({ workerHeartbeat: false }),
    PinModule,
    CryptoModule,
    AuditModule,
    AuthModule,
    ConnectionsModule,
    DictionariesModule,
    ListingsModule,
    WebhookEventsModule,
    WebhooksModule,
    EnrollmentModule,
    MetricsModule.register({ state: false }),
  ],
  controllers: [
    MeController,
    ConnectionsController,
    ListingsController,
    DictionariesController,
    WebhooksController,
    EnrollmentController,
    PlatformController,
  ],
})
export class ApiModule {}
