# Best-move arrows in any position

**Status:** Design approved, ready for implementation plan
**Date:** 2026-06-06
**Register:** product (see `PRODUCT.md`) · **Visual system:** `DESIGN.md`

## Problem

The board should show the engine's best candidate moves as arrows **in any position**.

Today the board already draws a *single* green best-move arrow (`BoardPanel.tsx`
`bestMoveArrow`), but it only appears:

- **after** the user runs "Analyze game" (the only thing that fills `evalByPly`, via
  `ImportDialog.tsx:567`, converting each `MoveEval`), and
- only on **in-game plies** (it is keyed by ply, so agent variations and FEN setups get
  nothing), and
- only as **one** move (the game scan is MultiPV 1).

The arrow is also raw green (`#15803d`), which violates the new `DESIGN.md` (untokenized,
and green sits in the Chess.com-adjacent / "brilliant" functional band).

## Goals

1. Show the engine's **top 3** candidate moves as ranked arrows.
2. Work in **any position**: pre-scan, mid-navigation, agent off-game variations
   (`agentFen`), and manual FEN imports.
3. **Toggle, default on**, with the preference persisted.
4. **Yield** to the agent's and coach's own arrows.
5. Style per `DESIGN.md`: ember accent, colorblind-safe (rank readable without color
   alone).

## Non-goals

- A keyboard shortcut for the toggle (no global keyboard-nav handler exists today; board
  nav is button-only). Button only.
- Configurable arrow count (decided: fixed top 3).
- Changing the full-game scan, the move list, or the advantage chart.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| How many arrows | **Top 3 ranked** (MultiPV 3) |
| Visibility | **Toggle, default ON**, persisted to localStorage |
| Eval for un-analyzed positions | **Cache-first, then live** debounced MultiPV analysis |
| Coexistence | **Yield** to agent/coach (suppress our arrows during coach review and while the agent drives the board) |
| Rendering | **Custom SVG overlay** (react-chessboard's `Arrow` is `{startSquare,endSquare,color}` only — no width/opacity/label) |
| Live depth | **depth 14, MultiPV 3** (matches the game scan's depth so arrow evals are consistent with the move list; faster than depth 18) |

### Why a custom overlay (Approach A)

`react-chessboard@5`'s `Arrow` type is `{ startSquare, endSquare, color }` — color only.
Ranked thickness and per-arrow eval chips (the approved mockup, and the colorblind-safe
encoding) are impossible through the library's `arrows` prop. We render our own SVG layer
over the board and reserve the library's `arrows` prop for the agent/coach arrows.

Rejected: **B (library color-only)** — no thickness/labels, rank leans on hue, fails the
approved visual and weakens the colorblind rule. **C (patch/replace the board lib)** —
unnecessary.

## Architecture

The board is a fixed aspect-square (`aspect-square w-full max-w-[560px]`). An
absolutely-positioned `<svg viewBox="0 0 8 8">` over it maps each square to one unit, so
arrow geometry is resolution-independent and needs no pixel measuring. Orientation flip is
a coordinate transform.

### Units

1. **`apps/web/src/lib/arrows.ts`** (pure, unit-tested)
   - `squareToXY(square: string, orientation: Orientation): { x: number; y: number }` —
     center of a square in 0–8 space (file/rank, flipped for black).
   - `bestMoveArrows(evalResult: EngineEval | undefined, count = 3): ArrowSpec[]` — take
     the first `count` ranked `lines`, read `line.pv[0]` (UCI), derive `from`/`to`
     (first 4 chars, promotions handled), and a per-line `evalText`. Skip lines with empty
     `pv`. Returns `[]` for terminal/empty evals.
   - **Eval-text convention is White-POV, used directly** (no side-to-move flip):
     `line.scoreCp`/`line.mate` are already White-POV (see `toEngineEval`,
     `engine.service.ts:179-213`). Format like the move list's `formatEval`
     (`MoveList.tsx:36`): `+1.4` / `−2.3` for centipawns; for mate, `M3` (White mating)
     vs `−M3` (Black mating) from the sign of `line.mate`. This keeps arrow chips
     consistent with the move list and the (fixed) eval bar.
   - `ArrowSpec = { from: string; to: string; rank: 1 | 2 | 3; evalText: string }`.

2. **`apps/web/src/components/board/BestMoveArrows.tsx`** (presentational)
   - Props: `arrows: ArrowSpec[]`, `orientation: Orientation`.
   - Renders, per spec: a line + arrowhead + an eval chip near the target square, styled
     by rank (below). Uses `squareToXY`. Honors `prefers-reduced-motion` (snap vs a
     ~120ms fade-in; no layout-property animation).
   - Pure function of props; no store access.

3. **`apps/web/src/hooks/useBestMoveArrows.ts`** (the brain)
   - Reads `currentFen` (selector), `arrowsEnabled`, `coach.mode`, and `agentFen`.
   - **Gates** (return `[]`): `!arrowsEnabled`, or `coach.mode !== "idle"`, or
     `agentFen != null` (the board is showing an agent-pushed off-game variation). This is
     the "yield to agent/coach" rule. Note: `agentFen` is only set when the agent pushes a
     *raw* off-game position; when the agent navigates to an in-game ply it clears
     `agentFen` and is indistinguishable from user navigation, so arrows show there (a ply
     position is fine to annotate). That is the intended, implementable boundary.
   - Otherwise **cache-first**: if `arrowEvalByFen[fen]` exists, use it. On miss, debounce
     ~250ms, then `api.analyzePosition({ fen, multipv: 3, depth: 14 })`, and
     `setArrowEval(fen, result)`. Dedupe in-flight requests per FEN. On error (e.g. 503
     no Stockfish) → no arrows, silent (the board must never break).
   - Returns `ArrowSpec[]` via `bestMoveArrows(arrowEvalByFen[fen])`.
   - Correctness note: results are keyed by FEN, so a late/slow response can never paint
     the wrong position — the selector always reads the *current* FEN's entry.

4. **`apps/web/src/store.ts`** (state)
   - `arrowEvalByFen: Record<string, EngineEval>` + `setArrowEval(fen, eval)`.
   - `arrowsEnabled: boolean` (default `true`, hydrated from + written to localStorage)
     + `toggleArrows()`.
   - Reset `arrowEvalByFen` on `setGame` (alongside the existing `evalByPly` reset) to
     avoid unbounded growth across games. (`arrowsEnabled` persists across games.)

5. **`apps/web/src/components/board/BoardControls.tsx`** (toggle)
   - Add a toggle button (arrow-style lucide icon), `aria-pressed={arrowsEnabled}`,
     active state tinted ember. Sits with the other board controls.

6. **`apps/web/src/components/board/BoardPanel.tsx`** (composition)
   - Wrap the board in a `relative` container; render `<BestMoveArrows>` as an
     `absolute inset-0 pointer-events-none` overlay when the hook returns arrows.
   - Normal review: overlay draws top 3; library `arrows` prop empty.
   - Coach reveal: keep the existing single library arrow (restyled from `#15803d` green
     to ember); overlay hidden by the gate.
   - Coach question: dragging, no arrows (unchanged).
   - Replace the green color constants with ember tokens.

7. **`apps/web/src/components/board/EvalBar.tsx`** (bonus: any-position eval + sign fix)
   - When `evalByPly[currentPly]` is absent, fall back to `arrowEvalByFen[currentFen]` so
     the bar shows an eval in any position too. Same data; reinforces the "one honest
     source of truth" principle. The bar and the #1 arrow then agree.
   - **Sign fix (see "Pre-existing issue" below):** drop the `* sign` side-to-move flip so
     the bar reads White-POV directly, matching the move list and both eval sources.

### Data flow

```
currentFen changes
   │
   ├─ useBestMoveArrows gates (toggle off / coach / agent) → []
   │
   └─ cache hit?  ── yes ─→ bestMoveArrows(cached) ─→ ArrowSpec[]
                  └─ no  ─→ debounce 250ms ─→ analyzePosition({fen, multipv:3, depth:14})
                                            ─→ setArrowEval(fen, result)
                                            ─→ selector rebuilds ArrowSpec[]
   │
   └─ BestMoveArrows overlay renders lines + heads + eval chips
```

The server eval-cache (keyed by `fen,depth,multipv,engine`) makes revisited positions
instant.

## Pre-existing issue to resolve: EvalBar sign

`EvalBar.tsx` (currently modified/uncommitted) computes:

```ts
const sign = stm === "w" ? 1 : -1;
const cp   = line.scoreCp != null ? line.scoreCp * sign : null;
const mate = line.mate    != null ? line.mate    * sign : null;
```

Its comment claims "engine scores are reported from the side-to-move's perspective." That
is **not true** of the data it consumes: `evalByPly` is filled from `MoveEval.scoreCpAfter`
(`ImportDialog.tsx:539`), which is **White-POV** (`analysis.service.ts:55,148`), exactly
like the move list — which displays it with no flip. Multiplying a White-POV value by the
side-to-move sign **inverts the eval for every black-to-move position** (bar jumps to the
wrong side, readout sign flipped).

This blocks the eval-bar fallback bonus (which feeds White-POV `arrowEvalByFen` through the
same code path). **Fix:** remove the `* sign` flip; read `scoreCp`/`mate` as White-POV
directly. Add a regression test asserting the bar fill + readout for a known black-to-move
position. This is a small, in-scope correction to code this feature touches; called out
explicitly because it lives in the user's uncommitted working tree.

## Visual specification

From the approved mockup and `DESIGN.md` (coordinates in the 0–8 SVG space; widths are
stroke widths in those units, ~0.09–0.14):

| Rank | Color (token) | OKLCH | Width | Opacity |
|---|---|---|---|---|
| 1 (best) | ember | `oklch(0.63 0.14 48)` | ~0.14 | 0.95 |
| 2 | ember-soft | `oklch(0.72 0.10 55)` | ~0.11 | 0.72 |
| 3 | muted | `oklch(0.70 0.006 60)` | ~0.09 | 0.55 |

- **Eval chip:** Plex Mono, the line's eval text, background `ink-elevated`, 1px border in
  the arrow's color, positioned at the target square. This is what makes rank readable
  with the color channel off (rank = width + number + lightness, never hue alone) —
  satisfying the `DESIGN.md` Glyph-First / colorblind-safe rule.
- **Motion:** ~120ms ease-out fade-in on appearance; snap under `prefers-reduced-motion`.
  No animation of layout properties.

## Edge cases

- **No Stockfish (503):** no arrows, silent; board unaffected.
- **Terminal position** (checkmate/stalemate): `lines` empty / no legal best → no arrows.
- **Fewer than 3 lines:** render as many as exist.
- **Promotions:** `pv[0]` like `e7e8q` → `from`/`to` = first 4 chars (matches existing
  `bestMoveArrow`).
- **Rapid stepping:** debounce + FEN-keyed cache; stale responses can't mispaint.
- **Flip:** overlay re-maps coordinates via `orientation`.
- **Unbounded cache:** `arrowEvalByFen` cleared on new game load.

## Testing

- **`lib/arrows.test.ts`:** `squareToXY` for both orientations; `bestMoveArrows` for a
  normal 3-line eval, a mate line (`M3`, correct sign), fewer than 3 lines, empty lines,
  and promotion UCI.
- **`store.test.ts`:** `toggleArrows` flips + persists; `setArrowEval` stores by FEN;
  `setGame` clears `arrowEvalByFen`.
- **`useBestMoveArrows` (with mocked `api` + fake timers):** gating (toggle off → `[]`;
  coach mode → `[]`; agent-driven → `[]`); cache-first (no fetch when cached); debounce +
  dedupe (one fetch for rapid FEN changes); error → `[]`.
- **`EvalBar` test:** White-POV sign is correct for a **black-to-move** position (the
  regression test for the sign fix), and the bar falls back to `arrowEvalByFen` when
  `evalByPly` is empty.
- Optional `BoardPanel` render test: overlay shows N arrows for a given store state.

## Out of scope / future

- Keyboard shortcut for the toggle (would be the first global key handler).
- User-configurable arrow count or depth.
- Hover-to-preview a candidate line on the board.
