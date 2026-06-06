import { Module } from '@nestjs/common';
import { EngineModule } from '../engine/engine.module';
import { ChessModule } from '../chess/chess.module';
import { AnalysisService } from './analysis.service';
import { CoachService } from './coach.service';
import { KeyMomentsService } from './key-moments.service';

@Module({
  imports: [EngineModule, ChessModule],
  providers: [AnalysisService, CoachService, KeyMomentsService],
  exports: [AnalysisService, CoachService, KeyMomentsService],
})
export class AnalysisModule {}
