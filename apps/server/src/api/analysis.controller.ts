import {
  BadRequestException,
  Body,
  Controller,
  NotFoundException,
  Post,
} from '@nestjs/common';
import type {
  AnalyzeGameRequest,
  AnalyzePositionRequest,
  EngineEval,
  MoveEval,
} from '@chess/shared';
import { AnalysisService } from '../analysis/analysis.service';
import { GameStore } from '../chess/game.store';

/**
 * Direct (non-agent) analysis endpoints. Both delegate to AnalysisService — the
 * same service the agent tools call — so there's a single source of truth. A
 * missing Stockfish binary bubbles up as EngineUnavailableError and is mapped to
 * HTTP 503 by the engine exception filter.
 */
@Controller('analysis')
export class AnalysisController {
  constructor(
    private readonly analysis: AnalysisService,
    private readonly store: GameStore,
  ) {}

  /** Engine evaluation of a single position. Invalid FEN → 400 (via ChessService). */
  @Post('position')
  analyzePosition(
    @Body() body: AnalyzePositionRequest,
  ): Promise<EngineEval> {
    const fen = typeof body?.fen === 'string' ? body.fen.trim() : '';
    if (!fen) {
      throw new BadRequestException('Provide a "fen" to analyze.');
    }
    return this.analysis.analyzePosition(fen, {
      depth: body.depth,
      multipv: body.multipv,
    });
  }

  /**
   * Full-game scan: evaluate every ply, returning the eval curve. The result is
   * cached on the game by the service. Unknown gameId → 404.
   */
  @Post('game')
  analyzeGame(@Body() body: AnalyzeGameRequest): Promise<MoveEval[]> {
    const gameId = typeof body?.gameId === 'string' ? body.gameId.trim() : '';
    if (!gameId) {
      throw new BadRequestException('Provide a "gameId" to analyze.');
    }
    if (!this.store.has(gameId)) {
      throw new NotFoundException(`Game not found: ${gameId}`);
    }
    return this.analysis.analyzeGame(gameId, body.depth);
  }
}
