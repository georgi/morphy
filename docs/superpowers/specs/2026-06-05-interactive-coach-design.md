# Interactive Coach — Design Spec

**Date:** 2026-06-05
**Status:** Approved, building

## 1. Problem

The agent currently answers a review request in one shot: a brief greeting, a long
chain of redundant tool calls, then a single multi-mistake blob. We want an
**interactive, move-by-move tutor**: it jumps to the few most instructive turning
points, shows each in the UI, asks the user to find a better move (played on the
board), and only then reveals + teaches — no greeting, no blob.

Decisions: answer by **playing on the board** (typing a move still works); **jump
between turning points** (not a full replay); quiz the **top few adaptive** swings.

## 2. Architecture (approach A)

Agent-driven loop with a tiny per-session review cursor. The cursor lives in the
**closure of `buildToolsForSession`** (tools are built once per chat session and
persist), so no separate store is needed. Pi session memory carries the dialogue.
The agent runs the loop via three new tools; it ends its turn after posing each
question and resumes when the user's next message (their move) arrives.

## 3. Shared contracts (`@chess/shared`)

```ts
export interface TurningPoint {
  index: number;              // 0-based position within the review
  ply: number;                // half-move of the mistake
  moveNumber: number;
  sideToMove: Color;          // side that is to move at fenBefore (the side that erred)
  fenBefore: string;          // position BEFORE the mistake (what the user faces)
  playedSan: string;          // the move actually played
  classification: MoveClassification;
  cpLoss: number;
  scoreCpBefore: number | null; // white-POV eval before the move
  bestMove: string | null;      // engine best move in SAN
  bestLine: string[];           // engine best line in SAN
}

// new AgentEvent variants (added to the union)
| { type: 'coach_question'; gameId: string; ply: number; fen: string;
    sideToMove: Color; index: number; total: number }
| { type: 'coach_reveal'; ply: number; bestMove: string | null; bestLine: string[];
    playedSan: string; userSan?: string;
    verdict: 'correct' | 'close' | 'off' | 'revealed'; evalText: string }
```

## 4. Server

### CoachService (`apps/server/src/analysis/coach.service.ts`)
- `computeTurningPoints(gameId, { max = 5 }): Promise<TurningPoint[]>`
  - `analyzeGame` once (reuse `game.analysis` cache) → `MoveEval[]`.
  - Keep `mistake`/`blunder` classifications; take the top `max` by `cpLoss`, then
    sort chronologically by `ply`.
  - For each: `fenBefore = positionAtPly(game, ply-1)`, convert `bestMove`/`bestLine`
    from UCI → SAN (via ChessService), fill `sideToMove`/`moveNumber`.

### ChessService helpers
- `uciToSan(fen, uci): string | null` and `uciLineToSan(fen, uciMoves): string[]`
  (walk a `Chess(fen)`, applying `{from,to,promotion}`).

### Tools (added in `chess-tools.service.ts`, sharing a closure `review` var)
`let review: { gameId: string; points: TurningPoint[]; cursor: number } | null`

- **`start_review({ gameId?, max? })`** — compute points, set `cursor = 0`. If none,
  return "cleanly played". Else emit `board_update` (fen = point0.fenBefore, ply =
  ply-1) and `coach_question`. Return the setup **without** `bestMove`/`bestLine`.
- **`score_guess({ san? })`** — current point `p`. With `san`: `evaluateMove(p.fenBefore, san)`
  → `cpLoss` → verdict (`≤20` correct, `≤60` close, else off); illegal move → tell the
  agent to ask again. Without `san`: verdict `revealed`. Emit `coach_reveal` (best move +
  line, played, user move, verdict). Return reveal text incl. best move + line.
- **`next_turning_point()`** — `cursor++`; if past the end return `{ done: true }`;
  else emit `board_update` + `coach_question` and return the next setup (no answer).

### System prompt (replaces `SYSTEM_PROMPT` in `agent.service.ts`)
No greeting/menus. On a review/coach/"what did I do wrong" request: call `start_review`,
then loop — one short message that sets the scene and asks for a better move, **stop and
wait**; on the user's reply call `score_guess` and react in 2–4 sentences (confirm-why, or
teach: best move + idea + why theirs falls short); `next_turning_point`; on done, a one-line
lesson. Never dump all mistakes; never reveal before the user tries. Other analysis tools
remain available for off-review questions. No game loaded → ask to import.

## 5. Web

- **Zustand `coach` slice** (`store.ts`): `{ mode: 'idle'|'question'|'reveal', current:
  CoachQuestion|null, lastReveal: CoachReveal|null }` + actions `setCoachQuestion`,
  `setCoachReveal`, `clearCoach`. `setGame`/manual navigation clear it.
- **`ChatPanel.tsx`**: handle `coach_question` → `setCoachQuestion`; `coach_reveal` →
  `setCoachReveal`. (Existing `board_update`/text/tool handling unchanged.)
- **`BoardPanel.tsx` quiz mode**: when `coach.mode === 'question'`, board shows
  `coach.current.fen`, pieces draggable. On drop: `chess.js` validates from→to (auto-queen
  on promotion); illegal → snap back; legal → append a user chat bubble, `sendAgentMessage`
  with the SAN, set streaming. On `reveal`, draw the best-move arrow (derive squares client-
  side from `coach.current.fen` + `bestMove` SAN). Outside quiz mode the board is unchanged
  (view-only, follows `currentPly`).
- **`CoachBanner.tsx`** (near the board): in `question` mode → "Your turn — find a better
  move for {Side} · {index+1}/{total}"; in `reveal` mode → ✓/✗ verdict + best move.

## 6. Errors
No game → `start_review` returns a friendly error → agent asks to import. Illegal guess →
client snaps back (board) or `score_guess` reports illegal (typed). Engine slowness → tools
await; the scan uses the cached game analysis. Promotion → auto-queen for v1.

## 7. Testing
- Server: `computeTurningPoints` selection (given `MoveEval[]`: right top-N, chronological,
  correct `fenBefore`/SAN conversion); the three tools' `execute` + emitted events; `uciToSan`.
- Web: coach-slice reducers; board move→SAN conversion + illegal snap-back; a smoke that
  `coach_question` flips the board to interactive.

## 8. Build order (workflow phases)
1. **Foundation** — shared `TurningPoint` + 2 events; build shared.
2. **Server** — `uciToSan` helpers, `CoachService`, 3 tools + closure cursor, new system
   prompt, tests.
3. **Web** — coach slice + `ChatPanel` event routing + `CoachBanner`, then `BoardPanel` quiz.
4. **Integration** — build + tests; boot server; scripted SSE coaching session
   (start_review → coach_question → send a move → score_guess → coach_reveal → next).

## 9. Out of scope
Branching/variations exploration on the board, under-promotion picker, persisting review
sessions, spaced-repetition. v1 auto-queens and reviews top ~5 swings.
