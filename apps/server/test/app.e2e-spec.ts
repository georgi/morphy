import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Chess } from 'chess.js';
import request from 'supertest';
import type { EngineEval, Game } from '@chess/shared';
import { AppModule } from '../src/app.module';

/**
 * Full-stack smoke test for the HTTP API.
 *
 * Boots the entire Nest application exactly as `main.ts` does (CORS + the `api`
 * global prefix) and exercises the real request path:
 *   - import a PGN and round-trip it by id (ChessService + GameStore, real);
 *   - analyze the starting position with the real Stockfish engine over UCI.
 *
 * The agent endpoints are intentionally not touched here — they need external
 * LLM credentials and live in their own (manual / integration) surface.
 *
 * Engine analysis runs at a deliberately shallow depth so the suite stays fast;
 * the point is to prove the wiring, not to find the strongest move.
 */
describe('HTTP API smoke (e2e)', () => {
  let app: INestApplication;

  const ANALYSIS_DEPTH = 10;

  const STARTPOS_FEN =
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  // A short but real game: the Ruy Lopez opening moves.
  const PGN = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *';

  beforeAll(async () => {
    // Prefer the Homebrew Stockfish if STOCKFISH_PATH isn't already set; the
    // EngineService falls back to looking up `stockfish` on PATH otherwise.
    process.env.STOCKFISH_PATH ??= '/opt/homebrew/bin/stockfish';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    // Mirror main.ts so the routes here match production exactly.
    app.enableCors();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('imports a PGN, returns a Game with moves, and round-trips it by id', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/games')
      .send({ pgn: PGN })
      .expect(201);

    const game = created.body as Game;

    // A valid, server-generated id.
    expect(typeof game.id).toBe('string');
    expect(game.id.length).toBeGreaterThan(0);

    // Real moves were parsed out of the PGN.
    expect(game.moves.length).toBeGreaterThan(0);
    expect(game.moves).toHaveLength(6);
    expect(game.moves[0].san).toBe('e4');
    expect(game.moves[0].uci).toBe('e2e4');

    // GET by the returned id returns that same game.
    const fetched = await request(app.getHttpServer())
      .get(`/api/games/${game.id}`)
      .expect(200);

    expect((fetched.body as Game).id).toBe(game.id);
    expect((fetched.body as Game).moves).toHaveLength(game.moves.length);
  });

  it('analyzes the start position with the real engine and returns a legal best move', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/analysis/position')
      .send({ fen: STARTPOS_FEN, depth: ANALYSIS_DEPTH })
      .expect(201);

    const evaluation = res.body as EngineEval;

    expect(evaluation.fen).toBe(STARTPOS_FEN);
    expect(typeof evaluation.bestMove).toBe('string');
    expect(evaluation.depth).toBeGreaterThan(0);
    expect(evaluation.lines.length).toBeGreaterThan(0);

    // The reported best move must be a legal move from the analyzed position.
    const legalUci = new Chess(STARTPOS_FEN)
      .moves({ verbose: true })
      .map((m) => m.lan);
    expect(legalUci).toContain(evaluation.bestMove);
  });
});
