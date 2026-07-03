import { Injectable } from "@nestjs/common";
import { Chess } from "chess.js";
import type { EngineEval, Game, MoveEval } from "@chess/shared";
import type { AnalyzeOptions } from "../engine/engine.service";
import { CachedEngine } from "../engine/cached-engine";
import { ChessService } from "../chess/chess.service";

/**
 * Centipawn magnitude used to score a mate-in-N when reducing it to a single
 * number for cp-loss arithmetic. Large enough that any mate dominates a normal
 * material/positional swing, so walking into (or missing) a forced mate always
 * produces a blunder-sized loss. Closer mates score slightly higher than distant
 * ones so the comparison stays monotonic.
 */
const MATE_SCORE_CP = 100_000;

/** Default search depth for a full-game scan — modest so a game isn't too slow. */
const DEFAULT_GAME_DEPTH = 14;

@Injectable()
export class AnalysisService {
  constructor(
    private readonly engine: CachedEngine,
    private readonly chess: ChessService,
  ) {}

  /**
   * Raw engine evaluation of a single position. Thin pass-through to the engine;
   * scores are White-POV centipawns (or a mate count) as documented on EngineEval.
   */
  analyzePosition(fen: string, opts: AnalyzeOptions = {}): Promise<EngineEval> {
    return this.engine.analyze(fen, opts);
  }

  /**
   * Evaluate a single played move against the engine's best move.
   *
   * Evals `fenBefore` (best move + score) and the position after `san` is played,
   * then measures how much worse the played move left things *from the moving
   * side's point of view*. The resulting centipawn loss drives the classification.
   */
  async evaluateMove(
    fenBefore: string,
    san: string,
    opts: AnalyzeOptions = {},
  ): Promise<MoveEval> {
    // Resolve the played move first so an illegal SAN fails fast (and cheaply,
    // before we spend an engine search on the prior position).
    const { fen: fenAfter, move } = this.chess.applySan(fenBefore, san);

    const before = await this.engine.analyze(fenBefore, opts);
    const after = await this.engine.analyze(fenAfter, opts);

    // EngineEval scores are White-POV; convert to the mover's POV so a positive
    // cp-loss always means "this move hurt the side that made it".
    const moverSign = move.color === "w" ? 1 : -1;
    const scoreCpBefore = topScoreCp(before);
    const scoreCpAfter = topScoreCp(after);

    // A move into a terminal position (checkmate / stalemate) yields no engine
    // lines, so povCp() would read 0 — making a *mating* move look like a total
    // loss (and get flagged as a blunder). Resolve the score from the position
    // itself in that case.
    const afterWhiteCp = terminalWhitePovCp(fenAfter) ?? povCp(after);
    const beforePov = moverSign * povCp(before);
    const afterPov = moverSign * afterWhiteCp;
    const cpLoss = Math.max(0, beforePov - afterPov);

    return {
      // A standalone position has no ply context; analyzeGame overrides this
      // with the move's real ply from the game.
      ply: 0,
      san: move.san,
      scoreCpBefore,
      scoreCpAfter,
      cpLoss,
      classification: this.chess.classify(cpLoss),
      bestMove: before.bestMove,
      bestLine: before.lines[0]?.pv ?? [],
    };
  }

  /**
   * Analyze every ply of a game (sent by value), building the eval curve. Runs
   * each ply through the engine sequentially (the engine serializes internally
   * anyway) and returns the curve — the caller owns persisting it, if at all.
   */
  async analyzeGame(
    game: Game,
    depth = DEFAULT_GAME_DEPTH,
  ): Promise<MoveEval[]> {
    const opts: AnalyzeOptions = { depth };
    const evals: MoveEval[] = [];
    for (const move of game.moves) {
      const moveEval = await this.evaluateMove(move.fenBefore, move.san, opts);
      // Trust the game's own ply over whatever applySan reconstructed.
      evals.push({ ...moveEval, ply: move.ply });
    }

    return evals;
  }

  /**
   * Walk a SAN variation from `fen`, returning the engine eval of the position
   * after each move. Useful for "explain this line" — one eval per ply played.
   *
   * @throws BadRequestException (via ChessService) if a move in the line is illegal.
   */
  async explainVariation(
    fen: string,
    line: string[],
    opts: AnalyzeOptions = {},
  ): Promise<{ ply: string; eval: EngineEval }[]> {
    const out: { ply: string; eval: EngineEval }[] = [];
    let current = fen;
    for (const san of line) {
      const { fen: next, move } = this.chess.applySan(current, san);
      const evaluation = await this.engine.analyze(next, opts);
      out.push({ ply: move.san, eval: evaluation });
      current = next;
    }
    return out;
  }
}

/**
 * Top-line score as a plain centipawn number for the cp-loss subtraction,
 * folding mate-in-N into a large signed centipawn value (White-POV). A line with
 * no usable score (shouldn't happen for a legal position) contributes 0.
 */
function povCp(evaluation: EngineEval): number {
  const line = evaluation.lines[0];
  if (!line) return 0;
  if (line.mate !== null) {
    // +mate => White mates; -mate => Black mates. Nearer mates rank higher.
    const sign = line.mate >= 0 ? 1 : -1;
    return sign * (MATE_SCORE_CP - Math.abs(line.mate));
  }
  return line.scoreCp ?? 0;
}

/**
 * Top-line centipawn score for storage on the MoveEval (White-POV). Mate lines
 * have no finite centipawn value, so they surface as `null` here — the cp-loss
 * math still accounts for them via {@link povCp}.
 */
function topScoreCp(evaluation: EngineEval): number | null {
  const line = evaluation.lines[0];
  if (!line) return null;
  return line.scoreCp;
}

/**
 * White-POV score for a TERMINAL position, where the engine returns no lines.
 * Checkmate → the side to move is mated, so the *other* color gets ±MATE_SCORE_CP
 * (White-POV); stalemate / dead draws → 0; any non-terminal position → null, so
 * callers fall back to the engine's evaluation. This stops a mate-delivering move
 * from being scored as a catastrophic loss (its post-position has no engine eval).
 */
export function terminalWhitePovCp(fen: string): number | null {
  const chess = new Chess(fen);
  if (chess.isCheckmate()) {
    // The side to move is checkmated; the winner is the other color.
    return chess.turn() === "b" ? MATE_SCORE_CP : -MATE_SCORE_CP;
  }
  if (chess.isStalemate() || chess.isInsufficientMaterial() || chess.isDraw()) {
    return 0;
  }
  return null;
}
