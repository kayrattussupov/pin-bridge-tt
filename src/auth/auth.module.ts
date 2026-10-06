import { Module } from '@nestjs/common';
import { AgenciesModule } from '../agencies/agencies.module';
import { AgencyAuthGuard } from './agency-auth.guard';
import { PlatformAuthGuard } from './platform-auth.guard';

@Module({
  imports: [AgenciesModule],
  providers: [AgencyAuthGuard, PlatformAuthGuard],
  exports: [AgencyAuthGuard, PlatformAuthGuard, AgenciesModule],
})
export class AuthModule {}
