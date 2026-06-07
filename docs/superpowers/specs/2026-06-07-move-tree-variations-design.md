# Move tree & branches (play moves to explore variations)

**Status:** Design approved, ready for implementation plan
**Date:** 2026-06-07
**Register:** product (see `PRODUCT.md`) · **Visual system:** `DESIGN.md`

## Problem

The board is read-only outside coach mode, and the move list is a flat, linear
two-column list. You can scrub through the game but you cannot *play* a move to
ask "what if?". A real analysis board lets you drag a piece in any position; if
that move differs from what was played, it opens a **variation**, and the move
list becomes a **tree** — exactly the Lichess model in the reference screenshot.

Today:

- `Game.moves` is a flat `Move[]` (`packages/shared/src/index.ts`); the store
  tracks a single `currentPly` index (`store.ts`), and `currentFen` derives the
  board position from `game.moves[currentPly - 1].fenAfter` (`store.ts:397`).
- The board only accepts drags during a coach review (`BoardPanel.tsx:124`,
  `onCoachDrop`); normal mode is `allowDragging: false` (`BoardPanel.tsx:148`).
- `MoveList` renders the flat plies as White/Black rows, navigating by ply
  (`MoveList.tsx`).

## Goals

1. **Drag a piece in any position to play a move.** Always available in normal
   mode (no separate "explore" toggle) — like Lichess.
2. **New moves create branches.** A move that isn't the existing continuation
   opens a variation; replaying the existing continuation just navigates to it.
3. **The move list becomes a tree** rendered Lichess-style: the mainline as
   two-column rows, variations as inset inline runs, nested and indented; any
   node clickable; active node highlighted and auto-scrolled.
4. The **eval bar and best-move arrows follow you into variations** (they are
   already FEN-keyed — see below), so exploring a line gives live engine feedback.

## Non-goals (v1)

Decided during brainstorming. The tree model is shaped so each drops in later.

- **Delete / promote a variation, right-click context menu** — out. ("Add +
  navigate only.")
- **Comments / NAGs / annotations** — out.
- **Underpromotion picker** — out; promotions auto-queen (matches `onCoachDrop`).
- **Server persistence.** Variations are **ephemeral**, client-only, reset on
  game switch and lost on reload. No changes to `@chess/shared`, the server, or
  PGN serialization.
- **Advantage chart / Key Moments in variations** — they stay mainline-only.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Lifetime of variations | **Ephemeral, client-only.** No server/shared-type changes; reset on `setGame`. |
| Tree operations | **Add + navigate only.** No delete/promote/context-menu/comments yet. |
| Board draggable when? | **Always in normal mode** (gated only by coach mode / agent-driven board), no toggle. |
| Promotion | **Auto-queen** for v1 (underpromotion later). |
| Eval surfaces in variations | **Eval bar + arrows follow** (FEN-keyed, free). **Advantage chart + Key Moments stay mainline.** |
| Data model | **Approach 2 — unified node tree, derived selectors** (below). |

## Approaches considered

**Approach 1 — Layered variations.** Keep flat `game.moves` + `currentPly`; add
a *separate* variation tree with a hybrid cursor (`{onMainline, ply}` | `{nodeId}`).
Mainline code untouched, but two parallel models, an awkward cursor, and a
MoveList that must interleave both. Rejected.

**Approach 2 — Unified node tree, derived selectors (chosen).** One tree built at
game load: a root (start position) plus a mainline spine generated from
`game.moves`. The cursor becomes a single `currentNodeId` — the store's
`currentPly` *field is removed* (one source of truth). What `currentPly` gave its
readers is split into two derived selectors so each consumer gets what it
actually needs:

- `currentNode(state)` → the active `MoveNode`. `EvalBar` uses its `mainline`
  flag to decide whether a mainline eval even applies (see below).
- `currentMainlinePly(state)` → the current node's ply if it's on the mainline,
  else the ply of its **nearest mainline ancestor** (the branch point). Always a
  number. Feeds the cursor/counter/agent-ply consumers.

This split is the keystone: in a variation, `EvalBar` finds no mainline eval and
falls through to the **existing FEN-keyed `arrowEvalByFen`** fallback, while the
advantage-chart cursor, ply counter, and agent message still have a sensible
mainline ply (the branch point). Clean Lichess model; extends naturally to
promote/delete/comments.

**Approach 3 — Refactor the `Game` type into a tree (server included).**
Contradicts the ephemeral decision; huge blast radius. Rejected.

## Why the eval surfaces are nearly free

Both the eval bar and the best-move arrows already resolve their evaluation from
the **current FEN**, not just the ply:

- `EvalBar.tsx:22` — `evalByPly[currentPly] ?? arrowEvalByFen[currentFen(s)]`.
- `useBestMoveArrows.ts:33` — reads `arrowEvalByFen[currentFen]`, fetching a
  debounced MultiPV-3/depth-14 eval on a miss and caching it by FEN.

So once `currentFen` returns a variation node's position, the arrows fetch/draw
for that line automatically. The eval bar needs one precise tweak: it must look
up a mainline eval **only when the current node is on the mainline**, otherwise
at a branch point it would surface the wrong position's eval. Hence `EvalBar`
reads `currentNode(s).mainline ? evalByPly[node.move.ply] : undefined`, then the
`arrowEvalByFen[currentFen]` fallback — so a variation always shows its own
FEN-keyed eval.

## Architecture

### Data model (in the store, ephemeral)

```ts
interface MoveNode {
  id: string;                 // stable unique id
  parentId: string | null;    // null only for the root
  move: Move | null;          // the move leading INTO this node (null at root)
  fen: string;                // position AT this node (root: game.startFen)
  children: string[];         // children[0] = mainline / primary continuation
  mainline: boolean;          // on the original game spine?
}
```

`Move` keeps its existing shape (`ply, moveNumber, color, san, uci, fenBefore,
fenAfter`); a variation node fills all fields too (ply = parent depth + 1,
moveNumber/color derived from side to move), so `MoveList` renders mainline and
variation nodes uniformly.

### Units

1. **`apps/web/src/lib/moveTree.ts`** (pure, unit-tested) — the tree algebra, no
   React/store. Functions:
   - `buildTree(game: Game): { nodesById: Record<string, MoveNode>; rootId: string }`
     — root from `game.startFen`, then a mainline chain from `game.moves` (each
     `mainline: true`, `children[0]` pointing to the next).
   - `applyMove(nodesById, nodeId, drop): { nodesById, nodeId, created } | null`
     — validate `from→to` (auto-queen) with chess.js against the node's FEN;
     return `null` if illegal. If a child with the same UCI exists, return it
     (`created: false`, no mutation). Otherwise create a child `MoveNode`
     (`mainline: false`), append to `children`, and return it (`created: true`).
     Returns a **new** `nodesById` (immutable update) for Zustand.
   - `mainlineNodeAtPly(nodesById, rootId, n)` — walk `children[0]` n times;
     used by `gotoPly`.
   - `lineToLeaf(nodesById, nodeId)` — follow `children[0]` to the leaf (for
     "last").
   - Ids: a module-local incrementing counter (`n1`, `n2`, …). **Not**
     `crypto.randomUUID` — keeps `buildTree` output deterministic for tests and
     avoids `Math.random`/uuid in pure code. Counter resets per `buildTree`.

2. **`apps/web/src/store.ts`** (state + navigation)
   - New slice: `nodesById: Record<string, MoveNode>`, `rootId: string`,
     `currentNodeId: string`.
   - `setGame(game)`: `buildTree(game)`, set `currentNodeId = rootId`, reset the
     tree alongside the existing `evalByPly`/`arrowEvalByFen`/`agentFen` resets.
   - `playMove(drop)`: `applyMove` from `currentNodeId`; on success set the new
     `nodesById` + `currentNodeId` and clear `agentFen`; on `null` (illegal) no-op
     and signal failure to the caller (so the board snaps the piece back).
   - `gotoNode(id)`: set `currentNodeId`, clear `agentFen`.
   - Navigation redefined in tree terms (same buttons/keys):
     - `nextPly` → `children[0]` of the current node, if any.
     - `prevPly` → `parentId`.
     - `gotoPly(0)` → `rootId`; `gotoPly(n)` → `mainlineNodeAtPly(…, n)` (used by
       KeyMoments / AdvantageChart / next-mistake — mainline jumps only).
     - first → `rootId`; last → `lineToLeaf(currentNodeId)`.
   - The `currentPly` **field is removed**; replaced by exported selectors
     (same pattern as the existing `currentFen` selector function):
     - `currentFen(state)`: `agentFen` override wins (unchanged); else
       `nodesById[currentNodeId].fen`.
     - `currentNode(state)`: `nodesById[currentNodeId]`.
     - `currentMainlinePly(state)`: current node's ply if `mainline`, else the ply
       of the nearest mainline ancestor (walk `parentId` until `mainline`); root → 0.
       Always a number.
   - `setBoardFromAgent(fen, ply)`: when `ply !== undefined`, navigate to the
     mainline node at that ply (`mainlineNodeAtPly`) and clear `agentFen`;
     otherwise set `agentFen` (overrides `currentFen`, cursor untouched) — same
     observable behavior as today, retargeted onto the tree.
   - `agentFen` interplay otherwise unchanged: all tree navigation clears it. When
     `agentFen` is set the board is not draggable (see below), so a move is never
     played from an off-tree position.

3. **`apps/web/src/components/board/BoardPanel.tsx`** (free-move on the board)
   - In **normal** mode set `allowDragging: true` and `onPieceDrop: onFreeMoveDrop`.
     Keep coach `question` (drag → `onCoachDrop`) and `reveal` (no drag) exactly
     as today. Disable dragging while `agentFen != null` (same yield rule the
     arrows use).
   - `onFreeMoveDrop({ sourceSquare, targetSquare })`: call `store.playMove({from,
     to})`. Return its success boolean so react-chessboard snaps back on illegal
     moves. No SAN/legality logic here — that lives in `applyMove`.

4. **`apps/web/src/components/moves/MoveList.tsx`** (flat list → tree)
   - Read `nodesById`, `rootId`, `currentNodeId`, `gotoNode`, plus `analysis`
     (for the mainline classification glyph + eval, keyed by mainline ply).
   - **Mainline** renders as today's two-column White/Black rows (reuse `toRows`
     over the mainline nodes' `move`s, so glyphs/evals/colors are unchanged).
   - **Variations:** a node whose `children.length > 1` has alternatives to
     `children[0]`. After the mainline row carrying that node's move, render an
     **inset block** (tinted background, left border) containing each variation
     (`children[1..]`) rendered by a recursive `renderVariation(nodeId)` as an
     **inline run** of move tokens with move numbers — `29…b5 30.b3 bxc4 31.bxc4`
     — black-first moves prefixed `N…`. Nested variations recurse with deeper
     indent. Variation nodes show no eval chip (mainline-only analysis).
   - Active node (`node.id === currentNodeId`) gets the ember/accent highlight
     (Lamplit Study tokens, replacing Lichess blue) and `aria-current`; it
     auto-scrolls into view (keep the existing `activeRef` + `scrollIntoView`).
   - Any token is a button → `gotoNode(id)`.
   - Empty state (no game / no moves) unchanged.

5. **`apps/web/src/components/board/EvalBar.tsx`** — replace the
   `s.evalByPly[s.currentPly]` lookup with the node-aware rule:
   `currentNode(s).mainline ? s.evalByPly[node.move.ply] : undefined`, then the
   `arrowEvalByFen[currentFen(s)]` fallback. `data-ply` reads `currentMainlinePly`.
   No visual change on the mainline.

6. **`apps/web/src/components/board/BoardControls.tsx`** — counter reads
   `currentMainlinePly`; `atStart`/`atEnd` and the first/prev/next/last disabled
   states come from the tree (`atStart = currentNodeId === rootId`; `next`/last
   disabled when the current node has no `children[0]`). `nextMistake` runs from
   `currentMainlinePly` against the mainline `analysis` → `gotoPly`.

7. **`apps/web/src/components/chart/AdvantageChart.tsx`** — cursor X reads
   `currentMainlinePly` (sits at the branch point while exploring a variation);
   clicking/dragging still calls `gotoPly`. **`KeyMoments.tsx`** is unchanged
   (it only calls `gotoPly`).

8. **`apps/web/src/components/chat/ChatPanel.tsx`** — send
   `ply: currentMainlinePly` (was `s.currentPly`). In a variation this is the
   branch-point ply, so the agent reasons about the nearest mainline position —
   a known v1 limitation (the agent is not variation-aware; see Out of scope).

9. **`apps/web/src/hooks/useBoardShortcuts.ts`** — `←/→/Home/End` already call
   `prevPly/nextPly/gotoPly(0)/gotoPly(lastPly)`; with those redefined on the tree
   they keep working. `lastPly` for `End` becomes "leaf of the current line"
   (follow `children[0]`). The `m` next-mistake uses `currentMainlinePly`.
   `f`/`a` unchanged. Still inert during coach mode.

### Data flow

```
drag piece (normal mode)
   │
   └─ onFreeMoveDrop → store.playMove({from,to})
          │
          ├─ applyMove illegal ───────────────→ false → piece snaps back
          ├─ move == children[?] (exists) ────→ gotoNode(existing), created:false
          └─ new move ───────────────────────→ append child (mainline:false),
                                                gotoNode(new), created:true
   │
   └─ currentNodeId changes → currentFen = node.fen
          ├─ EvalBar: node.mainline ? evalByPly[node.ply] : — → arrowEvalByFen[fen]
          ├─ useBestMoveArrows: fetch/draw top 3 for fen (debounced, cached)
          └─ MoveList: highlight currentNodeId, auto-scroll
```

## Edge cases

- **Replaying the existing move** (mainline or an existing variation): navigates
  to that child, no duplicate node (`applyMove` UCI match).
- **Move past the end of the game:** a continuation off the last mainline node —
  a new node with `mainline: false`. Fine; the mainline-only analysis simply has
  nothing for it.
- **Branching mid-game** (play a move at ply 10 when ply 11 already exists and
  differs): creates a variation under node 10. This is the core "new moves create
  branches" behavior.
- **Illegal drop:** `applyMove` → `null` → `playMove` no-op → `false` → snap back.
- **Promotion:** auto-queen (`promotion: "q"`), matching `onCoachDrop`.
- **agent-driven board / coach mode:** dragging disabled (no free moves); tree
  navigation clears `agentFen`.
- **Flip / orientation:** unaffected — the board renders `currentFen`.
- **Game switch / reload:** tree rebuilt from `game.moves` (or lost on reload) —
  ephemeral by decision.
- **Deep / wide trees:** acceptable for v1; no virtualization (the move list
  already renders the whole game).

## Testing

- **`lib/moveTree.test.ts`** (pure):
  - `buildTree`: root fen = `startFen`; N moves → a mainline chain of N nodes, all
    `mainline:true`, `children[0]` linkage correct, plies/SAN preserved.
  - `applyMove`: legal new move appends a `mainline:false` child and returns
    `created:true`; replaying an existing child returns `created:false` with no
    mutation; an illegal move returns `null`; promotion auto-queens; the returned
    `nodesById` is a new object (immutability).
  - `mainlineNodeAtPly` / `lineToLeaf` walk `children[0]` correctly.
- **`store.test.ts`** (extend):
  - `setGame` builds the tree and sets `currentNodeId = rootId`.
  - `playMove` at the root creates a variation child and moves the cursor;
    `currentFen` returns the new node's fen.
  - `currentMainlinePly`: real ply on a mainline node; the branch-point ply on a
    variation node; 0 at the root.
  - `currentNode(s).mainline` is `false` inside a variation (drives the EvalBar
    fallback).
  - `nextPly`/`prevPly`/`gotoPly(n)`/`gotoNode` move the cursor as specified;
    navigation clears `agentFen`. `setBoardFromAgent(fen, ply)` retargets onto the
    mainline node / sets `agentFen` as specified.
  - Illegal `playMove` is a no-op.
- **`MoveList` render test:** a game with one variation renders the mainline as
  rows plus an inset variation run; clicking a variation token calls `gotoNode`;
  the active node carries `aria-current`.
- **`EvalBar`** (extend): on a variation node (`currentNode.mainline === false`)
  the bar reads from `arrowEvalByFen[currentFen]`, not a stale `evalByPly` entry.

## Out of scope / future

- Delete / promote a variation; right-click context menu.
- Comments, NAGs, move annotations.
- Underpromotion picker.
- **Variation-aware agent chat.** `ChatPanel` sends the branch-point mainline ply,
  so asking the analyst about a variation position reasons about the nearest
  mainline node, not the exact line. Making the agent variation-aware (sending the
  node FEN) is a follow-up.
- Server/PGN persistence of variations (the tree model already mirrors PGN's
  recursive variation structure, so a `treeToPgn` is a clean later addition).
- Virtualized rendering for very large trees.
