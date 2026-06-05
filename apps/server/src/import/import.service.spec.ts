import type { MessageEvent } from '@nestjs/common';
import type { ImportEvent, StartImportRequest } from '@chess/shared';
import { ImportService } from './import.service';
import type { GameSource } from './game-source';
import { ChessService } from '../chess/chess.service';
import { openDatabase, type Db } from '../persistence/database';
import { GamesRepository } from '../persistence/games.repository';
import { CollectionsRepository } from '../persistence/collections.repository';
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
 * Build an ImportService wired to real repositories, with the chosen source slot
 * replaced by `source` (a fixture). Defaults to the `url` slot so the existing
 * tests are unchanged; remote-source pipeline tests pass `slot`.
 */
function makeService(
  db: Db,
  source: GameSource,
  slot: SourceSlot = 'url',
): {
  service: ImportService;
  jobs: ImportJobsRepository;
  games: GamesRepository;
  collections: CollectionsRepository;
} {
  const chess = new ChessService();
  const games = new GamesRepository(db);
  const collections = new CollectionsRepository(db);
  const jobs = new ImportJobsRepository(db);
  // The unused source slots get a never-called fixture so the constructor is
  // satisfied; only the chosen `slot` carries the test fixture.
  const unused = new FixtureSource([], 0);
  const pick = (s: SourceSlot): GameSource => (slot === s ? source : unused);
  const service = new ImportService(
    chess,
    games,
    collections,
    jobs,
    pick('url') as unknown as import('./sources/url.source').UrlSource,
    pick('lichess') as unknown as import('./sources/lichess.source').LichessSource,
    pick('chesscom') as unknown as import('./sources/chesscom.source').ChessComSource,
    pick('catalog') as unknown as import('./sources/catalog.source').CatalogSource,
  );
  return { service, jobs, games, collections };
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

  it('imports, dedups, and counts a mixed batch with one invalid game', async () => {
    const source = new FixtureSource([GAME_A, GAME_A_DUP, GAME_B, INVALID]);
    const { service, jobs, games } = makeService(db, source);

    const req: StartImportRequest = { source: 'url', url: 'http://x/games.pgn' };
    const { jobId } = service.start(req);
    const eventsPromise = collectEvents(service, jobId);
    const events = await eventsPromise;

    const job = jobs.get(jobId)!;
    expect(job.status).toBe('done');
    expect(job.imported).toBe(2); // A and B
    expect(job.skipped).toBe(1); // A_DUP collides with A by content hash
    expect(job.failed).toBe(1); // INVALID

    // The two imported games are persisted.
    expect(games.searchSummaries().total).toBe(2);

    // Event sequence: a `game` event for each insert, a `progress` after every
    // game, then exactly one terminal `done`.
    const gameEvents = events.filter((e) => e.type === 'game');
    expect(gameEvents).toHaveLength(2);

    const progressEvents = events.filter((e) => e.type === 'progress');
    expect(progressEvents).toHaveLength(4); // one per yielded game

    const done = events.filter((e) => e.type === 'done');
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ imported: 2, skipped: 1, failed: 1 });
    expect(events.some((e) => e.type === 'error')).toBe(false);

    // Final progress reflects the running totals.
    const last = progressEvents[progressEvents.length - 1];
    expect(last).toMatchObject({ imported: 2, skipped: 1, failed: 1 });
  });

  it('creates a collection up front and links imported games when named', async () => {
    const source = new FixtureSource([GAME_A, GAME_B]);
    const { service, jobs, games, collections } = makeService(db, source);

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

    const collection = collections.get(job.collectionId!)!;
    expect(collection.name).toBe('My Import');
    expect(collection.source).toBe('url');
    expect(collection.gameCount).toBe(2); // recounted at the end

    // Both games are linked to the collection and tagged source 'url'.
    const linked = games.searchSummaries({ collectionId: job.collectionId });
    expect(linked.total).toBe(2);
    expect(linked.games.every((g) => g.source === 'url')).toBe(true);

    const done = events.find((e) => e.type === 'done');
    expect(done).toMatchObject({ collectionId: job.collectionId });
  });

  it('skips every game on a re-import of the same batch (global dedup)', async () => {
    // First run imports A and B.
    const first = makeService(db, new FixtureSource([GAME_A, GAME_B]));
    await collectEvents(
      first.service,
      first.service.start({ source: 'url', url: 'http://x/a.pgn' }).jobId,
    );

    // Second run over the same games skips both.
    const second = makeService(db, new FixtureSource([GAME_A, GAME_B]));
    const { jobId } = second.service.start({
      source: 'url',
      url: 'http://x/a.pgn',
    });
    await collectEvents(second.service, jobId);

    const job = second.jobs.get(jobId)!;
    expect(job).toMatchObject({ status: 'done', imported: 0, skipped: 2, failed: 0 });
    expect(second.games.searchSummaries().total).toBe(2); // unchanged
  });

  it('ends the job as error when the source fails before any game', async () => {
    const source = new FixtureSource([], 0); // throws on first iteration
    const { service, jobs, games } = makeService(db, source);

    const { jobId } = service.start({ source: 'url', url: 'http://x/404.pgn' });
    const events = await collectEvents(service, jobId);

    const job = jobs.get(jobId)!;
    expect(job.status).toBe('error');
    expect(job.error).toContain('source exploded');
    expect(games.searchSummaries().total).toBe(0);

    const error = events.filter((e) => e.type === 'error');
    expect(error).toHaveLength(1);
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it('ends as done (partial) when the source fails after some games imported', async () => {
    // Yield A then throw — A is imported, the failure is non-fatal (partial).
    const source = new FixtureSource([GAME_A, GAME_B], 1);
    const { service, jobs, games } = makeService(db, source);

    const { jobId } = service.start({ source: 'url', url: 'http://x/partial.pgn' });
    const events = await collectEvents(service, jobId);

    const job = jobs.get(jobId)!;
    expect(job.status).toBe('done');
    expect(job.imported).toBe(1);
    expect(games.searchSummaries().total).toBe(1);
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('tags remote-source games with the provider and groups them in a collection', async () => {
    // A `lichess` import: a collection is created up front, games tag `'lichess'`.
    const source = new FixtureSource([GAME_A, GAME_B]);
    const { service, jobs, games, collections } = makeService(db, source, 'lichess');

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

    const collection = collections.get(job.collectionId!)!;
    expect(collection.source).toBe('lichess');
    expect(collection.name).toContain('abcd1234');

    const linked = games.searchSummaries({ collectionId: job.collectionId });
    expect(linked.total).toBe(2);
    expect(linked.games.every((g) => g.source === 'lichess')).toBe(true);

    const done = events.find((e) => e.type === 'done');
    expect(done).toMatchObject({ collectionId: job.collectionId });
  });

  it('groups a catalog import into a titled collection tagged catalog', async () => {
    const source = new FixtureSource([GAME_A]);
    const { service, jobs, games, collections } = makeService(db, source, 'catalog');

    // Any real manifest entry id; the fixture source ignores it but the
    // collection name/title is derived from the manifest.
    const { jobId } = service.start({
      source: 'catalog',
      entryId: 'morphy-opera-1858',
    });
    await collectEvents(service, jobId);

    const job = jobs.get(jobId)!;
    expect(job.status).toBe('done');
    expect(job.source).toBe('catalog');

    const collection = collections.get(job.collectionId!)!;
    expect(collection.source).toBe('catalog');
    // Title comes from the manifest entry, not the raw id.
    expect(collection.name.toLowerCase()).toContain('morphy');

    const linked = games.searchSummaries({ collectionId: job.collectionId });
    expect(linked.games.every((g) => g.source === 'catalog')).toBe(true);
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

  it('deletes the up-front collection when the source fails before any game', async () => {
    // A named URL import creates a collection up front; a hard failure before any
    // game must not leave an empty collection behind.
    const { service, jobs, collections } = makeService(db, new FixtureSource([], 0));
    const { jobId } = service.start({
      source: 'url',
      url: 'http://x/404.pgn',
      collectionName: 'Doomed',
    });
    await collectEvents(service, jobId);

    expect(jobs.get(jobId)!.status).toBe('error');
    expect(collections.list()).toHaveLength(0);
  });
});
