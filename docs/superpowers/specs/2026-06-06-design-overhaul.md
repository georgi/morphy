# Design overhaul: the Lamplit Study, realized

**Status:** Approved (user-supplied mockup), building via phased workflow
**Date:** 2026-06-06
**Register:** product · **Visual system:** `DESIGN.md` (this overhaul wires it into the app)

## Goal

Implement the supplied mockup: turn the stock-gray app into the warm-dark "Lamplit
Study" from `DESIGN.md`, and restructure the right side into a review surface
(**Game header → Key Moments → Moves → Advantage**), keeping the agent chat as a third
collapsible pane.

## Decisions (from the user)

| Question | Decision |
|---|---|
| Chat panel | **Keep a 3rd collapsible chat pane.** Layout becomes board │ review-info │ chat. |
| Key Moments text | **Agent-generated prose**, with a deterministic templated fallback so it always renders (and works with no Pi credentials). |
| Execution | **Phased workflow.** |
| Board pieces | Keep react-chessboard's default piece set (a pixel-exact custom set is out of scope); restyle squares + coordinates only. |
| Theme toggle | Light / dark (sun/moon) to match the mockup; keep `system` reachable but the bar shows two icons. |

## Phase 1 — Foundation

### 1a. Wire DESIGN.md into `apps/web/src/index.css`

Replace the stock shadcn `:root` (light) and `.dark` token blocks with the `DESIGN.md`
palette. Dark is primary. Keep every existing token **name** (shadcn variables are consumed
across the app); only change values. Add the new functional/board tokens in the `@theme
inline` block and the `:root`/`.dark` blocks.

**Dark (`.dark`, primary):**

```
--background: oklch(0.17 0.006 60);
--foreground: oklch(0.96 0.004 75);
--card: oklch(0.205 0.006 60);          --card-foreground: var(--foreground);
--popover: oklch(0.24 0.006 60);        --popover-foreground: var(--foreground);
--primary: oklch(0.63 0.14 48);         --primary-foreground: oklch(0.16 0.01 50);
--secondary: oklch(0.26 0.006 60);      --secondary-foreground: var(--foreground);
--muted: oklch(0.26 0.006 60);          --muted-foreground: oklch(0.70 0.006 60);
--accent: oklch(0.26 0.006 60);         --accent-foreground: var(--foreground);
--destructive: oklch(0.58 0.20 25);
--border: oklch(0.30 0.006 60);
--input: oklch(0.30 0.006 60);
--ring: oklch(0.63 0.14 48);
--chart-1: oklch(0.63 0.14 48);   /* ember */
--chart-2: oklch(0.70 0.13 165);  /* brilliant teal */
--chart-3: oklch(0.80 0.12 90);   /* inaccuracy yellow */
--chart-4: oklch(0.67 0.16 50);   /* mistake orange */
--chart-5: oklch(0.58 0.20 25);   /* blunder red */
--sidebar: oklch(0.205 0.006 60); --sidebar-foreground: var(--foreground);
--sidebar-primary: oklch(0.63 0.14 48); --sidebar-primary-foreground: oklch(0.16 0.01 50);
--sidebar-accent: oklch(0.26 0.006 60); --sidebar-accent-foreground: var(--foreground);
--sidebar-border: oklch(0.30 0.006 60); --sidebar-ring: oklch(0.63 0.14 48);
```

**Light (`:root`, warm paper):**

```
--background: oklch(0.97 0.005 75);
--foreground: oklch(0.22 0.006 60);
--card: oklch(0.99 0.003 75);           --card-foreground: var(--foreground);
--popover: oklch(0.99 0.003 75);        --popover-foreground: var(--foreground);
--primary: oklch(0.58 0.15 45);         --primary-foreground: oklch(0.99 0.004 75);
--secondary: oklch(0.95 0.006 70);      --secondary-foreground: var(--foreground);
--muted: oklch(0.95 0.006 70);          --muted-foreground: oklch(0.50 0.006 60);
--accent: oklch(0.95 0.006 70);         --accent-foreground: var(--foreground);
--destructive: oklch(0.52 0.20 25);
--border: oklch(0.90 0.006 70);
--input: oklch(0.90 0.006 70);
--ring: oklch(0.58 0.15 45);
--chart-1: oklch(0.58 0.15 45); --chart-2: oklch(0.55 0.12 165); --chart-3: oklch(0.62 0.13 90);
--chart-4: oklch(0.58 0.17 48); --chart-5: oklch(0.52 0.20 25);
--sidebar*: mirror light surfaces/borders.
```

**New shared tokens (both themes; define in `:root` + `.dark` and expose via `@theme inline`
as `--color-*`):**

```
--board-light  (dark: oklch(0.46 0.018 60), light: oklch(0.80 0.02 70))
--board-dark   (dark: oklch(0.35 0.015 55), light: oklch(0.62 0.025 65))
--eval-white   (dark: oklch(0.93 0.006 75), light: oklch(0.30 0.006 60))   /* eval-bar fill = side-to-show advantage */
--eval-track   (dark: oklch(0.30 0.006 60), light: oklch(0.85 0.006 70))
--ember-soft   (dark: oklch(0.72 0.10 55),  light: oklch(0.66 0.12 50))
--class-brilliant  → chart-2
--class-inaccuracy → chart-3
--class-mistake    → chart-4
--class-blunder    → chart-5
```

Keep `#000`/`#fff` out; every neutral carries the warm tint. Never reintroduce stock gray.

### 1b. Shared contract (`packages/shared/src/index.ts`)

Add:

```ts
export interface KeyMoment {
  ply: number;
  moveNumber: number;
  color: Color;                 // side that moved
  san: string;                  // e.g. "Bg4"
  classification: MoveClassification;   // inaccuracy | mistake | blunder | ...
  scoreCpAfter: number | null;  // White-POV
  evalText: string;             // White-POV readout, e.g. "+0.9"
  isTurningPoint: boolean;      // the single decisive moment
  description: string;          // coach prose (agent) or templated fallback
}
export interface KeyMomentsRequest { gameId: string; }
```

Rebuild `@chess/shared` after editing.

## Phase 2 — Server: Key Moments (`apps/server/src`)

New `analysis/key-moments.service.ts` + endpoint `POST /api/analysis/key-moments` in
`api/analysis.controller.ts` (wire providers in the owning module).

- **Selection (pure, tested):** from a game's `MoveEval[]`, take moves classified
  `inaccuracy|mistake|blunder`, rank by severity then `cpLoss`, cap at **5**. The single
  largest White-win-probability swing (use the existing win-prob mapping or `cpLoss`) is the
  `isTurningPoint`. `evalText` is White-POV via the shared formatter convention
  (`+0.9` / `−2.3` / `M3`). Returns `KeyMoment[]` with a **templated** `description`
  (e.g. ``"Inaccuracy: a 0.9-pawn swing. {bestMove} held the balance."``).
- **Agent enrichment (best-effort):** attempt to replace `description` with coach prose via
  a one-shot Pi generation (reuse `loadPiSdk`/`createAgentSession`, no tools, a JSON-output
  system prompt; collect the streamed text, parse a `[{ply, description}]` array, merge by
  ply). **On any error or missing credentials, keep the templated descriptions** — the
  endpoint must never fail because the agent is unavailable. Time-box the call.
- 400 on missing/blank `gameId`; 404 when the game isn't stored or has no analysis (or
  return `[]` when unanalyzed — pick one and document it; prefer `[]` so the client can show
  an "analyze to see key moments" state).
- Tests: selection ordering, turning-point pick, cap at 5, templated text, empty analysis.

## Phase 3 — Client components (`apps/web/src`)

All consume the new tokens (no raw hex/zinc; use `bg-card`, `text-muted-foreground`,
`text-primary`, and the `--class-*`/`--board-*` tokens via Tailwind `[color:var(--…)]` or
added theme colors). New files unless noted.

1. **`components/review/GameHeader.tsx`** — players with ○/● color dots + ratings
   (`headers.white`/`black`, `headers.whiteElo`/`blackElo` via the `[k: string]` index),
   result badge (`headers.result`), then `opening · site, date`
   (`eco`/`opening`, `event`/`site`, `date`). Graceful when fields are missing.
2. **`components/review/KeyMoments.tsx`** — section header `KEY MOMENTS {count}`; one card per
   moment: glyph (`?!`/`?`/`??`) in the `--class-*` color, `{moveNumber}…{san}`, the
   uppercase label (INACCURACY/MISTAKE/BLUNDER), a `TURNING POINT` pill for the turning
   point, the White-POV eval (right), and the `description`. The blunder/turning-point card
   gets a `--class-blunder` full border (never a side-stripe). Fetch via TanStack Query
   (`api.keyMoments(gameId)`); empty/loading/needs-analysis states.
3. **`lib/api.ts`** — add `keyMoments(gameId)` POST helper (only this agent touches api.ts).
4. **`components/moves/MoveList.tsx`** — replace raw `text-orange-500`/`text-yellow-600`
   classification colors with the `--class-*` tokens; keep glyphs + the `formatScore` eval.
5. **`components/chart/AdvantageChart.tsx`** — recolor area/curve/dots/cursor to tokens
   (`--eval-white`/`--foreground`/`--class-*`/`--primary` cursor), and add a compact legend
   row matching the mockup: `▲ !`(brilliant) `○ ?!`(inaccuracy) `◆ ??`(blunder). Replace its
   local `formatScore` with the shared `lib/eval.ts` one. Keep scrub/hover behavior.
6. **`components/board/EvalBar.tsx`** — swap `bg-zinc-800`/`bg-zinc-100` for
   `--eval-track`/`--eval-white`; keep the (already White-POV) logic.
7. **`components/board/BoardPanel.tsx`** — pass warm board square colors to react-chessboard
   (`--board-light`/`--board-dark`, resolved to values), enable coordinates, keep the
   `BestMoveArrows` overlay aligned. Ember (`--primary`) reveal arrow stays.
8. **`components/board/BoardControls.tsx`** — bottom bar per mockup: first/prev, `n / total`,
   next/last, an ember-outline **flip** button, and **Next mistake** (warning triangle).
9. **`components/theme/ThemeToggle.tsx`** — sun/moon to match the mockup (two-state feel),
   active state tinted; keep accessible.

## Phase 4 — Compose: `apps/web/src/views/AnalysisView.tsx` (single owner)

- **Top bar:** ember square logo + "Chess Analyzer", a `Reviewing · {opening}` subtitle
  (from `game.headers.opening`/eco), then Library, Import, **Analyze game** (ember-filled
  `variant="default"`), and the theme toggle.
- **Three resizable panes:** `BoardPanel` │ **ReviewPanel** │ `ChatPanel` (chat collapsible /
  smaller default). The ReviewPanel stacks: `GameHeader`, `KeyMoments`, a `MOVES` section
  (`MoveList`, scrollable), and a pinned `ADVANTAGE` section (`AdvantageChart`).
- Mount the new components; remove the old inline "Moves" header/chart arrangement.

## Phase 5 — Verify + Review

- Verify: `pnpm --filter @chess/shared build`; `pnpm --filter web typecheck && pnpm --filter
  web test`; `pnpm --filter server build` + the new key-moments unit spec. Fix to green. Do
  not start dev servers.
- Review: adversarial pass vs this spec — token coverage (no stock gray / raw hex left in
  touched files), colorblind-safe classifications (glyph + token, not hue alone), 3-pane
  layout + chat retained, Key Moments fallback works without the agent, no banned patterns
  (side-stripe borders, gradient text, glassmorphism).

## Out of scope

- Custom piece artwork. Live multi-move "key moment" navigation animations. Persisting chat
  pane collapse state. Real per-move "bishop pair"-level prose without the agent (fallback is
  templated).
