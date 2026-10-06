import { Module } from '@nestjs/common';
import { PinModule } from '../pin/pin.module';
import { DictionariesService } from './dictionaries.service';

@Module({
  imports: [PinModule],
  providers: [DictionariesService],
  exports: [DictionariesService],
})
export class DictionariesModule {}
