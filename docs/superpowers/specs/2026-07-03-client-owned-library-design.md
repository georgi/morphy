# Local DB migration: client-owned library in IndexedDB

**Date:** 2026-07-03
**Status:** proposed (awaiting approval)

## Goal

Move the game library (games + collections) out of the server's SQLite and into
the browser's **IndexedDB**, making each browser the system of record for its own
games. This deletes the multi-user privacy problem — no shared server library, so
no accounts/`owner_id`/auth needed — and turns the server into stateless compute.

## Non-goals (explicitly later or never)

- **WASM engine.** Stockfish + the shared `eval_cache` stay server-side this slice.
- **Accounts / auth / cross-device sync.** Removed as a need, not added.
- **Export/import JSON backup.** Worth doing later to blunt "cleared my browser";
  out of scope here.
- **Data migration.** Greenfield/dev-only — no existing data to preserve. The old
  server tables and endpoints are dropped, not migrated.

## Decisions locked (from brainstorming)

1. **Clean cut on the coach.** The server no longer holds the library, so the
   cross-library agent tools (`search_library`, `open_game`, `list_collections`)
   are **removed**. The coach is scoped to the currently-open game, which the
   client sends by value with each message. Single-game review — the product's
   core job — is unaffected.
2. **Server stays the engine + import proxy.** Native Stockfish, the shared
   `eval_cache`, PGN parsing, and remote fetching (lichess/chess.com CORS) remain
   server-side. Analysis flips from by-id to **by-value**.
3. **Greenfield.** No migration path.

## Architecture

```
┌─────────────────────────── Browser ───────────────────────────┐
│  UI (LibraryView, BoardPanel, ReviewPanel, ChatPanel)          │
│  Zustand store  ── system of record ──▶  IndexedDB             │
│    · games (object store)                (LibraryDB)           │
│    · collections (object store)                               │
│    · analysis stored on each game record                      │
└───────────┬───────────────────────────────────┬───────────────┘
            │ by-value requests                  │ by-value msg (game+ply)
            ▼                                     ▼
┌──────────────────────── Server (stateless) ───────────────────┐
│  /import  → fetch + parse + hash, STREAM games (no persist)    │
│  /analysis/position|game|key-moments → engine, BY VALUE        │
│  eval_cache (SQLite)  ── shared, per-FEN, user-independent ──  │
│  /agent   → coach over the game passed in context             │
└───────────────────────────────────────────────────────────────┘
```

The server keeps **one** SQLite table: `eval_cache`. `games`, `collections`,
`import_jobs` (see below) leave the server.

## Client persistence layer

**Approach:** the [`idb`](https://github.com/jakearchibald/idb) micro-wrapper
(~1KB, promise-based) plus hand-written repositories that mirror the shapes the
store/UI already consume. Rationale over alternatives:

- **`idb` + repos (chosen):** tiny dep, full control, and `LibraryDb` /
  `gamesRepo` / `collectionsRepo` mirror the existing server `GamesRepository` /
  `CollectionsRepository` method surface, so the store and LibraryView barely change.
- *Dexie:* nicer queries but a heavier dep and its own idioms — more than we need.
- *Raw IndexedDB:* no dep, but verbose and error-prone for indexes/upgrades.

**IndexedDB schema (`LibraryDb`, version 1):**

- `games` store, keyPath `id`. Indexes mirroring today's SQLite: `by-createdAt`,
  `by-white`, `by-black`, `by-eco`, `by-collection`, and a **unique** `by-hash`
  (`content_hash`) for dedup. Record = the full `Game` plus meta (`source`,
  `collectionId`, `createdAt`, `hasAnalysis`, `contentHash`) and cached
  `analysis: MoveEval[] | null`.
- `collections` store, keyPath `id`. Record = `{ id, name, description, source,
  sourceRef, gameCount, createdAt }`.

`content_hash` computation moves to `@chess/shared` (the hash fn is
source-agnostic) so client and server produce identical hashes.

**Repository surface** (all sync-looking `Promise`s):

- `gamesRepo`: `put`, `get(id)`, `existsByHash(hash)`, `search(query)` (paged,
  same `LibraryQuery`/`LibraryPage` contract as today), `setAnalysis(id, evals)`,
  `delete(id)`, `list()`.
- `collectionsRepo`: `put`, `get`, `list`, `delete`, `recountGames(id)`.

The Zustand store gains async thunks that call these; `library.service.ts`'s
query/sort/paginate logic is **ported** to the client `search()` (it's pure list
manipulation — moves cleanly).

## Server changes

**Import (`import.service` / `import.controller`).** Keep the fetch/parse/hash
pipeline; stop persisting. Two paths:

- **Single (`POST /games`)** → parse PGN/FEN, compute hash, **return the full
  `Game`** (with `contentHash`); client dedups against IndexedDB and stores it.
- **Bulk (`POST /import` + SSE)** → the pipeline streams **full game records**
  instead of `{ summary }`, each carrying its `contentHash`. Dedup moves
  client-side: the client checks `existsByHash` and updates its own
  imported/skipped counts. `ImportEvent`'s `game` variant carries `Game`, not
  `GameSummary`. Collections are described in the stream (an up-front
  `collection` event) and created in IndexedDB by the client. `import_jobs`
  persistence is dropped — progress lives in the client `useImportStore` for the
  stream's lifetime (already the case UI-side).

**Analysis (`analysis.controller` / `analysis.service`).** Flip to by-value:

- `POST /analysis/game` takes `{ game, depth? }` (the moves/FENs), not `gameId`.
- `POST /analysis/key-moments` takes `{ game }`.
- `/analysis/position` is already by-value (FEN) — unchanged.
- The engine and `eval_cache` are untouched; only the *input* changes from a store
  lookup to the request body. `AnalysisService.analyzeGame(game)` replaces
  `analyzeGame(gameId)`; it returns the eval curve, and the **client** stores it
  on the game record in IndexedDB (no server-side "cache analysis on the game").

**Agent (`agent.service` / `chess-tools.service`).**

- The coach's session context becomes `{ game, ply }` (by value) instead of
  `{ gameId, ply }`. `sendAgentMessage` includes the open `Game`; `AgentService`
  holds it as the session's current game (in-memory, per session).
- Tools that read the current game (`get_position`, `goto_move`, `analyze_game`,
  `evaluate_move` when given no FEN) read `context.game`. `analyze_position` /
  `evaluate_move` (by FEN) are already by-value.
- **Remove** `search_library`, `open_game`, `list_collections`.
- `GameStore` (the server-side games facade) is removed; `load_pgn` / `load_fen`
  build a transient per-session game held in memory, never a shared DB.

**Cleanup.** Remove `GamesRepository`, `CollectionsRepository`,
`ImportJobsRepository`, `library.controller`, `library.module`, and the
library/game persistence endpoints (`/library/*`, `GET/POST /games` storage
semantics). `persistence.module` shrinks to `EvalCacheRepository`. `game.store.ts`
is deleted or reduced to the transient per-session holder.

## Client changes

- `LibraryView` + its query state read from `gamesRepo.search()` /
  `collectionsRepo` instead of `api.searchLibrary` / `api.listCollections`.
- `useImportStore` writes streamed games into IndexedDB (and dedups) as they
  arrive; counts come from the client.
- Opening a game reads it from IndexedDB into the analyzer store.
- "Analyze game" posts the game by value, then writes the returned analysis onto
  the IndexedDB game record (`hasAnalysis = true`).
- `ChatPanel.send` includes the current `Game` in the message body.

## Error handling

- **IndexedDB unavailable / private-mode quota:** `LibraryDb.open()` surfaces a
  typed error; the app shows a non-blocking banner ("Your browser is blocking
  local storage — imports won't be saved") and the rest of the app (open a game,
  analyze, chat) still works in-memory for the session.
- **Quota exceeded on write:** toast + the game stays in the in-memory store for
  the session; not silently dropped.
- **Schema upgrades:** `idb`'s `upgrade` callback keyed on DB version; v1 is the
  baseline. Bumping version runs an ordered upgrade.
- **Engine unavailable:** unchanged — already a typed `EngineUnavailableError`.

## Testing

- **Client repos:** `fake-indexeddb` under vitest — put/get/dedup-by-hash,
  `search()` paging/sort/filter parity with the ported logic, `setAnalysis`.
- **Ported search logic:** unit-test the query/sort/paginate port directly (it was
  server-tested before; keep equivalent cases).
- **Server by-value analysis:** `analyzeGame(game)` / key-moments accept a game
  and return evals; `eval_cache` still hit (existing engine tests adapted).
- **Import stream:** emits full `Game` records with hashes; a source failure still
  ends the job cleanly.
- **Agent context:** the coach reads the by-value game from context; removed tools
  are gone from the tool list; `load_pgn` builds a transient game.

## Build sequence (for the implementation plan)

1. `content_hash` → `@chess/shared`; add `LibraryDb` + `gamesRepo`/`collectionsRepo`
   (+ ported `search`) with fake-indexeddb tests. Not yet wired.
2. Point `LibraryView` + store reads at the repos (games arrive via step 3).
3. Flip import to return/stream full games; client writes + dedups into IndexedDB.
4. Flip analysis to by-value; client stores analysis on the game record.
5. Flip the coach to by-value game context; remove cross-library tools; transient
   per-session game.
6. Delete obsolete server storage (repos, controllers, `game.store`); shrink
   `persistence.module` to `eval_cache`.

Each step keeps the app runnable; the privacy win lands at step 3 and is complete
at step 6.
