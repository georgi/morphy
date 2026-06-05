import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Game, GameSummary, Move } from '@chess/shared';
import { PersistenceModule } from '../persistence/persistence.module';
import { GamesRepository } from '../persistence/games.repository';
import { CollectionsRepository } from '../persistence/collections.repository';
import { LibraryModule } from './library.module';

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
    moves: [move(1, id)],
  };
}

/**
 * Controller-level e2e for the library REST surface. The PersistenceModule opens
 * a fresh in-memory SQLite DB (NODE_ENV==='test'), and we seed it through the
 * real repositories — no DB mocking — so search, fetch, delete, and cascade are
 * exercised end-to-end.
 */
describe('Library REST API (e2e)', () => {
  let app: INestApplication;
  let games: GamesRepository;
  let collections: CollectionsRepository;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PersistenceModule, LibraryModule],
    }).compile();

    games = moduleRef.get(GamesRepository);
    collections = moduleRef.get(CollectionsRepository);

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

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  function collId(): string {
    return collections.list()[0].id;
  }

  describe('GET /library/games', () => {
    it('returns a LibraryPage of all games', async () => {
      const res = await request(app.getHttpServer())
        .get('/library/games')
        .expect(200);
      expect(res.body.total).toBe(2);
      expect(res.body.games).toHaveLength(2);
      const m = res.body.games.find((g: GameSummary) => g.id === 'm');
      expect(m).toMatchObject({
        white: 'Magnus Carlsen',
        eco: 'B90',
        source: 'lichess',
        hasAnalysis: false,
        plyCount: 1,
      });
    });

    it('filters by free-text q', async () => {
      const res = await request(app.getHttpServer())
        .get('/library/games')
        .query({ q: 'ruy' })
        .expect(200);
      expect(res.body.games.map((g: GameSummary) => g.id)).toEqual(['f']);
    });

    it('filters by source and result', async () => {
      const res = await request(app.getHttpServer())
        .get('/library/games')
        .query({ source: 'lichess', result: '1-0' })
        .expect(200);
      expect(res.body.games.map((g: GameSummary) => g.id)).toEqual(['m']);
    });

    it('sorts and paginates', async () => {
      const res = await request(app.getHttpServer())
        .get('/library/games')
        .query({ sort: 'white', dir: 'asc', limit: 1, offset: 0 })
        .expect(200);
      expect(res.body.total).toBe(2);
      expect(res.body.games.map((g: GameSummary) => g.white)).toEqual([
        'Bobby Fischer',
      ]);
    });
  });

  describe('GET /library/games/:id', () => {
    it('returns the full game', async () => {
      const res = await request(app.getHttpServer())
        .get('/library/games/m')
        .expect(200);
      expect(res.body.id).toBe('m');
      expect(res.body.moves).toHaveLength(1);
      expect(res.body.headers.white).toBe('Magnus Carlsen');
    });

    it('404s for an unknown id', async () => {
      await request(app.getHttpServer())
        .get('/library/games/nope')
        .expect(404);
    });
  });

  describe('GET /library/collections', () => {
    it('lists collections', async () => {
      const res = await request(app.getHttpServer())
        .get('/library/collections')
        .expect(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({
        name: 'Sicilians',
        source: 'lichess',
        gameCount: 1,
      });
    });

    it('returns a collection with its games', async () => {
      const res = await request(app.getHttpServer())
        .get(`/library/collections/${collId()}`)
        .expect(200);
      expect(res.body.collection.name).toBe('Sicilians');
      expect(res.body.games.map((g: GameSummary) => g.id)).toEqual(['m']);
    });

    it('404s for an unknown collection', async () => {
      await request(app.getHttpServer())
        .get('/library/collections/nope')
        .expect(404);
    });
  });

  describe('DELETE /library/games/:id', () => {
    it('deletes a game and returns 204', async () => {
      games.create(makeGame('z', { white: 'Z', black: 'Y' }), {
        source: 'manual',
      });
      await request(app.getHttpServer())
        .delete('/library/games/z')
        .expect(204);
      await request(app.getHttpServer())
        .get('/library/games/z')
        .expect(404);
    });

    it('is idempotent (204 for an already-absent game)', async () => {
      await request(app.getHttpServer())
        .delete('/library/games/ghost')
        .expect(204);
    });
  });

  describe('DELETE /library/collections/:id', () => {
    it('cascades: removes the collection and its games', async () => {
      const id = collId();
      await request(app.getHttpServer())
        .delete(`/library/collections/${id}`)
        .expect(204);

      await request(app.getHttpServer())
        .get(`/library/collections/${id}`)
        .expect(404);
      // The game that lived in the collection is gone too.
      await request(app.getHttpServer())
        .get('/library/games/m')
        .expect(404);
      // A game outside the collection survives.
      await request(app.getHttpServer())
        .get('/library/games/f')
        .expect(200);
    });
  });
});
