# Chess Analyzer — Design Spec

**Date:** 2026-06-04
**Status:** Approved design, pending spec review

## 1. Goal

An AI-native chess analysis web app. The user imports a game (FEN or PGN), steps
through it on an interactive board with engine evaluation, and **chats with an
agent** that explains what they did wrong, walks through positions and variations,
and suggests how to improve.

"AI-native" means: **every meaningful domain function is exposed as a tool to the
agent.** The same NestJS services that back the REST API are wrapped as Pi Agent
SDK tools. Services are the single source of truth.

## 2. Stack (decided)

| Concern | Choice |
|---|---|
| Server | NestJS (Node 22, TypeScript) |
| Engine | Native Stockfish over UCI (`node-uci`), `stockfish` binary on PATH |
| Agent | Pi Agent SDK (`@earendil-works/pi-coding-agent`), **configured externally** (auth via env / `auth.json` — app does not manage keys) |
| Agent transport | Server-Sent Events (NestJS `@Sse`) |
| Chess logic | `chess.js` (parsing, legal moves, SAN, navigation) |
| Frontend build | Vite + React 19 + TypeScript |
| Routing / server-state | TanStack Router + TanStack Query |
| Client state | Zustand |
| UI kit | shadcn/ui + Tailwind |
| Board | `react-chessboard` (pin to current major, match its API exactly) |
| Persistence | In-memory (server `Map` + client Zustand); resets on restart |
| LLM provider | Anthropic (inherited from external Pi config) |

## 3. Repo layout (pnpm workspace)

```
chess-analyzer/
├─ pnpm-workspace.yaml
├─ package.json                 # workspace root scripts
├─ apps/
│  ├─ server/                   # NestJS
│  └─ web/                      # Vite + React
└─ packages/
   └─ shared/                   # @chess/shared — types imported by both
```

`@chess/shared` exports: `Game`, `Move`, `MoveEval`, `EngineLine`, `EngineEval`,
`MoveClassification`, `AgentEvent`, and the request/response DTOs for every REST
endpoint and tool. No type is defined twice.

## 4. Server modules

All engine/chess/analysis logic lives in services. Controllers (REST) and the Pi
tool registry both delegate to the same service methods — never reimplement logic
in a controller or a tool.

### EngineModule → `EngineService`
- Spawns a single native `stockfish` process via `node-uci`.
- Serializes analysis requests through an internal queue (one UCI engine = one
  request at a time).
- Supports `MultiPV`. Timeout per request; auto-restart the process on crash/timeout.
- `analyze(fen, { depth?, multipv? }): Promise<EngineEval>` where
  `EngineEval = { bestMove: string; lines: EngineLine[]; depth: number }` and
  `EngineLine = { pv: string[]; scoreCp: number | null; mate: number | null; rank: number }`.
- Missing binary → throws a typed `EngineUnavailableError` → mapped to HTTP 503.

### ChessModule → `ChessService` + `GameStore`
- `ChessService` wraps `chess.js`:
  - `importPgn(pgn): Game`, `importFen(fen): Game`
  - `legalMoves(fen): string[]`, `applySan(fen, san): { fen, move }`
  - `positionAtPly(game, ply): string` (FEN), `materialBalance(fen)`
  - `classify(cpLoss): MoveClassification`
- `GameStore`: in-memory `Map<gameId, Game>`. `gameId` is a server-generated id.
- A `Game` holds: id, headers (event/white/black/result/ECO if present), starting
  FEN, ordered `Move[]` (san, uci, fen-after, ply), and an optional cached
  `MoveEval[]` once analyzed.

### AnalysisModule → `AnalysisService`
Composes Engine + Chess:
- `analyzePosition(fen, opts): EngineEval`
- `evaluateMove(fenBefore, san): MoveEval` — eval before vs. eval after best move
  vs. eval after played move → centipawn loss → `classify`.
- `analyzeGame(gameId): MoveEval[]` — scan every ply, build the eval curve, flag
  inaccuracies/mistakes/blunders. Results cached on the `Game`.
- `explainVariation(fen, sanLine: string[]): { ply: string; eval: EngineEval }[]`.

**Classification thresholds** (centipawn loss vs. best move, Lichess-like):
`inaccuracy ≥ 50`, `mistake ≥ 100`, `blunder ≥ 300`. Mate swings override to blunder.

### AgentModule
- `ChessToolsService` — builds `defineTool[]` (TypeBox params). Each tool's
  `execute` calls a service method and returns `{ content: [{type:'text', text}], details }`.
- `AgentService` — manages Pi sessions: `createAgentSession({ sessionManager:
  SessionManager.inMemory(), customTools })` per chat session, keyed by `sessionId`.
  Seeds a system prompt describing the app and the active game context.
- `AgentController` — SSE bridge (see §6).

### Tool surface (the AI-native core)

| Tool | Params (TypeBox) | Service call |
|---|---|---|
| `load_pgn` | `{ pgn }` | `ChessService.importPgn` → store |
| `load_fen` | `{ fen }` | `ChessService.importFen` → store |
| `get_position` | `{ gameId, ply? }` | `ChessService.positionAtPly` |
| `list_legal_moves` | `{ fen }` | `ChessService.legalMoves` |
| `material_balance` | `{ fen }` | `ChessService.materialBalance` |
| `goto_move` | `{ gameId, ply }` | navigates the board the user sees (emits UI event) |
| `analyze_position` | `{ fen, depth?, multipv? }` | `AnalysisService.analyzePosition` |
| `evaluate_move` | `{ fen, san }` | `AnalysisService.evaluateMove` |
| `analyze_game` | `{ gameId }` | `AnalysisService.analyzeGame` |
| `explain_variation` | `{ fen, line: string[] }` | `AnalysisService.explainVariation` |
| `identify_opening` | `{ fen }` or `{ gameId }` | ChessService + small bundled ECO table |

`goto_move` and `load_*` produce a UI-affecting side effect: they emit an event on
the session's SSE stream so the client board follows what the agent is doing.

## 5. REST API (for direct, non-agent UI actions)

| Method | Path | Body / returns |
|---|---|---|
| POST | `/api/games` | `{ pgn }` or `{ fen }` → `Game` |
| GET | `/api/games/:id` | → `Game` |
| POST | `/api/analysis/position` | `{ fen, depth?, multipv? }` → `EngineEval` |
| POST | `/api/analysis/game` | `{ gameId }` → `MoveEval[]` |
| GET | `/api/agent/:sessionId/stream` | SSE stream of `AgentEvent` |
| POST | `/api/agent/:sessionId/messages` | `{ text, gameId?, ply? }` → 202 |

## 6. Agent streaming (SSE)

1. Client opens a persistent `EventSource` to `GET /api/agent/:sessionId/stream`.
   Server creates/looks up the Pi session and returns an RxJS `Observable<MessageEvent>`
   fed by a per-session `Subject`.
2. Client `POST`s a user message to `/messages`; the controller calls
   `session.prompt(text)` (with current game/ply context injected) and returns 202.
3. `session.subscribe(...)` maps Pi events → `AgentEvent` and pushes onto the
   Subject: `text_delta` (streamed answer), `tool_start` / `tool_end` (live tool
   activity shown in the chat), `board_update` (from `goto_move`/`load_*`), `done`,
   `error`.
4. The chat panel renders streamed text **and** a compact tool-activity trail
   ("analyzing position at depth 18…"). `board_update` drives the Zustand board state.

## 7. Frontend

- **Routing:** TanStack Router, single `/` analysis route (extensible).
- **Server state:** TanStack Query for `/api/games` and `/api/analysis/*`.
- **Client state:** Zustand store — active `Game`, `currentPly`, `orientation`,
  `evalByPly` cache, `chatMessages`, `streamStatus`.
- **UI:** shadcn/ui (Button, Card, Input, Tabs, ScrollArea, Resizable, Dialog,
  Sonner) + Tailwind.
- **Board:** `react-chessboard`, position driven by `currentPly`.
- **Layout:**
  - Left: board + vertical **eval bar** + nav controls (◀ ▶, flip, jump-to-mistake).
  - Middle: **move list** with inline eval and classification badges (?! ? ??).
  - Right: **Agent chat** panel (streamed answer + tool-activity trail + input).
  - Top: **Import** dialog accepting FEN or PGN.

## 8. "What did I do wrong" flow

Import PGN → board + move list render → "Analyze game" paints the eval curve and
flags mistakes → user asks *"what did I do wrong around move 14?"* → agent (game
context + tools) calls `evaluate_move` / `analyze_position` / `explain_variation`,
streams an explanation, and drives the board to the relevant position/variation
via `goto_move`.

## 9. Error handling

- Engine: queue + per-request timeout + auto-restart; missing binary → 503 with
  install hint; surfaced as a toast.
- Invalid PGN/FEN: `chess.js` throws → 400 with message → toast.
- Tool errors: wrapped into tool-result `content` so the agent can recover/report.
- Agent transport: SSE `error` event closes the stream cleanly; client shows a retry.

## 10. Testing (TDD)

- **Server unit:** `ChessService` (PGN/FEN parse, SAN, classification thresholds),
  `AnalysisService` (cp-loss math, game scan), each tool's `execute` (maps to service).
- **Engine integration:** real `stockfish`, gated/skipped when the binary is absent.
- **e2e:** import + analyze endpoints via Nest testing harness.
- **Web:** vitest + RTL for store logic and a smoke render of the analysis view.

## 11. Build order (workflow phases)

1. Workspace + `@chess/shared` types + tooling (tsconfig, eslint, scripts).
2. `EngineService` (native UCI) + tests.
3. `ChessService`/`GameStore` + `AnalysisService` + tests.
4. REST controllers + e2e.
5. Pi tool registry + `AgentService` + SSE controller.
6. Web shell: board + move list + eval bar + import dialog.
7. Agent chat panel wired to SSE + board sync.
8. End-to-end verification pass (run the app, import a real game, ask the agent).

## 12. Verify at implementation time (research before coding the relevant phase)

- Exact Pi SDK API: `createAgentSession` options, event shapes from `subscribe`,
  `defineTool` return contract, `SessionManager` usage — from `earendil-works/pi`
  `examples/sdk/` and `docs/sdk.md`.
- `react-chessboard` current major API (props for position, drop handler,
  orientation, custom arrows/squares).
- `node-uci` API (init, position, go, info parsing, process lifecycle).

## 13. Out of scope (YAGNI for this scaffold)

Multi-user accounts, cloud persistence, opening-explorer database, puzzle training,
mobile-native, engine pools/horizontal scaling, agent key management (external).
