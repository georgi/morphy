import { BadRequestException, Body, Controller, Post } from "@nestjs/common";
import type {
  AnalyzeGameRequest,
  AnalyzePositionRequest,
  EngineEval,
  Game,
  KeyMoment,
  KeyMomentsRequest,
  MoveEval,
} from "@chess/shared";
import { AnalysisService } from "../analysis/analysis.service";
import { KeyMomentsService } from "../analysis/key-moments.service";

/**
 * Direct (non-agent) analysis endpoints. Both delegate to AnalysisService — the
 * same service the agent tools call — so there's a single source of truth. A
 * missing Stockfish binary bubbles up as EngineUnavailableError and is mapped to
 * HTTP 503 by the engine exception filter. `/game` and `/key-moments` are
 * by-value: the client sends the `Game` in the body and owns persisting the
 * result — there is no server-side game lookup, so a missing/empty game is a
 * 400 (validation), never a 404.
 */
@Controller("analysis")
export class AnalysisController {
  constructor(
    private readonly analysis: AnalysisService,
    private readonly keyMoments: KeyMomentsService,
  ) {}

  /** Engine evaluation of a single position. Invalid FEN → 400 (via ChessService). */
  @Post("position")
  analyzePosition(@Body() body: AnalyzePositionRequest): Promise<EngineEval> {
    const fen = typeof body?.fen === "string" ? body.fen.trim() : "";
    if (!fen) {
      throw new BadRequestException('Provide a "fen" to analyze.');
    }
    return this.analysis.analyzePosition(fen, {
      depth: body.depth,
      multipv: body.multipv,
    });
  }

  /**
   * Full-game scan: evaluate every ply of the game sent in the body, returning
   * the eval curve. By-value — the client owns caching the result (there is no
   * server-side store write). Missing/empty game → 400.
   */
  @Post("game")
  analyzeGame(@Body() body: AnalyzeGameRequest): Promise<MoveEval[]> {
    const game = requireGame(body?.game, 'Provide a "game" to analyze.');
    return this.analysis.analyzeGame(game, body.depth);
  }

  /**
   * Decisive moments of the game sent in the body (up to five), each with a
   * White-POV eval and a coaching note — agent prose when the agent is
   * reachable, a templated fallback otherwise. Missing/empty game → 400; a game
   * with no `analysis` attached returns `[]` so the client can prompt the user
   * to analyze first.
   */
  @Post("key-moments")
  keyMomentsForGame(@Body() body: KeyMomentsRequest): Promise<KeyMoment[]> {
    const game = requireGame(body?.game, 'Provide a "game" to review.');
    return this.keyMoments.forGame(game);
  }
}

/** Validate a by-value `Game` from a request body, or 400. */
function requireGame(game: Game | undefined | null, message: string): Game {
  if (!game || !game.id || !Array.isArray(game.moves)) {
    throw new BadRequestException(message);
  }
  return game;
}
