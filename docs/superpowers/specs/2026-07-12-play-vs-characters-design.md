# Play vs. Characters — Design

**Date:** 2026-07-12
**Status:** Approved (UX + backend architecture approved interactively; state/error/testing sections finalized by Claude at user's request)

## Overview

A new **Play** mode: the user plays a full game against an AI opponent with a
personality. Characters span dead greats (real names), living figures
(recognizable parodies, no real names), and archetypes. Stockfish generates
candidate moves; an LLM picks one in character and supplies banter. Finished
games flow into the existing library and analysis view.

## Decisions log

| Decision | Choice |
|---|---|
| Move generation | Stockfish MultiPV candidates; LLM picks in character |
| Chat cadence | Reactive + occasional banter; always replies to user chat |
| Roster naming | Dead players real names; living people as parody characters |
| UX placement | New `/play` route: roster grid → play screen |
| Difficulty | Baked into each character (no slider) |
| Game end | Result overlay → save to library + one-click analyze |
| Orchestration | Hybrid: deterministic structured LLM call per move + persona chat session for banter/user chat |
| Roster select layout | Roster grid (cards) |
| Play screen layout | Board left, persona chat panel right (analysis-view shape) |
| Game-end treatment | Result overlay on the board |

## UX

### Navigation
Top nav gains **Play** (Analyze · Library · Play). Routes:

- `/play` — character select (roster grid)
- `/play/$gameId` — active game

### `/play` — roster grid
Card per character: avatar (emoji v1), name, one-line catchphrase, strength
stars (1–5), style tag ("Trappy", "Positional", "Chaos"). Clicking a card
expands it in place: short bio + **Play as White / Play as Black / Random**.
Choosing a side creates the game and navigates to `/play/$gameId`.

### `/play/$gameId` — play screen
Reuses the analysis layout shape:

- **Left:** board with existing name plates — the character's plate shows
  avatar + name + strength. Below the board: a control strip with
  **Resign** and **Offer draw**.
- **Middle:** move list, **without** eval bar / classification badges — no
  engine hints during play.
- **Right:** persona chat panel (existing chat component style). Banter
  messages stream in on notable moments; the user can type to the character
  at any time.

The AI's move animates in after a short thinking beat. The board only accepts
user moves on the user's turn; illegal moves are rejected by the board as
today.

### Game end
Modal **result overlay** over the board: result (1–0 / 0–1 / ½–½ + reason),
the character's in-persona parting shot, and actions:

- **Analyze this game** (primary) — saves the finished game to the existing
  client-owned library, then routes to the analysis view with the game loaded.
- **Rematch** — new game, same character, colors swapped.
- **New opponent** — back to `/play`.

Chat remains usable behind the overlay (overlay is dismissible).

## Roster (v1 — 8 characters)

| id | Name | Recognizable as | Style | Strength |
|---|---|---|---|---|
| `norwegian` | The Norwegian | Magnus Carlsen | Universal; grinds "equal" endgames; bone-dry: *"This is, objectively, lost for you."* | ⭐⭐⭐⭐⭐ |
| `speedrunner` | The Speedrunner | Hikaru Nakamura | Narrates to imaginary chat: *"Chat, takes takes takes."* | ⭐⭐⭐⭐⭐ |
| `tal` | Mikhail Tal | himself | Sacrifices on principle; poetic; deep dark forest | ⭐⭐⭐⭐ |
| `fischer` | Bobby Fischer | himself | Ruthless precision; prickly; demands respect | ⭐⭐⭐⭐⭐ |
| `morphy` | Paul Morphy | himself (house patron) | Romantic elegance; courteous; punishes greed | ⭐⭐⭐⭐ |
| `clickbait-coach` | The Clickbait Coach | Levy Rozman | Thumbnail-speak (*"THE ROOK!!"*) but names real motifs; teaches | ⭐⭐⭐⭐ |
| `hustler` | The Washington Square Hustler | park archetype | Traps, gambits, relentless patter, plays for five bucks | ⭐⭐⭐ |
| `blitz-sisters` | The Blitz Sisters | Botez sisters | Two voices interrupting each other; self-aware queen-blunder joke | ⭐⭐⭐ |

Persona prompts are affectionate parody: funny voice, but the prompt requires
smuggling genuine chess insight into the bit (the Hustler explains the trap
after you fall in; the Coach names the actual motif).

## Character config schema

Server-side registry (static TS objects in `apps/server/src/play/characters/`):

```ts
interface CharacterConfig {
  id: string;
  name: string;
  avatar: string;            // emoji v1
  tagline: string;           // card one-liner
  bio: string;               // expanded card text
  strength: 1 | 2 | 3 | 4 | 5;
  styleTag: string;          // "Trappy", "Positional", ...
  chess: {
    multiPv: number;         // candidate pool size (3–8)
    evalWindowCp: number;    // max cp below best considered (30–150)
    searchDepth: number;     // engine depth for move generation
    blunderRate: number;     // 0–1 chance to inject a genuine mistake candidate
    styleHints: string;      // prose given to the LLM: aggression, traps, simplification, sac appetite
  };
  personaPrompt: string;     // full system prompt (server-only, never sent to client)
  banter: {
    chattiness: 'low' | 'medium' | 'high';
    triggers: BanterTrigger[]; // subset of: own-interesting-move, user-blunder,
                               // user-good-move, capture, check, mate-threat,
                               // game-start, game-end
  };
}
```

`@chess/shared` exposes the **public** subset (`Character`: id, name, avatar,
tagline, bio, strength, styleTag) — prompts and chess profile stay server-side.

## Backend architecture

New **`PlayModule`** (`apps/server/src/play/`) composing existing services.

### CharacterRegistry
Static configs + `list()` / `get(id)`. `list()` returns the public subset.

### PlayService
Owns active play sessions in an in-memory map (pattern: `GameStore`, which it
uses via `ChessService` for the actual game/move state).

**AI-move pipeline (per AI turn):**

1. **Candidates** — `EngineService` MultiPV top-N at the character's depth;
   filter to lines within `evalWindowCp` of best. With probability
   `blunderRate`, append one genuine mistake candidate (a legal move ranked
   well below the window).
2. **Selection** — one structured LLM call through the existing model-fallback
   harness: persona system prompt + FEN + last ~6 moves + candidate list with
   evals + last 2 banter lines → JSON `{ move: string; comment?: string }`.
   Comment is optional and gated by the character's chattiness/triggers.
3. **Validation** — chosen move must be in the candidate list; otherwise fall
   back to the engine's best move (and drop the comment). The game never
   stalls on a bad LLM response.
4. **Apply** — via `ChessService`; emit `ai_move` (and `banter` if a comment
   survived) on the game's SSE stream.

**Banter on user moves:** after each user move, a shallow engine eval
(low depth, cached alongside) classifies the moment (blunder / good move /
capture / check / mate threat). If it matches the character's triggers (and a
per-game cooldown of ~3 plies since last unprompted banter passes), fire a
persona comment through the chat session.

### Persona chat session
One `AgentService` Pi session per play game, created with the character's
`personaPrompt`. Every applied move (both sides) and every emitted comment is
appended to the session context, so free-form user chat is coherent with the
game ("you said you'd attack my king…"). **Play sessions get no analysis
tools** — the character cannot leak engine lines. User chat messages route to
this session; replies stream over the same SSE channel as `banter` events.

### PlayController (REST + SSE, `/api/play`)

| Endpoint | Purpose |
|---|---|
| `GET  /api/play/characters` | Public roster for the grid |
| `POST /api/play` | `{ characterId, side }` → `PlayGame` (creates game; if AI is White, first AI move arrives on the stream) |
| `GET  /api/play/:id` | Current `PlayGame` state (resync after reconnect) |
| `POST /api/play/:id/move` | `{ move }` (SAN/UCI) → updated state ack; AI reply via SSE |
| `POST /api/play/:id/resign` | Ends game |
| `POST /api/play/:id/draw-offer` | Character accepts/declines in persona (accept iff eval ≤ slight disadvantage for it) |
| `POST /api/play/:id/chat` | User chat message → persona session |
| `GET  /api/play/:id/events` | SSE: `ai_move`, `banter` (token-streamed), `chat` (token-streamed reply), `game_over`, `error` |

### Game end
`ChessService` detects mate/stalemate/draw rules; resignation/draw via
endpoints. On end: generate the in-persona parting shot (one LLM call through
the chat session), emit `game_over { result, reason, partingShot }`. The
**client** saves the finished PGN to the client-owned library (existing
pattern) with metadata `{ opponent: characterId, side, result }`, then may
route to analysis.

### Shared types
`Character`, `PlayGame` (id, characterId, side, fen, moves, status, result),
`PlayEvent` union, request DTOs — all in `@chess/shared`, no duplication.

## Web app (state & data flow)

- **Routing:** two new TanStack Router routes: `/play`, `/play/$gameId`.
- **Server state:** TanStack Query for `GET /api/play/characters`.
- **Client state:** a new Zustand slice `playStore`, separate from the
  analysis store: active `PlayGame`, board position, per-game chat transcript,
  stream status, pending-AI-move flag, result. The analysis store is untouched
  — leaving a play game mid-way abandons it (v1: no persistence of in-progress
  games; refresh loses the game — acceptable, sessions also live in server
  memory only).
- **SSE:** reuse the existing SSE hook/bridge pattern from the coach chat for
  `/api/play/:id/events`.
- **Board:** `react-chessboard` in interactive mode, orientation = user side,
  input locked while `pendingAiMove` or game over.
- **Reused components:** chat panel shell, name plates, move list (badges
  hidden via prop), import-dialog-style modal for the result overlay.

## Error handling

- **Engine unavailable** → existing `EngineUnavailableError` / HTTP 503;
  play screen shows the existing engine-down toast; game creation blocked.
- **LLM failure on move selection** → after model-fallback exhausts, play the
  engine's best move silently. Personality degrades; the game continues.
- **LLM failure on banter/chat** → reuse existing inline chat error surfacing
  (from the rate-limit fallback work); moves are never blocked by chat
  failures.
- **Illegal/out-of-turn move submissions** → 400 with reason; board state
  re-synced from server response.
- **SSE disconnect** → existing reconnect pattern; on reconnect the client
  fetches `GET /api/play/:id` state (included in `PlayGame`) to resync.

## Testing

- **Unit (server):** candidate filtering (window, pool size, blunder
  injection determinism via seeded RNG), move validation + engine-best
  fallback, banter trigger classification + cooldown, draw-accept rule,
  registry public-subset mapping.
- **Service tests:** `PlayService` with mocked `EngineService` + mocked LLM
  harness (pattern already used in `agent.service.spec.ts` /
  `chess-tools.service.spec.ts`): full move round-trip, AI-plays-White
  opening move, game-over emission, LLM-returns-garbage fallback.
- **Web:** `playStore` unit tests (pattern: `store.test.ts`) for move
  application, stream event reduction, game-over transitions.
- **Manual e2e:** one scripted game vs. the Hustler at low depth (fast),
  verifying banter arrives, resign works, and Analyze-handoff loads the game
  in the analysis view.

## Out of scope (v1)

- Time controls / clocks
- Adaptive difficulty, difficulty slider
- Character portraits (emoji avatars v1), voice/TTS
- Persisting in-progress games across refresh/server restart
- In-play move takebacks (character would refuse anyway)
- Public-release rights review for parody personas (personal app)
