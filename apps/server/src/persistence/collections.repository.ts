import { Inject, Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import type { Collection, ImportSource } from '@chess/shared';
import { DATABASE, type Db } from './database';

/** Fields supplied when creating a collection; `id`/`gameCount`/`createdAt` are managed. */
export interface NewCollection {
  name: string;
  description?: string;
  source?: ImportSource;
  sourceRef?: string;
}

/** Row shape for the `collections` table (snake_case columns). */
interface CollectionRow {
  id: string;
  name: string;
  description: string | null;
  source: string;
  source_ref: string | null;
  game_count: number;
  created_at: number;
}

/**
 * Synchronous CRUD over the `collections` table. A collection groups imported
 * games (a Lichess study, a Chess.com archive, a catalog entry, a named URL
 * import). `game_count` is maintained here via {@link recountGames} rather than a
 * trigger so the repository owns the invariant.
 */
@Injectable()
export class CollectionsRepository {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  /** Create a collection row and return it (with a generated id and zero games). */
  create(input: NewCollection): Collection {
    const row: CollectionRow = {
      id: uuidv4(),
      name: input.name,
      description: input.description ?? null,
      source: input.source ?? 'manual',
      source_ref: input.sourceRef ?? null,
      game_count: 0,
      created_at: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO collections
           (id, name, description, source, source_ref, game_count, created_at)
         VALUES
           (@id, @name, @description, @source, @source_ref, @game_count, @created_at)`,
      )
      .run(row);
    return this.fromRow(row);
  }

  /** Look up a collection by id, or `undefined` if absent. */
  get(id: string): Collection | undefined {
    const row = this.db
      .prepare('SELECT * FROM collections WHERE id = ?')
      .get(id) as CollectionRow | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  /** All collections, newest first. */
  list(): Collection[] {
    const rows = this.db
      .prepare('SELECT * FROM collections ORDER BY created_at DESC, rowid DESC')
      .all() as CollectionRow[];
    return rows.map((r) => this.fromRow(r));
  }

  /** Remove a collection; returns whether one was removed. Does not touch games. */
  delete(id: string): boolean {
    const info = this.db.prepare('DELETE FROM collections WHERE id = ?').run(id);
    return info.changes > 0;
  }

  /**
   * Recompute and store `game_count` from the `games` table. Called after games
   * are inserted into / removed from a collection so the denormalized count stays
   * truthful. Returns the fresh count.
   */
  recountGames(id: string): number {
    const { n } = this.db
      .prepare('SELECT COUNT(*) AS n FROM games WHERE collection_id = ?')
      .get(id) as { n: number };
    this.db
      .prepare('UPDATE collections SET game_count = ? WHERE id = ?')
      .run(n, id);
    return n;
  }

  private fromRow(row: CollectionRow): Collection {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      source: row.source as ImportSource,
      sourceRef: row.source_ref ?? undefined,
      gameCount: row.game_count,
      createdAt: row.created_at,
    };
  }
}
