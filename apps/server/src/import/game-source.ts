import type { StartImportRequest } from '@chess/shared';

/**
 * A streaming source of single-game PGN strings. Each yielded string is exactly
 * one game's PGN (headers + movetext), ready for `ChessService.importPgn`. The
 * pipeline (see {@link import('./import.service').ImportService}) consumes the
 * async iterable one game at a time, yielding to the event loop between games so
 * a multi-thousand-game import stays responsive.
 *
 * Sources never dedup or persist — they only fetch + split. A source-level
 * failure (bad URL, 404, network down before any game) should throw from
 * `fetch` (or its first iteration) so the pipeline can end the job as `error`.
 */
export interface GameSource {
  fetch(params: StartImportRequest): AsyncIterable<string>;
}
