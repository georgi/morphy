import type { EngineEval, EngineLine } from '@chess/shared';
import { openDatabase, type Db } from './database';
import { EvalCacheRepository } from './eval-cache.repository';

const FEN_NORM = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
const ENGINE_ID = 'stockfish-18';

function line(rank: number, scoreCp: number): EngineLine {
  return { rank, pv: [`pv${rank}`], scoreCp, mate: null };
}

function evalWith(lineCount: number): EngineEval {
  return {
    fen: FEN_NORM,
    bestMove: 'e2e4',
    lines: Array.from({ length: lineCount }, (_, i) => line(i + 1, 30 - i * 10)),
    depth: 18,
  };
}

describe('EvalCacheRepository', () => {
  let db: Db;
  let repo: EvalCacheRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new EvalCacheRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns undefined on a cold miss', () => {
    expect(repo.get(FEN_NORM, 18, 1, ENGINE_ID)).toBeUndefined();
  });

  it('round-trips a stored eval on an exact-key hit', () => {
    const stored = evalWith(1);
    repo.set(FEN_NORM, 18, 1, ENGINE_ID, JSON.stringify(stored));

    const hit = repo.get(FEN_NORM, 18, 1, ENGINE_ID);
    expect(hit).toEqual(stored);
  });

  it('serves a request for fewer lines from a wider stored row, sliced', () => {
    const stored = evalWith(3);
    repo.set(FEN_NORM, 18, 3, ENGINE_ID, JSON.stringify(stored));

    // Request multipv=1 → the stored multipv=3 row qualifies (3 >= 1).
    const hit = repo.get(FEN_NORM, 18, 1, ENGINE_ID);
    expect(hit).toBeDefined();
    expect(hit!.lines).toHaveLength(1);
    expect(hit!.lines[0]).toEqual(stored.lines[0]);

    // Request multipv=2 → still served, sliced to the top two.
    const hit2 = repo.get(FEN_NORM, 18, 2, ENGINE_ID);
    expect(hit2!.lines).toHaveLength(2);
    expect(hit2!.lines).toEqual(stored.lines.slice(0, 2));
  });

  it('misses when the stored row has fewer lines than requested', () => {
    repo.set(FEN_NORM, 18, 1, ENGINE_ID, JSON.stringify(evalWith(1)));
    // Only a 1-line row exists; a 3-line request must not be satisfied by it.
    expect(repo.get(FEN_NORM, 18, 3, ENGINE_ID)).toBeUndefined();
  });

  it('misses on an engine_id mismatch (upgrade invalidates old rows)', () => {
    repo.set(FEN_NORM, 18, 1, ENGINE_ID, JSON.stringify(evalWith(1)));
    expect(repo.get(FEN_NORM, 18, 1, 'stockfish-17')).toBeUndefined();
    // The matching engine still hits.
    expect(repo.get(FEN_NORM, 18, 1, ENGINE_ID)).toBeDefined();
  });

  it('misses on a depth mismatch', () => {
    repo.set(FEN_NORM, 18, 1, ENGINE_ID, JSON.stringify(evalWith(1)));
    expect(repo.get(FEN_NORM, 14, 1, ENGINE_ID)).toBeUndefined();
  });

  it('prefers the narrowest qualifying row when several are stored', () => {
    const narrow = evalWith(2);
    const wide = evalWith(5);
    repo.set(FEN_NORM, 18, 2, ENGINE_ID, JSON.stringify(narrow));
    repo.set(FEN_NORM, 18, 5, ENGINE_ID, JSON.stringify(wide));

    const hit = repo.get(FEN_NORM, 18, 1, ENGINE_ID);
    // Narrowest row that still satisfies the request is the multipv=2 one.
    expect(hit!.lines[0]).toEqual(narrow.lines[0]);
  });

  it('overwrites an existing row at the same key on re-set', () => {
    repo.set(FEN_NORM, 18, 1, ENGINE_ID, JSON.stringify(evalWith(1)));
    const deeper: EngineEval = { ...evalWith(1), bestMove: 'd2d4' };
    repo.set(FEN_NORM, 18, 1, ENGINE_ID, JSON.stringify(deeper));

    expect(repo.get(FEN_NORM, 18, 1, ENGINE_ID)!.bestMove).toBe('d2d4');
  });
});
