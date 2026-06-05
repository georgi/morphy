import type { AgentEvent, Game, Move } from '@chess/shared';

// The Pi Agent SDK is ESM-only and its native dynamic import can't load under
// Jest's CJS VM (the reason agent tools have no spec yet). `defineTool` only
// shapes a definition object — stub the loader so it returns the definition
// verbatim, leaving each tool's real `execute` (the code under test) intact.
jest.mock('./pi-loader', () => ({
  loadPiSdk: jest.fn(async () => ({
    defineTool: (def: unknown) => def,
  })),
}));

import { openDatabase, type Db } from '../persistence/database';
import { GamesRepository } from '../persistence/games.repository';
import { CollectionsRepository } from '../persistence/collections.repository';
import { LibraryService } from '../library/library.service';
import { ChessService } from '../chess/chess.service';
import { GameStore } from '../chess/game.store';
import type { AnalysisService } from '../analysis/analysis.service';
import type { CoachService } from '../analysis/coach.service';
import { ChessToolsService } from './chess-tools.service';
import type { ToolSessionContext } from './chess-tools.service';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function move(ply: number, san: string): Move {
  return {
    ply,
    moveNumber: Math.floor((ply - 1) / 2) + 1,
    color: ply % 2 === 1 ? 'w' : 'b',
    san,
    uci: '0000',
    fenBefore: START_FEN,
    fenAfter: START_FEN,
  };
}

function makeGame(id: string, headers: Record<string, string>): Game {
  return {
    id,
    headers,
    startFen: START_FEN,
    moves: [move(1, 'e4'), move(2, 'e5')],
  };
}

/**
 * A handle on a built tool: the SDK's `defineTool` returns objects with
 * `name`/`execute`, which is all these thin library tools need at the unit level.
 */
interface BuiltTool {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{
    content: { type: 'text'; text: string }[];
    details: Record<string, unknown>;
  }>;
}

/**
 * Unit coverage for the three library agent tools (`search_library`,
 * `open_game`, `list_collections`). They are thin wrappers over the real
 * {@link LibraryService} (backed by real repositories on an in-memory SQLite DB —
 * never mocked), so we drive them through the actual `buildToolsForSession`
 * registry and assert they delegate correctly and that `open_game` emits a
 * `board_update`. The analysis/coach services are unused by these tools, so they
 * are passed as inert stubs.
 */
describe('Library agent tools', () => {
  let db: Db;
  let games: GamesRepository;
  let collections: CollectionsRepository;
  let tools: ChessToolsService;
  let emitted: AgentEvent[];
  let ctx: ToolSessionContext;
  let built: Record<string, BuiltTool>;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    games = new GamesRepository(db);
    collections = new CollectionsRepository(db);
    const library = new LibraryService(games, collections);

    // The library tools never call analysis/coach; inert stubs keep the
    // constructor satisfied without spawning the engine.
    const analysis = {} as AnalysisService;
    const coach = {} as CoachService;
    tools = new ChessToolsService(
      new ChessService(),
      new GameStore(games),
      analysis,
      coach,
      library,
    );

    const coll = collections.create({
      name: 'Sicilians',
      source: 'lichess',
      sourceRef: 'user/x',
    });
    games.create(
      makeGame('m', {
        white: 'Magnus Carlsen',
        black: 'Hikaru Nakamura',
        result: '1-0',
        eco: 'B90',
        opening: 'Sicilian Najdorf',
        date: '2021.01.01',
      }),
      { source: 'lichess', collectionId: coll.id },
    );
    games.create(
      makeGame('f', {
        white: 'Bobby Fischer',
        black: 'Boris Spassky',
        result: '0-1',
        eco: 'C95',
        opening: 'Ruy Lopez',
        date: '1972.07.11',
      }),
      { source: 'manual' },
    );
    collections.recountGames(coll.id);

    emitted = [];
    ctx = {
      emit: (event) => emitted.push(event),
      getContext: () => ({}),
    };

    const list = await tools.buildToolsForSession(ctx);
    built = Object.fromEntries(
      (list as unknown as BuiltTool[]).map((t) => [t.name, t]),
    );
  });

  afterEach(() => {
    db.close();
  });

  it('registers the three library tools', () => {
    expect(built.search_library).toBeDefined();
    expect(built.open_game).toBeDefined();
    expect(built.list_collections).toBeDefined();
  });

  describe('search_library', () => {
    it('returns all games as summaries with the total', async () => {
      const res = await built.search_library.execute('1', {});
      expect(res.details.total).toBe(2);
      const summaries = res.details.games as { id: string }[];
      expect(summaries.map((g) => g.id).sort()).toEqual(['f', 'm']);
      expect(res.content[0].text).toContain('matching game');
    });

    it('filters by free-text q (delegating to LibraryService)', async () => {
      const res = await built.search_library.execute('1', { q: 'ruy' });
      const summaries = res.details.games as { id: string }[];
      expect(summaries.map((g) => g.id)).toEqual(['f']);
      expect(res.details.total).toBe(1);
    });

    it('filters by source and result', async () => {
      const res = await built.search_library.execute('1', {
        source: 'lichess',
        result: '1-0',
      });
      const summaries = res.details.games as { id: string }[];
      expect(summaries.map((g) => g.id)).toEqual(['m']);
    });

    it('reports an empty result clearly', async () => {
      const res = await built.search_library.execute('1', { q: 'no-such-game' });
      expect(res.details.total).toBe(0);
      expect(res.content[0].text).toMatch(/no games match/i);
    });
  });

  describe('open_game', () => {
    it('loads the game and emits a board_update at ply 0', async () => {
      const res = await built.open_game.execute('1', { id: 'm' });
      expect(res.details.gameId).toBe('m');
      expect(res.content[0].text).toContain('Magnus Carlsen vs Hikaru Nakamura');

      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toEqual({
        type: 'board_update',
        fen: START_FEN,
        gameId: 'm',
        ply: 0,
      });
    });

    it('errors (no board_update) for an unknown id', async () => {
      const res = await built.open_game.execute('1', { id: 'nope' });
      expect(res.details.error).toMatch(/not found/i);
      expect(emitted).toHaveLength(0);
    });
  });

  describe('list_collections', () => {
    it('lists collections with their game counts', async () => {
      const res = await built.list_collections.execute('1', {});
      const cols = res.details.collections as { name: string; gameCount: number }[];
      expect(cols).toHaveLength(1);
      expect(cols[0]).toMatchObject({ name: 'Sicilians', gameCount: 1 });
      expect(res.content[0].text).toContain('Sicilians');
    });
  });
});
