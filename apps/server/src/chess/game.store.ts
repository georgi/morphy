import { Injectable, Optional } from '@nestjs/common';
import type { Game, MoveEval } from '@chess/shared';
import { openDatabase } from '../persistence/database';
import { GamesRepository, type GameMeta } from '../persistence/games.repository';

/**
 * Store for imported games. Now a thin synchronous facade over
 * {@link GamesRepository} (durable SQLite) — the public method signatures are
 * unchanged so existing services, agent tools, and tests are unaffected.
 *
 * When constructed without a repository (e.g. `new GameStore()` in unit tests),
 * it lazily backs itself with a private in-memory SQLite database, preserving the
 * old "process-lifetime, isolated per instance" behavior the tests rely on.
 */
@Injectable()
export class GameStore {
  private readonly repo: GamesRepository;

  constructor(@Optional() repo?: GamesRepository) {
    this.repo = repo ?? new GamesRepository(openDatabase(':memory:'));
  }

  /** Store a freshly imported game. Overwrites any existing game with the same id. */
  create(game: Game, meta?: GameMeta): Game {
    return this.repo.create(game, meta);
  }

  /** Look up a game by id, or `undefined` if it was never stored. */
  get(id: string): Game | undefined {
    return this.repo.get(id);
  }

  /** Whether a game with this id exists. */
  has(id: string): boolean {
    return this.repo.has(id);
  }

  /** Replace the stored game for `id`. Returns the stored game, or `undefined` if absent. */
  update(id: string, game: Game): Game | undefined {
    return this.repo.update(id, game);
  }

  /**
   * Attach (or replace) the cached analysis for a game. Returns the updated game,
   * or `undefined` if no game with `id` is stored.
   */
  setAnalysis(id: string, analysis: MoveEval[]): Game | undefined {
    return this.repo.setAnalysis(id, analysis);
  }

  /** All stored games (insertion order). */
  list(): Game[] {
    return this.repo.list();
  }

  /** Remove a game; returns whether one was removed. */
  delete(id: string): boolean {
    return this.repo.delete(id);
  }
}
