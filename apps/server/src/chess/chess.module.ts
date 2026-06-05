import { Module } from '@nestjs/common';
import { ChessService } from './chess.service';
import { GameStore } from './game.store';

@Module({
  providers: [ChessService, GameStore],
  exports: [ChessService, GameStore],
})
export class ChessModule {}
