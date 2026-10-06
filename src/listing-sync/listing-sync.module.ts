import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { ImagesModule } from '../images/images.module';
import { ListingsModule } from '../listings/listings.module';
import { PinModule } from '../pin/pin.module';
import { ListingSyncProcessor } from './listing-sync.processor';
import { ListingSyncService } from './listing-sync.service';

/** Worker side of publishing: consumes the listings queue. */
@Module({
  imports: [ConnectionsModule, ListingsModule, PinModule, ImagesModule],
  providers: [ListingSyncService, ListingSyncProcessor],
  exports: [ListingSyncService],
})
export class ListingSyncModule {}
