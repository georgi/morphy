// apps/web/src/lib/db/collections-repo.ts — client-side counterpart to
// apps/server/src/persistence/collections.repository.ts. Method shapes mirror
// the server repository; unlike it, `put` takes a full `Collection` (id
// generation/defaulting happens one layer up, not here).
import type { Collection } from "@chess/shared";
import { libraryDb } from "./library-db";

/** Insert (or replace, by id) a collection. Returns the stored collection. */
async function put(c: Collection): Promise<Collection> {
  const db = await libraryDb();
  await db.put("collections", c);
  return c;
}

/** Look up a collection by id, or `undefined` if absent. */
async function get(id: string): Promise<Collection | undefined> {
  const db = await libraryDb();
  return db.get("collections", id);
}

/**
 * All collections, newest first. Ties (equal `createdAt`) fall back to
 * `getAll()`'s primary-key order — there is no client-side equivalent of the
 * server's `rowid` insertion-order tiebreak.
 */
async function list(): Promise<Collection[]> {
  const db = await libraryDb();
  const all = await db.getAll("collections");
  return all.slice().sort((a, b) => b.createdAt - a.createdAt);
}

/** Remove a collection; returns whether one was removed. Does not touch games. */
async function del(id: string): Promise<boolean> {
  const db = await libraryDb();
  const existing = await db.get("collections", id);
  if (!existing) return false;
  await db.delete("collections", id);
  return true;
}

/**
 * Recompute and store `gameCount` from the `games` store's `by-collection`
 * index. No-op if the collection does not exist.
 */
async function recountGames(id: string): Promise<void> {
  const db = await libraryDb();
  const collection = await db.get("collections", id);
  if (!collection) return;
  const count = await db.countFromIndex("games", "by-collection", id);
  await db.put("collections", { ...collection, gameCount: count });
}

export const collectionsRepo = { put, get, list, delete: del, recountGames };
