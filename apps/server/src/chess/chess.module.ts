import { Module } from '@nestjs/common';
import { ChessService } from './chess.service';

@Module({
  providers: [ChessService],
  exports: [ChessService],
})
export class ChessModule {}
