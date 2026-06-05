import { EngineService } from './engine.service';
import { EngineUnavailableError } from './errors';

const STARTPOS_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// 20 legal first moves for White from the start position, in UCI notation.
const LEGAL_FIRST_MOVES = new Set([
  'a2a3', 'a2a4', 'b2b3', 'b2b4', 'c2c3', 'c2c4', 'd2d3', 'd2d4',
  'e2e3', 'e2e4', 'f2f3', 'f2f4', 'g2g3', 'g2g4', 'h2h3', 'h2h4',
  'b1a3', 'b1c3', 'g1f3', 'g1h3',
]);

describe('EngineService', () => {
  describe('with real Stockfish', () => {
    let service: EngineService;

    beforeAll(() => {
      service = new EngineService();
    });

    afterAll(async () => {
      await service.onModuleDestroy();
    });

    it('exposes a slugified engine id after handshaking', async () => {
      // Force a handshake.
      await service.analyze(STARTPOS_FEN, { depth: 4 });

      const id = service.engineId;
      expect(id).toMatch(/^stockfish-/);
      // A clean slug: lowercase alphanumerics and dashes only, no stray edges.
      expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(id).not.toBe('stockfish-unknown');
    }, 30_000);

    it('analyzes the start position at shallow depth', async () => {
      const result = await service.analyze(STARTPOS_FEN, { depth: 8 });

      expect(result.fen).toBe(STARTPOS_FEN);
      expect(result.bestMove).not.toBeNull();
      expect(LEGAL_FIRST_MOVES.has(result.bestMove!)).toBe(true);
      expect(result.depth).toBeGreaterThanOrEqual(8);

      expect(result.lines).toHaveLength(1);
      const [line] = result.lines;
      expect(line.rank).toBe(1);
      expect(line.pv.length).toBeGreaterThan(0);
      expect(line.pv[0]).toBe(result.bestMove);
      // Start position is roughly equal — a small White-POV centipawn number.
      expect(typeof line.scoreCp).toBe('number');
      expect(line.mate).toBeNull();
      expect(Math.abs(line.scoreCp!)).toBeLessThan(200);
    }, 30_000);

    it('returns the requested number of MultiPV lines, ranked', async () => {
      const result = await service.analyze(STARTPOS_FEN, {
        depth: 8,
        multipv: 3,
      });

      expect(result.lines).toHaveLength(3);
      expect(result.lines.map((l) => l.rank)).toEqual([1, 2, 3]);
      for (const line of result.lines) {
        expect(typeof line.scoreCp === 'number' || line.mate !== null).toBe(
          true,
        );
        expect(line.pv.length).toBeGreaterThan(0);
      }
    }, 30_000);

    it('normalizes mate scores to White-POV (negative when Black mates)', async () => {
      // Black to move and mating White in 1 (Qh4#-style net): from this FEN
      // Black delivers mate, so the White-POV mate distance must be negative.
      // Position: White king boxed on g1, Black queen + rook deliver mate.
      const blackMatesFen = '6k1/5ppp/8/8/8/8/5qPP/7K b - - 0 1';
      const result = await service.analyze(blackMatesFen, { depth: 10 });

      expect(result.bestMove).not.toBeNull();
      const mateLine = result.lines.find((l) => l.mate !== null);
      expect(mateLine).toBeDefined();
      // Black is mating -> White-POV mate is negative.
      expect(mateLine!.mate!).toBeLessThan(0);
      expect(mateLine!.scoreCp).toBeNull();
    }, 30_000);

    it('serializes concurrent analyze calls without cross-talk', async () => {
      const [a, b] = await Promise.all([
        service.analyze(STARTPOS_FEN, { depth: 6 }),
        service.analyze(STARTPOS_FEN, { depth: 6 }),
      ]);

      expect(LEGAL_FIRST_MOVES.has(a.bestMove!)).toBe(true);
      expect(LEGAL_FIRST_MOVES.has(b.bestMove!)).toBe(true);
    }, 30_000);
  });

  describe('engineId fallback', () => {
    it('reports stockfish-unknown before any handshake', () => {
      const service = new EngineService();
      expect(service.engineId).toBe('stockfish-unknown');
    });
  });

  describe('missing binary', () => {
    const original = process.env.STOCKFISH_PATH;

    afterEach(() => {
      if (original === undefined) delete process.env.STOCKFISH_PATH;
      else process.env.STOCKFISH_PATH = original;
    });

    it('throws EngineUnavailableError when the binary does not exist', async () => {
      process.env.STOCKFISH_PATH =
        '/nonexistent/path/definitely-not-stockfish-xyz';
      const service = new EngineService();

      await expect(service.analyze(STARTPOS_FEN, { depth: 4 })).rejects.toThrow(
        EngineUnavailableError,
      );

      await service.onModuleDestroy();
    }, 15_000);
  });
});
