import { Module } from '@nestjs/common';
import { ChessModule } from '../chess/chess.module';
import { AnalysisModule } from '../analysis/analysis.module';
import { LibraryModule } from '../library/library.module';
import { ChessToolsService } from './chess-tools.service';
import { AgentService } from './agent.service';
import { AgentController } from './agent.controller';
import { AGENT_HARNESS, type AgentHarness } from './harness/agent-harness';
import { PiHarness } from './harness/pi-harness';
import { ClaudeHarness } from './harness/claude-harness';

/**
 * Select the agent backend from the environment. `AGENT_BACKEND=claude` picks the
 * Claude Agent SDK adapter; anything else (default `pi`) picks the Pi adapter.
 * Pure so it can be unit-tested without booting Nest. Only the selected adapter is
 * instantiated, so the unused SDK is never imported.
 */
export function createHarnessFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AgentHarness {
  const backend = (env.AGENT_BACKEND ?? 'pi').toLowerCase();
  return backend === 'claude' ? new ClaudeHarness() : new PiHarness();
}

/**
 * The AI-native agent layer: wraps the chess/analysis services as backend-neutral
 * agent tools and streams agent turns to the client over SSE.
 *
 * Imports ChessModule + AnalysisModule to inject ChessService, GameStore,
 * AnalysisService, and CoachService, plus LibraryModule for the library tools
 * (`search_library`, `open_game`, `list_collections`) — the single source of
 * truth the tools delegate to. The {@link AGENT_HARNESS} provider selects the Pi
 * or Claude backend from the environment at boot.
 */
@Module({
  imports: [ChessModule, AnalysisModule, LibraryModule],
  controllers: [AgentController],
  providers: [
    ChessToolsService,
    AgentService,
    { provide: AGENT_HARNESS, useFactory: () => createHarnessFromEnv() },
  ],
  exports: [AgentService],
})
export class AgentModule {}
