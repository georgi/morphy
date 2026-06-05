import { Module } from '@nestjs/common';
import { EngineModule } from '../engine/engine.module';
import { ChessModule } from '../chess/chess.module';
import { AnalysisService } from './analysis.service';
import { CoachService } from './coach.service';

@Module({
  imports: [EngineModule, ChessModule],
  providers: [AnalysisService, CoachService],
  exports: [AnalysisService, CoachService],
})
export class AnalysisModule {}
