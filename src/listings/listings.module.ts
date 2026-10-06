import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConnectionsModule } from '../connections/connections.module';
import { DictionariesModule } from '../dictionaries/dictionaries.module';
import { PinModule } from '../pin/pin.module';
import { IdempotencyService } from './idempotency.service';
import { ListingValidationService } from './listing-validation.service';
import { ListingsService } from './listings.service';

/** Services only; controllers are mounted by ApiModule. */
@Module({
  imports: [AuthModule, ConnectionsModule, DictionariesModule, PinModule],
  providers: [ListingValidationService, ListingsService, IdempotencyService],
  exports: [ListingValidationService, ListingsService, IdempotencyService],
})
export class ListingsModule {}
