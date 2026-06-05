# Game Library, Persistent Analysis Cache & Bulk Download — Design Spec

**Date:** 2026-06-05
**Status:** Approved, building

## 1. Problem

The app is entirely in-memory. `GameStore` is a `Map` that resets on restart;
`analyzeGame` caches `MoveEval[]` on the in-memory game object (also lost on
restart) and there is **no cross-game position cache** — the same opening position
in two games is re-evaluated from scratch by Stockfish. Import is single-game only
(`POST /api/games` with one `{pgn}`/`{fen}`); there is no bulk import or download.

We want three things, built as layers on the existing architecture:

1. **A durable game library** — store many games, browse, search, organize into
   collections; survives restart.
2. **A persistent analysis cache** — save Stockfish evals keyed so identical
   positions are never re-evaluated, across games and across restarts.
3. **Bulk download of popular game libraries** — from Lichess, Chess.com, a curated
   catalog of classics, and arbitrary URL / pasted multi-game PGN.

### Decisions (from brainstorming)

- **Storage:** SQLite via `better-sqlite3` (synchronous; fits NestJS without forcing
  everything async). DB at `~/.chess-analyzer/library.db`, override `CHESS_DB_PATH`,
  `:memory:` in tests. WAL mode.
- **Eval cache scope:** global position cache keyed by
  `(fen_norm, depth, multipv, engine_id)`.
- **Sources:** all four — Lichess API, Chess.com public archives, curated catalog,
  URL / multi-game PGN paste.
- **Import model:** async job, returns a `jobId`, streams progress over SSE.
- **Analysis policy:** lazy / on-demand only (import stores moves + headers; analysis
  runs when a game is opened or analyzed; the eval cache makes seen positions instant).
- **v1 boundaries:** native `.pgn` and `.pgn.gz` only (`.zip`/TWIC is a later add that
  needs one dependency). Catalog manifest points to **remote** PGN URLs with a couple
  of small classics **bundled offline** as a fallback.

## 2. Architecture

The eval cache sits in a **`CachedEngine` gateway** in front of `EngineService`
(which stays a pure UCI wrapper). `AnalysisService` depends on `CachedEngine`, so every
path (`analyzePosition`, `evaluateMove`, `analyzeGame`, `explainVariation`) is cached
through one choke point. `GameStore` becomes a thin synchronous facade over
`GamesRepository`, preserving its current interface so existing services, agent tools,
and tests barely move.

```
apps/server/src/
├─ persistence/            NEW  PersistenceModule (@Global)
│   ├─ database.ts              better-sqlite3 connection + migrations on boot, WAL
│   ├─ games.repository.ts      games + denormalized search columns
│   ├─ collections.repository.ts
│   ├─ eval-cache.repository.ts
│   └─ import-jobs.repository.ts
├─ chess/game.store.ts     MOD  facade over GamesRepository (same method signatures)
├─ engine/
│   ├─ engine.service.ts   MOD  capture + expose engineId (UCI "id name")
│   └─ cached-engine.ts    NEW  analyze() gateway: cache lookup → miss → engine → write
├─ analysis/*              MOD  inject CachedEngine instead of EngineService
├─ library/               NEW  LibraryController + LibraryService
└─ import/                NEW  ImportController + ImportService
    ├─ game-source.ts           interface fetch(params): AsyncIterable<string>
    ├─ pgn-splitter.ts          multi-game PGN text → single-game PGN strings
    ├─ content-hash.ts          dedup key
    ├─ catalog.json             curated manifest (+ a few bundled classics under sources/fixtures)
    └─ sources/{url,lichess,chesscom,catalog}.source.ts
```

## 3. Data model (SQLite)

WAL mode. Migrations run on boot from `database.ts` (idempotent `CREATE TABLE IF NOT
EXISTS` + a `schema_version` row). Indexed columns in **bold**.

| Table | Columns |
|---|---|
| `games` | `id` PK, **white**, **black**, `result`, **eco**, `opening`, `date`, `ply_count`, **content_hash** UNIQUE, **source**, **collection_id** (FK→collections, nullable), `has_analysis` INT, **created_at**, `data` TEXT (JSON: full `Game`) |
| `collections` | `id` PK, `name`, `description`, `source`, `source_ref`, `game_count`, `created_at` |
| `eval_cache` | PK **(`fen_norm`, `depth`, `multipv`, `engine_id`)**, `eval_json` TEXT, `created_at` |
| `import_jobs` | `id` PK, `source`, `params` TEXT, `status`, `total` (nullable), `imported`, `skipped`, `failed`, `error` (nullable), `created_at`, `updated_at` |

- `games.data` is the canonical `Game` JSON; denormalized columns exist only for
  fast search/sort without parsing JSON. FTS5 over players/event/opening is an
  optional refinement (LIKE on indexed columns is the v1 baseline).
- **`content_hash`** = `sha256(normalizedSanList + '|' + white + '|' + black + '|' +
  date + '|' + result)`. Global dedup: a duplicate import is skipped (counted), not
  inserted.
- **Eval cache key.** `fen_norm` = first **four** FEN fields (piece placement, side to
  move, castling, en-passant); halfmove-clock and fullmove-number are dropped, so
  transpositions and shared openings hit. `engine_id` = slug of Stockfish's UCI
  `id name` (e.g. `stockfish-16-1`); a Stockfish upgrade silently invalidates old rows.
  Lookup matches exact `(fen_norm, depth, engine_id)` and accepts a stored row with
  `multipv ≥ requested` (return the top-`requested` lines sliced). Dropping the
  halfmove clock treats 50-move-rule edge positions as identical — accepted tradeoff.

## 4. Shared contract additions (`@chess/shared`)

```ts
export type ImportSource = 'manual' | 'lichess' | 'chesscom' | 'catalog' | 'url';

export interface GameSummary {
  id: string; white?: string; black?: string; result?: string;
  eco?: string; opening?: string; date?: string; plyCount: number;
  source: ImportSource; collectionId?: string; hasAnalysis: boolean; createdAt: number;
}

export interface Collection {
  id: string; name: string; description?: string;
  source: ImportSource; sourceRef?: string; gameCount: number; createdAt: number;
}

export interface LibraryQuery {
  q?: string; player?: string; eco?: string; result?: string;
  source?: ImportSource; collectionId?: string;
  sort?: 'createdAt' | 'white' | 'black' | 'date'; dir?: 'asc' | 'desc';
  limit?: number; offset?: number;
}
export interface LibraryPage { games: GameSummary[]; total: number; }

export interface CatalogEntry {
  id: string; title: string; description: string; gameCount?: number; url: string; bundled?: boolean;
}

export type StartImportRequest =
  | { source: 'url'; url?: string; pgn?: string; collectionName?: string }
  | { source: 'lichess'; kind: 'user' | 'study' | 'broadcast'; id: string; max?: number }
  | { source: 'chesscom'; username: string; months?: string[] | 'all' }
  | { source: 'catalog'; entryId: string };

export interface ImportJob {
  id: string; source: ImportSource; status: 'pending' | 'running' | 'done' | 'error';
  total?: number; imported: number; skipped: number; failed: number;
  collectionId?: string; error?: string;
}

export type ImportEvent =
  | { type: 'progress'; imported: number; skipped: number; failed: number; total?: number }
  | { type: 'game'; summary: GameSummary }
  | { type: 'done'; collectionId?: string; imported: number; skipped: number; failed: number }
  | { type: 'error'; message: string };
```

## 5. Download subsystem

```ts
interface GameSource { fetch(params): AsyncIterable<string> /* each item = one game's PGN */ }
```

| Source | Mechanism |
|---|---|
| `url` | fetch a `.pgn` / `.pgn.gz` URL (zlib gunzip for `.gz`) **or** take pasted multi-game PGN → `PgnSplitter`. |
| `lichess` | `GET /api/games/user/{u}` (Accept `application/x-chess-pgn`, `max`), `/api/study/{id}.pgn`, broadcast PGN. Anonymous; `LICHESS_TOKEN` from env if present. 429 → exponential backoff. |
| `chesscom` | `GET /pub/player/{u}/games/archives` → monthly `{games:[{pgn}]}`. Required `User-Agent` header. `months` selects a subset or `'all'`. |
| `catalog` | bundled `catalog.json` manifest → fetch entry `url` (remote PGN) → split; a couple of small classics bundled under `sources/fixtures/` as offline fallback (`bundled: true`). |

**Pipeline (one path, async job):**

```
POST /api/import {source,...}
  → ImportJobsRepository.create(status:'running')
  → resolve GameSource by source
  → run pipeline WITHOUT awaiting; return { jobId }

pipeline(source, job, collection?):
  for await (pgn of source.fetch(params)):
    try:
      game = chess.importPgn(pgn)                 // existing probe-hardened parser
      hash = contentHash(game)
      if games.existsByHash(hash): job.skipped++  // global dedup
      else: games.insert(game, {source, collectionId, hash}); job.imported++; emit {game, progress}
    catch: job.failed++ (keep a capped error sample); emit {progress}
    await tick()                                  // yield: better-sqlite3 is sync; don't starve SSE
  job.status = source-failed-before-any-game ? 'error' : 'done'; emit {done|error}
```

A collection row is created up-front for `lichess`/`chesscom`/`catalog`/url-with-name
imports and games are linked to it; bare single imports have `collection_id = null`.

## 6. REST API additions

| Method | Path | Returns |
|---|---|---|
| GET | `/api/library/games?q&player&eco&result&source&collectionId&sort&dir&limit&offset` | `LibraryPage` |
| GET | `/api/library/games/:id` | full `Game` |
| DELETE | `/api/library/games/:id` | `204` |
| GET | `/api/library/collections` | `Collection[]` |
| GET | `/api/library/collections/:id` | `{ collection, games: GameSummary[] }` |
| DELETE | `/api/library/collections/:id` | `204` (cascade games) |
| GET | `/api/import/catalog` | `CatalogEntry[]` |
| POST | `/api/import` | `{ jobId }` |
| GET | `/api/import/:jobId/stream` | SSE `ImportEvent` |
| GET | `/api/import/:jobId` | `ImportJob` (poll fallback) |

Existing `POST /api/games`, `GET /api/games/:id` keep working, now persistent via the
repository.

## 7. Web (`apps/web`) + agent

- **Library route** (`/library`, TanStack Router): searchable / sortable / paginated
  `GameSummary` table (player, result, opening, date, source, analyzed badge);
  player / ECO / result / source / collection filters; row click loads the full game
  into the existing analysis view. **Collections** sidebar with counts.
- **Download dialog** (extends today's Import dialog): tabs **Lichess** (kind + id +
  max), **Chess.com** (username + month selection), **Catalog** (browse `CatalogEntry`
  list), **URL / Paste** (URL field + the existing multi-game PGN paste) → `POST
  /api/import` → live progress panel (imported / skipped / failed) from the import SSE →
  invalidate library query on `done`.
- **State:** TanStack Query for `/api/library/*`, `/api/import/catalog`; Zustand gains
  library query state, collections, and the active import job + progress. Existing
  analysis view otherwise unchanged (now shows cached analysis instantly).
- **New agent tools** (AI-native ethos — thin wrappers over `LibraryService`):
  `search_library`, `open_game` (emits `board_update`), `list_collections`.
  `import_games` is an optional later tool.

## 8. Error handling

- Per-game parse errors counted as `failed`, never abort the job (real-world exports
  are quirky — the existing probe files prove it).
- Source-level failure (bad username, 404 study, network down before any game) →
  job `error` with a clear message; partial success → `done` with counts.
- 429 / transient network → exponential backoff with a small retry budget; persistent
  failure ends the job partial with a message.
- Eval-cache writes are **best-effort**: a cache write failure logs and continues; it
  never fails an analysis.
- Migrations run on boot; a `schema_version` mismatch fails fast with a clear message.
- Yield to the event loop between inserts so a multi-thousand-game import keeps
  SSE/HTTP responsive (better-sqlite3 is synchronous).

## 9. Testing

Real `better-sqlite3` against `:memory:` / temp-file DBs — never mock the DB.

- **Repositories:** CRUD, search/filter/sort/paginate, dedup-by-hash; eval-cache
  hit / miss / `multipv ≥ requested` slice / `engine_id` mismatch miss; cascade delete.
- **FEN normalization:** table of equivalent (differ only in clocks) vs distinct FENs.
- **CachedEngine:** miss → `EngineService.analyze` called once + row written; hit →
  engine **not** called (spy/mock EngineService).
- **PgnSplitter:** fed the exact adversarial variants from `lichess_import_probe.mjs`
  and `adversarial-chesscom.mjs` → correct split + count.
- **Sources:** each against recorded fixtures (no live network in unit tests); a
  network-gated opt-in smoke like the existing probes.
- **ImportService:** fixture source yielding N games incl. duplicates + invalid →
  asserts imported / skipped / failed counts and the SSE event sequence.
- **Controllers:** Library + Import e2e via supertest (list / search / delete; start
  job + poll status), matching `api.controller.spec.ts`.
- **Web:** Zustand store tests for library/import state; a Library-view + download-dialog
  view test matching `AnalysisView.test.tsx`.
- All existing **70 server + 13 web** tests stay green (the facade preserves behavior).

## 10. Build sequence (implementation order)

1. **Persistence foundation** — `PersistenceModule`, `database.ts` + migrations,
   `GamesRepository`; `GameStore` → facade. Durability, zero behavior change; existing
   tests stay green.
2. **Eval cache** — `EvalCacheRepository`, `CachedEngine`, FEN-norm, `engineId` capture;
   wire `AnalysisService` to `CachedEngine`. Re-analysis now skips Stockfish.
3. **Library API + UI** — `CollectionsRepository`, `LibraryService` / controller, shared
   `GameSummary` / `Collection` / `LibraryQuery` types, web Library view + collections.
4. **Import core** — `GameSource`, `PgnSplitter`, `content-hash`, `ImportJobsRepository`,
   `ImportService` + SSE, `ImportController`; **URL/paste source first** (no network dep).
5. **Remote sources** — `LichessSource`, `ChessComSource`, `CatalogSource` (+ manifest
   and bundled classics). Independent of each other.
6. **Agent tools + download dialog** — `search_library` / `open_game` /
   `list_collections` tools; web download dialog tabs wired to the import SSE.
