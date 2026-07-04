import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Res,
} from "@nestjs/common";
import type {
  AnalyzeGameRequest,
  AnalyzeGameStreamEvent,
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
 * HTTP 503 by the engine exception filter. `/game`, `/game/stream`, and
 * `/key-moments` are by-value: the client sends the `Game` in the body and owns
 * persisting the result — there is no server-side game lookup, so a missing/empty
 * game is a 400 (validation), never a 404.
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
   * Streaming variant of `/game`: same per-ply scan, but emits an SSE frame
   * after each ply so the client can show live Stockfish progress (X / N moves)
   * and light up the eval bar incrementally. Terminal `done`/`error` frames
   * carry the full curve / the failure message. The game is sent by value in
   * the POST body (same as `/game`), so this is a one-shot stream, not a
   * resumable job — there is no server-side job state.
   */
  @Post("game/stream")
  async analyzeGameStream(
    @Body() body: AnalyzeGameRequest,
    @Res() res: SseResponse,
  ): Promise<void> {
    const game = requireGame(body?.game, 'Provide a "game" to analyze.');
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    // Disable proxy buffering (nginx etc.) so frames flush immediately.
    res.setHeader("X-Accel-Buffering", "no");
    const send = (event: AnalyzeGameStreamEvent) =>
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    try {
      const evals = await this.analysis.analyzeGame(
        game,
        body.depth,
        (current, total) => {
          const last = current[current.length - 1];
          if (last) send({ type: "progress", ply: last.ply, total, eval: last });
        },
      );
      send({ type: "done", evals });
    } catch (err) {
      send({ type: "error", message: errorMessage(err) });
    } finally {
      res.end();
    }
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

/** Stringify an unknown error the same way the import stream does. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "Analysis failed.";
}

/** Minimal shape of the Express response the SSE handler uses (avoids a hard
 * dep on `@types/express`). */
interface SseResponse {
  setHeader(name: string, value: string | number | string[]): this;
  write(chunk: string | Uint8Array): boolean;
  end(): void;
}

/** Validate a by-value `Game` from a request body, or 400. */
function requireGame(game: Game | undefined | null, message: string): Game {
  if (!game || !game.id || !Array.isArray(game.moves)) {
    throw new BadRequestException(message);
  }
  return game;
}
