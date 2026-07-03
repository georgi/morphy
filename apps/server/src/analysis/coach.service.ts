import { Injectable } from '@nestjs/common';
import type { Color, Game, MoveEval, TurningPoint } from '@chess/shared';
import { ChessService } from '../chess/chess.service';
import { AnalysisService } from './analysis.service';

/** Default number of turning points to surface for a review. */
const DEFAULT_MAX_TURNING_POINTS = 5;

/** Plies of the engine's best line to keep when converting it to SAN. */
const BEST_LINE_PLIES = 6;

/** Classifications worth quizzing the user on — clear, instructive errors. */
const TURNING_POINT_CLASSES = new Set<MoveEval['classification']>([
  'mistake',
  'blunder',
]);

/**
 * Picks the most instructive turning points of a game for the interactive coach.
 *
 * A turning point is a mistake/blunder the user can be quizzed on: the position
 * BEFORE the move (what they faced), the move they actually played, and the
 * engine's better move/line in SAN. Selection keeps the few biggest swings, then
 * orders them chronologically so the review walks the game front-to-back.
 */
@Injectable()
export class CoachService {
  constructor(
    private readonly chess: ChessService,
    private readonly analysis: AnalysisService,
  ) {}

  /**
   * Compute the review turning points for a game (passed by value): take the top
   * `max` mistakes/blunders by centipawn loss, then sort them chronologically by
   * ply and build a {@link TurningPoint} per move (position before, played move,
   * best move/line in SAN). Reuses `game.analysis` when present, otherwise runs a
   * one-off engine scan (not cached anywhere — the client owns the game).
   */
  async computeTurningPoints(
    game: Game,
    opts: { max?: number } = {},
  ): Promise<TurningPoint[]> {
    const max = opts.max ?? DEFAULT_MAX_TURNING_POINTS;
    // Prefer the eval curve the game already carries; otherwise compute it once
    // for this review. Nothing is written back — there is no shared store.
    const evals = game.analysis ?? (await this.analysis.analyzeGame(game));

    const selected = evals
      .filter((e) => TURNING_POINT_CLASSES.has(e.classification))
      // Biggest swings first, keep only the top `max`…
      .sort((a, b) => b.cpLoss - a.cpLoss)
      .slice(0, Math.max(0, max))
      // …then replay them in the order they were played.
      .sort((a, b) => a.ply - b.ply);

    return selected.map((moveEval, index) =>
      this.toTurningPoint(game, moveEval, index),
    );
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private toTurningPoint(
    game: Game,
    moveEval: MoveEval,
    index: number,
  ): TurningPoint {
    const fenBefore = this.chess.positionAtPly(game, moveEval.ply - 1);
    const sideToMove = (fenBefore.split(' ')[1] as Color) ?? 'w';
    const moveNumber = Math.floor((moveEval.ply - 1) / 2) + 1;

    const bestMove = moveEval.bestMove
      ? this.chess.uciToSan(fenBefore, moveEval.bestMove)
      : null;
    const bestLine = this.chess.uciLineToSan(
      fenBefore,
      moveEval.bestLine.slice(0, BEST_LINE_PLIES),
    );

    return {
      index,
      ply: moveEval.ply,
      moveNumber,
      sideToMove,
      fenBefore,
      playedSan: moveEval.san,
      classification: moveEval.classification,
      cpLoss: moveEval.cpLoss,
      scoreCpBefore: moveEval.scoreCpBefore,
      bestMove,
      bestLine,
    };
  }
}
