import { gunzipSync } from 'node:zlib';
import { Injectable } from '@nestjs/common';
import type { StartImportRequest } from '@chess/shared';
import type { GameSource } from '../game-source';
import { PgnSplitter } from '../pgn-splitter';

/**
 * The `'url'` import source: either fetch a remote `.pgn` / `.pgn.gz` file, or
 * accept pasted multi-game PGN text directly. Either way the resulting text is
 * run through {@link PgnSplitter} and each single-game PGN is yielded.
 *
 * No network library — uses the global `fetch` (Node 22) and `node:zlib` for
 * gzip. A `.gz` URL (or a gzip `Content-Encoding`/magic-byte) is gunzipped; a
 * plain `.pgn` is decoded as UTF-8.
 *
 * Source-level failures (no input, non-2xx response, network error) throw from
 * the first iteration so the pipeline ends the job as `error` with the message.
 */
@Injectable()
export class UrlSource implements GameSource {
  constructor(private readonly splitter: PgnSplitter = new PgnSplitter()) {}

  async *fetch(params: StartImportRequest): AsyncIterable<string> {
    if (params.source !== 'url') {
      throw new Error(`UrlSource cannot handle source "${params.source}".`);
    }

    const pasted = params.pgn?.trim();
    const url = params.url?.trim();

    let text: string;
    if (pasted) {
      // Pasted multi-game PGN takes precedence; no network involved.
      text = pasted;
    } else if (url) {
      text = await this.download(url);
    } else {
      throw new Error('Provide a "url" or pasted "pgn" to import.');
    }

    for (const game of this.splitter.split(text)) {
      yield game;
    }
  }

  /** Fetch `url` and decode to PGN text, gunzipping when the body is gzip. */
  private async download(url: string): Promise<string> {
    let response: Response;
    try {
      response = await globalThis.fetch(url, {
        headers: { Accept: 'application/x-chess-pgn, text/plain, */*' },
      });
    } catch (err) {
      throw new Error(
        `Failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!response.ok) {
      throw new Error(
        `Failed to fetch ${url}: ${response.status} ${response.statusText}`.trim(),
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return this.decode(url, response, buffer);
  }

  /**
   * Decode a downloaded body to text. Gunzips when the URL ends in `.gz`, the
   * response declared `Content-Encoding: gzip`, or the bytes carry the gzip
   * magic number (`1f 8b`). Otherwise treats the bytes as UTF-8.
   */
  private decode(url: string, response: Response, buffer: Buffer): string {
    const looksGzip =
      url.toLowerCase().endsWith('.gz') ||
      response.headers.get('content-encoding')?.includes('gzip') === true ||
      (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b);
    const decoded = looksGzip ? gunzipSync(buffer) : buffer;
    return decoded.toString('utf8');
  }
}
