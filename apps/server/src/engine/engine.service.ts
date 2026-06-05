import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Engine, type BestMove, type Info } from 'node-uci';
import type { EngineEval, EngineLine } from '@chess/shared';
import { EngineTimeoutError, EngineUnavailableError } from './errors';

export interface AnalyzeOptions {
  depth?: number;
  multipv?: number;
}

const DEFAULT_DEPTH = 18;
const DEFAULT_MULTIPV = 1;
const DEFAULT_THREADS = 4;
const DEFAULT_HASH_MB = 256;
/** Hard ceiling per analyze() call before we tear the process down and restart. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Talks to a single native Stockfish process over UCI (via node-uci).
 *
 * Guarantees:
 *  - one `go` in flight at a time (internal FIFO promise queue);
 *  - a per-request timeout; on crash or timeout the process is force-restarted;
 *  - scores are normalized to White-POV centipawns;
 *  - a missing/unspawnable binary surfaces as a typed {@link EngineUnavailableError}.
 */
@Injectable()
export class EngineService implements OnModuleDestroy {
  private readonly logger = new Logger(EngineService.name);
  private readonly binaryPath = process.env.STOCKFISH_PATH || 'stockfish';

  private engine: Engine | null = null;
  /** MultiPV currently configured on the live engine; -1 = unknown/needs set. */
  private currentMultipv = -1;
  /** FIFO mutex: every command runs after the previous one settles. */
  private queue: Promise<unknown> = Promise.resolve();
  private destroyed = false;
  /**
   * Slug of the engine's UCI `id name` line, captured during the handshake
   * (e.g. `stockfish-18`). Stays `null` until the engine first starts; the
   * {@link engineId} getter falls back to a stable placeholder until then.
   */
  private engineIdSlug: string | null = null;

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    await this.shutdown();
  }

  /**
   * Stable identifier for the running engine, derived from its UCI `id name`
   * (e.g. `stockfish-18`). Used by the eval cache so a Stockfish upgrade
   * silently invalidates stale rows. Falls back to `stockfish-unknown` until the
   * engine has handshaked at least once (or if it never advertised a name).
   */
  get engineId(): string {
    return this.engineIdSlug ?? 'stockfish-unknown';
  }

  /**
   * Analyze a position. Returns the top-`multipv` lines with White-POV scores.
   * Serialized behind the internal queue so only one search runs at a time.
   */
  async analyze(fen: string, opts: AnalyzeOptions = {}): Promise<EngineEval> {
    const depth = opts.depth ?? DEFAULT_DEPTH;
    const multipv = Math.max(1, opts.multipv ?? DEFAULT_MULTIPV);

    return this.exclusive(async () => {
      const engine = await this.ensureStarted();
      try {
        if (this.currentMultipv !== multipv) {
          await engine.setoption('MultiPV', multipv);
          this.currentMultipv = multipv;
        }
        await engine.position(fen);
        const result = await this.withTimeout(
          engine.go({ depth }),
          REQUEST_TIMEOUT_MS,
        );
        return this.toEngineEval(fen, result, multipv);
      } catch (err) {
        // A crash rejects go(); a hang trips withTimeout. Either way the process
        // is in an unknown state — tear it down so the next call gets a fresh one.
        await this.shutdown();
        throw err;
      }
    });
  }

  // --- internals -----------------------------------------------------------

  /** Run `fn` exclusively; callers are queued FIFO and isolated from each other. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    // Keep the lock alive even if a prior task rejected.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Lazily spawn + configure the engine. Throws EngineUnavailableError if spawn fails. */
  private async ensureStarted(): Promise<Engine> {
    if (this.engine) return this.engine;

    const engine = new Engine(this.binaryPath);
    try {
      await engine.init();
      // node-uci populates engine.id from the `id name` line during init().
      const name = engine.id?.name;
      if (name) this.engineIdSlug = slugify(name);
      await engine.setoption('Threads', DEFAULT_THREADS);
      await engine.setoption('Hash', DEFAULT_HASH_MB);
      await engine.isready();
    } catch (err) {
      // Best-effort cleanup of any half-spawned process.
      await this.killEngine(engine);
      throw this.wrapStartupError(err);
    }

    this.engine = engine;
    this.currentMultipv = -1;
    return engine;
  }

  /** Tear down the live engine; the next analyze() will respawn it. */
  private async shutdown(): Promise<void> {
    const engine = this.engine;
    this.engine = null;
    this.currentMultipv = -1;
    if (engine) await this.killEngine(engine);
  }

  private async killEngine(engine: Engine): Promise<void> {
    try {
      await engine.quit();
    } catch {
      // Process may already be dead, or quit() may hang on a wedged process.
    }
    try {
      engine.proc?.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new EngineTimeoutError()), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private wrapStartupError(err: unknown): Error {
    if (err instanceof EngineUnavailableError) return err;
    const code = (err as { code?: string } | null)?.code;
    if (code === 'ENOENT' || code === 'EACCES') {
      return new EngineUnavailableError(
        `Stockfish binary not found or not executable at "${this.binaryPath}". ` +
          `Install Stockfish or set STOCKFISH_PATH.`,
        { cause: err },
      );
    }
    return new EngineUnavailableError(
      `Failed to start Stockfish at "${this.binaryPath}": ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }

  /**
   * Build an {@link EngineEval} from a raw go() result, normalizing scores to
   * White-POV centipawns. Keeps the deepest line seen per multipv slot.
   */
  private toEngineEval(
    fen: string,
    result: BestMove,
    multipv: number,
  ): EngineEval {
    const blackToMove = sideToMove(fen) === 'b';

    // Last line wins per slot: info is chronological with non-decreasing depth,
    // so the final occurrence for each multipv index is the deepest.
    const byRank = new Map<number, Info>();
    let maxDepth = 0;
    for (const info of result.info) {
      if (!info.score || info.pv == null) continue;
      const rank = info.multipv ?? 1; // MultiPV omitted at default 1 -> rank 1
      byRank.set(rank, info);
      if (typeof info.depth === 'number' && info.depth > maxDepth) {
        maxDepth = info.depth;
      }
    }

    const lines: EngineLine[] = [...byRank.values()]
      .sort((a, b) => (a.multipv ?? 1) - (b.multipv ?? 1))
      .slice(0, multipv)
      .map((info) => {
        const score = info.score!;
        const sign = blackToMove ? -1 : 1;
        const isMate = score.unit === 'mate';
        return {
          rank: info.multipv ?? 1,
          pv: info.pv!.split(' ').filter(Boolean),
          scoreCp: isMate ? null : sign * score.value,
          mate: isMate ? sign * score.value : null,
        };
      });

    return {
      fen,
      bestMove: result.bestmove ?? lines[0]?.pv[0] ?? null,
      lines,
      depth: maxDepth,
    };
  }
}

/** Side to move from a FEN's 2nd field; `'startpos'` is White to move. */
function sideToMove(fen: string): 'w' | 'b' {
  if (fen === 'startpos') return 'w';
  return fen.split(' ')[1] === 'b' ? 'b' : 'w';
}

/**
 * Turn a UCI `id name` (e.g. `Stockfish 16.1`) into a stable cache slug
 * (`stockfish-16-1`): lowercase, non-alphanumeric runs collapsed to a single
 * dash, edges trimmed. Used as the eval cache's `engine_id`.
 */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'stockfish-unknown'
  );
}
