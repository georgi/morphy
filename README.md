# Morphy

An AI-native chess analysis web app. Import a game (PGN or FEN), step through it on
an interactive board with live engine evaluation, and **chat with an agent** that
explains what you did wrong, walks through positions and variations, and drives the
board to show you exactly what it means.

"AI-native" means every meaningful domain function is exposed as a tool to the agent.
The same NestJS services that back the REST API are wrapped as Pi Agent SDK tools, so
the engine, chess logic, and game store are the single source of truth for both the UI
and the agent.

## Architecture

```
chess-analyzer/                 pnpm workspace
├─ packages/shared/             @chess/shared — types imported by BOTH apps
├─ apps/server/                 NestJS API + engine + agent
└─ apps/web/                    Vite + React 19 SPA
```

### Server (`apps/server`) — NestJS, Node 22

| Module | Responsibility |
|---|---|
| `EngineModule` / `EngineService` | Spawns a single native **Stockfish** process over UCI (`node-uci`), serializes analysis through an internal queue, supports `MultiPV`, restarts on crash/timeout. Missing binary → `EngineUnavailableError` → HTTP 503. |
| `ChessModule` / `ChessService` + `GameStore` | Wraps `chess.js` (PGN/FEN parse, legal moves, SAN, navigation, material balance, move classification). `GameStore` is an in-memory `Map<gameId, Game>`. |
| `AnalysisModule` / `AnalysisService` | Composes Engine + Chess: analyze a position, evaluate a single move (centipawn loss → classification), scan a whole game into an eval curve, explain a variation. |
| `AgentModule` | `ChessToolsService` builds the Pi tool registry (TypeBox params); `AgentService` manages one Pi session per chat `sessionId` and bridges Pi events to **Server-Sent Events**; `AgentController` is the SSE + message endpoint. |
| `ApiModule` | The REST controllers (below). |

Engine output is real Stockfish: `EngineEval = { fen, bestMove, lines: EngineLine[], depth }`
where each `EngineLine` carries `{ pv, scoreCp, mate, rank }`.

**Move classification** (centipawn loss vs. the engine's best move, Lichess-like):
`inaccuracy ≥ 50`, `mistake ≥ 100`, `blunder ≥ 300`. A mate swing overrides to blunder.

### Web (`apps/web`) — Vite + React 19

- **Routing:** TanStack Router (single `/` analysis route).
- **Server state:** TanStack Query for `/api/games` and `/api/analysis/*`.
- **Client state:** Zustand store — active `Game`, `currentPly`, `orientation`,
  `evalByPly` cache, chat transcript, and stream status.
- **UI:** shadcn/ui (Radix) + Tailwind v4; `sonner` for toasts.
- **Board:** `react-chessboard` (review board, position driven by `currentPly`).
- **Layout:** left = board + vertical **eval bar** + nav controls; middle = **move list**
  with inline eval and `?!`/`?`/`??` classification badges; right = **agent chat** panel
  (streamed answer + a compact tool-activity trail + input). Top bar = **Import** dialog
  (PGN or FEN) and **Analyze game**.

### Shared (`packages/shared`)

The canonical contract: `Game`, `Move`, `MoveEval`, `EngineLine`, `EngineEval`,
`MoveClassification`, `AgentEvent`, and the request DTOs for every endpoint and tool.
No type is defined twice — both apps import from `@chess/shared`.

## REST API

Served under the `/api` prefix on port **3001** (the Vite dev server proxies `/api` to it).

| Method | Path | Body / returns |
|---|---|---|
| POST | `/api/games` | `{ pgn }` or `{ fen }` → `Game` |
| GET | `/api/games/:id` | → `Game` |
| POST | `/api/analysis/position` | `{ fen, depth?, multipv? }` → `EngineEval` |
| POST | `/api/analysis/game` | `{ gameId }` → `MoveEval[]` |
| GET | `/api/agent/:sessionId/stream` | SSE stream of `AgentEvent` |
| POST | `/api/agent/:sessionId/messages` | `{ text, gameId?, ply? }` → `202 Accepted` |

Invalid PGN/FEN → `400`; unknown game id → `404`; engine binary missing → `503`.

## How the agent works

1. The client opens a persistent `EventSource` to `GET /api/agent/:sessionId/stream`.
   The server lazily creates a Pi agent session keyed by `sessionId`, seeded with a
   chess-coach system prompt and the chess tools, and feeds it from a per-session RxJS
   `Subject`.
2. The client `POST`s a user message to `/messages`. The controller injects the current
   game/ply context (FEN at the active ply + recent moves) into the prompt, calls
   `session.prompt(...)`, and returns `202` immediately.
3. Pi events are translated to the shared `AgentEvent` union and pushed onto the stream:
   `text_delta` (streamed answer), `tool_start` / `tool_end` (live tool activity shown in
   the chat trail), `board_update` (the agent moving the board you see), `done`, `error`.
4. `board_update` events drive the Zustand board state, so the board follows the agent's
   explanation in real time.

### Agent tools (the AI-native core)

Every tool is a thin wrapper that delegates to the **same** services the REST API uses —
logic is never reimplemented in a tool.

| Tool | Service call |
|---|---|
| `load_pgn` / `load_fen` | `ChessService.importPgn` / `importFen` → `GameStore` (emits `board_update`) |
| `get_position` | `ChessService.positionAtPly` |
| `list_legal_moves` | `ChessService.legalMoves` |
| `material_balance` | `ChessService.materialBalance` |
| `goto_move` | navigates the board the user sees (emits `board_update`) |
| `analyze_position` | `AnalysisService.analyzePosition` |
| `evaluate_move` | `AnalysisService.evaluateMove` |
| `analyze_game` | `AnalysisService.analyzeGame` |
| `explain_variation` | `AnalysisService.explainVariation` |
| `identify_opening` | `ChessService` + a small bundled ECO table |

## Prerequisites

- **Node 22** and **pnpm 9**.
- **Stockfish** on your `PATH`:
  ```bash
  brew install stockfish        # macOS; apt-get install stockfish on Debian/Ubuntu
  stockfish --help              # confirm it resolves
  ```
- **Pi / Anthropic credentials configured externally.** The app does **not** manage keys.
  The agent uses the Pi Agent SDK (`@earendil-works/pi-coding-agent`), which reads its own
  auth from the environment / `~/.pi/agent/auth.json`. If no provider credentials are
  present, the REST API and engine still work fully; only the chat panel is unavailable.

## Install, build, run

```bash
pnpm install            # install all workspace deps (run once)

pnpm build              # build shared + server + web
pnpm test               # run all tests (server uses the real Stockfish binary)

pnpm dev                # run server (:3001) and web (:5173) together
# or per app:
pnpm dev:server         # NestJS in watch mode on :3001
pnpm dev:web            # Vite dev server on :5173 (proxies /api → :3001)
```

Open <http://localhost:5173>, click **Import**, paste a PGN, then **Analyze game** and
ask the agent something in the chat panel.

### Running the built server

```bash
pnpm --filter server build
pnpm --filter server start          # node dist/apps/server/src/main.js, listens on :3001
```

## Sample game to paste

Morphy's "Opera Game" (Paris, 1858) — a clean miniature that ends in a forced mate, so
**Analyze game** lights up several flagged moves and the agent has plenty to talk about:

```
[Event "Paris Opera"]
[Site "Paris FRA"]
[Date "1858.??.??"]
[White "Paul Morphy"]
[Black "Duke Karl / Count Isouard"]
[Result "1-0"]
[ECO "C41"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7
8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8
13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0
```

The Import dialog also ships a **Load sample game** button that pastes this PGN for you.

Then try asking the agent: *"What did Black do wrong, and when did the game become lost?"*
```
