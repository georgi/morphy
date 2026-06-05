import {
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import type {
  Collection,
  Game,
  ImportSource,
  LibraryPage,
  LibraryQuery,
} from '@chess/shared';
import { LibraryService, type CollectionDetail } from './library.service';

/** Sort keys accepted by `GET /api/library/games`; anything else falls back. */
const SORT_KEYS: ReadonlySet<NonNullable<LibraryQuery['sort']>> = new Set([
  'createdAt',
  'white',
  'black',
  'date',
]);

const IMPORT_SOURCES: ReadonlySet<ImportSource> = new Set([
  'manual',
  'lichess',
  'chesscom',
  'catalog',
  'url',
]);

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function int(value: unknown): number | undefined {
  const s = str(value);
  if (s === undefined) return undefined;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Library browse/search surface. Query params arrive as strings, so this
 * controller validates and coerces them into a typed {@link LibraryQuery} before
 * delegating to {@link LibraryService}. Unknown `source`/`sort`/`dir` values are
 * dropped (the repository applies its own defaults).
 */
@Controller('library')
export class LibraryController {
  constructor(private readonly library: LibraryService) {}

  /** Search/sort/paginate the library. Returns a {@link LibraryPage}. */
  @Get('games')
  searchGames(@Query() raw: Record<string, unknown>): LibraryPage {
    const rawSource = str(raw.source);
    const source =
      rawSource && IMPORT_SOURCES.has(rawSource as ImportSource)
        ? (rawSource as ImportSource)
        : undefined;
    const rawSort = str(raw.sort);
    const sort =
      rawSort && SORT_KEYS.has(rawSort as NonNullable<LibraryQuery['sort']>)
        ? (rawSort as LibraryQuery['sort'])
        : undefined;
    const dir = str(raw.dir) === 'asc' ? 'asc' : 'desc';

    return this.library.searchGames({
      q: str(raw.q),
      player: str(raw.player),
      eco: str(raw.eco),
      result: str(raw.result),
      source,
      collectionId: str(raw.collectionId),
      sort,
      dir,
      limit: int(raw.limit),
      offset: int(raw.offset),
    });
  }

  /** Fetch the full stored game by id, or 404 if it was never stored. */
  @Get('games/:id')
  getGame(@Param('id') id: string): Game {
    const game = this.library.getGame(id);
    if (!game) {
      throw new NotFoundException(`Game not found: ${id}`);
    }
    return game;
  }

  /** Delete a game by id. 204 whether or not it existed (idempotent delete). */
  @Delete('games/:id')
  @HttpCode(204)
  deleteGame(@Param('id') id: string): void {
    this.library.deleteGame(id);
  }

  /** All collections, newest first. */
  @Get('collections')
  listCollections(): Collection[] {
    return this.library.listCollections();
  }

  /** A collection plus its games (as summaries). 404 if the collection is unknown. */
  @Get('collections/:id')
  getCollection(@Param('id') id: string): CollectionDetail {
    const detail = this.library.getCollection(id);
    if (!detail) {
      throw new NotFoundException(`Collection not found: ${id}`);
    }
    return detail;
  }

  /** Delete a collection and cascade-delete its games. 204 (idempotent). */
  @Delete('collections/:id')
  @HttpCode(204)
  deleteCollection(@Param('id') id: string): void {
    this.library.deleteCollection(id);
  }
}
