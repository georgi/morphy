// apps/web/src/lib/db/library-db.ts — IndexedDB schema + connection for the
// client-owned game library. Mirrors the shape of the server's SQLite `games`
// and `collections` tables (see apps/server/src/persistence) closely enough
// that the repositories in this directory can be swapped in as a drop-in
// client-side backend for the library.
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Collection, Game, ImportSource, MoveEval } from "@chess/shared";

/**
 * The record stored in the `games` object store: the full {@link Game} plus the
 * provenance/denormalized fields the server keeps in separate SQLite columns
 * (content hash, source, collection membership, import time, analysis presence).
 * `analysis` is stored as `null` (rather than left absent) so every record has a
 * stable shape and the `hasAnalysis` flag is the single source of truth for
 * whether analysis has been attached.
 */
export type StoredGame = Omit<Game, "analysis"> & {
  contentHash: string;
  source: ImportSource;
  collectionId?: string;
  createdAt: number;
  hasAnalysis: boolean;
  analysis: MoveEval[] | null;
};

export interface LibrarySchema extends DBSchema {
  games: {
    key: string;
    value: StoredGame;
    indexes: {
      "by-createdAt": number;
      "by-white": string;
      "by-black": string;
      "by-eco": string;
      "by-collection": string;
      "by-hash": string;
    };
  };
  collections: {
    key: string;
    value: Collection;
  };
}

const DEFAULT_DB_NAME = "chess-analyzer/library";
const DB_VERSION = 1;

/** Open (creating/upgrading as needed) the library database under `name`. */
export function openLibraryDb(
  name: string = DEFAULT_DB_NAME,
): Promise<IDBPDatabase<LibrarySchema>> {
  return openDB<LibrarySchema>(name, DB_VERSION, {
    upgrade(db) {
      const games = db.createObjectStore("games", { keyPath: "id" });
      games.createIndex("by-createdAt", "createdAt");
      games.createIndex("by-white", "headers.white");
      games.createIndex("by-black", "headers.black");
      games.createIndex("by-eco", "headers.eco");
      games.createIndex("by-collection", "collectionId");
      games.createIndex("by-hash", "contentHash", { unique: true });

      db.createObjectStore("collections", { keyPath: "id" });
    },
  });
}

let singletonName = DEFAULT_DB_NAME;
let singleton: Promise<IDBPDatabase<LibrarySchema>> | undefined;

/** The shared connection used by {@link gamesRepo} / {@link collectionsRepo}. */
export function libraryDb(): Promise<IDBPDatabase<LibrarySchema>> {
  if (!singleton) singleton = openLibraryDb(singletonName);
  return singleton;
}

/**
 * Test-only: drop the cached singleton and point the next {@link libraryDb} call
 * at a fresh, empty database (a random name by default) so test cases don't
 * observe each other's data. Not used outside tests.
 */
export function resetLibraryDbForTests(
  name: string = `test-${Math.random().toString(36).slice(2)}`,
): void {
  singleton = undefined;
  singletonName = name;
}
