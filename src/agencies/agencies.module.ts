import { Module } from '@nestjs/common';
import { AgenciesService } from './agencies.service';

@Module({
  providers: [AgenciesService],
  exports: [AgenciesService],
})
export class AgenciesModule {}
