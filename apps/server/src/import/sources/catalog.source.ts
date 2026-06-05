import { gunzipSync } from 'node:zlib';
import { Injectable } from '@nestjs/common';
import type { CatalogEntry, StartImportRequest } from '@chess/shared';
import type { GameSource } from '../game-source';
import { PgnSplitter } from '../pgn-splitter';
import { findCatalogEntry } from '../catalog.manifest';
import { BUNDLED_PGNS } from './fixtures/bundled-pgns';
import { fetchWithRetry, globalFetch, type FetchFn } from './http';

/**
 * The `'catalog'` import source (SPEC §5 / §10.5). Resolves an `entryId` against
 * the bundled {@link findCatalogEntry manifest}, then yields single-game PGNs:
 *
 *  - `bundled: true` entries read the offline PGN from
 *    `sources/fixtures/bundled-pgns.ts` (keyed by entry id) — no network.
 *  - other entries fetch the entry's `url` (a remote `.pgn` / `.pgn.gz`), gunzip
 *    if needed, then split. If that remote fetch fails but a bundled fixture
 *    exists for the id, we fall back to the offline copy (best-effort offline).
 *
 * An unknown `entryId`, or a remote failure with no bundled fallback, throws so
 * the pipeline ends the job as `error`. `fetchFn` is injectable for tests.
 */
@Injectable()
export class CatalogSource implements GameSource {
  constructor(
    private readonly fetchFn: FetchFn = globalFetch,
    private readonly splitter: PgnSplitter = new PgnSplitter(),
  ) {}

  async *fetch(params: StartImportRequest): AsyncIterable<string> {
    if (params.source !== 'catalog') {
      throw new Error(`CatalogSource cannot handle source "${params.source}".`);
    }

    const entry = findCatalogEntry(params.entryId?.trim() ?? '');
    if (!entry) {
      throw new Error(`Unknown catalog entry "${params.entryId}".`);
    }

    const text = await this.resolveText(entry);
    for (const game of this.splitter.split(text)) {
      yield game;
    }
  }

  /**
   * Produce the multi-game PGN text for an entry. Bundled entries read the
   * offline fixture directly; remote entries fetch the URL and gunzip when
   * needed, falling back to a bundled fixture (if present) on network failure.
   */
  private async resolveText(entry: CatalogEntry): Promise<string> {
    const bundled = BUNDLED_PGNS[entry.id];
    if (entry.bundled) {
      if (!bundled) {
        throw new Error(`Catalog entry "${entry.id}" is bundled but has no fixture.`);
      }
      return bundled;
    }

    try {
      return await this.download(entry.url);
    } catch (err) {
      if (bundled) return bundled; // best-effort offline fallback
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /** Fetch `url` and decode to PGN text, gunzipping a `.gz` / gzip-magic body. */
  private async download(url: string): Promise<string> {
    const response = await fetchWithRetry(this.fetchFn, url, {
      headers: { Accept: 'application/x-chess-pgn, text/plain, */*' },
    });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch catalog PGN ${url}: ${response.status} ${response.statusText}`.trim(),
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const looksGzip =
      url.toLowerCase().endsWith('.gz') ||
      response.headers.get('content-encoding')?.includes('gzip') === true ||
      (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b);
    return (looksGzip ? gunzipSync(buffer) : buffer).toString('utf8');
  }
}
