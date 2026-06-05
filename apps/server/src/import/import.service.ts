import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { map } from 'rxjs/operators';
import type { MessageEvent } from '@nestjs/common';
import type {
  Game,
  GameSummary,
  ImportEvent,
  ImportSource,
  StartImportRequest,
} from '@chess/shared';
import { ChessService } from '../chess/chess.service';
import { GamesRepository } from '../persistence/games.repository';
import { CollectionsRepository } from '../persistence/collections.repository';
import { ImportJobsRepository } from '../persistence/import-jobs.repository';
import type { GameSource } from './game-source';
import { UrlSource } from './sources/url.source';
import { LichessSource } from './sources/lichess.source';
import { ChessComSource } from './sources/chesscom.source';
import { CatalogSource } from './sources/catalog.source';
import { findCatalogEntry } from './catalog.manifest';
import { contentHash } from './content-hash';

/** How many per-game parse errors to retain in the job's `error` sample. */
const ERROR_SAMPLE_CAP = 5;

/** Live running counts for an in-flight pipeline. */
interface Counts {
  imported: number;
  skipped: number;
  failed: number;
}

/**
 * Bulk-import orchestrator. `start` creates a `running` job row, resolves the
 * {@link GameSource} for the request, kicks off the pipeline **without awaiting**
 * it, and returns `{ jobId }` immediately so the HTTP request returns fast. The
 * pipeline streams {@link ImportEvent}s onto a per-job RxJS Subject (read by the
 * SSE endpoint) and persists progress to the job row (the poll fallback).
 *
 * All four sources are wired: `url` (paste / arbitrary PGN URL) plus the remote
 * providers `lichess`, `chesscom`, and `catalog` (see {@link resolveSource}).
 */
@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);
  /** Per-job event channels. Kept until the job ends, then completed + dropped. */
  private readonly streams = new Map<string, Subject<ImportEvent>>();

  constructor(
    private readonly chess: ChessService,
    private readonly games: GamesRepository,
    private readonly collections: CollectionsRepository,
    private readonly jobs: ImportJobsRepository,
    private readonly urlSource: UrlSource,
    private readonly lichessSource: LichessSource,
    private readonly chesscomSource: ChessComSource,
    private readonly catalogSource: CatalogSource,
  ) {}

  /**
   * Begin an import. Creates the job row, opens its event stream, optionally
   * creates a collection up front (named URL imports / remote providers), and
   * launches the pipeline in the background. Returns the new job id.
   *
   * @throws BadRequestException when the request is malformed (no resolvable
   *   source) — the only synchronous validation; all per-game and source-level
   *   failures are reported asynchronously on the job/stream.
   */
  start(req: StartImportRequest): { jobId: string } {
    const source = this.resolveSource(req);

    const collectionId = this.maybeCreateCollection(req);
    const job = this.jobs.create({
      source: req.source as ImportSource,
      params: req,
      status: 'running',
      collectionId,
    });

    // The Subject must exist before the (sync-started) pipeline emits, so an SSE
    // client that connects between `start` and the first tick still sees events.
    this.streams.set(job.id, new Subject<ImportEvent>());

    // Fire and forget: the request returns now; progress flows over SSE / poll.
    void this.runPipeline(job.id, source, req, collectionId, req.source);

    return { jobId: job.id };
  }

  /**
   * SSE source for a job. Maps each {@link ImportEvent} to the `{ data }` shape
   * `@Sse` expects. If the job already finished (stream completed), returns an
   * empty stream — clients should fall back to `GET /api/import/:jobId`.
   */
  getStream(jobId: string): Observable<MessageEvent> {
    const live = this.streams.get(jobId);
    const events = live ? live.asObservable() : this.replayTerminal(jobId);
    return events.pipe(
      map((event): MessageEvent => ({ data: JSON.stringify(event) })),
    );
  }

  /**
   * Reconnect path: no live channel exists for this job, so it has already
   * finished (a fast import can complete before the browser opens the stream) —
   * or never existed. If the persisted job row is terminal, synthesize and replay
   * its single `done`/`error` frame so a late subscriber resolves instead of
   * hanging forever; otherwise emit nothing and complete (the client falls back
   * to `GET /api/import/:jobId`).
   */
  private replayTerminal(jobId: string): Observable<ImportEvent> {
    const job = this.jobs.get(jobId);
    return new Observable<ImportEvent>((subscriber) => {
      if (job?.status === 'done') {
        subscriber.next({
          type: 'done',
          collectionId: job.collectionId,
          imported: job.imported,
          skipped: job.skipped,
          failed: job.failed,
        });
      } else if (job?.status === 'error') {
        subscriber.next({ type: 'error', message: job.error ?? 'Import failed.' });
      }
      subscriber.complete();
    });
  }

  // ── pipeline ───────────────────────────────────────────────────────────────

  /**
   * The single import path (SPEC §5). Iterates the source's PGN stream; per game
   * parses → hashes → dedups → inserts, counting imported/skipped/failed and
   * emitting progress. A source-level failure before any game ends the job as
   * `error`; otherwise it ends `done` (partial success still counts).
   */
  private async runPipeline(
    jobId: string,
    source: GameSource,
    req: StartImportRequest,
    collectionId: string | undefined,
    importSource: ImportSource,
  ): Promise<void> {
    const counts: Counts = { imported: 0, skipped: 0, failed: 0 };
    const errorSample: string[] = [];
    let sawAnyGame = false;

    try {
      for await (const pgn of source.fetch(req)) {
        sawAnyGame = true;
        this.ingest(jobId, pgn, collectionId, importSource, counts, errorSample);
        this.emit(jobId, {
          type: 'progress',
          imported: counts.imported,
          skipped: counts.skipped,
          failed: counts.failed,
        });
        this.jobs.update(jobId, { ...counts });
        // Yield: better-sqlite3 is synchronous; don't starve SSE/HTTP.
        await tick();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A source failure after some games were imported is a partial success;
      // only a failure before the first game is a hard job error.
      if (!sawAnyGame) {
        // Nothing was imported and a collection was created up front (remote /
        // named imports) — drop the empty collection so it doesn't litter the
        // sidebar. No games reference it yet, so the delete is safe.
        if (collectionId) this.collections.delete(collectionId);
        this.finishError(jobId, message);
        return;
      }
      if (errorSample.length < ERROR_SAMPLE_CAP) errorSample.push(message);
    }

    if (collectionId) this.collections.recountGames(collectionId);
    this.finishDone(jobId, counts, errorSample, collectionId);
  }

  /**
   * Import one game's PGN into the pipeline: parse, hash, dedup, insert. Mutates
   * `counts` and emits a `game` event on a fresh insert. Parse errors are caught
   * here (counted as `failed`, sampled) and never abort the job.
   */
  private ingest(
    jobId: string,
    pgn: string,
    collectionId: string | undefined,
    importSource: ImportSource,
    counts: Counts,
    errorSample: string[],
  ): void {
    let game: Game;
    try {
      game = this.chess.importPgn(pgn);
    } catch (err) {
      counts.failed += 1;
      if (errorSample.length < ERROR_SAMPLE_CAP) {
        errorSample.push(err instanceof Error ? err.message : String(err));
      }
      return;
    }

    const hash = contentHash(game);
    if (this.games.existsByHash(hash)) {
      counts.skipped += 1;
      return;
    }

    // A bare URL/paste import with no collection stays `'manual'` (matching the
    // single-game `POST /api/games` provenance); remote providers and named/
    // grouped imports tag the game with the real source.
    const source: ImportSource =
      importSource === 'url' && !collectionId ? 'manual' : importSource;
    this.games.create(game, {
      source,
      collectionId: collectionId ?? null,
      contentHash: hash,
    });
    counts.imported += 1;
    this.emit(jobId, {
      type: 'game',
      summary: this.summarize(game, source, collectionId),
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** Resolve the concrete {@link GameSource} for a request. */
  private resolveSource(req: StartImportRequest): GameSource {
    switch (req.source) {
      case 'url':
        return this.urlSource;
      case 'lichess':
        return this.lichessSource;
      case 'chesscom':
        return this.chesscomSource;
      case 'catalog':
        return this.catalogSource;
      default:
        throw new BadRequestException(
          `Unsupported import source "${(req as { source?: string }).source}".`,
        );
    }
  }

  /**
   * Create a collection up front when the import is named/grouped (SPEC §5).
   * Remote providers (`lichess` / `chesscom` / `catalog`) always get a collection
   * so their games are browsable as a group; URL imports only get one when
   * `collectionName` is supplied; bare pastes/URLs import with `collection_id =
   * null`.
   */
  private maybeCreateCollection(req: StartImportRequest): string | undefined {
    switch (req.source) {
      case 'url':
        if (!req.collectionName?.trim()) return undefined;
        return this.collections.create({
          name: req.collectionName.trim(),
          source: 'url',
          sourceRef: req.url?.trim(),
        }).id;

      case 'lichess':
        return this.collections.create({
          name: `Lichess ${req.kind}: ${req.id}`,
          source: 'lichess',
          sourceRef: `${req.kind}/${req.id}`,
        }).id;

      case 'chesscom':
        return this.collections.create({
          name: `Chess.com: ${req.username}`,
          source: 'chesscom',
          sourceRef: req.username,
        }).id;

      case 'catalog': {
        const entry = findCatalogEntry(req.entryId);
        return this.collections.create({
          name: entry?.title ?? `Catalog: ${req.entryId}`,
          description: entry?.description,
          source: 'catalog',
          sourceRef: req.entryId,
        }).id;
      }

      default:
        return undefined;
    }
  }

  /** Project an inserted {@link Game} into a {@link GameSummary} for a `game` event. */
  private summarize(
    game: Game,
    source: ImportSource,
    collectionId: string | undefined,
  ): GameSummary {
    return {
      id: game.id,
      white: game.headers.white,
      black: game.headers.black,
      result: game.headers.result,
      eco: game.headers.eco,
      opening: game.headers.opening,
      date: game.headers.date,
      plyCount: game.moves.length,
      source,
      collectionId,
      hasAnalysis: false,
      createdAt: Date.now(),
    };
  }

  private emit(jobId: string, event: ImportEvent): void {
    this.streams.get(jobId)?.next(event);
  }

  private finishDone(
    jobId: string,
    counts: Counts,
    errorSample: string[],
    collectionId: string | undefined,
  ): void {
    this.jobs.update(jobId, {
      ...counts,
      status: 'done',
      error: errorSample.length ? errorSample.join(' | ') : undefined,
    });
    this.emit(jobId, {
      type: 'done',
      collectionId,
      imported: counts.imported,
      skipped: counts.skipped,
      failed: counts.failed,
    });
    this.logger.log(
      `Import ${jobId} done: imported=${counts.imported} skipped=${counts.skipped} failed=${counts.failed}`,
    );
    this.closeStream(jobId);
  }

  private finishError(jobId: string, message: string): void {
    this.jobs.update(jobId, { status: 'error', error: message });
    this.emit(jobId, { type: 'error', message });
    this.logger.warn(`Import ${jobId} failed: ${message}`);
    this.closeStream(jobId);
  }

  private closeStream(jobId: string): void {
    const subject = this.streams.get(jobId);
    if (subject) {
      subject.complete();
      this.streams.delete(jobId);
    }
  }
}

/** Resolve on the next macrotask so synchronous SQLite writes don't starve I/O. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
