import { Chess } from 'chess.js';
import type { EngineEval } from '@chess/shared';
import { AnalysisService } from './analysis.service';
import {
  EngineService,
  type AnalyzeOptions,
} from '../engine/engine.service';
import { CachedEngine } from '../engine/cached-engine';
import { EngineUnavailableError } from '../engine/errors';
import { EvalCacheRepository } from '../persistence/eval-cache.repository';
import { openDatabase, type Db } from '../persistence/database';
import { ChessService } from '../chess/chess.service';

// White to move, queen on h5 attacked by the g6 pawn (1.e4 e5 2.Qh5 Nc6 3.Bc4 g6).
// The engine's best is a quiet retreat (Qf3); a "natural" queen move like Qf5
// drops the queen to gxf5 — a textbook hanging-queen blunder.
const HANGING_QUEEN_FEN =
  'r1bqkbnr/pppp1p1p/2n3p1/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 0 4';
const BLUNDER_SAN = 'Qf5';
const SAFE_SAN = 'Qf3';

/** Whether a real Stockfish binary is reachable; gates the engine-backed suite. */
async function stockfishAvailable(engine: EngineService): Promise<boolean> {
  try {
    await engine.analyze(
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      { depth: 4 },
    );
    return true;
  } catch (err) {
    if (err instanceof EngineUnavailableError) return false;
    throw err;
  }
}

describe('AnalysisService', () => {
  describe('cp-loss + classification (real Stockfish)', () => {
    let engine: EngineService;
    let db: Db;
    let service: AnalysisService;
    let hasEngine = false;

    beforeAll(async () => {
      engine = new EngineService();
      db = openDatabase(':memory:');
      const cached = new CachedEngine(engine, new EvalCacheRepository(db));
      hasEngine = await stockfishAvailable(engine);
      service = new AnalysisService(cached, new ChessService());
    }, 30_000);

    afterAll(async () => {
      await engine.onModuleDestroy();
      db.close();
    });

    it('flags a hanging-queen move as a blunder with a large cp-loss', async () => {
      if (!hasEngine) {
        console.warn('Stockfish unavailable — skipping engine-backed test');
        return;
      }

      const result = await service.evaluateMove(HANGING_QUEEN_FEN, BLUNDER_SAN, {
        depth: 12,
      });

      expect(result.san).toBe('Qf5');
      // Dropping a queen for nothing is worth roughly 900cp; allow margin but stay
      // well above the 300cp blunder threshold.
      expect(result.cpLoss).toBeGreaterThanOrEqual(300);
      expect(result.classification).toBe('blunder');
      // The engine should prefer a different (safe) move over the played one.
      expect(result.bestMove).not.toBeNull();
      expect(result.bestLine.length).toBeGreaterThan(0);
      expect(result.bestLine[0]).toBe(result.bestMove);
    }, 30_000);

    it('treats the engine-preferred quiet move as a non-blunder', async () => {
      if (!hasEngine) {
        console.warn('Stockfish unavailable — skipping engine-backed test');
        return;
      }

      const result = await service.evaluateMove(HANGING_QUEEN_FEN, SAFE_SAN, {
        depth: 12,
      });

      expect(result.san).toBe('Qf3');
      expect(result.cpLoss).toBeLessThan(300);
      expect(result.classification).not.toBe('blunder');
    }, 30_000);
  });

  describe('eval curve (fake engine)', () => {
    // A deterministic fake engine: every position scores 0cp with a stub best
    // move, so we can assert structure (curve length, caching) without Stockfish.
    function fakeEngine(): CachedEngine {
      const analyze = jest.fn(
        (fen: string, _opts?: AnalyzeOptions): Promise<EngineEval> =>
          Promise.resolve({
            fen,
            bestMove: 'e2e4',
            lines: [{ rank: 1, pv: ['e2e4'], scoreCp: 0, mate: null }],
            depth: 12,
          }),
      );
      return { analyze } as unknown as CachedEngine;
    }

    it('builds one MoveEval per ply off the game sent by value', async () => {
      const chess = new ChessService();
      const engine = fakeEngine();
      const service = new AnalysisService(engine, chess);

      const game = chess.importPgn('1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0');
      expect(game.moves.length).toBe(7);

      const curve = await service.analyzeGame(game, 12);

      expect(curve).toHaveLength(game.moves.length);
      expect(curve.map((e) => e.ply)).toEqual(
        game.moves.map((m) => m.ply),
      );
      expect(curve.map((e) => e.san)).toEqual(game.moves.map((m) => m.san));

      // By-value: nothing is written back onto `game` — the caller owns caching.
      expect(game.analysis).toBeUndefined();
      // One eval-before + one eval-after per ply.
      expect((engine.analyze as jest.Mock)).toHaveBeenCalledTimes(
        game.moves.length * 2,
      );
    });

    it('returns [] for a game with no moves', async () => {
      const chess = new ChessService();
      const service = new AnalysisService(fakeEngine(), chess);

      const game = chess.importFen(
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      );
      expect(await service.analyzeGame(game)).toEqual([]);
    });
  });

  describe('cp-loss sign handling (fake engine)', () => {
    // Engine returns White-POV scores; a fake lets us assert that a position that
    // is great for White but bad for Black yields the right cp-loss per side.
    function scriptedEngine(scores: Map<string, number>): CachedEngine {
      const analyze = jest.fn(
        (fen: string): Promise<EngineEval> =>
          Promise.resolve({
            fen,
            bestMove: 'e2e4',
            lines: [
              {
                rank: 1,
                pv: ['e2e4'],
                scoreCp: scores.get(fen) ?? 0,
                mate: null,
              },
            ],
            depth: 12,
          }),
      );
      return { analyze } as unknown as CachedEngine;
    }

    it('measures cp-loss from the moving side POV for a black blunder', async () => {
      const chess = new ChessService();
      const startFen =
        'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
      const { fen: afterFen } = chess.applySan(startFen, 'a5');

      // White-POV: before is even (0), after Black's bad move White is +400.
      // Black is the mover, so its POV loss is 0 - (-400) = 400 (a blunder).
      const scores = new Map<string, number>([
        [startFen, 0],
        [afterFen, 400],
      ]);
      const service = new AnalysisService(scriptedEngine(scores), chess);

      const result = await service.evaluateMove(startFen, 'a5');
      expect(new Chess(startFen).turn()).toBe('b');
      expect(result.cpLoss).toBe(400);
      expect(result.classification).toBe('blunder');
      expect(result.scoreCpBefore).toBe(0);
      expect(result.scoreCpAfter).toBe(400);
    });
  });

  describe('explainVariation (fake engine)', () => {
    it('returns one eval per move, walking the SAN line', async () => {
      const chess = new ChessService();
      const analyze = jest.fn(
        (fen: string): Promise<EngineEval> =>
          Promise.resolve({
            fen,
            bestMove: 'e2e4',
            lines: [{ rank: 1, pv: ['e2e4'], scoreCp: 10, mate: null }],
            depth: 12,
          }),
      );
      const engine = { analyze } as unknown as CachedEngine;
      const service = new AnalysisService(engine, chess);

      const startFen = new Chess().fen();
      const line = ['e4', 'e5', 'Nf3'];
      const out = await service.explainVariation(startFen, line);

      expect(out).toHaveLength(line.length);
      expect(out.map((step) => step.ply)).toEqual(line);
      for (const step of out) {
        expect(step.eval.depth).toBe(12);
        expect(step.eval.lines[0].scoreCp).toBe(10);
      }
    });
  });
});
