// apps/web/src/lib/db/search.test.ts — parity tests for the client-side port of
// the server's GamesRepository.searchSummaries. Representative cases are
// carried over from apps/server/src/persistence/games.repository.spec.ts and
// apps/server/src/library/library.controller.spec.ts so the two backends stay
// behaviorally identical.
import { describe, expect, it } from "vitest";
import type { Move } from "@chess/shared";
import { searchGames } from "./search";
import type { StoredGame } from "./library-db";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function move(ply: number, san: string): Move {
  return {
    ply,
    moveNumber: Math.floor((ply - 1) / 2) + 1,
    color: ply % 2 === 1 ? "w" : "b",
    san,
    uci: "0000",
    fenBefore: START_FEN,
    fenAfter: START_FEN,
  };
}

function gameWith(
  id: string,
  headers: Record<string, string>,
  overrides: Partial<StoredGame> = {},
): StoredGame {
  return {
    id,
    headers,
    startFen: START_FEN,
    moves: [move(1, id)],
    contentHash: `hash-${id}`,
    source: "manual",
    createdAt: 0,
    hasAnalysis: false,
    analysis: null,
    ...overrides,
  };
}

// Same fixture data as the server's `searchSummaries` describe block.
const m = gameWith(
  "m",
  {
    white: "Magnus Carlsen",
    black: "Hikaru Nakamura",
    result: "1-0",
    eco: "B90",
    opening: "Sicilian Najdorf",
    date: "2021.01.01",
  },
  { source: "lichess", collectionId: "c1" },
);
const f = gameWith(
  "f",
  {
    white: "Bobby Fischer",
    black: "Boris Spassky",
    result: "0-1",
    eco: "C95",
    opening: "Ruy Lopez",
    date: "1972.07.11",
  },
  { source: "manual" },
);
const k = gameWith(
  "k",
  {
    white: "Garry Kasparov",
    black: "Magnus Carlsen",
    result: "1/2-1/2",
    eco: "B90",
    opening: "Sicilian Najdorf",
    date: "2004.03.02",
  },
  { source: "catalog" },
);
const all = [m, f, k];

describe("searchGames", () => {
  it("returns all games with a correct total and summary shape", () => {
    const page = searchGames(all, {});
    expect(page.total).toBe(3);
    expect(page.games).toHaveLength(3);
    const mSummary = page.games.find((g) => g.id === "m")!;
    expect(mSummary).toMatchObject({
      id: "m",
      white: "Magnus Carlsen",
      black: "Hikaru Nakamura",
      result: "1-0",
      eco: "B90",
      opening: "Sicilian Najdorf",
      plyCount: 1,
      source: "lichess",
      collectionId: "c1",
      hasAnalysis: false,
    });
  });

  it("defaults to game date descending (newest first)", () => {
    expect(searchGames(all, {}).games.map((g) => g.id)).toEqual([
      "m",
      "k",
      "f",
    ]);
  });

  it("sinks undated / unknown-year games to the bottom under the date sort", () => {
    const nodate = gameWith("nodate", { white: "No", black: "Date" });
    const unknown = gameWith("unknown", {
      white: "Un",
      black: "Known",
      date: "????.??.??",
    });
    const ids = searchGames([...all, nodate, unknown], {}).games.map(
      (g) => g.id,
    );
    expect(ids.slice(0, 3)).toEqual(["m", "k", "f"]);
    expect(ids.slice(3).sort()).toEqual(["nodate", "unknown"]);
  });

  it("free-text q matches white/black/eco/opening (case-insensitive)", () => {
    expect(
      searchGames(all, { q: "carlsen" })
        .games.map((g) => g.id)
        .sort(),
    ).toEqual(["k", "m"]);
    expect(searchGames(all, { q: "ruy" }).games.map((g) => g.id)).toEqual([
      "f",
    ]);
    expect(
      searchGames(all, { q: "b90" })
        .games.map((g) => g.id)
        .sort(),
    ).toEqual(["k", "m"]);
  });

  it("player filter matches either side", () => {
    const page = searchGames(all, { player: "spassky" });
    expect(page.games.map((g) => g.id)).toEqual(["f"]);
    expect(page.total).toBe(1);
  });

  it("exact eco / result / source / collection filters", () => {
    expect(
      searchGames(all, { eco: "B90" })
        .games.map((g) => g.id)
        .sort(),
    ).toEqual(["k", "m"]);
    expect(searchGames(all, { result: "0-1" }).games.map((g) => g.id)).toEqual([
      "f",
    ]);
    expect(
      searchGames(all, { source: "catalog" }).games.map((g) => g.id),
    ).toEqual(["k"]);
    expect(
      searchGames(all, { collectionId: "c1" }).games.map((g) => g.id),
    ).toEqual(["m"]);
  });

  it("combines filters with AND", () => {
    const page = searchGames(all, { eco: "B90", result: "1-0" });
    expect(page.games.map((g) => g.id)).toEqual(["m"]);
    expect(page.total).toBe(1);
  });

  it("sorts by a whitelisted column in the requested direction", () => {
    const asc = searchGames(all, { sort: "white", dir: "asc" });
    expect(asc.games.map((g) => g.white)).toEqual([
      "Bobby Fischer",
      "Garry Kasparov",
      "Magnus Carlsen",
    ]);
    const desc = searchGames(all, { sort: "date", dir: "desc" });
    expect(desc.games.map((g) => g.id)).toEqual(["m", "k", "f"]);
  });

  it("paginates while reporting the full total", () => {
    const first = searchGames(all, {
      sort: "white",
      dir: "asc",
      limit: 2,
      offset: 0,
    });
    expect(first.games.map((g) => g.id)).toEqual(["f", "k"]);
    expect(first.total).toBe(3);

    const second = searchGames(all, {
      sort: "white",
      dir: "asc",
      limit: 2,
      offset: 2,
    });
    expect(second.games.map((g) => g.id)).toEqual(["m"]);
    expect(second.total).toBe(3);
  });

  it("clamps limit between 1 and 200", () => {
    expect(searchGames(all, { limit: 0 }).games).toHaveLength(1);
    expect(searchGames(all, { limit: 1000 }).games).toHaveLength(3);
  });

  it("reflects hasAnalysis when set on a stored game", () => {
    const withAnalysis = gameWith(
      "f",
      { white: "Bobby Fischer", black: "Boris Spassky" },
      { hasAnalysis: true, analysis: [] },
    );
    const page = searchGames([withAnalysis], {});
    expect(page.games[0].hasAnalysis).toBe(true);
  });
});
