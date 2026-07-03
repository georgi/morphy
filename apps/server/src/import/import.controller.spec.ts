import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { ImportJob } from '@chess/shared';
import { PersistenceModule } from '../persistence/persistence.module';
import { ImportModule } from './import.module';

const A =
  '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O';
const B =
  '1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0';

// A two-game pasted PGN file (study-style, blank-line separated).
const PASTE =
  '[Event "Chapter 1"]\n[White "A"]\n[Black "B"]\n[Result "*"]\n\n' +
  A +
  ' *\n\n[Event "Chapter 2"]\n[White "C"]\n[Black "D"]\n[Result "1-0"]\n\n' +
  B;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Controller-level e2e for the import REST surface. A fresh in-memory SQLite DB
 * (NODE_ENV==='test') is opened by PersistenceModule (still needed for the
 * import-jobs row / poll fallback); we drive the `url`/paste source end-to-end
 * (no network — pasted PGN) and poll the job to completion. Games are no longer
 * persisted server-side — they are streamed to the client — so the job counts
 * (not a library query) are what we assert.
 */
describe('Import REST API (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PersistenceModule, ImportModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  /** Poll `GET /api/import/:jobId` until it reaches a terminal state. */
  async function pollUntilDone(jobId: string): Promise<ImportJob> {
    for (let i = 0; i < 100; i += 1) {
      const res = await request(app.getHttpServer())
        .get(`/import/${jobId}`)
        .expect(200);
      const job = res.body as ImportJob;
      if (job.status === 'done' || job.status === 'error') return job;
      await sleep(10);
    }
    throw new Error(`Job ${jobId} did not finish in time`);
  }

  describe('GET /import/catalog', () => {
    it('returns the curated catalog manifest', async () => {
      const res = await request(app.getHttpServer())
        .get('/import/catalog')
        .expect(200);
      const entries = res.body as Array<Record<string, unknown>>;
      expect(Array.isArray(entries)).toBe(true);
      expect(entries.length).toBeGreaterThan(0);
      // Every entry carries the CatalogEntry contract.
      for (const e of entries) {
        expect(typeof e.id).toBe('string');
        expect(typeof e.title).toBe('string');
        expect(typeof e.url).toBe('string');
      }
      // At least one classic is bundled offline.
      expect(entries.some((e) => e.bundled === true)).toBe(true);
    });
  });

  describe('POST /import (paste) → poll', () => {
    it('starts a paste job and completes with the games imported', async () => {
      const start = await request(app.getHttpServer())
        .post('/import')
        .send({ source: 'url', pgn: PASTE, collectionName: 'Pasted' })
        .expect(201);
      const jobId = start.body.jobId as string;
      expect(typeof jobId).toBe('string');

      const job = await pollUntilDone(jobId);
      expect(job.status).toBe('done');
      // The server streams both games; imported = games streamed, skipped is
      // always 0 (the client dedups against its own library, not the server).
      expect(job.imported).toBe(2);
      expect(job.skipped).toBe(0);
      expect(job.failed).toBe(0);
      expect(job.collectionId).toBeDefined();
    });

    it('re-streams the same paste without server-side dedup', async () => {
      const start = await request(app.getHttpServer())
        .post('/import')
        .send({ source: 'url', pgn: PASTE })
        .expect(201);
      const job = await pollUntilDone(start.body.jobId);
      // The server keeps no state across imports, so it re-streams both games;
      // deduplication now lives on the client.
      expect(job.status).toBe('done');
      expect(job.imported).toBe(2);
      expect(job.skipped).toBe(0);
    });
  });

  describe('POST /import validation', () => {
    it('400s when no source is given', async () => {
      await request(app.getHttpServer())
        .post('/import')
        .send({ url: 'http://x/a.pgn' })
        .expect(400);
    });

    it('400s for an unknown source', async () => {
      await request(app.getHttpServer())
        .post('/import')
        .send({ source: 'pigeon' })
        .expect(400);
    });
  });

  describe('GET /import/:jobId', () => {
    it('404s for an unknown job', async () => {
      await request(app.getHttpServer()).get('/import/nope').expect(404);
    });
  });
});
