import { Injectable } from '@nestjs/common';
import type { StartImportRequest } from '@chess/shared';
import type { GameSource } from '../game-source';
import { PgnSplitter } from '../pgn-splitter';
import { splitPgnStream } from './pgn-stream';
import { fetchWithRetry, globalFetch, type FetchFn } from './http';

/** Lichess always serves PGN exports under this content type. */
const PGN_ACCEPT = 'application/x-chess-pgn';

/**
 * The `'lichess'` import source. Resolves one of three Lichess PGN endpoints from
 * the request `kind` and streams the response through the PGN splitter:
 *
 *  - `user`      → `GET /api/games/user/{id}`  (`max` games, Accept x-chess-pgn)
 *  - `study`     → `GET /api/study/{id}.pgn`   (a whole study, all chapters)
 *  - `broadcast` → `GET /api/broadcast/round/{id}.pgn` (a broadcast round)
 *
 * Anonymous by default; if `LICHESS_TOKEN` is set it is sent as a Bearer token
 * (higher rate limits / access to private studies). 429 / transient failures are
 * retried with exponential backoff via {@link fetchWithRetry} (SPEC §8). A
 * source-level failure (404 study, bad user, network down) throws so the pipeline
 * ends the job as `error`.
 *
 * The `fetchFn` is injectable so unit tests drive recorded fixtures with no
 * network; production uses the global `fetch`.
 */
@Injectable()
export class LichessSource implements GameSource {
  constructor(
    private readonly fetchFn: FetchFn = globalFetch,
    private readonly splitter: PgnSplitter = new PgnSplitter(),
  ) {}

  async *fetch(params: StartImportRequest): AsyncIterable<string> {
    if (params.source !== 'lichess') {
      throw new Error(`LichessSource cannot handle source "${params.source}".`);
    }

    const id = params.id?.trim();
    if (!id) throw new Error('Provide a Lichess id (user / study / broadcast).');

    const url = this.endpoint(params.kind, id, params.max);
    const response = await fetchWithRetry(this.fetchFn, url, {
      headers: this.headers(),
    });
    if (!response.ok) {
      throw new Error(
        `Lichess request failed: ${response.status} ${response.statusText} (${url})`.trim(),
      );
    }

    yield* splitPgnStream(response.body, this.splitter);
  }

  /** Build the PGN endpoint URL for a given lichess import kind. */
  private endpoint(kind: 'user' | 'study' | 'broadcast', id: string, max?: number): string {
    const u = encodeURIComponent(id);
    switch (kind) {
      case 'user': {
        // Always newest-first (`dateDesc`) so a `max` cap keeps the most recent
        // games, not the oldest. It is Lichess's current default, but pinning it
        // makes the behavior explicit and survives any default change.
        const params = new URLSearchParams({ sort: 'dateDesc' });
        if (max && max > 0) params.set('max', String(Math.floor(max)));
        return `https://lichess.org/api/games/user/${u}?${params.toString()}`;
      }
      case 'study':
        return `https://lichess.org/api/study/${u}.pgn`;
      case 'broadcast':
        return `https://lichess.org/api/broadcast/round/${u}.pgn`;
      default:
        throw new Error(`Unknown lichess kind "${String(kind)}".`);
    }
  }

  /** Accept PGN; attach a Bearer token only when `LICHESS_TOKEN` is configured. */
  private headers(): Record<string, string> {
    const headers: Record<string, string> = { Accept: PGN_ACCEPT };
    const token = process.env.LICHESS_TOKEN?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }
}
