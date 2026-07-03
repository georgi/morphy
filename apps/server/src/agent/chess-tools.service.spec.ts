import type { AgentEvent, Game } from '@chess/shared';

import { ChessService } from '../chess/chess.service';
import type { AnalysisService } from '../analysis/analysis.service';
import type { CoachService } from '../analysis/coach.service';
import { ChessToolsService } from './chess-tools.service';
import type { ToolSessionContext } from './chess-tools.service';

const SCHOLARS_MATE_PGN = '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0';

/**
 * A handle on a built tool: `defineAgentTool` returns objects with `name`/`execute`,
 * which is all these thin tools need at the unit level. `execute` takes only the
 * parsed params (no SDK tool-call id).
 */
interface BuiltTool {
  name: string;
  execute: (params: Record<string, unknown>) => Promise<{
    content: { type: 'text'; text: string }[];
    details: Record<string, unknown>;
  }>;
}

/**
 * A mutable session context whose current game the tools read/replace by value —
 * mirroring how {@link AgentService} mutates the same object in place so the tool
 * closures always see the latest game.
 */
function makeCtx(initial: { game?: Game; ply?: number } = {}) {
  const state: { game?: Game; ply?: number } = { ...initial };
  const emitted: AgentEvent[] = [];
  const ctx: ToolSessionContext = {
    emit: (event) => emitted.push(event),
    getContext: () => state,
    setGame: (game) => {
      state.game = game;
    },
  };
  return { ctx, emitted, state };
}

/**
 * Unit coverage for the by-value agent tools. Since the migration to a
 * client-owned library, the tools operate on the game held on the
 * {@link ToolSessionContext} (no shared store, no library) — so we drive them
 * through the real `buildToolsForSession` registry with a real {@link ChessService}
 * and inert analysis/coach stubs (these tests never reach the engine).
 */
describe('Chess agent tools (by value)', () => {
  let chess: ChessService;
  let tools: ChessToolsService;

  beforeEach(() => {
    chess = new ChessService();
    // These tools never call analysis/coach; inert stubs keep the constructor
    // satisfied without spawning the engine.
    const analysis = {} as AnalysisService;
    const coach = {} as CoachService;
    tools = new ChessToolsService(chess, analysis, coach);
  });

  async function build(
    ctx: ToolSessionContext,
  ): Promise<Record<string, BuiltTool>> {
    const list = await tools.buildToolsForSession(ctx);
    return Object.fromEntries(
      (list as unknown as BuiltTool[]).map((t) => [t.name, t]),
    );
  }

  it('does not register the removed cross-library tools', async () => {
    const { ctx } = makeCtx();
    const built = await build(ctx);

    expect(built.search_library).toBeUndefined();
    expect(built.open_game).toBeUndefined();
    expect(built.list_collections).toBeUndefined();

    // The core by-value tools remain.
    for (const name of [
      'load_pgn',
      'load_fen',
      'get_position',
      'goto_move',
      'analyze_game',
      'identify_opening',
      'start_review',
    ]) {
      expect(built[name]).toBeDefined();
    }
  });

  it('get_position reads the by-value game from the session context', async () => {
    const game = chess.importPgn(SCHOLARS_MATE_PGN);
    const { ctx } = makeCtx({ game });
    const built = await build(ctx);

    const res = await built.get_position.execute({ ply: 2 });

    expect(res.details.gameId).toBe(game.id);
    expect(res.details.ply).toBe(2);
    expect(res.details.fen).toBe(chess.positionAtPly(game, 2));
  });

  it('load_pgn sets the session current game and emits a board_update', async () => {
    const { ctx, emitted, state } = makeCtx();
    const built = await build(ctx);

    const res = await built.load_pgn.execute({ pgn: SCHOLARS_MATE_PGN });

    // The game now lives on the session context (no store write).
    expect(state.game).toBeDefined();
    expect(state.game?.id).toBe(res.details.gameId);
    expect(state.game?.moves).toHaveLength(7); // Scholar's Mate: 7 half-moves.

    // Board driven to the starting position of the freshly loaded game.
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({
      type: 'board_update',
      fen: state.game?.startFen,
      gameId: state.game?.id,
      ply: 0,
    });

    // A follow-up tool that takes no game reads the game load_pgn just set.
    const pos = await built.get_position.execute({ ply: 1 });
    expect(pos.details.gameId).toBe(state.game?.id);
    expect(pos.details.fen).toBe(chess.positionAtPly(state.game as Game, 1));
  });

  it('returns the not-found message when no game is loaded', async () => {
    const { ctx, emitted } = makeCtx();
    const built = await build(ctx);

    const res = await built.get_position.execute({ ply: 0 });

    expect(res.details.error).toMatch(/no game/i);
    expect(res.content[0].text).toMatch(/no game/i);
    expect(emitted).toHaveLength(0);
  });
});
