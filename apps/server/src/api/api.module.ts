import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ChessModule } from '../chess/chess.module';
import { AnalysisModule } from '../analysis/analysis.module';
import { GamesController } from './games.controller';
import { AnalysisController } from './analysis.controller';
import { EngineExceptionFilter } from './engine-exception.filter';

/**
 * REST surface for direct (non-agent) UI actions: importing/fetching games and
 * running engine analysis. Controllers delegate to the shared ChessService /
 * GameStore / AnalysisService (re-exported by ChessModule and AnalysisModule),
 * so the REST API and the agent tools stay on a single source of truth.
 */
@Module({
  imports: [ChessModule, AnalysisModule],
  controllers: [GamesController, AnalysisController],
  providers: [
    {
      // Map EngineUnavailableError → 503 across these controllers.
      provide: APP_FILTER,
      useClass: EngineExceptionFilter,
    },
  ],
})
export class ApiModule {}
