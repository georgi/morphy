// apps/web/src/lib/db/search.ts — pure filter/sort/paginate over the client's
// in-memory game list. This is a line-for-line port of the server's
// `GamesRepository.searchSummaries` (apps/server/src/persistence/games.repository.ts)
// so the two backends stay behaviorally identical; keep the two in sync.
import type { GameSummary, LibraryPage, LibraryQuery } from "@chess/shared";
import type { StoredGame } from "./library-db";

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function includesCI(haystack: string | undefined, needle: string): boolean {
  return (haystack ?? "").toLowerCase().includes(needle.toLowerCase());
}

/** A missing date, or an unknown-year placeholder header (`????.??.??`). */
function isUndated(date: string | undefined): boolean {
  return date == null || date.startsWith("?");
}

/** Project a stored game into the shared {@link GameSummary} contract. */
function toSummary(g: StoredGame): GameSummary {
  return {
    id: g.id,
    white: g.headers.white,
    black: g.headers.black,
    result: g.headers.result,
    eco: g.headers.eco,
    opening: g.headers.opening,
    date: g.headers.date,
    plyCount: g.moves.length,
    source: g.source,
    collectionId: g.collectionId,
    hasAnalysis: g.hasAnalysis,
    createdAt: g.createdAt,
  };
}

/** Whitelist mapping `LibraryQuery.sort` to the comparable value it sorts on. */
const SORT_KEYS: Record<
  NonNullable<LibraryQuery["sort"]>,
  (g: StoredGame) => string | number
> = {
  createdAt: (g) => g.createdAt,
  white: (g) => g.headers.white ?? "",
  black: (g) => g.headers.black ?? "",
  date: (g) => g.headers.date ?? "",
};

/**
 * Filter/sort/paginate stored games into {@link GameSummary} rows — the pure,
 * client-side counterpart to the server's `searchSummaries`. Filters:
 *  - `q`           — free text matched (case-insensitive substring) against
 *                    white, black, eco, and opening.
 *  - `player`      — case-insensitive substring against either side.
 *  - `eco`         — exact ECO match.
 *  - `result`      — exact result match.
 *  - `source`      — exact import source.
 *  - `collectionId`— exact collection membership.
 *
 * `total` is the unpaginated count under the same filters. `sort` defaults to
 * game `date` desc (newest games first; undated rows sink to the bottom
 * regardless of direction); `limit` defaults to 50 (clamped 1..200), `offset`
 * to 0.
 */
export function searchGames(
  all: StoredGame[],
  query: LibraryQuery = {},
): LibraryPage {
  let filtered = all;

  const q = query.q?.trim();
  if (q) {
    filtered = filtered.filter(
      (g) =>
        includesCI(g.headers.white, q) ||
        includesCI(g.headers.black, q) ||
        includesCI(g.headers.eco, q) ||
        includesCI(g.headers.opening, q),
    );
  }

  const player = query.player?.trim();
  if (player) {
    filtered = filtered.filter(
      (g) =>
        includesCI(g.headers.white, player) ||
        includesCI(g.headers.black, player),
    );
  }

  const eco = query.eco?.trim();
  if (eco) {
    filtered = filtered.filter((g) => g.headers.eco === eco);
  }

  const result = query.result?.trim();
  if (result) {
    filtered = filtered.filter((g) => g.headers.result === result);
  }

  if (query.source) {
    filtered = filtered.filter((g) => g.source === query.source);
  }

  if (query.collectionId) {
    filtered = filtered.filter((g) => g.collectionId === query.collectionId);
  }

  const total = filtered.length;

  const sortKey = query.sort ?? "date";
  const keyOf = SORT_KEYS[sortKey];
  const dir = query.dir === "asc" ? 1 : -1;
  const limit = clamp(query.limit ?? 50, 1, 200);
  const offset = Math.max(0, query.offset ?? 0);

  // Primary sort key, then a stable tiebreak by import recency (mirrors the
  // server's `created_at DESC` tiebreak; there is no client-side `rowid`, but
  // createdAt ties are rare enough that this is a faithful match in practice).
  const sorted = filtered.slice().sort((a, b) => {
    if (sortKey === "date") {
      // Undated / unknown-year rows sink to the bottom in either direction —
      // this ordering is NOT flipped by `dir`.
      const aUndated = isUndated(a.headers.date);
      const bUndated = isUndated(b.headers.date);
      if (aUndated !== bUndated) return aUndated ? 1 : -1;
    }
    const av = keyOf(a);
    const bv = keyOf(b);
    if (av < bv) return -dir;
    if (av > bv) return dir;
    return b.createdAt - a.createdAt;
  });

  const page = sorted.slice(offset, offset + limit);
  return { games: page.map(toSummary), total };
}
