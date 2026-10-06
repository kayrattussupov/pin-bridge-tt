import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { PinModule } from '../pin/pin.module';
import { StatusSyncService } from './status-sync.service';

@Module({
  imports: [ConnectionsModule, PinModule],
  providers: [StatusSyncService],
  exports: [StatusSyncService],
})
export class StatusSyncModule {}
