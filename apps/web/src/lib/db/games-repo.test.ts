// apps/web/src/lib/db/games-repo.test.ts
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import type { Game, MoveEval } from "@chess/shared";
import { resetLibraryDbForTests } from "./library-db";
import { gamesRepo, type GameMeta } from "./games-repo";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function makeGame(id: string, overrides: Partial<Game> = {}): Game {
  return {
    id,
    headers: {
      white: "Alice",
      black: "Bob",
      result: "1-0",
      date: "2026.01.01",
    },
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
    ...overrides,
  };
}

function makeMeta(overrides: Partial<GameMeta> = {}): GameMeta {
  return {
    source: "manual",
    createdAt: 1,
    contentHash: "hash-1",
    ...overrides,
  };
}

const sampleAnalysis: MoveEval[] = [
  {
    ply: 1,
    san: "e4",
    scoreCpBefore: 20,
    scoreCpAfter: 30,
    cpLoss: 0,
    classification: "best",
    bestMove: "e2e4",
    bestLine: ["e2e4", "e7e5"],
  },
];

// Fresh, isolated database per test.
beforeEach(() => {
  resetLibraryDbForTests();
});

describe("gamesRepo", () => {
  it("put + get round-trips a Game", async () => {
    const game = makeGame("g1");
    const returned = await gamesRepo.put(game, makeMeta());
    expect(returned).toBe(game);

    const fetched = await gamesRepo.get("g1");
    expect(fetched).toEqual(game);
    expect(fetched).not.toBe(game);
  });

  it("get returns undefined for a missing game", async () => {
    expect(await gamesRepo.get("nope")).toBeUndefined();
  });

  it("existsByHash is false before put and true after", async () => {
    expect(await gamesRepo.existsByHash("hash-1")).toBe(false);
    await gamesRepo.put(makeGame("g1"), makeMeta({ contentHash: "hash-1" }));
    expect(await gamesRepo.existsByHash("hash-1")).toBe(true);
  });

  it("setAnalysis sets analysis and flips hasAnalysis in search results", async () => {
    await gamesRepo.put(makeGame("g1"), makeMeta());
    await gamesRepo.setAnalysis("g1", sampleAnalysis);

    const fetched = await gamesRepo.get("g1");
    expect(fetched?.analysis).toEqual(sampleAnalysis);

    const page = await gamesRepo.search({});
    expect(page.games.find((g) => g.id === "g1")?.hasAnalysis).toBe(true);
  });

  it("setAnalysis is a no-op for a missing game", async () => {
    await expect(
      gamesRepo.setAnalysis("ghost", sampleAnalysis),
    ).resolves.toBeUndefined();
    expect(await gamesRepo.get("ghost")).toBeUndefined();
  });

  it("delete removes a game and is idempotent", async () => {
    await gamesRepo.put(makeGame("g1"), makeMeta());
    expect(await gamesRepo.delete("g1")).toBe(true);
    expect(await gamesRepo.get("g1")).toBeUndefined();
    expect(await gamesRepo.delete("g1")).toBe(false);
  });

  it("put overwrites an existing game with the same id", async () => {
    await gamesRepo.put(makeGame("g1"), makeMeta({ contentHash: "h1" }));
    const replacement = makeGame("g1", {
      headers: { white: "Carol", black: "Dave" },
    });
    await gamesRepo.put(replacement, makeMeta({ contentHash: "h2" }));

    expect(await gamesRepo.get("g1")).toEqual(replacement);
    expect(await gamesRepo.list()).toHaveLength(1);
  });

  it("list returns all games oldest first by createdAt", async () => {
    await gamesRepo.put(
      makeGame("a"),
      makeMeta({ createdAt: 200, contentHash: "ha" }),
    );
    await gamesRepo.put(
      makeGame("b"),
      makeMeta({ createdAt: 100, contentHash: "hb" }),
    );
    await gamesRepo.put(
      makeGame("c"),
      makeMeta({ createdAt: 300, contentHash: "hc" }),
    );
    expect((await gamesRepo.list()).map((g) => g.id)).toEqual(["b", "a", "c"]);
  });

  it("records collectionId and surfaces it via search", async () => {
    await gamesRepo.put(
      makeGame("g1"),
      makeMeta({ collectionId: "col-1", contentHash: "h1" }),
    );
    const page = await gamesRepo.search({ collectionId: "col-1" });
    expect(page.games.map((g) => g.id)).toEqual(["g1"]);
  });
});
