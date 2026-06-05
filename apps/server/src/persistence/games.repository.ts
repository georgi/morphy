import { Inject, Injectable } from '@nestjs/common';
import type {
  Game,
  GameSummary,
  ImportSource,
  LibraryPage,
  LibraryQuery,
  MoveEval,
} from '@chess/shared';
import { DATABASE, type Db } from './database';
import { contentHash } from './content-hash';

/** Optional provenance recorded alongside a game on insert. */
export interface GameMeta {
  /** Where the game came from. Defaults to `'manual'`. */
  source?: ImportSource;
  /** Collection this game belongs to, or `null`/absent for direct imports. */
  collectionId?: string | null;
  /** Precomputed content hash; derived from the game when omitted. */
  contentHash?: string;
}

/** Row shape for the `games` table (snake_case columns). */
interface GameRow {
  id: string;
  white: string | null;
  black: string | null;
  result: string | null;
  eco: string | null;
  opening: string | null;
  date: string | null;
  ply_count: number;
  content_hash: string;
  source: string;
  collection_id: string | null;
  has_analysis: number;
  created_at: number;
  data: string;
}

/** Subset of `games` columns read for a {@link GameSummary} (no `data` JSON). */
interface GameSummaryRow {
  id: string;
  white: string | null;
  black: string | null;
  result: string | null;
  eco: string | null;
  opening: string | null;
  date: string | null;
  ply_count: number;
  source: string;
  collection_id: string | null;
  has_analysis: number;
  created_at: number;
}

/** Whitelist mapping the public `LibraryQuery.sort` to a real, indexed column. */
const SORT_COLUMNS: Record<
  NonNullable<LibraryQuery['sort']>,
  string
> = {
  createdAt: 'created_at',
  white: 'white',
  black: 'black',
  date: 'date',
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Project a denormalized row into the shared {@link GameSummary} contract. */
function toSummary(row: GameSummaryRow): GameSummary {
  return {
    id: row.id,
    white: row.white ?? undefined,
    black: row.black ?? undefined,
    result: row.result ?? undefined,
    eco: row.eco ?? undefined,
    opening: row.opening ?? undefined,
    date: row.date ?? undefined,
    plyCount: row.ply_count,
    source: row.source as ImportSource,
    collectionId: row.collection_id ?? undefined,
    hasAnalysis: row.has_analysis === 1,
    createdAt: row.created_at,
  };
}

/**
 * Synchronous CRUD over the `games` table. The canonical {@link Game} lives in the
 * `data` JSON column; the scalar columns are denormalized copies for fast
 * search/sort without parsing JSON. This repository is the durable backing store
 * behind {@link GameStore}.
 */
@Injectable()
export class GamesRepository {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  /**
   * Insert (or replace, by id) a game with optional provenance. The Map-style
   * `create` semantics of the old in-memory store are preserved: an existing row
   * with the same id is overwritten. Returns the stored game.
   */
  create(game: Game, meta: GameMeta = {}): Game {
    const hash = meta.contentHash ?? contentHash(game);
    const row = this.toRow(game, {
      source: meta.source ?? 'manual',
      collectionId: meta.collectionId ?? null,
      contentHash: this.resolveHashForId(game.id, hash, meta.contentHash != null),
      createdAt: Date.now(),
    });
    this.db
      .prepare(
        `INSERT OR REPLACE INTO games
           (id, white, black, result, eco, opening, date, ply_count,
            content_hash, source, collection_id, has_analysis, created_at, data)
         VALUES
           (@id, @white, @black, @result, @eco, @opening, @date, @ply_count,
            @content_hash, @source, @collection_id, @has_analysis, @created_at, @data)`,
      )
      .run(row);
    return game;
  }

  /**
   * Reconcile the content hash with the `content_hash UNIQUE` constraint when a
   * direct `create` stores two games whose moves+headers collide under *different*
   * ids (e.g. fixture games). The import pipeline never hits this: it dedups via
   * {@link existsByHash} and supplies an explicit hash (`explicit`), which is
   * stored verbatim so the global-dedup probe stays exact. Only an implicitly
   * derived hash that already belongs to a different id is disambiguated.
   */
  private resolveHashForId(
    id: string,
    hash: string,
    explicit: boolean,
  ): string {
    if (explicit) return hash;
    const owner = this.db
      .prepare('SELECT id FROM games WHERE content_hash = ? LIMIT 1')
      .get(hash) as { id: string } | undefined;
    if (!owner || owner.id === id) return hash;
    return `${hash}:${id}`;
  }

  /** Look up a game by id, or `undefined` if absent. Returns a fresh object. */
  get(id: string): Game | undefined {
    const row = this.db
      .prepare('SELECT data FROM games WHERE id = ?')
      .get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Game) : undefined;
  }

  /** Whether a game with this id exists. */
  has(id: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM games WHERE id = ? LIMIT 1')
      .get(id);
    return row !== undefined;
  }

  /** Whether a game with this content hash already exists (global dedup probe). */
  existsByHash(hash: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM games WHERE content_hash = ? LIMIT 1')
      .get(hash);
    return row !== undefined;
  }

  /**
   * Replace the stored game for `id`, preserving its provenance (source,
   * collection, created_at). Returns the stored game, or `undefined` if absent.
   */
  update(id: string, game: Game): Game | undefined {
    const existing = this.db
      .prepare(
        'SELECT source, collection_id, created_at FROM games WHERE id = ?',
      )
      .get(id) as
      | { source: string; collection_id: string | null; created_at: number }
      | undefined;
    if (!existing) return undefined;
    const row = this.toRow(game, {
      source: existing.source as ImportSource,
      collectionId: existing.collection_id,
      contentHash: this.resolveHashForId(game.id, contentHash(game), false),
      createdAt: existing.created_at,
    });
    this.db
      .prepare(
        `UPDATE games SET
           white=@white, black=@black, result=@result, eco=@eco, opening=@opening,
           date=@date, ply_count=@ply_count, content_hash=@content_hash,
           has_analysis=@has_analysis, data=@data
         WHERE id=@id`,
      )
      .run(row);
    return game;
  }

  /**
   * Attach (or replace) the cached analysis for a game. Returns the updated game,
   * or `undefined` if no game with `id` exists. Does not mutate any caller-held
   * object — the stored game is re-read from JSON and returned fresh.
   */
  setAnalysis(id: string, analysis: MoveEval[]): Game | undefined {
    const game = this.get(id);
    if (!game) return undefined;
    const updated: Game = { ...game, analysis };
    this.db
      .prepare('UPDATE games SET data = ?, has_analysis = 1 WHERE id = ?')
      .run(JSON.stringify(updated), id);
    return updated;
  }

  /** All stored games, oldest first (insertion order). */
  list(): Game[] {
    const rows = this.db
      .prepare('SELECT data FROM games ORDER BY created_at ASC, rowid ASC')
      .all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Game);
  }

  /** Remove a game; returns whether one was removed. */
  delete(id: string): boolean {
    const info = this.db.prepare('DELETE FROM games WHERE id = ?').run(id);
    return info.changes > 0;
  }

  /** Remove every game in a collection; returns how many were deleted (cascade). */
  deleteByCollection(collectionId: string): number {
    const info = this.db
      .prepare('DELETE FROM games WHERE collection_id = ?')
      .run(collectionId);
    return info.changes;
  }

  /**
   * Search/sort/paginate stored games into {@link GameSummary} rows, reading only
   * the denormalized columns (never parsing the `data` JSON). Filters:
   *  - `q`           — free text matched (LIKE, case-insensitive) against white,
   *                    black, eco, and opening.
   *  - `player`      — LIKE against either side.
   *  - `eco`         — exact ECO match.
   *  - `result`      — exact result match.
   *  - `source`      — exact import source.
   *  - `collectionId`— exact collection membership.
   *
   * `total` is the unpaginated count under the same filters. `sort` defaults to
   * `createdAt` desc; `limit` defaults to 50 (clamped 1..200), `offset` to 0.
   */
  searchSummaries(query: LibraryQuery = {}): LibraryPage {
    const where: string[] = [];
    const params: Record<string, string> = {};

    if (query.q && query.q.trim()) {
      params.q = `%${query.q.trim()}%`;
      where.push(
        '(white LIKE @q OR black LIKE @q OR eco LIKE @q OR opening LIKE @q)',
      );
    }
    if (query.player && query.player.trim()) {
      params.player = `%${query.player.trim()}%`;
      where.push('(white LIKE @player OR black LIKE @player)');
    }
    if (query.eco && query.eco.trim()) {
      params.eco = query.eco.trim();
      where.push('eco = @eco');
    }
    if (query.result && query.result.trim()) {
      params.result = query.result.trim();
      where.push('result = @result');
    }
    if (query.source) {
      params.source = query.source;
      where.push('source = @source');
    }
    if (query.collectionId) {
      params.collectionId = query.collectionId;
      where.push('collection_id = @collectionId');
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { total } = this.db
      .prepare(`SELECT COUNT(*) AS total FROM games ${whereSql}`)
      .get(params) as { total: number };

    const sortColumn = SORT_COLUMNS[query.sort ?? 'createdAt'];
    const dir = query.dir === 'asc' ? 'ASC' : 'DESC';
    const limit = clamp(query.limit ?? 50, 1, 200);
    const offset = Math.max(0, query.offset ?? 0);

    const rows = this.db
      .prepare(
        `SELECT id, white, black, result, eco, opening, date, ply_count,
                source, collection_id, has_analysis, created_at
           FROM games
           ${whereSql}
           ORDER BY ${sortColumn} ${dir}, created_at DESC, rowid DESC
           LIMIT @__limit OFFSET @__offset`,
      )
      .all({ ...params, __limit: limit, __offset: offset }) as GameSummaryRow[];

    return { games: rows.map(toSummary), total };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private toRow(
    game: Game,
    meta: {
      source: ImportSource;
      collectionId: string | null;
      contentHash: string;
      createdAt: number;
    },
  ): GameRow {
    const h = game.headers;
    return {
      id: game.id,
      white: h.white ?? null,
      black: h.black ?? null,
      result: h.result ?? null,
      eco: h.eco ?? null,
      opening: h.opening ?? null,
      date: h.date ?? null,
      ply_count: game.moves.length,
      content_hash: meta.contentHash,
      source: meta.source,
      collection_id: meta.collectionId,
      has_analysis: game.analysis ? 1 : 0,
      created_at: meta.createdAt,
      data: JSON.stringify(game),
    };
  }
}
