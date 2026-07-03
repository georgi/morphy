// apps/web/src/lib/db/games-repo.ts — client-side counterpart to
// apps/server/src/persistence/games.repository.ts. Method shapes mirror the
// server repository so a later task can wire either backend behind the same
// call sites; the caller here always supplies fully-resolved provenance (no
// server-side defaulting of `source`/`collectionId`/`contentHash`).
import type {
  Game,
  ImportSource,
  LibraryPage,
  LibraryQuery,
  MoveEval,
} from "@chess/shared";
import { libraryDb, type StoredGame } from "./library-db";
import { searchGames } from "./search";

/** Provenance recorded alongside a game on insert. */
export interface GameMeta {
  source: ImportSource;
  collectionId?: string;
  createdAt: number;
  contentHash: string;
}

function toGame(stored: StoredGame): Game {
  const game: Game = {
    id: stored.id,
    headers: stored.headers,
    startFen: stored.startFen,
    moves: stored.moves,
  };
  if (stored.analysis) game.analysis = stored.analysis;
  return game;
}

function toStored(game: Game, meta: GameMeta): StoredGame {
  return {
    id: game.id,
    headers: game.headers,
    startFen: game.startFen,
    moves: game.moves,
    contentHash: meta.contentHash,
    source: meta.source,
    collectionId: meta.collectionId,
    createdAt: meta.createdAt,
    hasAnalysis: game.analysis != null,
    analysis: game.analysis ?? null,
  };
}

/** Insert (or replace, by id) a game with its provenance. Returns the stored game. */
async function put(game: Game, meta: GameMeta): Promise<Game> {
  const db = await libraryDb();
  await db.put("games", toStored(game, meta));
  return game;
}

/** Look up a game by id, or `undefined` if absent. */
async function get(id: string): Promise<Game | undefined> {
  const db = await libraryDb();
  const stored = await db.get("games", id);
  return stored ? toGame(stored) : undefined;
}

/** Whether a game with this content hash already exists (dedup probe). */
async function existsByHash(hash: string): Promise<boolean> {
  const db = await libraryDb();
  const key = await db.getKeyFromIndex("games", "by-hash", hash);
  return key !== undefined;
}

/** Search/sort/paginate stored games into a {@link LibraryPage}. */
async function search(query: LibraryQuery): Promise<LibraryPage> {
  const db = await libraryDb();
  const all = await db.getAll("games");
  return searchGames(all, query);
}

/**
 * Attach (or replace) the cached analysis for a game. No-op if no game with
 * `id` exists.
 */
async function setAnalysis(id: string, analysis: MoveEval[]): Promise<void> {
  const db = await libraryDb();
  const stored = await db.get("games", id);
  if (!stored) return;
  await db.put("games", { ...stored, analysis, hasAnalysis: true });
}

/** Remove a game; returns whether one was removed. */
async function del(id: string): Promise<boolean> {
  const db = await libraryDb();
  const existing = await db.get("games", id);
  if (!existing) return false;
  await db.delete("games", id);
  return true;
}

/** All stored games, oldest first (by `createdAt`). */
async function list(): Promise<Game[]> {
  const db = await libraryDb();
  const stored = await db.getAllFromIndex("games", "by-createdAt");
  return stored.map(toGame);
}

export const gamesRepo = {
  put,
  get,
  existsByHash,
  search,
  setAnalysis,
  delete: del,
  list,
};
