import { Chess } from 'chess.js';
import type { EngineEval, Game, MoveEval } from '@chess/shared';
import { CoachService } from './coach.service';
import { AnalysisService } from './analysis.service';
import { EngineService, type AnalyzeOptions } from '../engine/engine.service';
import { CachedEngine } from '../engine/cached-engine';
import { EngineUnavailableError } from '../engine/errors';
import { EvalCacheRepository } from '../persistence/eval-cache.repository';
import { openDatabase, type Db } from '../persistence/database';
import { ChessService } from '../chess/chess.service';

// Morphy's Opera Game: famous, decisive, and full of instructive Black errors.
const OPERA_GAME_PGN = `[Event "Paris Opera"]
[White "Morphy"]
[Black "Allies"]
[Result "1-0"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6
7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7
12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8
17. Rd8# 1-0`;

const SCHOLARS_MATE_PGN =
  '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0';

/** Whether a real Stockfish binary is reachable; gates the engine-backed suite. */
async function stockfishAvailable(engine: EngineService): Promise<boolean> {
  try {
    await engine.analyze(new Chess().fen(), { depth: 4 });
    return true;
  } catch (err) {
    if (err instanceof EngineUnavailableError) return false;
    throw err;
  }
}

/** Build a MoveEval shaped like analyzeGame's output for a single game move. */
function moveEvalFor(
  game: Game,
  ply: number,
  cpLoss: number,
  classification: MoveEval['classification'],
  bestUci: string,
  bestLine: string[],
): MoveEval {
  const move = game.moves[ply - 1];
  return {
    ply,
    san: move.san,
    scoreCpBefore: 30,
    scoreCpAfter: 30 - cpLoss,
    cpLoss,
    classification,
    bestMove: bestUci,
    bestLine,
  };
}

/** Attach a hand-built eval curve to a game (by value — no store involved). */
function withAnalysis(game: Game, analysis: MoveEval[]): Game {
  return { ...game, analysis };
}

describe('CoachService', () => {
  describe('computeTurningPoints (pre-seeded analysis, no engine)', () => {
    let chess: ChessService;
    let coach: CoachService;

    beforeEach(() => {
      chess = new ChessService();
      // analyzeGame is never reached when game.analysis is present, so a stub
      // AnalysisService is enough for these selection/conversion assertions.
      const analysis = {} as AnalysisService;
      coach = new CoachService(chess, analysis);
    });

    it('selects the top-N mistakes/blunders, ordered chronologically', async () => {
      const game = chess.importPgn(OPERA_GAME_PGN);

      // Hand-built curve: four flagged errors + noise. cpLoss orders the picks,
      // but the returned points must come back in ply order.
      const analysis: MoveEval[] = [
        moveEvalFor(game, 2, 10, 'good', 'g1f3', []), // ignored (good)
        moveEvalFor(game, 6, 320, 'blunder', 'b1c3', []), // pick (biggest)
        moveEvalFor(game, 8, 150, 'mistake', 'c1g5', []), // pick
        moveEvalFor(game, 4, 60, 'inaccuracy', 'd4e5', []), // ignored (inaccuracy)
        moveEvalFor(game, 12, 200, 'mistake', 'e1g1', []), // pick
      ];

      const points = await coach.computeTurningPoints(
        withAnalysis(game, analysis),
        { max: 2 },
      );

      // max=2 → keep the two biggest swings (plies 6 and 12), chronological.
      expect(points.map((p) => p.ply)).toEqual([6, 12]);
      expect(points.map((p) => p.index)).toEqual([0, 1]);
      expect(points.map((p) => p.cpLoss)).toEqual([320, 200]);
      expect(points.map((p) => p.classification)).toEqual([
        'blunder',
        'mistake',
      ]);
    });

    it('defaults to 5 turning points and keeps them chronological', async () => {
      const game = chess.importPgn(OPERA_GAME_PGN);

      const analysis: MoveEval[] = [
        moveEvalFor(game, 12, 500, 'blunder', 'e1g1', []),
        moveEvalFor(game, 4, 110, 'mistake', 'd4e5', []),
        moveEvalFor(game, 8, 120, 'mistake', 'c1g5', []),
        moveEvalFor(game, 16, 900, 'blunder', 'd1b8', []),
        moveEvalFor(game, 6, 130, 'mistake', 'b1c3', []),
        moveEvalFor(game, 10, 140, 'mistake', 'a2a4', []),
      ];

      const points = await coach.computeTurningPoints(
        withAnalysis(game, analysis),
      );

      // Six flagged, default max 5 → drop the smallest swing (ply 4, cpLoss 110).
      expect(points).toHaveLength(5);
      expect(points.map((p) => p.ply)).toEqual([6, 8, 10, 12, 16]);
      // Strictly increasing plies (chronological).
      for (let i = 1; i < points.length; i++) {
        expect(points[i].ply).toBeGreaterThan(points[i - 1].ply);
      }
    });

    it('builds fenBefore, sideToMove and moveNumber from the game position', async () => {
      const game = chess.importPgn(OPERA_GAME_PGN);

      // Ply 4 is Black's 4...Bxf3 (a half-move; side to move at fenBefore is b).
      const analyzed = withAnalysis(game, [
        moveEvalFor(game, 4, 200, 'mistake', 'g4f3', ['g4f3', 'd1f3']),
      ]);

      const [point] = await coach.computeTurningPoints(analyzed);

      // fenBefore must equal the position at ply-1 (i.e. before the played move).
      expect(point.fenBefore).toBe(chess.positionAtPly(game, 3));
      expect(point.fenBefore).toBe(game.moves[3].fenBefore);
      expect(point.sideToMove).toBe('b');
      expect(point.fenBefore.split(' ')[1]).toBe('b');
      // Ply 4 → fourth half-move → move number 2.
      expect(point.moveNumber).toBe(2);
      expect(point.playedSan).toBe(game.moves[3].san);
    });

    it('converts the engine best move and line from UCI to SAN', async () => {
      const game = chess.importPgn(OPERA_GAME_PGN);

      // Ply 6 is Black's 6th half-move (3...dxe5 here); fenBefore has Black to
      // move, where d8e7 (Qe7) and the follow-up b1c3 (Nc3) are both legal.
      const fenBefore = chess.positionAtPly(game, 5);
      const expectedBest = chess.uciToSan(fenBefore, 'd8e7');
      const expectedLine = chess.uciLineToSan(fenBefore, ['d8e7', 'b1c3']);

      const analyzed = withAnalysis(game, [
        moveEvalFor(game, 6, 150, 'mistake', 'd8e7', ['d8e7', 'b1c3']),
      ]);

      const [point] = await coach.computeTurningPoints(analyzed);

      expect(point.bestMove).toBe(expectedBest);
      expect(point.bestMove).toBe('Qe7');
      expect(point.bestLine).toEqual(expectedLine);
      // SAN entries, never raw UCI.
      for (const san of point.bestLine) {
        expect(san).not.toMatch(/^[a-h][1-8][a-h][1-8]/);
      }
    });

    it('caps the best line at six plies', async () => {
      const game = chess.importPgn(OPERA_GAME_PGN);

      // A long legal line from the start position (ply 1, White to move).
      const longLine = [
        'e2e4',
        'e7e5',
        'g1f3',
        'b8c6',
        'f1b5',
        'a7a6',
        'b5a4',
        'g8f6',
      ];
      const analyzed = withAnalysis(game, [
        moveEvalFor(game, 1, 120, 'mistake', 'e2e4', longLine),
      ]);

      const [point] = await coach.computeTurningPoints(analyzed);
      expect(point.bestLine).toHaveLength(6);
    });

    it('returns an empty array when nothing is flagged', async () => {
      const game = chess.importPgn(SCHOLARS_MATE_PGN);
      const analyzed = withAnalysis(game, [
        moveEvalFor(game, 1, 5, 'good', 'e2e4', []),
        moveEvalFor(game, 2, 40, 'inaccuracy', 'd2d4', []),
      ]);

      expect(await coach.computeTurningPoints(analyzed)).toEqual([]);
    });
  });

  describe('analysis fallback (fake engine)', () => {
    // No cached analysis → CoachService must drive AnalysisService.analyzeGame.
    // White-POV scores: the blunder position is great for White (+1000), so the
    // Black move that produced it carries a large mover-POV cp-loss. Every other
    // position is even.
    function fakeEngine(blunderFen: string): CachedEngine {
      const analyze = jest.fn(
        (fen: string, _opts?: AnalyzeOptions): Promise<EngineEval> =>
          Promise.resolve({
            fen,
            bestMove: 'e2e4',
            lines: [
              {
                rank: 1,
                pv: ['e2e4'],
                scoreCp: fen === blunderFen ? 1000 : 0,
                mate: null,
              },
            ],
            depth: 12,
          }),
      );
      return { analyze } as unknown as CachedEngine;
    }

    it('runs analyzeGame when the game has no cached analysis', async () => {
      const chess = new ChessService();
      const game = chess.importPgn(SCHOLARS_MATE_PGN);

      // Make Black's 3...Nf6 (ply 6) walk into a position winning for White.
      const engine = fakeEngine(game.moves[5].fenAfter);
      const analysis = new AnalysisService(engine, chess);
      const coach = new CoachService(chess, analysis);

      const points = await coach.computeTurningPoints(game);

      // The fake engine made the position after ply 6 winning for White, so the
      // Black move into it (ply 6) is flagged as a turning point.
      const ply6 = points.find((p) => p.ply === 6);
      expect(ply6).toBeDefined();
      expect(ply6?.playedSan).toBe(game.moves[5].san);
      expect(ply6?.classification).toBe('blunder');
      // Returned chronologically.
      for (let i = 1; i < points.length; i++) {
        expect(points[i].ply).toBeGreaterThan(points[i - 1].ply);
      }
      // analyzeGame was actually invoked to build the curve on demand…
      expect(engine.analyze as jest.Mock).toHaveBeenCalled();
      // …and the result was NOT cached back onto the passed game (client owns it).
      expect(game.analysis).toBeUndefined();
    });
  });

  describe('engine-backed selection (real Stockfish)', () => {
    let engine: EngineService;
    let db: Db;
    let chess: ChessService;
    let coach: CoachService;
    let hasEngine = false;

    beforeAll(async () => {
      engine = new EngineService();
      db = openDatabase(':memory:');
      const cached = new CachedEngine(engine, new EvalCacheRepository(db));
      chess = new ChessService();
      const analysis = new AnalysisService(cached, chess);
      coach = new CoachService(chess, analysis);
      hasEngine = await stockfishAvailable(engine);
    }, 30_000);

    afterAll(async () => {
      await engine.onModuleDestroy();
      db.close();
    });

    it('finds chronological turning points with SAN best moves', async () => {
      if (!hasEngine) {
        console.warn('Stockfish unavailable — skipping engine-backed test');
        return;
      }

      const game = chess.importPgn(SCHOLARS_MATE_PGN);

      const points = await coach.computeTurningPoints(game);

      // Scholar's Mate has at least one clear Black error (allowing Qxf7#).
      expect(points.length).toBeGreaterThan(0);
      // Chronological order.
      for (let i = 1; i < points.length; i++) {
        expect(points[i].ply).toBeGreaterThan(points[i - 1].ply);
      }
      for (const point of points) {
        // fenBefore is the position the user faced (before their move).
        expect(point.fenBefore).toBe(chess.positionAtPly(game, point.ply - 1));
        expect(['mistake', 'blunder']).toContain(point.classification);
        // Best move is SAN (or null), never raw UCI.
        if (point.bestMove) {
          expect(point.bestMove).not.toMatch(/^[a-h][1-8][a-h][1-8]/);
        }
      }
    }, 60_000);
  });
});
