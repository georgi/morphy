import type { MessageEvent } from '@nestjs/common';
import type { ImportEvent, StartImportRequest } from '@chess/shared';
import { ImportService } from './import.service';
import type { GameSource } from './game-source';
import { ChessService } from '../chess/chess.service';
import { openDatabase, type Db } from '../persistence/database';
import { ImportJobsRepository } from '../persistence/import-jobs.repository';

// Two distinct legal games + one that re-exports game A with decorations
// (a content-hash duplicate of A) + one invalid PGN.
const GAME_A =
  '[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n[Date "2024.01.01"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 1-0';
const GAME_A_DUP =
  '[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n[Date "2024.01.01"]\n\n1. e4 { [%clk 0:03:00] } e5 2. Nf3 Nc6 $1 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 1-0';
const GAME_B =
  '[White "Carl"]\n[Black "Dana"]\n[Result "0-1"]\n[Date "2024.02.02"]\n\n1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7 0-1';
const INVALID = '[White "X"]\n\n1. e4 e5 2. Zz9 not-a-move';

/**
 * A test {@link GameSource} that yields a fixed list of PGN strings, or throws
 * (optionally after yielding some games) to exercise source-level failure.
 */
class FixtureSource implements GameSource {
  constructor(
    private readonly pgns: string[],
    private readonly failAfter?: number,
  ) {}

  async *fetch(_params: StartImportRequest): AsyncIterable<string> {
    let i = 0;
    for (const pgn of this.pgns) {
      if (this.failAfter !== undefined && i >= this.failAfter) {
        throw new Error('source exploded');
      }
      yield pgn;
      i += 1;
    }
    if (this.failAfter === 0 && this.pgns.length === 0) {
      throw new Error('source exploded');
    }
  }
}

type SourceSlot = 'url' | 'lichess' | 'chesscom' | 'catalog';

/**
 * Build an ImportService wired to a real {@link ImportJobsRepository} (the only
 * repository it still touches), with the chosen source slot replaced by `source`
 * (a fixture). Defaults to the `url` slot; remote-source pipeline tests pass a
 * `slot`. Games/collections are no longer persisted — they are streamed to the
 * client — so no games/collections repositories are wired.
 */
function makeService(
  db: Db,
  source: GameSource,
  slot: SourceSlot = 'url',
): {
  service: ImportService;
  jobs: ImportJobsRepository;
} {
  const chess = new ChessService();
  const jobs = new ImportJobsRepository(db);
  // The unused source slots get a never-called fixture so the constructor is
  // satisfied; only the chosen `slot` carries the test fixture.
  const unused = new FixtureSource([], 0);
  const pick = (s: SourceSlot): GameSource => (slot === s ? source : unused);
  const service = new ImportService(
    chess,
    jobs,
    pick('url') as unknown as import('./sources/url.source').UrlSource,
    pick('lichess') as unknown as import('./sources/lichess.source').LichessSource,
    pick('chesscom') as unknown as import('./sources/chesscom.source').ChessComSource,
    pick('catalog') as unknown as import('./sources/catalog.source').CatalogSource,
  );
  return { service, jobs };
}

/** Collect all SSE events for a job until its stream completes. */
function collectEvents(
  service: ImportService,
  jobId: string,
): Promise<ImportEvent[]> {
  return new Promise((resolve) => {
    const events: ImportEvent[] = [];
    service.getStream(jobId).subscribe({
      next: (msg: MessageEvent) =>
        events.push(JSON.parse(msg.data as string) as ImportEvent),
      complete: () => resolve(events),
    });
  });
}

describe('ImportService', () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('streams a full game + content hash per parsed game and does not dedup', async () => {
    const source = new FixtureSource([GAME_A, GAME_A_DUP, GAME_B, INVALID]);
    const { service, jobs } = makeService(db, source);

    const req: StartImportRequest = { source: 'url', url: 'http://x/games.pgn' };
    const { jobId } = service.start(req);
    const events = await collectEvents(service, jobId);

    const job = jobs.get(jobId)!;
    expect(job.status).toBe('done');
    // The server no longer dedups: A, A_DUP and B are all streamed; only the
    // invalid PGN fails. imported = games streamed; skipped is always 0.
    expect(job.imported).toBe(3);
    expect(job.skipped).toBe(0);
    expect(job.failed).toBe(1); // INVALID

    // A `game` event for each parsed game, carrying the full Game + its hash.
    const gameEvents = events.filter((e) => e.type === 'game');
    expect(gameEvents).toHaveLength(3);
    for (const e of gameEvents) {
      expect(e.game).toBeDefined();
      expect(e.game.moves.length).toBeGreaterThan(0);
      expect(typeof e.contentHash).toBe('string');
    }
    // A and its decorated re-export hash identically (the client dedups on this).
    expect(gameEvents[0].contentHash).toBe(gameEvents[1].contentHash);
    expect(gameEvents[0].contentHash).not.toBe(gameEvents[2].contentHash);

    const progressEvents = events.filter((e) => e.type === 'progress');
    expect(progressEvents).toHaveLength(4); // one per yielded game

    const done = events.filter((e) => e.type === 'done');
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ imported: 3, skipped: 0, failed: 1 });
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('emits a collection frame up front for a named import and links it on done', async () => {
    const source = new FixtureSource([GAME_A, GAME_B]);
    const { service, jobs } = makeService(db, source);

    const req: StartImportRequest = {
      source: 'url',
      url: 'http://x/games.pgn',
      collectionName: 'My Import',
    };
    const { jobId } = service.start(req);
    const events = await collectEvents(service, jobId);

    const job = jobs.get(jobId)!;
    expect(job.status).toBe('done');
    expect(job.collectionId).toBeDefined();

    // The collection is described (not persisted) and streamed before any game.
    const collectionEvent = events.find((e) => e.type === 'collection');
    expect(collectionEvent).toBeDefined();
    expect(collectionEvent!.collection).toMatchObject({
      id: job.collectionId,
      name: 'My Import',
      source: 'url',
    });
    const firstCollectionIdx = events.findIndex((e) => e.type === 'collection');
    const firstGameIdx = events.findIndex((e) => e.type === 'game');
    expect(firstCollectionIdx).toBeLessThan(firstGameIdx);

    expect(events.filter((e) => e.type === 'game')).toHaveLength(2);

    const done = events.find((e) => e.type === 'done');
    expect(done).toMatchObject({ collectionId: job.collectionId });
  });

  it('re-imports the same batch without server-side dedup (dedup is client-side)', async () => {
    const first = makeService(db, new FixtureSource([GAME_A, GAME_B]));
    const firstEvents = await collectEvents(
      first.service,
      first.service.start({ source: 'url', url: 'http://x/a.pgn' }).jobId,
    );
    expect(firstEvents.filter((e) => e.type === 'game')).toHaveLength(2);

    // Second run over the same games streams both again — the server keeps no
    // state, so it cannot skip; the client dedups against its own library.
    const second = makeService(db, new FixtureSource([GAME_A, GAME_B]));
    const { jobId } = second.service.start({
      source: 'url',
      url: 'http://x/a.pgn',
    });
    const secondEvents = await collectEvents(second.service, jobId);

    const job = second.jobs.get(jobId)!;
    expect(job).toMatchObject({ status: 'done', imported: 2, skipped: 0, failed: 0 });
    expect(secondEvents.filter((e) => e.type === 'game')).toHaveLength(2);
  });

  it('ends the job as error when the source fails before any game', async () => {
    const source = new FixtureSource([], 0); // throws on first iteration
    const { service, jobs } = makeService(db, source);

    const { jobId } = service.start({ source: 'url', url: 'http://x/404.pgn' });
    const events = await collectEvents(service, jobId);

    const job = jobs.get(jobId)!;
    expect(job.status).toBe('error');
    expect(job.error).toContain('source exploded');

    const error = events.filter((e) => e.type === 'error');
    expect(error).toHaveLength(1);
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(events.some((e) => e.type === 'game')).toBe(false);
  });

  it('ends as done (partial) when the source fails after some games streamed', async () => {
    // Yield A then throw — A is streamed, the failure is non-fatal (partial).
    const source = new FixtureSource([GAME_A, GAME_B], 1);
    const { service, jobs } = makeService(db, source);

    const { jobId } = service.start({ source: 'url', url: 'http://x/partial.pgn' });
    const events = await collectEvents(service, jobId);

    const job = jobs.get(jobId)!;
    expect(job.status).toBe('done');
    expect(job.imported).toBe(1);
    expect(events.filter((e) => e.type === 'game')).toHaveLength(1);
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('streams a lichess import under a provider-tagged collection frame', async () => {
    const source = new FixtureSource([GAME_A, GAME_B]);
    const { service, jobs } = makeService(db, source, 'lichess');

    const { jobId } = service.start({
      source: 'lichess',
      kind: 'study',
      id: 'abcd1234',
    });
    const events = await collectEvents(service, jobId);

    const job = jobs.get(jobId)!;
    expect(job.status).toBe('done');
    expect(job.source).toBe('lichess');
    expect(job.collectionId).toBeDefined();

    const collectionEvent = events.find((e) => e.type === 'collection');
    expect(collectionEvent!.collection).toMatchObject({
      id: job.collectionId,
      source: 'lichess',
    });
    expect(collectionEvent!.collection.name).toContain('abcd1234');

    expect(events.filter((e) => e.type === 'game')).toHaveLength(2);
    const done = events.find((e) => e.type === 'done');
    expect(done).toMatchObject({ collectionId: job.collectionId });
  });

  it('streams a catalog import under a titled collection frame', async () => {
    const source = new FixtureSource([GAME_A]);
    const { service, jobs } = makeService(db, source, 'catalog');

    // Any real manifest entry id; the fixture source ignores it but the
    // collection name/title is derived from the manifest.
    const { jobId } = service.start({
      source: 'catalog',
      entryId: 'morphy-opera-1858',
    });
    const events = await collectEvents(service, jobId);

    const job = jobs.get(jobId)!;
    expect(job.status).toBe('done');
    expect(job.source).toBe('catalog');

    const collectionEvent = events.find((e) => e.type === 'collection');
    expect(collectionEvent!.collection.source).toBe('catalog');
    // Title comes from the manifest entry, not the raw id.
    expect(collectionEvent!.collection.name.toLowerCase()).toContain('morphy');
  });

  it('replays the terminal `done` frame to a client that subscribes after the job finished', async () => {
    const source = new FixtureSource([GAME_A, GAME_B]);
    const { service, jobs } = makeService(db, source);

    const { jobId } = service.start({
      source: 'url',
      url: 'http://x/a.pgn',
      collectionName: 'Late',
    });
    // Drain the live stream to completion; the live channel is then closed+dropped.
    await collectEvents(service, jobId);

    // A late subscriber (the real browser SSE race for fast imports) must still
    // receive a single terminal `done` synthesized from the persisted job row.
    const replay = await collectEvents(service, jobId);
    const job = jobs.get(jobId)!;
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({
      type: 'done',
      imported: job.imported,
      skipped: job.skipped,
      failed: job.failed,
      collectionId: job.collectionId,
    });
  });

  it('replays a terminal `error` frame to a late subscriber when the source failed', async () => {
    const { service } = makeService(db, new FixtureSource([], 0));
    const { jobId } = service.start({ source: 'url', url: 'http://x/404.pgn' });
    await collectEvents(service, jobId);

    const replay = await collectEvents(service, jobId);
    expect(replay).toHaveLength(1);
    expect(replay[0].type).toBe('error');
  });

  it('streams the up-front collection then an error when the source fails before any game', async () => {
    // A named URL import describes a collection up front; a hard failure before
    // any game streams both frames — the client drops the orphaned collection.
    const { service, jobs } = makeService(db, new FixtureSource([], 0));
    const { jobId } = service.start({
      source: 'url',
      url: 'http://x/404.pgn',
      collectionName: 'Doomed',
    });
    const events = await collectEvents(service, jobId);

    expect(jobs.get(jobId)!.status).toBe('error');
    expect(events.some((e) => e.type === 'collection')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(events.some((e) => e.type === 'game')).toBe(false);
  });
});
