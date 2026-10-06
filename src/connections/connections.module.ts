import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PinModule } from '../pin/pin.module';
import { ConnectionsService } from './connections.service';

/** Services only; the HTTP controller is mounted by ApiModule so the worker exposes no routes. */
@Module({
  imports: [AuthModule, PinModule],
  providers: [ConnectionsService],
  exports: [ConnectionsService],
})
export class ConnectionsModule {}
