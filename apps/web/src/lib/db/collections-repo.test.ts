// apps/web/src/lib/db/collections-repo.test.ts
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import type { Collection, Game } from "@chess/shared";
import { resetLibraryDbForTests } from "./library-db";
import { gamesRepo } from "./games-repo";
import { collectionsRepo } from "./collections-repo";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function makeCollection(
  id: string,
  overrides: Partial<Collection> = {},
): Collection {
  return {
    id,
    name: id,
    source: "manual",
    gameCount: 0,
    createdAt: 1,
    ...overrides,
  };
}

function makeGame(id: string): Game {
  return {
    id,
    headers: { white: "Alice", black: "Bob" },
    startFen: START_FEN,
    moves: [
      {
        ply: 1,
        moveNumber: 1,
        color: "w",
        san: "e4",
        uci: "e2e4",
        fenBefore: START_FEN,
        fenAfter: START_FEN,
      },
    ],
  };
}

beforeEach(() => {
  resetLibraryDbForTests();
});

describe("collectionsRepo", () => {
  it("put + get round-trips a Collection", async () => {
    const c = makeCollection("c1");
    const returned = await collectionsRepo.put(c);
    expect(returned).toBe(c);
    expect(await collectionsRepo.get("c1")).toEqual(c);
  });

  it("get returns undefined for a missing collection", async () => {
    expect(await collectionsRepo.get("nope")).toBeUndefined();
  });

  it("list returns collections newest first", async () => {
    await collectionsRepo.put(makeCollection("old", { createdAt: 100 }));
    await collectionsRepo.put(makeCollection("new", { createdAt: 200 }));
    expect((await collectionsRepo.list()).map((c) => c.id)).toEqual([
      "new",
      "old",
    ]);
  });

  it("delete removes a collection and is idempotent (does not touch games)", async () => {
    await collectionsRepo.put(makeCollection("c1"));
    await gamesRepo.put(makeGame("g1"), {
      source: "manual",
      collectionId: "c1",
      createdAt: 1,
      contentHash: "h1",
    });

    expect(await collectionsRepo.delete("c1")).toBe(true);
    expect(await collectionsRepo.get("c1")).toBeUndefined();
    expect(await collectionsRepo.delete("c1")).toBe(false);
    expect(await gamesRepo.get("g1")).toBeDefined();
  });

  it("recountGames sets gameCount from the games store", async () => {
    await collectionsRepo.put(makeCollection("c1"));
    await gamesRepo.put(makeGame("g1"), {
      source: "manual",
      collectionId: "c1",
      createdAt: 1,
      contentHash: "h1",
    });
    await gamesRepo.put(makeGame("g2"), {
      source: "manual",
      collectionId: "c1",
      createdAt: 2,
      contentHash: "h2",
    });
    await gamesRepo.put(makeGame("g3"), {
      source: "manual",
      createdAt: 3,
      contentHash: "h3",
    });

    await collectionsRepo.recountGames("c1");
    expect((await collectionsRepo.get("c1"))?.gameCount).toBe(2);
  });

  it("recountGames is a no-op for a missing collection", async () => {
    await expect(
      collectionsRepo.recountGames("ghost"),
    ).resolves.toBeUndefined();
  });
});
