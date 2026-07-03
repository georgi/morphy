import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EMPTY, Observable, ReplaySubject } from 'rxjs';
import { map } from 'rxjs/operators';
import type { MessageEvent } from '@nestjs/common';
import type {
  Collection,
  Game,
  ImportEvent,
  ImportSource,
  StartImportRequest,
} from '@chess/shared';
import { ChessService } from '../chess/chess.service';
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
 * pipeline streams {@link ImportEvent}s onto a per-job RxJS `ReplaySubject`
 * (read by the SSE endpoint, buffered so late subscribers still see every
 * frame) and persists progress to the job row (the poll fallback).
 *
 * All four sources are wired: `url` (paste / arbitrary PGN URL) plus the remote
 * providers `lichess`, `chesscom`, and `catalog` (see {@link resolveSource}).
 *
 * The server no longer persists imported games or collections: it parses each
 * game, computes its content hash, and STREAMS the full {@link Game} (plus a
 * `collection` frame up front for grouped imports) to the client, which dedups
 * and writes into IndexedDB. The job row / SSE machinery stays for progress.
 */
@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);
  /**
   * Per-job event channels. Each channel is a `ReplaySubject` that buffers
   * EVERY frame — `collection`, every `game`, and the terminal `done`/`error`
   * — for the job's whole lifetime, not just the live ones.
   *
   * That buffering is what makes a late subscriber correct: the browser only
   * opens its `EventSource` after the `POST /import` response round-trips, so
   * a fast/inline import (pasted PGN, no network fetch) can emit its entire
   * frame sequence — or finish outright — before anyone is listening. A plain
   * `Subject` drops those frames on the floor (silent data loss: the client
   * ends up with nothing imported and no error). A `ReplaySubject` replays its
   * buffer to any subscriber that attaches later, including after the subject
   * has completed (a completed `ReplaySubject` still replays the buffer to a
   * new subscriber before signalling `complete`), so `getStream` can use the
   * exact same channel for both live and post-completion subscribers — no
   * separate terminal-frame-replay path needed.
   *
   * Entries are kept for the life of the process (never deleted — mirrors
   * `ImportJobsRepository`, which is the same kind of unbounded in-memory
   * store). Memory tradeoff: this buffers full `Game` payloads per job for as
   * long as the process runs, which is fine for ephemeral, bounded bulk
   * imports but would need eviction/TTL for a long-lived multi-tenant server.
   */
  private readonly streams = new Map<string, ReplaySubject<ImportEvent>>();

  constructor(
    private readonly chess: ChessService,
    private readonly jobs: ImportJobsRepository,
    private readonly urlSource: UrlSource,
    private readonly lichessSource: LichessSource,
    private readonly chesscomSource: ChessComSource,
    private readonly catalogSource: CatalogSource,
  ) {}

  /**
   * Begin an import. Creates the job row, opens its event stream, optionally
   * describes a collection up front (named URL imports / remote providers) —
   * emitted to the client, not persisted here — and launches the pipeline in the
   * background. Returns the new job id.
   *
   * @throws BadRequestException when the request is malformed (no resolvable
   *   source) — the only synchronous validation; all per-game and source-level
   *   failures are reported asynchronously on the job/stream.
   */
  start(req: StartImportRequest): { jobId: string } {
    const source = this.resolveSource(req);

    const collection = this.buildCollection(req);
    const job = this.jobs.create({
      source: req.source as ImportSource,
      params: req,
      status: 'running',
      collectionId: collection?.id,
    });

    // The ReplaySubject must exist before the (sync-started) pipeline emits,
    // so an SSE client that connects between `start` and the first tick still
    // sees events — and any client that connects even later still replays
    // them from the buffer. Unbounded: buffer every frame for the job's life.
    this.streams.set(job.id, new ReplaySubject<ImportEvent>());

    // Fire and forget: the request returns now; progress flows over SSE / poll.
    void this.runPipeline(job.id, source, req, collection);

    return { jobId: job.id };
  }

  /**
   * SSE source for a job. Maps each {@link ImportEvent} to the `{ data }` shape
   * `@Sse` expects. The job's channel is a `ReplaySubject` that buffers its full
   * frame history, so this behaves identically whether the subscriber attaches
   * while the pipeline is still running or after it has already finished
   * (`done`/`error`) — either way it replays every frame in order, then
   * completes. Unknown job ids (never started, or from a previous process —
   * job state is in-memory only) get an immediately-completed empty stream;
   * clients fall back to `GET /api/import/:jobId`.
   */
  getStream(jobId: string): Observable<MessageEvent> {
    const stream = this.streams.get(jobId);
    const events = stream ? stream.asObservable() : EMPTY;
    return events.pipe(
      map((event): MessageEvent => ({ data: JSON.stringify(event) })),
    );
  }

  // ── pipeline ───────────────────────────────────────────────────────────────

  /**
   * The single import path (SPEC §5). Emits a `collection` frame up front (for
   * grouped imports), then iterates the source's PGN stream; per game it parses →
   * hashes → emits the full {@link Game} for the client to dedup and store,
   * counting parsed/failed and emitting progress. A source-level failure before
   * any game ends the job as `error`; otherwise it ends `done` (partial success
   * still counts). Nothing is persisted server-side.
   */
  private async runPipeline(
    jobId: string,
    source: GameSource,
    req: StartImportRequest,
    collection: Collection | undefined,
  ): Promise<void> {
    const counts: Counts = { imported: 0, skipped: 0, failed: 0 };
    const errorSample: string[] = [];
    let sawAnyGame = false;

    // Defer past `start`'s synchronous return so a subscriber that attaches
    // immediately still receives the up-front `collection` frame.
    await tick();
    if (collection) {
      this.emit(jobId, { type: 'collection', collection });
    }

    try {
      for await (const pgn of source.fetch(req)) {
        sawAnyGame = true;
        this.ingest(jobId, pgn, counts, errorSample);
        this.emit(jobId, {
          type: 'progress',
          imported: counts.imported,
          skipped: counts.skipped,
          failed: counts.failed,
        });
        this.jobs.update(jobId, { ...counts });
        // Yield so a synchronous source doesn't starve SSE/HTTP.
        await tick();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A source failure after some games were streamed is a partial success;
      // only a failure before the first game is a hard job error. The client
      // drops any orphaned up-front collection on the `error` frame.
      if (!sawAnyGame) {
        this.finishError(jobId, message);
        return;
      }
      if (errorSample.length < ERROR_SAMPLE_CAP) errorSample.push(message);
    }

    this.finishDone(jobId, counts, errorSample, collection?.id);
  }

  /**
   * Parse one game's PGN and stream it to the client. Mutates `counts` and emits
   * a `game` event carrying the full {@link Game} plus its {@link contentHash}
   * (the client dedups; the server does not). Parse errors are caught here
   * (counted as `failed`, sampled) and never abort the job.
   */
  private ingest(
    jobId: string,
    pgn: string,
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

    // `imported` here is the count of games the server STREAMED. The client
    // recomputes imported-vs-skipped from its own dedup as it stores them.
    counts.imported += 1;
    this.emit(jobId, { type: 'game', game, contentHash: contentHash(game) });
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
   * Describe the collection to stream up front when the import is named/grouped
   * (SPEC §5). Remote providers (`lichess` / `chesscom` / `catalog`) always get a
   * collection so their games are browsable as a group; URL imports only get one
   * when `collectionName` is supplied; bare pastes/URLs stream with no collection.
   * The returned {@link Collection} is emitted to the client (which persists it) —
   * the server does not touch a database here.
   */
  private buildCollection(req: StartImportRequest): Collection | undefined {
    const base = { id: randomUUID(), gameCount: 0, createdAt: Date.now() };
    switch (req.source) {
      case 'url':
        if (!req.collectionName?.trim()) return undefined;
        return {
          ...base,
          name: req.collectionName.trim(),
          source: 'url',
          sourceRef: req.url?.trim(),
        };

      case 'lichess':
        return {
          ...base,
          name: `Lichess ${req.kind}: ${req.id}`,
          source: 'lichess',
          sourceRef: `${req.kind}/${req.id}`,
        };

      case 'chesscom':
        return {
          ...base,
          name: `Chess.com: ${req.username}`,
          source: 'chesscom',
          sourceRef: req.username,
        };

      case 'catalog': {
        const entry = findCatalogEntry(req.entryId);
        return {
          ...base,
          name: entry?.title ?? `Catalog: ${req.entryId}`,
          description: entry?.description,
          source: 'catalog',
          sourceRef: req.entryId,
        };
      }

      default:
        return undefined;
    }
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

  /**
   * Signal completion once the terminal frame has been emitted. The subject is
   * intentionally NOT removed from `streams`: a completed `ReplaySubject`
   * still replays its buffered history to a subscriber that attaches later, so
   * keeping the entry around is what makes late subscribers work at all.
   */
  private closeStream(jobId: string): void {
    this.streams.get(jobId)?.complete();
  }
}

/** Resolve on the next macrotask so synchronous SQLite writes don't starve I/O. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
