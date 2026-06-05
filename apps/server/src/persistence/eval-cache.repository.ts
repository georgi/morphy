import { Inject, Injectable } from '@nestjs/common';
import type { EngineEval } from '@chess/shared';
import { DATABASE, type Db } from './database';

/** Row shape for the `eval_cache` table. */
interface EvalCacheRow {
  multipv: number;
  eval_json: string;
}

/**
 * Synchronous read/write of the global Stockfish eval cache, keyed by
 * `(fen_norm, depth, multipv, engine_id)`.
 *
 * Lookups match the exact `(fen_norm, depth, engine_id)` and accept any stored
 * row whose `multipv` is **≥** the requested count, returning the cached
 * {@link EngineEval} with its lines sliced to the top `requested`. A row stored
 * at higher MultiPV therefore satisfies a request for fewer lines (the narrower
 * one is a prefix of the wider analysis), maximizing hit rate.
 */
@Injectable()
export class EvalCacheRepository {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  /**
   * Fetch a cached eval for the exact `(fenNorm, depth, engineId)` that has at
   * least `multipv` lines, sliced to the requested `multipv`. Returns
   * `undefined` on a miss. Prefers the narrowest qualifying row (smallest stored
   * MultiPV ≥ requested) to minimize wasted slicing.
   */
  get(
    fenNorm: string,
    depth: number,
    multipv: number,
    engineId: string,
  ): EngineEval | undefined {
    const row = this.db
      .prepare(
        `SELECT multipv, eval_json FROM eval_cache
           WHERE fen_norm = ? AND depth = ? AND engine_id = ? AND multipv >= ?
           ORDER BY multipv ASC
           LIMIT 1`,
      )
      .get(fenNorm, depth, engineId, multipv) as EvalCacheRow | undefined;
    if (!row) return undefined;

    const cached = JSON.parse(row.eval_json) as EngineEval;
    return { ...cached, lines: cached.lines.slice(0, multipv) };
  }

  /**
   * Write-through a freshly computed eval. `INSERT OR REPLACE` so re-analysis at
   * the same key (e.g. a deeper run) overwrites the prior row. `evalJson` is the
   * already-serialized {@link EngineEval}.
   */
  set(
    fenNorm: string,
    depth: number,
    multipv: number,
    engineId: string,
    evalJson: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO eval_cache
           (fen_norm, depth, multipv, engine_id, eval_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(fenNorm, depth, multipv, engineId, evalJson, Date.now());
  }
}
