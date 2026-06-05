import { Injectable } from '@nestjs/common';
import type {
  Collection,
  Game,
  GameSummary,
  LibraryPage,
  LibraryQuery,
} from '@chess/shared';
import { GamesRepository } from '../persistence/games.repository';
import { CollectionsRepository } from '../persistence/collections.repository';

/** A collection together with the (summary) games it contains. */
export interface CollectionDetail {
  collection: Collection;
  games: GameSummary[];
}

/**
 * Read/browse facade over the games + collections repositories. Thin by design:
 * the controller and the agent tools (`search_library`, `open_game`,
 * `list_collections`) share this single source of truth so the REST surface and
 * the agent never drift.
 */
@Injectable()
export class LibraryService {
  constructor(
    private readonly games: GamesRepository,
    private readonly collections: CollectionsRepository,
  ) {}

  /** Search/sort/paginate stored games into a {@link LibraryPage}. */
  searchGames(query: LibraryQuery): LibraryPage {
    return this.games.searchSummaries(query);
  }

  /** Fetch a full stored {@link Game} by id, or `undefined` if absent. */
  getGame(id: string): Game | undefined {
    return this.games.get(id);
  }

  /** Delete a game by id; returns whether one was removed. */
  deleteGame(id: string): boolean {
    return this.games.delete(id);
  }

  /** All collections, newest first. */
  listCollections(): Collection[] {
    return this.collections.list();
  }

  /**
   * A collection plus its games (as summaries), or `undefined` if the collection
   * does not exist.
   */
  getCollection(id: string): CollectionDetail | undefined {
    const collection = this.collections.get(id);
    if (!collection) return undefined;
    const { games } = this.games.searchSummaries({
      collectionId: id,
      limit: 200,
    });
    return { collection, games };
  }

  /**
   * Delete a collection and cascade-delete every game in it. Returns whether the
   * collection existed (and was removed).
   */
  deleteCollection(id: string): boolean {
    if (!this.collections.get(id)) return false;
    this.games.deleteByCollection(id);
    this.collections.delete(id);
    return true;
  }
}
