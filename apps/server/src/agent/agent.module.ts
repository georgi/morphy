import { Module } from '@nestjs/common';
import { ChessModule } from '../chess/chess.module';
import { AnalysisModule } from '../analysis/analysis.module';
import { LibraryModule } from '../library/library.module';
import { ChessToolsService } from './chess-tools.service';
import { AgentService } from './agent.service';
import { AgentController } from './agent.controller';

/**
 * The AI-native agent layer: wraps the chess/analysis services as Pi Agent SDK
 * tools and streams agent turns to the client over SSE.
 *
 * Imports ChessModule + AnalysisModule to inject ChessService, GameStore,
 * AnalysisService, and CoachService, plus LibraryModule for the library tools
 * (`search_library`, `open_game`, `list_collections`) — the single source of
 * truth the tools delegate to.
 */
@Module({
  imports: [ChessModule, AnalysisModule, LibraryModule],
  controllers: [AgentController],
  providers: [ChessToolsService, AgentService],
  exports: [AgentService],
})
export class AgentModule {}
