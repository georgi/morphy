import { Injectable } from '@nestjs/common';
import type { StartImportRequest } from '@chess/shared';
import type { GameSource } from '../game-source';
import { fetchWithRetry, globalFetch, type FetchFn } from './http';

/** Chess.com's public API requires a descriptive, non-empty User-Agent. */
const USER_AGENT =
  'morphy/1.0 (https://github.com/georgi/morphy; bulk PGN import)';

/** Shape of a monthly archive payload from chess.com's public API. */
interface ChessComArchive {
  games?: Array<{ pgn?: string }>;
}

/** Shape of the archives index payload. */
interface ChessComArchivesIndex {
  archives?: string[];
}

/**
 * The `'chesscom'` import source. Two-step (SPEC §5): first the player's monthly
 * archive index (`GET /pub/player/{u}/games/archives`), then each selected monthly
 * archive (`GET …/{year}/{month}` → `{ games: [{ pgn }] }`), yielding each game's
 * PGN. `months` selects a subset (`'YYYY/MM'` or `'YYYY-MM'`) or `'all'`.
 *
 * Chess.com's public API requires a descriptive `User-Agent` (it 403s blank/UA-less
 * requests); we always send {@link USER_AGENT}. 429 / transient failures retry with
 * backoff (SPEC §8). A failure fetching the index (bad username, network down)
 * throws so the pipeline ends the job as `error`; a single bad monthly archive
 * is non-fatal (it is skipped and the import continues, whether or not games
 * have been yielded already).
 *
 * `fetchFn` is injectable so unit tests run against recorded fixtures, no network.
 */
@Injectable()
export class ChessComSource implements GameSource {
  constructor(private readonly fetchFn: FetchFn = globalFetch) {}

  async *fetch(params: StartImportRequest): AsyncIterable<string> {
    if (params.source !== 'chesscom') {
      throw new Error(`ChessComSource cannot handle source "${params.source}".`);
    }

    const username = params.username?.trim().toLowerCase();
    if (!username) throw new Error('Provide a chess.com "username".');

    const archives = await this.fetchArchives(username);
    const selected = this.selectArchives(archives, params.months);

    for (const archiveUrl of selected) {
      let archive: ChessComArchive;
      try {
        archive = await this.fetchJson<ChessComArchive>(archiveUrl);
      } catch {
        // A single bad monthly archive is never fatal — skip it and keep going
        // (SPEC §8 per-archive failure isolation). Only an index-level failure
        // (`fetchArchives`, above) ends the job as `error`.
        continue;
      }
      // Chess.com lists a month's games oldest-first; reverse so the most recent
      // game in the (most recent) month is yielded first.
      const games = [...(archive.games ?? [])].reverse();
      for (const game of games) {
        const pgn = game.pgn?.trim();
        if (pgn) yield pgn;
      }
    }
  }

  /** Fetch the player's archive index; throws (source-level failure) on error. */
  private async fetchArchives(username: string): Promise<string[]> {
    const url = `https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/archives`;
    const index = await this.fetchJson<ChessComArchivesIndex>(url);
    return index.archives ?? [];
  }

  /**
   * Filter the archive URLs by `months`, then order them most-recent-month-first
   * so the import starts at the newest games. `'all'` / undefined keeps every
   * archive; an array keeps archives whose trailing `year/month` matches an entry
   * (either `YYYY/MM` or `YYYY-MM` form). The index arrives oldest-first, so we
   * reverse it.
   */
  private selectArchives(
    archives: string[],
    months: string[] | 'all' | undefined,
  ): string[] {
    const selected =
      !months || months === 'all'
        ? archives
        : (() => {
            const wanted = new Set(months.map((m) => m.replace(/-/g, '/').trim()));
            return archives.filter((url) => {
              const suffix = url.split('/').slice(-2).join('/'); // "2024/01"
              return wanted.has(suffix);
            });
          })();
    return selected.slice().reverse();
  }

  /** GET + JSON-parse with the required User-Agent and backoff retry. */
  private async fetchJson<T>(url: string): Promise<T> {
    const response = await fetchWithRetry(this.fetchFn, url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(
        `Chess.com request failed: ${response.status} ${response.statusText} (${url})`.trim(),
      );
    }
    return (await response.json()) as T;
  }
}
