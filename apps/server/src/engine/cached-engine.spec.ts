import type { EngineEval } from '@chess/shared';
import { CachedEngine } from './cached-engine';
import { EngineService, type AnalyzeOptions } from './engine.service';
import { normalizeFen } from './fen-norm';
import { EvalCacheRepository } from '../persistence/eval-cache.repository';
import { openDatabase, type Db } from '../persistence/database';

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const ENGINE_ID = 'stockfish-test';

function evalFor(fen: string, lineCount = 1): EngineEval {
  return {
    fen,
    bestMove: 'e2e4',
    lines: Array.from({ length: lineCount }, (_, i) => ({
      rank: i + 1,
      pv: ['e2e4'],
      scoreCp: 20 - i * 5,
      mate: null,
    })),
    depth: 18,
  };
}

/** A mock EngineService whose `analyze` is a jest.fn and `engineId` is fixed. */
function mockEngine(impl?: (fen: string, opts?: AnalyzeOptions) => EngineEval): {
  engine: EngineService;
  analyze: jest.Mock;
} {
  const analyze = jest.fn((fen: string, opts?: AnalyzeOptions) =>
    Promise.resolve(impl ? impl(fen, opts) : evalFor(fen)),
  );
  const engine = { analyze, engineId: ENGINE_ID } as unknown as EngineService;
  return { engine, analyze };
}

describe('CachedEngine', () => {
  let db: Db;
  let cache: EvalCacheRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    cache = new EvalCacheRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('on a miss: calls EngineService.analyze once and writes the row through', async () => {
    const { engine, analyze } = mockEngine();
    const cached = new CachedEngine(engine, cache);

    const result = await cached.analyze(FEN, { depth: 18, multipv: 1 });

    expect(analyze).toHaveBeenCalledTimes(1);
    expect(result.bestMove).toBe('e2e4');
    // The eval is now persisted under the normalized key.
    const row = cache.get(normalizeFen(FEN), 18, 1, ENGINE_ID);
    expect(row).toBeDefined();
    expect(row!.bestMove).toBe('e2e4');
  });

  it('on a hit: returns the cached eval WITHOUT calling EngineService.analyze', async () => {
    // Pre-seed the cache so the very first analyze() is a hit.
    cache.set(
      normalizeFen(FEN),
      18,
      1,
      ENGINE_ID,
      JSON.stringify(evalFor(FEN)),
    );
    const { engine, analyze } = mockEngine();
    const cached = new CachedEngine(engine, cache);

    const result = await cached.analyze(FEN, { depth: 18, multipv: 1 });

    expect(analyze).not.toHaveBeenCalled();
    expect(result.bestMove).toBe('e2e4');
  });

  it('serves the second identical call from the cache (single engine hit)', async () => {
    const { engine, analyze } = mockEngine();
    const cached = new CachedEngine(engine, cache);

    await cached.analyze(FEN, { depth: 18, multipv: 1 });
    await cached.analyze(FEN, { depth: 18, multipv: 1 });

    // Miss then hit: the engine ran exactly once.
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it('hits across FENs that differ only in clocks (normalized key)', async () => {
    const { engine, analyze } = mockEngine();
    const cached = new CachedEngine(engine, cache);

    await cached.analyze(
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      { depth: 18 },
    );
    await cached.analyze(
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 9 42',
      { depth: 18 },
    );

    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it('uses default depth/multipv so a bare call keys the cache consistently', async () => {
    const { engine, analyze } = mockEngine();
    const cached = new CachedEngine(engine, cache);

    await cached.analyze(FEN);
    await cached.analyze(FEN);

    expect(analyze).toHaveBeenCalledTimes(1);
    // Default depth 18 / multipv 1 row was written.
    expect(cache.get(normalizeFen(FEN), 18, 1, ENGINE_ID)).toBeDefined();
  });

  it('keys by engineId so a different engine forces a fresh search', async () => {
    cache.set(
      normalizeFen(FEN),
      18,
      1,
      'stockfish-old',
      JSON.stringify(evalFor(FEN)),
    );
    const { engine, analyze } = mockEngine();
    const cached = new CachedEngine(engine, cache);

    await cached.analyze(FEN, { depth: 18, multipv: 1 });
    // The pre-seeded row belongs to a different engine id, so this is a miss.
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it('does not fail the analysis when a cache write throws (best-effort)', async () => {
    const throwingCache = {
      get: jest.fn(() => undefined),
      set: jest.fn(() => {
        throw new Error('disk full');
      }),
    } as unknown as EvalCacheRepository;
    const { engine, analyze } = mockEngine();
    const cached = new CachedEngine(engine, throwingCache);

    const result = await cached.analyze(FEN, { depth: 18, multipv: 1 });

    expect(result.bestMove).toBe('e2e4');
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it('treats a cache read failure as a miss and still analyzes', async () => {
    const throwingCache = {
      get: jest.fn(() => {
        throw new Error('corrupt row');
      }),
      set: jest.fn(),
    } as unknown as EvalCacheRepository;
    const { engine, analyze } = mockEngine();
    const cached = new CachedEngine(engine, throwingCache);

    const result = await cached.analyze(FEN, { depth: 18, multipv: 1 });

    expect(result.bestMove).toBe('e2e4');
    expect(analyze).toHaveBeenCalledTimes(1);
  });
});
