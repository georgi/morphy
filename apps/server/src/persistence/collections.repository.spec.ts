import type { Game, Move } from '@chess/shared';
import { openDatabase, type Db } from './database';
import { CollectionsRepository } from './collections.repository';
import { GamesRepository } from './games.repository';

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
    moves: [move(1, id)],
    ...overrides,
  };
}

describe('CollectionsRepository', () => {
  let db: Db;
  let repo: CollectionsRepository;
  let games: GamesRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new CollectionsRepository(db);
    games = new GamesRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('creates a collection with generated id, defaults, and zero games', () => {
    const c = repo.create({ name: 'My Study' });
    expect(c.id).toEqual(expect.any(String));
    expect(c.name).toBe('My Study');
    expect(c.source).toBe('manual');
    expect(c.gameCount).toBe(0);
    expect(c.createdAt).toEqual(expect.any(Number));
    expect(c.description).toBeUndefined();
    expect(c.sourceRef).toBeUndefined();
  });

  it('round-trips description / source / sourceRef', () => {
    const c = repo.create({
      name: 'Magnus games',
      description: 'lichess pull',
      source: 'lichess',
      sourceRef: 'user/DrNykterstein',
    });
    expect(repo.get(c.id)).toEqual(c);
  });

  it('returns undefined for a missing collection', () => {
    expect(repo.get('nope')).toBeUndefined();
  });

  it('lists collections newest first', () => {
    const a = repo.create({ name: 'A' });
    const b = repo.create({ name: 'B' });
    const ids = repo.list().map((c) => c.id);
    expect(ids).toEqual([b.id, a.id]);
  });

  it('deletes a collection and reports whether one was removed', () => {
    const c = repo.create({ name: 'Temp' });
    expect(repo.delete(c.id)).toBe(true);
    expect(repo.delete(c.id)).toBe(false);
    expect(repo.get(c.id)).toBeUndefined();
  });

  it('recountGames reflects the games linked to the collection', () => {
    const c = repo.create({ name: 'Coll' });
    expect(repo.recountGames(c.id)).toBe(0);

    games.create(makeGame('g1'), { collectionId: c.id });
    games.create(makeGame('g2'), { collectionId: c.id });
    games.create(makeGame('g3')); // no collection

    expect(repo.recountGames(c.id)).toBe(2);
    expect(repo.get(c.id)?.gameCount).toBe(2);

    games.delete('g1');
    expect(repo.recountGames(c.id)).toBe(1);
    expect(repo.get(c.id)?.gameCount).toBe(1);
  });
});
