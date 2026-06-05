import { Injectable, Logger, Optional } from '@nestjs/common';
import type { EngineEval } from '@chess/shared';
import { EngineService, type AnalyzeOptions } from './engine.service';
import { EvalCacheRepository } from '../persistence/eval-cache.repository';
import { openDatabase } from '../persistence/database';
import { normalizeFen } from './fen-norm';

/**
 * Default search depth when a caller omits one. Mirrors EngineService's own
 * default so a bare `analyze(fen)` keys the cache identically whether it hits or
 * misses. Kept here (not imported) because the cache key must be computed from
 * the *effective* depth, which CachedEngine pins explicitly on the engine call.
 */
const DEFAULT_DEPTH = 18;
const DEFAULT_MULTIPV = 1;

/**
 * Caching gateway in front of {@link EngineService}. Exposes the same
 * `analyze(fen, opts)` signature so it is a drop-in dependency for
 * AnalysisService — every analysis path routes through this one choke point.
 *
 * On a cache hit the stored {@link EngineEval} is returned (lines sliced to the
 * requested MultiPV) without touching Stockfish. On a miss the underlying engine
 * runs and the result is written through. Cache reads and writes are
 * **best-effort**: any cache error is logged and analysis proceeds against the
 * engine, so a broken cache never fails an analysis.
 */
@Injectable()
export class CachedEngine {
  private readonly logger = new Logger(CachedEngine.name);
  private readonly cache: EvalCacheRepository;

  /**
   * `cache` is `@Optional` so CachedEngine stays self-sufficient when wired in
   * isolation (unit tests, or a feature module compiled without the `@Global`
   * PersistenceModule), mirroring {@link GameStore}'s fallback. In the running
   * app the global EvalCacheRepository is injected; absent it, a private
   * in-memory cache keeps behavior intact (just not durable).
   */
  constructor(
    private readonly engine: EngineService,
    @Optional() cache?: EvalCacheRepository,
  ) {
    this.cache = cache ?? new EvalCacheRepository(openDatabase(':memory:'));
  }

  /**
   * Analyze `fen`, served from the eval cache when possible. The effective depth
   * and MultiPV are pinned here and passed verbatim to the engine, so the cache
   * key always matches what was (or would be) computed.
   */
  async analyze(fen: string, opts: AnalyzeOptions = {}): Promise<EngineEval> {
    const depth = opts.depth ?? DEFAULT_DEPTH;
    const multipv = Math.max(1, opts.multipv ?? DEFAULT_MULTIPV);
    const fenNorm = normalizeFen(fen);
    const engineId = this.engine.engineId;

    const hit = this.tryGet(fenNorm, depth, multipv, engineId);
    if (hit) return hit;

    const result = await this.engine.analyze(fen, { depth, multipv });
    this.tryWrite(fenNorm, depth, multipv, engineId, result);
    return result;
  }

  /** Best-effort cache read; a failure logs and is treated as a miss. */
  private tryGet(
    fenNorm: string,
    depth: number,
    multipv: number,
    engineId: string,
  ): EngineEval | undefined {
    try {
      return this.cache.get(fenNorm, depth, multipv, engineId);
    } catch (err) {
      this.logger.warn(
        `Eval cache read failed for ${fenNorm} (depth=${depth}, multipv=${multipv}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return undefined;
    }
  }

  /** Best-effort write-through; a failure logs and never throws. */
  private tryWrite(
    fenNorm: string,
    depth: number,
    multipv: number,
    engineId: string,
    result: EngineEval,
  ): void {
    try {
      this.cache.set(fenNorm, depth, multipv, engineId, JSON.stringify(result));
    } catch (err) {
      this.logger.warn(
        `Eval cache write failed for ${fenNorm} (depth=${depth}, multipv=${multipv}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
