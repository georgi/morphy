import { Injectable } from '@nestjs/common';
import { Type } from '@sinclair/typebox';
import type { EngineEval, TurningPoint } from '@chess/shared';
import { ChessService } from '../chess/chess.service';
import { AnalysisService } from '../analysis/analysis.service';
import { CoachService } from '../analysis/coach.service';
import { defineAgentTool, type AgentTool } from './harness/agent-tool';
import type { ToolSessionContext } from './harness/agent-tool';

// Re-export so existing imports (`import type { ToolSessionContext } from
// './chess-tools.service'`) keep working after the type moved into the harness.
export type { ToolSessionContext } from './harness/agent-tool';

/** Cap on tool text returned to the model, to avoid blowing up the context window. */
const MAX_TOOL_TEXT = 8_000;

/**
 * Builds the backend-neutral agent tool registry. Every tool is a thin wrapper
 * that delegates to ChessService / AnalysisService / CoachService and returns a
 * text-content result. Tools operate on the session's CURRENT GAME, held by value
 * on the {@link ToolSessionContext} (the client sends it with each message);
 * `load_pgn`/`load_fen` replace it. Tools that move the board the user sees
 * (`load_pgn`, `load_fen`, `goto_move`) additionally emit a `board_update` event
 * so the client follows the agent. The active {@link AgentHarness} wraps these
 * tools onto its own SDK's tool shape.
 */
@Injectable()
export class ChessToolsService {
  constructor(
    private readonly chess: ChessService,
    private readonly analysis: AnalysisService,
    private readonly coach: CoachService,
  ) {}

  /**
   * Build the full tool set bound to a single chat session's context. Async to
   * keep the signature stable for callers, though tool construction is now
   * synchronous (no SDK import — the harness wraps these neutral tools).
   */
  async buildToolsForSession(
    ctx: ToolSessionContext,
  ): Promise<AgentTool[]> {
    // Per-session interactive-review cursor, shared by the three coaching tools
    // below. `buildToolsForSession` runs once per chat session, so this closure
    // variable carries the review state across the session's tool calls without a
    // separate store. `null` until start_review begins one.
    let review: {
      gameId: string;
      points: TurningPoint[];
      cursor: number;
    } | null = null;

    // ── load_pgn ───────────────────────────────────────────────────────────
    const loadPgn = defineAgentTool({
      name: 'load_pgn',
      label: 'Load PGN',
      description:
        'Import a chess game from PGN text. Returns the new gameId, headers, ' +
        'move count, and identified opening. Drives the board to the starting ' +
        'position. Use this when the user pastes a game.',
      parameters: Type.Object({
        pgn: Type.String({ description: 'The full PGN text of the game.' }),
      }),
      execute: async (params) => {
        const game = this.chess.importPgn(params.pgn);
        ctx.setGame(game);
        ctx.emit({
          type: 'board_update',
          fen: game.startFen,
          gameId: game.id,
          ply: 0,
        });
        const opening = game.headers.opening
          ? `${game.headers.eco ?? ''} ${game.headers.opening}`.trim()
          : 'unknown';
        const players = [game.headers.white, game.headers.black]
          .filter(Boolean)
          .join(' vs ');
        const text = [
          `Loaded game ${game.id}.`,
          players ? `Players: ${players}.` : null,
          game.headers.result ? `Result: ${game.headers.result}.` : null,
          `Moves: ${game.moves.length} (${Math.ceil(game.moves.length / 2)} full moves).`,
          `Opening: ${opening}.`,
          `Starting FEN: ${game.startFen}`,
        ]
          .filter(Boolean)
          .join('\n');
        return this.textResult(text, { gameId: game.id });
      },
    });

    // ── load_fen ───────────────────────────────────────────────────────────
    const loadFen = defineAgentTool({
      name: 'load_fen',
      label: 'Load FEN',
      description:
        'Import a single position from a FEN string as a new game. Returns the ' +
        'new gameId and drives the board to that position.',
      parameters: Type.Object({
        fen: Type.String({ description: 'A valid FEN position string.' }),
      }),
      execute: async (params) => {
        const game = this.chess.importFen(params.fen);
        ctx.setGame(game);
        ctx.emit({
          type: 'board_update',
          fen: game.startFen,
          gameId: game.id,
          ply: 0,
        });
        return this.textResult(
          `Loaded position as game ${game.id}.\nFEN: ${game.startFen}`,
          { gameId: game.id },
        );
      },
    });

    // ── get_position ─────────────────────────────────────────────────────────
    const getPosition = defineAgentTool({
      name: 'get_position',
      label: 'Get Position',
      description:
        'Return the FEN of the current game at a given ply (half-move). Ply 0 is ' +
        'the starting position; ply N is the position after the N-th half-move. ' +
        'Omit ply to use the position the user is currently viewing.',
      parameters: Type.Object({
        ply: Type.Optional(
          Type.Number({
            description:
              'Half-move index. Defaults to the current ply (or 0).',
          }),
        ),
      }),
      execute: async (params) => {
        const game = ctx.getContext().game;
        if (!game) {
          return this.errorResult('No game loaded. Load a game first.');
        }
        const ply = params.ply ?? ctx.getContext().ply ?? 0;
        const fen = this.chess.positionAtPly(game, ply);
        const move = ply > 0 ? game.moves[Math.min(ply, game.moves.length) - 1] : undefined;
        const movePart = move ? ` after ${move.san} (${move.color === 'w' ? 'White' : 'Black'})` : '';
        return this.textResult(
          `Game ${game.id} at ply ${ply}${movePart}:\nFEN: ${fen}`,
          { gameId: game.id, ply, fen },
        );
      },
    });

    // ── list_legal_moves ─────────────────────────────────────────────────────
    const listLegalMoves = defineAgentTool({
      name: 'list_legal_moves',
      label: 'List Legal Moves',
      description: 'List all legal moves (in SAN) from a position given by FEN.',
      parameters: Type.Object({
        fen: Type.String({ description: 'The position FEN.' }),
      }),
      execute: async (params) => {
        const moves = this.chess.legalMoves(params.fen);
        return this.textResult(
          `${moves.length} legal moves: ${moves.join(', ')}`,
          { count: moves.length, moves },
        );
      },
    });

    // ── material_balance ─────────────────────────────────────────────────────
    const materialBalance = defineAgentTool({
      name: 'material_balance',
      label: 'Material Balance',
      description:
        'Compute the material count for both sides (pawn=1, knight/bishop=3, ' +
        'rook=5, queen=9) and the signed difference (positive favors White).',
      parameters: Type.Object({
        fen: Type.String({ description: 'The position FEN.' }),
      }),
      execute: async (params) => {
        const balance = this.chess.materialBalance(params.fen);
        const lead =
          balance.diff === 0
            ? 'Material is even.'
            : `${balance.diff > 0 ? 'White' : 'Black'} is up ${Math.abs(balance.diff)}.`;
        return this.textResult(
          `White ${balance.white}, Black ${balance.black} (diff ${balance.diff}). ${lead}`,
          balance,
        );
      },
    });

    // ── goto_move ────────────────────────────────────────────────────────────
    const gotoMove = defineAgentTool({
      name: 'goto_move',
      label: 'Go To Move',
      description:
        'Navigate the board the user is looking at to a specific ply of the ' +
        'current game. Call this whenever you reference a position so the user ' +
        'sees what you are talking about. Ply 0 is the start; ply N is after the ' +
        'N-th half-move.',
      parameters: Type.Object({
        ply: Type.Number({ description: 'Half-move index to navigate to.' }),
      }),
      execute: async (params) => {
        const game = ctx.getContext().game;
        if (!game) {
          return this.errorResult('No game loaded. Load a game first.');
        }
        const ply = Math.max(0, Math.min(params.ply, game.moves.length));
        const fen = this.chess.positionAtPly(game, ply);
        ctx.emit({ type: 'board_update', fen, gameId: game.id, ply });
        const move = ply > 0 ? game.moves[ply - 1] : undefined;
        const movePart = move ? ` (after ${move.san})` : '';
        return this.textResult(
          `Board moved to ply ${ply}${movePart} of game ${game.id}.\nFEN: ${fen}`,
          { gameId: game.id, ply, fen },
        );
      },
    });

    // ── analyze_position ─────────────────────────────────────────────────────
    const analyzePosition = defineAgentTool({
      name: 'analyze_position',
      label: 'Analyze Position',
      description:
        'Run the chess engine on a position (FEN) and return the best move and ' +
        'top engine lines with evaluations (centipawns from White, or mate-in-N).',
      parameters: Type.Object({
        fen: Type.String({ description: 'The position FEN to analyze.' }),
        depth: Type.Optional(
          Type.Number({ description: 'Search depth (default ~18).' }),
        ),
        multipv: Type.Optional(
          Type.Number({ description: 'Number of top lines to return (default 1).' }),
        ),
      }),
      execute: async (params) => {
        const evaluation = await this.analysis.analyzePosition(params.fen, {
          depth: params.depth,
          multipv: params.multipv,
        });
        return this.textResult(this.formatEngineEval(evaluation), evaluation);
      },
    });

    // ── evaluate_move ────────────────────────────────────────────────────────
    const evaluateMove = defineAgentTool({
      name: 'evaluate_move',
      label: 'Evaluate Move',
      description:
        'Evaluate a played move (SAN) from a position (FEN) against the engine ' +
        "best move. Returns the centipawn loss and a classification (best/good/" +
        'inaccuracy/mistake/blunder) — use this to explain why a move was good or bad.',
      parameters: Type.Object({
        fen: Type.String({ description: 'The position before the move (FEN).' }),
        san: Type.String({ description: 'The played move in SAN, e.g. "Nf3".' }),
      }),
      execute: async (params) => {
        const result = await this.analysis.evaluateMove(params.fen, params.san);
        const bestLine = result.bestLine.length
          ? ` Best line: ${result.bestLine.join(' ')}.`
          : '';
        const text =
          `${result.san} is a ${result.classification} ` +
          `(centipawn loss ${result.cpLoss}). ` +
          `Best move was ${result.bestMove ?? 'n/a'}.${bestLine}`;
        return this.textResult(text, result);
      },
    });

    // ── analyze_game ─────────────────────────────────────────────────────────
    const analyzeGame = defineAgentTool({
      name: 'analyze_game',
      label: 'Analyze Game',
      description:
        'Scan every move of the current game with the engine, building the eval ' +
        'curve and flagging inaccuracies, mistakes, and blunders.',
      parameters: Type.Object({}),
      execute: async () => {
        const game = ctx.getContext().game;
        if (!game) {
          return this.errorResult('No game to analyze. Load a game first.');
        }
        const evals = await this.analysis.analyzeGame(game);
        const flagged = evals.filter((e) =>
          ['inaccuracy', 'mistake', 'blunder'].includes(e.classification),
        );
        const lines = flagged.map(
          (e) =>
            `ply ${e.ply} ${e.san}: ${e.classification} ` +
            `(cp loss ${e.cpLoss}, best ${e.bestMove ?? 'n/a'})`,
        );
        const summary =
          `Analyzed ${evals.length} moves of game ${game.id}. ` +
          `${flagged.length} flagged.` +
          (lines.length ? `\n${lines.join('\n')}` : '');
        return this.textResult(summary, { gameId: game.id, evals });
      },
    });

    // ── explain_variation ────────────────────────────────────────────────────
    const explainVariation = defineAgentTool({
      name: 'explain_variation',
      label: 'Explain Variation',
      description:
        'Play a SAN line out from a position (FEN) and return the engine eval ' +
        'after each move, so you can explain how a variation unfolds.',
      parameters: Type.Object({
        fen: Type.String({ description: 'The starting position (FEN).' }),
        line: Type.Array(Type.String(), {
          description: 'The variation as an ordered list of SAN moves.',
        }),
      }),
      execute: async (params) => {
        const steps = await this.analysis.explainVariation(
          params.fen,
          params.line,
        );
        const lines = steps.map(
          (s) => `${s.ply}: ${this.formatScore(s.eval)}`,
        );
        return this.textResult(
          `Variation ${params.line.join(' ')}:\n${lines.join('\n')}`,
          { steps },
        );
      },
    });

    // ── identify_opening ─────────────────────────────────────────────────────
    const identifyOpening = defineAgentTool({
      name: 'identify_opening',
      label: 'Identify Opening',
      description:
        'Identify the opening (ECO code + name) from the current game or from a ' +
        'FEN / PGN / list of SAN moves. Uses the bundled ECO table. Omit fen to ' +
        'use the current game.',
      parameters: Type.Object({
        fen: Type.Optional(
          Type.String({
            description:
              'A FEN or PGN string to identify (alternative to the current game).',
          }),
        ),
      }),
      execute: async (params) => {
        let opening: { eco?: string; name?: string };
        if (params.fen) {
          opening = this.chess.identifyOpening(params.fen);
        } else {
          const game = ctx.getContext().game;
          if (!game) {
            return this.errorResult('Provide a fen/pgn, or load a game first.');
          }
          opening = {
            eco: game.headers.eco,
            name: game.headers.opening,
          };
          if (!opening.eco && !opening.name) {
            opening = this.chess.identifyOpening(game.moves.map((m) => m.san));
          }
        }
        const text =
          opening.eco || opening.name
            ? `Opening: ${[opening.eco, opening.name].filter(Boolean).join(' ')}.`
            : 'Opening could not be identified from the bundled ECO table.';
        return this.textResult(text, opening);
      },
    });

    // ── start_review ─────────────────────────────────────────────────────────
    const startReview = defineAgentTool({
      name: 'start_review',
      label: 'Start Review',
      description:
        'Begin an interactive, move-by-move coaching review of a game. Finds the ' +
        "few biggest mistakes, moves the board to the position BEFORE the first " +
        'one, and puts the UI into quiz mode so the user can try to find a better ' +
        'move. Returns the setup for that first turning point — whose move it is, ' +
        'what was actually played, and how bad it was — but NOT the best move (do ' +
        'not reveal it; ask the user to find it). Reviews the current game. Call ' +
        'score_guess once the user answers.',
      parameters: Type.Object({
        max: Type.Optional(
          Type.Number({
            description: 'How many turning points to review (default 5).',
          }),
        ),
      }),
      execute: async (params) => {
        const game = ctx.getContext().game;
        if (!game) {
          return this.errorResult(
            'No game to review. Ask the user to import a game first.',
          );
        }
        const points = await this.coach.computeTurningPoints(game, {
          max: params.max,
        });
        review = { gameId: game.id, points, cursor: 0 };
        if (points.length === 0) {
          return this.textResult(
            'No significant mistakes found — the game was cleanly played. ' +
              'Tell the user so and offer to look at anything specific.',
            { gameId: game.id, total: 0 },
          );
        }
        return this.presentTurningPoint(ctx, game.id, points[0], points.length);
      },
    });

    // ── score_guess ──────────────────────────────────────────────────────────
    const scoreGuess = defineAgentTool({
      name: 'score_guess',
      label: 'Score Guess',
      description:
        "Score the user's attempt at the current turning point and reveal the " +
        'answer. Pass their move in SAN (e.g. "Nf3") to grade it against the ' +
        'engine; omit san if they gave up or asked to see the answer. Reveals the ' +
        'engine best move and line and draws the best-move arrow on the board. ' +
        'Requires an active review (call start_review first).',
      parameters: Type.Object({
        san: Type.Optional(
          Type.String({
            description:
              "The user's move in SAN. Omit to just reveal the answer.",
          }),
        ),
      }),
      execute: async (params) => {
        const point = this.currentReviewPoint(review);
        if (!point) {
          return this.errorResult(
            'No active turning point. Call start_review to begin a review.',
          );
        }

        let verdict: 'correct' | 'close' | 'off' | 'revealed';
        let cpLoss: number | null = null;
        if (params.san) {
          let moveEval;
          try {
            moveEval = await this.analysis.evaluateMove(
              point.fenBefore,
              params.san,
            );
          } catch {
            // Illegal/unparseable SAN — don't reveal; let the agent re-ask.
            return this.textResult(
              `"${params.san}" is not a legal move in this position. Ask the ` +
                'user to try a different move (do not reveal the answer yet).',
              { illegal: true, san: params.san },
            );
          }
          cpLoss = moveEval.cpLoss;
          verdict = cpLoss <= 20 ? 'correct' : cpLoss <= 60 ? 'close' : 'off';
        } else {
          verdict = 'revealed';
        }

        const evalText = this.formatTurningPointEval(point);
        ctx.emit({
          type: 'coach_reveal',
          ply: point.ply,
          bestMove: point.bestMove,
          bestLine: point.bestLine,
          playedSan: point.playedSan,
          userSan: params.san,
          verdict,
          evalText,
        });

        const lineText = point.bestLine.length
          ? ` Best line: ${point.bestLine.join(' ')}.`
          : '';
        const compared = this.describeGuess(verdict, params.san, cpLoss);
        const text =
          `The engine's best move was ${point.bestMove ?? 'n/a'} ` +
          `(${evalText}).${lineText} ` +
          `The user actually played ${point.playedSan}. ${compared}`;
        return this.textResult(text, {
          verdict,
          best: point.bestMove,
          cpLoss,
        });
      },
    });

    // ── next_turning_point ───────────────────────────────────────────────────
    const nextTurningPoint = defineAgentTool({
      name: 'next_turning_point',
      label: 'Next Turning Point',
      description:
        'Advance the interactive review to the next turning point: moves the ' +
        'board to the position before it and puts the UI back into quiz mode. ' +
        'Returns the setup WITHOUT the best move (ask the user to find it). When ' +
        'the review is finished it reports { done: true } — wrap up the lesson ' +
        'then. Requires an active review.',
      parameters: Type.Object({}),
      execute: async () => {
        if (!review) {
          return this.errorResult(
            'No active review. Call start_review to begin one.',
          );
        }
        review.cursor += 1;
        if (review.cursor >= review.points.length) {
          return this.textResult('Review complete.', { done: true });
        }
        return this.presentTurningPoint(
          ctx,
          review.gameId,
          review.points[review.cursor],
          review.points.length,
        );
      },
    });

    // Each tool is internally well-typed against its own TObject schema; the
    // registry erases the per-tool param type to the neutral `AgentTool[]` (the
    // schemas are heterogeneous, and `execute`'s param is contravariant, so they
    // don't unify under `AgentTool<TSchema>` without this widening).
    const tools: AgentTool[] = [
      loadPgn,
      loadFen,
      getPosition,
      listLegalMoves,
      materialBalance,
      gotoMove,
      analyzePosition,
      evaluateMove,
      analyzeGame,
      explainVariation,
      identifyOpening,
      startReview,
      scoreGuess,
      nextTurningPoint,
    ] as unknown as AgentTool[];
    return tools;
  }

  // ── coaching helpers ─────────────────────────────────────────────────────

  /**
   * Move the board to a turning point (the position BEFORE the mistake) and put
   * the UI into quiz mode by emitting `board_update` + `coach_question`, then
   * return the quiz setup for the agent. Deliberately omits the best move/line so
   * the agent can't leak the answer before the user has tried.
   */
  private presentTurningPoint(
    ctx: ToolSessionContext,
    gameId: string,
    point: TurningPoint,
    total: number,
  ) {
    ctx.emit({
      type: 'board_update',
      fen: point.fenBefore,
      gameId,
      ply: point.ply - 1,
    });
    ctx.emit({
      type: 'coach_question',
      gameId,
      ply: point.ply,
      fen: point.fenBefore,
      sideToMove: point.sideToMove,
      index: point.index,
      total,
    });
    const side = point.sideToMove === 'w' ? 'White' : 'Black';
    const text =
      `Turning point ${point.index + 1} of ${total} (move ${point.moveNumber}, ` +
      `${side} to move). ${side} played ${point.playedSan}, a ${point.classification} ` +
      `(cp loss ${point.cpLoss}). Ask the user to find a better move — do NOT ` +
      'reveal it. Wait for their answer, then call score_guess.';
    return this.textResult(text, {
      index: point.index,
      total,
      ply: point.ply,
      playedSan: point.playedSan,
      classification: point.classification,
    });
  }

  /**
   * The turning point the review is currently parked on, or `null` if there is no
   * active review or the cursor has run past the end.
   */
  private currentReviewPoint(
    review: { points: TurningPoint[]; cursor: number } | null,
  ): TurningPoint | null {
    if (!review) return null;
    return review.points[review.cursor] ?? null;
  }

  /** White-POV eval string for a turning point's position before the mistake. */
  private formatTurningPointEval(point: TurningPoint): string {
    if (point.scoreCpBefore === null) return 'unclear';
    const cp = point.scoreCpBefore;
    return `${cp >= 0 ? '+' : ''}${(cp / 100).toFixed(2)}`;
  }

  /** One-line description of how the user's guess compared to the best move. */
  private describeGuess(
    verdict: 'correct' | 'close' | 'off' | 'revealed',
    san: string | undefined,
    cpLoss: number | null,
  ): string {
    if (verdict === 'revealed') {
      return 'The user did not attempt a move; explain the idea behind the best move.';
    }
    const loss = cpLoss ?? 0;
    switch (verdict) {
      case 'correct':
        return `Their move ${san} is essentially as good (cp loss ${loss}) — confirm it and say why it works.`;
      case 'close':
        return `Their move ${san} is reasonable but inferior (cp loss ${loss}) — credit it, then point to the better move.`;
      default:
        return `Their move ${san} falls short (cp loss ${loss}) — teach the better move and why theirs is worse.`;
    }
  }

  // ── result helpers ─────────────────────────────────────────────────────────

  /** Build a normal tool result with text content (truncated) and structured details. */
  private textResult(text: string, details: unknown) {
    return {
      content: [{ type: 'text' as const, text: this.truncate(text) }],
      details: details as Record<string, unknown>,
    };
  }

  /** Build an error tool result. Returned (not thrown) so the agent can recover/report. */
  private errorResult(message: string) {
    return {
      content: [{ type: 'text' as const, text: this.truncate(message) }],
      details: { error: message } as Record<string, unknown>,
    };
  }

  private truncate(text: string): string {
    if (text.length <= MAX_TOOL_TEXT) return text;
    return `${text.slice(0, MAX_TOOL_TEXT)}\n…(truncated)`;
  }

  // ── formatting ───────────────────────────────────────────────────────────

  private formatEngineEval(evaluation: EngineEval): string {
    const header = `Best move: ${evaluation.bestMove ?? 'n/a'} (depth ${evaluation.depth}).`;
    const lines = evaluation.lines.map((line) => {
      const score =
        line.mate !== null
          ? `mate in ${line.mate}`
          : `${(line.scoreCp ?? 0) >= 0 ? '+' : ''}${((line.scoreCp ?? 0) / 100).toFixed(2)}`;
      return `  ${line.rank}. ${score}  ${line.pv.slice(0, 8).join(' ')}`;
    });
    return [header, ...lines].join('\n');
  }

  /** Compact White-POV score string for a single eval (top line). */
  private formatScore(evaluation: EngineEval): string {
    const line = evaluation.lines[0];
    if (!line) return 'no score';
    if (line.mate !== null) return `mate in ${line.mate}`;
    const cp = line.scoreCp ?? 0;
    return `${cp >= 0 ? '+' : ''}${(cp / 100).toFixed(2)}`;
  }
}
