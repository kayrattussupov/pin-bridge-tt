import { Module } from '@nestjs/common';
import { AgenciesModule } from '../agencies/agencies.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { DomainProofService } from './domain-proof';
import { EnrollmentService } from './enrollment.service';

/** Service only; the controller is mounted by ApiModule, the CLI uses the service directly. */
@Module({
  imports: [AgenciesModule, WebhooksModule],
  providers: [EnrollmentService, DomainProofService],
  exports: [EnrollmentService, DomainProofService],
})
export class EnrollmentModule {}
