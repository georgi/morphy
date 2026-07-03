# Client-Owned Library (IndexedDB) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the game library (games + collections) from server SQLite into the browser's IndexedDB, making each browser its own system of record and turning the server into stateless compute.

**Architecture:** Client owns games/collections in IndexedDB via `idb` + repositories that mirror the current server repos. The server keeps only the shared `eval_cache`; import streams full games (no persistence), analysis flips by-id → by-value, and the coach reasons over the open game passed in the message body. Cross-library agent tools are removed.

**Tech Stack:** TypeScript, React, Zustand, `idb` (new), NestJS, better-sqlite3 (server, eval_cache only), Vitest (web), Jest (server), `fake-indexeddb` (new, web tests).

## Global Constraints

- Design spec: `docs/superpowers/specs/2026-07-03-client-owned-library-design.md` (verbatim source of truth).
- Preserve existing wire/type **contracts** except where a task explicitly changes them: `LibraryQuery`, `LibraryPage`, `Collection`, `Game`, `GameSummary` shapes stay identical unless noted.
- `content_hash` must produce **identical** output on client and server (shared implementation).
- `eval_cache` stays server-side and unchanged — it is per-FEN and user-independent.
- Every task ends green: web `pnpm --filter web typecheck && pnpm --filter web test`; server `pnpm --filter server typecheck && pnpm --filter server test:unit`; `npx prettier --check` on changed files.
- Commit per task with the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Each task keeps the app runnable. Privacy win lands at Task 5; migration complete at Task 8.

---

### Task 1: Move `content_hash` to `@chess/shared`

**Files:**
- Create: `packages/shared/src/content-hash.ts` (moved logic)
- Modify: `packages/shared/src/index.ts` (re-export)
- Modify: `apps/server/src/import/content-hash.ts` (re-export from shared, or delete + update importers)
- Test: `packages/shared/src/content-hash.spec.ts`

**Interfaces:**
- Produces: `export function contentHash(pgnOrGame: string): string` — exact same algorithm/signature as today's `apps/server/src/import/content-hash.ts`. Later tasks (import dedup, client repo) call this.

**Steps:**
- [ ] Read `apps/server/src/import/content-hash.ts`; note the exact function name, signature, and algorithm.
- [ ] Move the implementation verbatim into `packages/shared/src/content-hash.ts`; export it; re-export from `packages/shared/src/index.ts`.
- [ ] Update `apps/server/src/import/content-hash.ts` to re-export from `@chess/shared` (keep the path working for existing importers) OR delete it and repoint importers (`import.service.ts`, `games.repository.ts` if any). Verify with grep that no importer breaks.
- [ ] Port the existing content-hash test (`apps/server/src/import/content-hash.spec.ts`) into `packages/shared/src/content-hash.spec.ts`: same PGN → same hash; whitespace/movetext-equivalent handling identical to current behavior; two different games → different hashes.
- [ ] Build shared (`pnpm --filter @chess/shared build`), run server + shared tests, typecheck both. Commit: `refactor(shared): move content_hash into @chess/shared`.

---

### Task 2: Client persistence layer — `LibraryDb` + repositories

**Files:**
- Modify: `apps/web/package.json` (add `idb`; add `fake-indexeddb` dev dep)
- Create: `apps/web/src/lib/db/library-db.ts` (open + schema v1)
- Create: `apps/web/src/lib/db/games-repo.ts`
- Create: `apps/web/src/lib/db/collections-repo.ts`
- Create: `apps/web/src/lib/db/search.ts` (ported query/sort/paginate)
- Test: `apps/web/src/lib/db/games-repo.test.ts`, `collections-repo.test.ts`, `search.test.ts`
- Reference (read, do not modify): `apps/server/src/library/library.service.ts` (search/sort/paginate logic to port), `apps/server/src/persistence/games.repository.ts`, `collections.repository.ts` (method shapes), `packages/shared/src/index.ts` (`Game`, `GameSummary`, `LibraryQuery`, `LibraryPage`, `Collection`)

**Interfaces:**
- Produces:
  - `openLibraryDb(): Promise<IDBPDatabase<LibrarySchema>>` and a shared singleton `libraryDb()`.
  - `gamesRepo`: `put(game: Game, meta: GameMeta): Promise<Game>`, `get(id: string): Promise<Game | undefined>`, `existsByHash(hash: string): Promise<boolean>`, `search(query: LibraryQuery): Promise<LibraryPage>`, `setAnalysis(id: string, analysis: MoveEval[]): Promise<void>`, `delete(id: string): Promise<boolean>`, `list(): Promise<Game[]>`. `GameMeta = { source: ImportSource; collectionId?: string; createdAt: number; contentHash: string }`.
  - `collectionsRepo`: `put(c: Collection): Promise<Collection>`, `get(id): Promise<Collection | undefined>`, `list(): Promise<Collection[]>`, `delete(id): Promise<boolean>`, `recountGames(id): Promise<void>`.
  - `searchGames(all: StoredGame[], query: LibraryQuery): LibraryPage` — pure, in `search.ts`.

**Design notes for the implementer:**
- Object stores: `games` (keyPath `id`) with indexes `by-createdAt`, `by-white`, `by-black`, `by-eco`, `by-collection`, and unique `by-hash`; `collections` (keyPath `id`).
- Stored game record = `Game & { contentHash: string; source: ImportSource; collectionId?: string; createdAt: number; hasAnalysis: boolean; analysis: MoveEval[] | null }`.
- Port `library.service`'s filtering/sorting/pagination **verbatim** into the pure `searchGames`; keep `LibraryQuery`/`LibraryPage` output identical. Read the source first and mirror the default sort (newest first — see commit `a148795`).
- Tests use `fake-indexeddb` (`import "fake-indexeddb/auto"` in the test or a setup file). Reset the DB between tests.

**Steps:**
- [ ] Add `idb` (dep) and `fake-indexeddb` (devDep); `pnpm install`.
- [ ] Write failing `games-repo.test.ts`: put+get round-trips a Game; `existsByHash` true after put, false before; `setAnalysis` sets `analysis` + `hasAnalysis`; `delete` removes.
- [ ] Write failing `search.test.ts`: seed N games; assert default sort is newest-first; free-text query filters players; `collectionId` filter; pagination `offset`/`limit` produce the same `LibraryPage` shape the server returned. (Copy representative cases from `library.controller.spec.ts`.)
- [ ] Implement `library-db.ts`, `games-repo.ts`, `collections-repo.ts`, `search.ts` to green.
- [ ] Write + pass `collections-repo.test.ts`: put/get/list/delete; `recountGames` sets `gameCount` from the games store.
- [ ] Typecheck + web tests + prettier. Commit: `feat(web): IndexedDB library persistence layer`.

---

### Task 3: Point library reads at the repos

**Files:**
- Modify: `apps/web/src/views/LibraryView.tsx` (and any `useLibraryStore` query wiring in `apps/web/src/store.ts`)
- Modify: `apps/web/src/lib/api.ts` (remove/retire `searchLibrary`, `getLibraryGame`, `deleteLibraryGame`, `listCollections`, `getCollection`, `deleteCollection` — or leave unused until Task 8; prefer removing their call sites now)
- Test: `apps/web/src/views/LibraryView.test.tsx` (seed IDB instead of mocking fetch)

**Interfaces:**
- Consumes: `gamesRepo`, `collectionsRepo` from Task 2.

**Steps:**
- [ ] Read `LibraryView.tsx` + `useLibraryStore` to inventory every server library call.
- [ ] Replace `useQuery`/`api.*` library reads with `gamesRepo.search(query)` / `collectionsRepo.list()` etc. (react-query with `queryFn: () => gamesRepo.search(query)` is fine — keep the query-key/pagination UX).
- [ ] Update `LibraryView.test.tsx`: seed games into `fake-indexeddb`, assert the list renders newest-first and paginates. Remove fetch stubs for library.
- [ ] Typecheck + web tests + prettier. Commit: `feat(web): read the library from IndexedDB`.

---

### Task 4: Analysis by-value (server + shared)

**Files:**
- Modify: `packages/shared/src/index.ts` (`AnalyzeGameRequest`, `KeyMomentsRequest` → by-value)
- Modify: `apps/server/src/api/analysis.controller.ts` (accept game in body)
- Modify: `apps/server/src/analysis/analysis.service.ts` (`analyzeGame(game: Game, depth?)`, key-moments over a passed game)
- Test: `apps/server/src/api/analysis.controller.spec.ts` (add), `analysis.service.spec.ts` (adapt)

**Interfaces:**
- Produces (changed):
  - `AnalyzeGameRequest = { game: Game; depth?: number }`
  - `KeyMomentsRequest = { game: Game }`
  - `AnalysisService.analyzeGame(game: Game, depth?: number): Promise<MoveEval[]>` (returns curve; no server-side "store analysis on game").
  - `AnalysisService.keyMoments(game: Game): Promise<KeyMoment[]>`
- Unchanged: `/analysis/position` (already by-value), engine, `eval_cache`.

**Steps:**
- [ ] Read `analysis.controller.ts` + `analysis.service.ts`; note where `gameId` / `GameStore` are used.
- [ ] Change the shared request types to carry `game`.
- [ ] Write failing controller/service test: `analyzeGame(game)` returns a `MoveEval[]` of the right length off the engine; unknown/empty game → 400 (validation), not 404.
- [ ] Reimplement `analyzeGame`/`keyMoments` to take a `Game`; drop `GameStore`/`gameId` lookups and the "cache analysis on the game" write (client owns that now). Engine + `eval_cache` calls unchanged.
- [ ] Update `analysis.controller.ts` endpoints to read `body.game`.
- [ ] Server typecheck + unit tests + prettier. Commit: `feat(analysis): evaluate games by value, not by id`.

---

### Task 5: Import → client-owned (server/shared, then client)

**Files:**
- Modify: `packages/shared/src/index.ts` (`ImportEvent` `game` variant carries `Game`; add `collection` event if needed; `ImportGameRequest` unchanged)
- Modify: `apps/server/src/import/import.service.ts` (stop persisting; emit full games + hashes; describe collection)
- Modify: `apps/server/src/import/import.controller.ts` and `apps/server/src/api/games.controller.ts` (`POST /games` returns parsed `Game` + `contentHash`, no persistence)
- Modify: `apps/web/src/store.ts` (`useImportStore`) + `apps/web/src/lib/api.ts` (import stream/handlers)
- Test: `apps/server/src/import/*.spec.ts` (adapt), `apps/web/src/store.test.ts` (import reducers write to IDB)

**Interfaces:**
- Produces (changed): `ImportEvent` `game` variant = `{ type: "game"; game: Game; contentHash: string }`; optional `{ type: "collection"; collection: Collection }`. `POST /games` → `Game` (with `contentHash`).
- Consumes: `gamesRepo.existsByHash` / `gamesRepo.put` / `collectionsRepo.put` (Task 2), `contentHash` (Task 1).

**Steps:**
- [ ] Read `import.service.ts` end-to-end; locate every `games.*`/`collections.*` persistence call and the `emit({type:'game', summary})` site.
- [ ] Change the pipeline: compute `contentHash`, emit `{type:'game', game, contentHash}`; drop server inserts. Emit a `collection` event up front for named/remote imports instead of DB-creating it. Counts (imported/skipped) become client-side; server emits raw games + a final `done`.
- [ ] `POST /games`: parse PGN/FEN, compute hash, return `Game` (no store write).
- [ ] Adapt server import specs to assert the new stream shape (full game, no persistence).
- [ ] Client: in `useImportStore.applyEvent`, on a `game` event `await gamesRepo.existsByHash(contentHash)` → skip or `put`; increment client counts; on `collection` event `collectionsRepo.put`. Single-import path writes the returned game.
- [ ] Update `store.test.ts` import cases to assert dedup + IDB writes (fake-indexeddb).
- [ ] Server + web typecheck/tests + prettier. Commit: `feat(import): stream games to the client instead of persisting`.

---

### Task 6: Coach over the open game (by value); remove cross-library tools

**Files:**
- Modify: `apps/server/src/agent/agent.service.ts` (session context `{ game, ply }`; `sendMessage` takes the game)
- Modify: `apps/server/src/agent/chess-tools.service.ts` (tools read `context.game`; remove `search_library`/`open_game`/`list_collections`; `load_pgn`/`load_fen` build a transient in-session game)
- Modify: `packages/shared/src/index.ts` (`AgentMessageRequest` carries `game` instead of/in addition to `gameId`)
- Modify: `apps/web/src/components/chat/ChatPanel.tsx` (`send` includes the current `Game`)
- Delete/reduce: `apps/server/src/chess/game.store.ts` (transient per-session holder, not a shared DB)
- Test: `apps/server/src/agent/chess-tools.*.spec.ts` (adapt/remove library-tool cases), `apps/web` ChatPanel send test

**Interfaces:**
- Produces (changed): `AgentMessageRequest = { text: string; game?: Game; ply?: number }`. `AgentService` session `context = { game?: Game; ply?: number }`.
- Consumes: by-value analysis (Task 4) for `analyze_game`/`evaluate_move` tools.

**Steps:**
- [ ] Read `chess-tools.service.ts` fully; list every tool and its dependence on `this.store` / `this.library`.
- [ ] Change `AgentMessageRequest` to carry `game`; thread it into `AgentService` session `context`.
- [ ] Repoint `get_position`/`goto_move`/`analyze_game`/`evaluate_move`(no-FEN) at `context.game`. Remove `search_library`/`open_game`/`list_collections` from the tool list + their imports of `LibraryService`.
- [ ] Make `load_pgn`/`load_fen` build a transient game held on the session context (no shared store).
- [ ] Client: `ChatPanel.send` posts `{ text, game: currentGame, ply }`.
- [ ] Adapt agent tool specs: removed tools absent; a tool reads the by-value game from context.
- [ ] Server + web typecheck/tests + prettier. Commit: `feat(agent): coach over the open game; drop cross-library tools`.

---

### Task 7: Analysis result storage on the client

**Files:**
- Modify: `apps/web/src/lib/api.ts` (`analyzeGame`/`keyMoments` post the game by value)
- Modify: `apps/web/src/store.ts` and the analyze action / `ReviewPanel`/`KeyMoments` call sites
- Test: `apps/web/src/store.test.ts` (analysis persists to IDB record)

**Interfaces:**
- Consumes: by-value `/analysis/*` (Task 4), `gamesRepo.setAnalysis` (Task 2).

**Steps:**
- [ ] Update `api.analyzeGame`/`api.keyMoments` to send `{ game }`.
- [ ] After a successful game analysis, `await gamesRepo.setAnalysis(game.id, evals)` and update the in-memory store (`hasAnalysis = true`); opening a game rehydrates `analysis` from IDB.
- [ ] Test: analyzing a stored game writes `analysis` to its IDB record and flips `hasAnalysis`.
- [ ] Web typecheck/tests + prettier. Commit: `feat(web): store analysis on the IndexedDB game record`.

---

### Task 8: Delete obsolete server storage

**Files:**
- Delete: `apps/server/src/persistence/games.repository.ts`, `collections.repository.ts`, `import-jobs.repository.ts` (+ their specs), `apps/server/src/library/` (controller/module/service + specs), `apps/server/src/chess/game.store.ts` if fully unused
- Modify: `apps/server/src/persistence/database.ts` (drop `games`, `collections`, `import_jobs` tables; keep `eval_cache` + `schema_version`; bump `SCHEMA_VERSION`), `persistence.module.ts` (export only `EvalCacheRepository`), `app.module.ts`/module wiring, `apps/web/src/lib/api.ts` (remove dead library/game endpoints)
- Test: adjust `database.spec.ts` (now one table), remove deleted specs

**Steps:**
- [ ] Grep for every importer of the deleted classes/modules; confirm none remain after Tasks 1–7.
- [ ] Delete the files; shrink `database.ts` schema to `eval_cache` (+ `schema_version`), bump `SCHEMA_VERSION`; update `persistence.module.ts` and any module imports.
- [ ] Remove dead client API functions.
- [ ] Update `database.spec.ts` to expect only `eval_cache` + `schema_version`.
- [ ] Full server + web typecheck/tests + prettier. Commit: `refactor(server): drop server-side library storage`.

---

## Self-Review

- **Spec coverage:** client persistence (T2/T3), import→stream (T5), analysis by-value (T4/T7), coach by-value + tool removal (T6), server cleanup (T8), content_hash shared (T1), eval_cache retained (T4/T8). All spec sections covered.
- **Ordering:** T1 (hash) → T2 (repos) → T3 (reads) → T4 (analysis server) → T5 (import) → T6 (coach) → T7 (client analysis storage) → T8 (delete). Each keeps the app runnable; privacy win at T5, complete at T8.
- **Type consistency:** `contentHash`, `GameMeta`, `LibraryPage`, `AnalyzeGameRequest`/`KeyMomentsRequest` (by-value), `ImportEvent.game`, `AgentMessageRequest.game`, `gamesRepo.setAnalysis` used consistently across tasks.
- **Note:** T7 depends on T4's by-value endpoints; both touch `api.ts` — run sequentially.
