import type { Game, Move, MoveEval } from '@chess/shared';
import { openDatabase, type Db } from './database';
import { GamesRepository } from './games.repository';
import { contentHash, normalizedSanList } from './content-hash';

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

function makeGame(id: string, overrides: Partial<Game> = {}): Game {
  return {
    id,
    headers: { white: 'Alice', black: 'Bob', result: '1-0', date: '2026.01.01' },
    startFen: START_FEN,
    moves: [move(1, 'e4'), move(2, 'e5')],
    ...overrides,
  };
}

const sampleAnalysis: MoveEval[] = [
  {
    ply: 1,
    san: 'e4',
    scoreCpBefore: 20,
    scoreCpAfter: 30,
    cpLoss: 0,
    classification: 'best',
    bestMove: 'e2e4',
    bestLine: ['e2e4', 'e7e5'],
  },
];

describe('GamesRepository', () => {
  let db: Db;
  let repo: GamesRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new GamesRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('creates and retrieves a game (round-trips the full Game JSON)', () => {
    const game = makeGame('g1');
    expect(repo.create(game)).toBe(game);

    const fetched = repo.get('g1');
    expect(fetched).toEqual(game);
    // Fresh object from JSON, not the same reference.
    expect(fetched).not.toBe(game);
    expect(repo.has('g1')).toBe(true);
  });

  it('returns undefined / false for a missing game', () => {
    expect(repo.get('nope')).toBeUndefined();
    expect(repo.has('nope')).toBe(false);
  });

  it('denormalizes headers and ply_count into columns', () => {
    repo.create(makeGame('g1'));
    const row = db
      .prepare(
        'SELECT white, black, result, date, ply_count, source, collection_id, has_analysis FROM games WHERE id = ?',
      )
      .get('g1') as Record<string, unknown>;
    expect(row).toMatchObject({
      white: 'Alice',
      black: 'Bob',
      result: '1-0',
      date: '2026.01.01',
      ply_count: 2,
      source: 'manual',
      collection_id: null,
      has_analysis: 0,
    });
  });

  function insertCollection(id: string): void {
    db.prepare(
      'INSERT INTO collections (id, name, source, game_count, created_at) VALUES (?, ?, ?, 0, ?)',
    ).run(id, id, 'manual', Date.now());
  }

  it('records provenance from meta (source + collectionId)', () => {
    insertCollection('c1');
    repo.create(makeGame('g1'), { source: 'lichess', collectionId: 'c1' });
    const row = db
      .prepare('SELECT source, collection_id FROM games WHERE id = ?')
      .get('g1') as { source: string; collection_id: string | null };
    expect(row).toEqual({ source: 'lichess', collection_id: 'c1' });
  });

  it('overwrites an existing game on create with the same id', () => {
    repo.create(makeGame('g1'));
    const replacement = makeGame('g1', {
      headers: { white: 'Carol', black: 'Dave' },
      moves: [move(1, 'd4')],
    });
    repo.create(replacement);
    expect(repo.get('g1')).toEqual(replacement);
    expect(repo.list()).toHaveLength(1);
  });

  it('updates an existing game and ignores unknown ids', () => {
    repo.create(makeGame('g1'));
    const replacement = makeGame('g1', {
      headers: { white: 'Alice', black: 'Bob', event: 'World Championship' },
    });
    expect(repo.update('g1', replacement)).toBe(replacement);
    expect(repo.get('g1')?.headers.event).toBe('World Championship');

    expect(repo.update('missing', makeGame('missing'))).toBeUndefined();
    expect(repo.has('missing')).toBe(false);
  });

  it('preserves provenance across update', () => {
    insertCollection('c9');
    repo.create(makeGame('g1'), { source: 'catalog', collectionId: 'c9' });
    repo.update('g1', makeGame('g1', { headers: { white: 'X' } }));
    const row = db
      .prepare('SELECT source, collection_id FROM games WHERE id = ?')
      .get('g1') as { source: string; collection_id: string | null };
    expect(row).toEqual({ source: 'catalog', collection_id: 'c9' });
  });

  it('attaches analysis without mutating the caller object and flips has_analysis', () => {
    const game = makeGame('g1');
    repo.create(game);

    const updated = repo.setAnalysis('g1', sampleAnalysis);
    expect(updated?.analysis).toEqual(sampleAnalysis);
    expect(repo.get('g1')?.analysis).toEqual(sampleAnalysis);
    // The caller-held object is untouched.
    expect(game.analysis).toBeUndefined();

    const hasAnalysis = db
      .prepare('SELECT has_analysis FROM games WHERE id = ?')
      .get('g1') as { has_analysis: number };
    expect(hasAnalysis.has_analysis).toBe(1);
  });

  it('returns undefined when setting analysis on a missing game', () => {
    expect(repo.setAnalysis('ghost', sampleAnalysis)).toBeUndefined();
  });

  it('lists games in insertion order and deletes them', () => {
    repo.create(makeGame('a'));
    repo.create(makeGame('b', { headers: { white: 'B', black: 'B2' } }));
    expect(repo.list().map((g) => g.id)).toEqual(['a', 'b']);

    expect(repo.delete('a')).toBe(true);
    expect(repo.delete('a')).toBe(false);
    expect(repo.list().map((g) => g.id)).toEqual(['b']);
  });

  describe('content-hash dedup', () => {
    it('hashes identical games (different ids) to the same content_hash', () => {
      const a = makeGame('a');
      const b = makeGame('b'); // same moves + headers, different id
      expect(contentHash(a)).toBe(contentHash(b));
    });

    it('distinguishes games that differ in moves or headers', () => {
      const base = makeGame('a');
      const diffMoves = makeGame('a', { moves: [move(1, 'd4')] });
      const diffPlayers = makeGame('a', {
        headers: { white: 'Carol', black: 'Bob', result: '1-0', date: '2026.01.01' },
      });
      expect(contentHash(diffMoves)).not.toBe(contentHash(base));
      expect(contentHash(diffPlayers)).not.toBe(contentHash(base));
    });

    it('ignores check/annotation glyphs in the SAN spine', () => {
      const plain = makeGame('a', { moves: [move(1, 'Qh5'), move(2, 'Nc6')] });
      const decorated = makeGame('b', {
        moves: [move(1, 'Qh5+!'), move(2, 'Nc6?')],
      });
      expect(normalizedSanList(plain)).toBe(normalizedSanList(decorated));
      expect(contentHash(plain)).toBe(contentHash(decorated));
    });

    it('existsByHash reports presence by content hash (global dedup probe)', () => {
      const game = makeGame('g1');
      const hash = contentHash(game);
      expect(repo.existsByHash(hash)).toBe(false);
      repo.create(game, { contentHash: hash });
      expect(repo.existsByHash(hash)).toBe(true);
    });
  });

  describe('searchSummaries', () => {
    function insertCollection(id: string): void {
      db.prepare(
        'INSERT INTO collections (id, name, source, game_count, created_at) VALUES (?, ?, ?, 0, ?)',
      ).run(id, id, 'manual', Date.now());
    }

    function gameWith(
      id: string,
      headers: Record<string, string>,
    ): Game {
      return makeGame(id, { headers, moves: [move(1, id)] });
    }

    beforeEach(() => {
      insertCollection('c1');
      // Distinct content (unique move spine via id) so the UNIQUE hash holds.
      repo.create(
        gameWith('m', {
          white: 'Magnus Carlsen',
          black: 'Hikaru Nakamura',
          result: '1-0',
          eco: 'B90',
          opening: 'Sicilian Najdorf',
          date: '2021.01.01',
        }),
        { source: 'lichess', collectionId: 'c1' },
      );
      repo.create(
        gameWith('f', {
          white: 'Bobby Fischer',
          black: 'Boris Spassky',
          result: '0-1',
          eco: 'C95',
          opening: 'Ruy Lopez',
          date: '1972.07.11',
        }),
        { source: 'manual' },
      );
      repo.create(
        gameWith('k', {
          white: 'Garry Kasparov',
          black: 'Magnus Carlsen',
          result: '1/2-1/2',
          eco: 'B90',
          opening: 'Sicilian Najdorf',
          date: '2004.03.02',
        }),
        { source: 'catalog' },
      );
    });

    it('returns all games with a correct total and summary shape', () => {
      const page = repo.searchSummaries();
      expect(page.total).toBe(3);
      expect(page.games).toHaveLength(3);
      const m = page.games.find((g) => g.id === 'm')!;
      expect(m).toMatchObject({
        id: 'm',
        white: 'Magnus Carlsen',
        black: 'Hikaru Nakamura',
        result: '1-0',
        eco: 'B90',
        opening: 'Sicilian Najdorf',
        plyCount: 1,
        source: 'lichess',
        collectionId: 'c1',
        hasAnalysis: false,
      });
      expect(m.createdAt).toEqual(expect.any(Number));
    });

    it('free-text q matches white/black/eco/opening (case-insensitive)', () => {
      // "carlsen" appears as white in "k" and black in "k", white in "m".
      const byName = repo.searchSummaries({ q: 'carlsen' });
      expect(byName.games.map((g) => g.id).sort()).toEqual(['k', 'm']);

      const byOpening = repo.searchSummaries({ q: 'ruy' });
      expect(byOpening.games.map((g) => g.id)).toEqual(['f']);

      const byEco = repo.searchSummaries({ q: 'b90' });
      expect(byEco.games.map((g) => g.id).sort()).toEqual(['k', 'm']);
    });

    it('player filter matches either side', () => {
      const page = repo.searchSummaries({ player: 'spassky' });
      expect(page.games.map((g) => g.id)).toEqual(['f']);
      expect(page.total).toBe(1);
    });

    it('exact eco / result / source / collection filters', () => {
      expect(
        repo.searchSummaries({ eco: 'B90' }).games.map((g) => g.id).sort(),
      ).toEqual(['k', 'm']);
      expect(
        repo.searchSummaries({ result: '0-1' }).games.map((g) => g.id),
      ).toEqual(['f']);
      expect(
        repo.searchSummaries({ source: 'catalog' }).games.map((g) => g.id),
      ).toEqual(['k']);
      expect(
        repo.searchSummaries({ collectionId: 'c1' }).games.map((g) => g.id),
      ).toEqual(['m']);
    });

    it('combines filters with AND', () => {
      const page = repo.searchSummaries({ eco: 'B90', result: '1-0' });
      expect(page.games.map((g) => g.id)).toEqual(['m']);
      expect(page.total).toBe(1);
    });

    it('sorts by a whitelisted column in the requested direction', () => {
      const asc = repo.searchSummaries({ sort: 'white', dir: 'asc' });
      expect(asc.games.map((g) => g.white)).toEqual([
        'Bobby Fischer',
        'Garry Kasparov',
        'Magnus Carlsen',
      ]);
      const desc = repo.searchSummaries({ sort: 'date', dir: 'desc' });
      expect(desc.games.map((g) => g.id)).toEqual(['m', 'k', 'f']);
    });

    it('paginates while reporting the full total', () => {
      const first = repo.searchSummaries({
        sort: 'white',
        dir: 'asc',
        limit: 2,
        offset: 0,
      });
      expect(first.games.map((g) => g.id)).toEqual(['f', 'k']);
      expect(first.total).toBe(3);

      const second = repo.searchSummaries({
        sort: 'white',
        dir: 'asc',
        limit: 2,
        offset: 2,
      });
      expect(second.games.map((g) => g.id)).toEqual(['m']);
      expect(second.total).toBe(3);
    });

    it('reflects hasAnalysis after analysis is attached', () => {
      repo.setAnalysis('f', sampleAnalysis);
      const f = repo
        .searchSummaries({ player: 'fischer' })
        .games.find((g) => g.id === 'f')!;
      expect(f.hasAnalysis).toBe(true);
    });

    it('deleteByCollection cascades and returns the count', () => {
      repo.create(gameWith('m2', { white: 'X', black: 'Y' }), {
        collectionId: 'c1',
      });
      expect(repo.deleteByCollection('c1')).toBe(2);
      expect(repo.searchSummaries({ collectionId: 'c1' }).total).toBe(0);
      // Games outside the collection are untouched.
      expect(repo.searchSummaries().total).toBe(2);
    });
  });
});
