import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { EngineEval } from '@chess/shared';
import { ApiModule } from './api.module';
import { EngineService } from '../engine/engine.service';
import { EngineUnavailableError } from '../engine/errors';

/**
 * Controller-level e2e for the direct REST surface. The engine is stubbed so the
 * suite runs without a Stockfish binary; ChessService is real, so PGN/FEN parsing
 * + error mapping are exercised end-to-end. `POST /games` no longer persists — it
 * returns the parsed game plus its content hash for the client to store.
 */
describe('REST API (e2e)', () => {
  let app: INestApplication;
  let engine: { analyze: jest.Mock };

  const startEval: EngineEval = {
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    bestMove: 'e2e4',
    lines: [{ rank: 1, pv: ['e2e4', 'e7e5'], scoreCp: 25, mate: null }],
    depth: 12,
  };

  const STARTPOS_FEN =
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  beforeAll(async () => {
    engine = { analyze: jest.fn().mockResolvedValue(startEval) };

    const moduleRef = await Test.createTestingModule({
      imports: [ApiModule],
    })
      .overrideProvider(EngineService)
      .useValue(engine)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /games', () => {
    it('imports a PGN and returns the parsed game plus a content hash', async () => {
      const pgn = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *';
      const res = await request(app.getHttpServer())
        .post('/games')
        .send({ pgn })
        .expect(201);

      expect(res.body.game.id).toEqual(expect.any(String));
      expect(res.body.game.moves).toHaveLength(6);
      expect(res.body.contentHash).toEqual(expect.any(String));
    });

    it('imports a FEN', async () => {
      const res = await request(app.getHttpServer())
        .post('/games')
        .send({ fen: STARTPOS_FEN })
        .expect(201);
      expect(res.body.game.startFen).toContain('rnbqkbnr');
      expect(res.body.game.moves).toEqual([]);
    });

    it('rejects a request with neither pgn nor fen (400)', async () => {
      await request(app.getHttpServer()).post('/games').send({}).expect(400);
    });

    it('rejects invalid PGN (400)', async () => {
      await request(app.getHttpServer())
        .post('/games')
        .send({ pgn: 'this is not a pgn 99. Zz9' })
        .expect(400);
    });

    it('rejects invalid FEN (400)', async () => {
      await request(app.getHttpServer())
        .post('/games')
        .send({ fen: 'not-a-fen' })
        .expect(400);
    });
  });

  describe('POST /analysis/position', () => {
    it('returns an engine eval', async () => {
      const res = await request(app.getHttpServer())
        .post('/analysis/position')
        .send({ fen: STARTPOS_FEN, depth: 12 })
        .expect(201);
      expect(res.body.bestMove).toBe('e2e4');
      expect(engine.analyze).toHaveBeenCalledWith(
        STARTPOS_FEN,
        expect.objectContaining({ depth: 12 }),
      );
    });

    it('rejects a missing fen (400)', async () => {
      await request(app.getHttpServer())
        .post('/analysis/position')
        .send({})
        .expect(400);
    });

    it('maps EngineUnavailableError to 503', async () => {
      engine.analyze.mockRejectedValueOnce(
        new EngineUnavailableError('stockfish not found'),
      );
      await request(app.getHttpServer())
        .post('/analysis/position')
        .send({ fen: STARTPOS_FEN })
        .expect(503);
    });
  });

  describe('POST /analysis/game', () => {
    it('analyzes a game sent by value', async () => {
      const imported = await request(app.getHttpServer())
        .post('/games')
        .send({ pgn: '1. e4 e5 *' })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post('/analysis/game')
        .send({ game: imported.body.game })
        .expect(201);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(2);
      expect(res.body[0]).toHaveProperty('classification');
    });

    it('rejects a missing game (400, not 404)', async () => {
      await request(app.getHttpServer())
        .post('/analysis/game')
        .send({})
        .expect(400);
    });
  });

  describe('POST /analysis/key-moments', () => {
    it('returns [] for a game with no analysis attached', async () => {
      const imported = await request(app.getHttpServer())
        .post('/games')
        .send({ pgn: '1. e4 e5 *' })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post('/analysis/key-moments')
        .send({ game: imported.body.game })
        .expect(201);

      expect(res.body).toEqual([]);
    });

    it('rejects a missing game (400, not 404)', async () => {
      await request(app.getHttpServer())
        .post('/analysis/key-moments')
        .send({})
        .expect(400);
    });
  });
});
