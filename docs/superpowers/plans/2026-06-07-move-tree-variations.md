# Move Tree & Branches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the player drag a piece in any position to play a move; new moves open variations and the flat move list becomes a Lichess-style tree, with the eval bar and best-move arrows following into variations.

**Architecture:** A pure `moveTree.ts` module builds a node tree (root + mainline spine from `game.moves`) and applies dropped moves (chess.js-validated, auto-queen) that append child nodes — `children[0]` is the mainline/primary continuation, the rest are variations. The Zustand store swaps its single `currentPly` index for a `currentNodeId` cursor and exposes derived selectors (`currentFen`, `currentNode`, `currentMainlinePly`). Because the eval bar and arrows already resolve eval by **FEN**, they follow into variations for free. The move list rewrites into a recursive tree renderer.

**Tech Stack:** React 19, Zustand 5, react-chessboard 5, chess.js 1.4, Vitest 4 + @testing-library/react, Tailwind v4, TypeScript.

**Spec:** `docs/superpowers/specs/2026-06-07-move-tree-variations-design.md`

**Conventions (read once):**
- Tests are colocated `*.test.ts(x)`, run with Vitest. Run one file: `pnpm -C apps/web test <path>`. Run all: `pnpm -C apps/web test`. Typecheck: `pnpm -C apps/web typecheck`.
- The analyzer store is a singleton; tests reset it in `beforeEach` via `useAnalyzerStore.setState({...})`.
- Imports use the `@/` alias for `apps/web/src` and `@chess/shared` for the contract package.
- Commit after each task. Conventional commit messages.

**Migration strategy (why `currentPly` lingers):** Removing the `currentPly` store field touches six components and three test files at once. To keep every commit green, Tasks 2–9 **keep `currentPly` as a synced scaffolding field** (updated in each nav action to the branch-point ply) while migrating consumers to the new selectors one at a time. Task 10 deletes the field and the last test references. Every task ends with a passing `pnpm -C apps/web typecheck` and the relevant tests.

---

### Task 1: `moveTree.ts` — the pure tree module

**Files:**
- Create: `apps/web/src/lib/moveTree.ts`
- Test: `apps/web/src/lib/moveTree.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/moveTree.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Game } from "@chess/shared";
import {
  buildTree,
  emptyTree,
  applyMove,
  mainlineNodeAtPly,
  lineToLeaf,
  nearestMainlinePly,
} from "./moveTree";

const START_FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** 1. e4 e5 — a two-ply game. */
function makeGame(): Game {
  const fenAfterE4 =
    "rnbqkbnr/pppppppp/8/4P3/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
  const fenAfterE5 =
    "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
  return {
    id: "g1",
    headers: {},
    startFen: START_FEN,
    moves: [
      { ply: 1, moveNumber: 1, color: "w", san: "e4", uci: "e2e4", fenBefore: START_FEN, fenAfter: fenAfterE4 },
      { ply: 2, moveNumber: 1, color: "b", san: "e5", uci: "e7e5", fenBefore: fenAfterE4, fenAfter: fenAfterE5 },
    ],
  };
}

describe("buildTree", () => {
  it("creates a root at startFen plus a mainline chain", () => {
    const game = makeGame();
    const { nodesById, rootId } = buildTree(game);
    const root = nodesById[rootId];
    expect(root.move).toBeNull();
    expect(root.fen).toBe(START_FEN);
    expect(root.mainline).toBe(true);

    const first = nodesById[root.children[0]];
    expect(first.move?.san).toBe("e4");
    expect(first.mainline).toBe(true);
    const second = nodesById[first.children[0]];
    expect(second.move?.san).toBe("e5");
    expect(second.children).toHaveLength(0);
    expect(Object.keys(nodesById)).toHaveLength(3);
  });
});

describe("emptyTree", () => {
  it("is a lone root at the given fen", () => {
    const { nodesById, rootId } = emptyTree(START_FEN);
    expect(Object.keys(nodesById)).toHaveLength(1);
    expect(nodesById[rootId].fen).toBe(START_FEN);
    expect(nodesById[rootId].children).toHaveLength(0);
  });
});

describe("applyMove", () => {
  it("appends a new variation child and returns created:true", () => {
    const game = makeGame();
    const { nodesById, rootId } = buildTree(game);
    // From the root, play 1. d4 (a sibling variation to 1. e4).
    const res = applyMove(nodesById, rootId, { from: "d2", to: "d4" });
    expect(res).not.toBeNull();
    expect(res!.created).toBe(true);
    const node = res!.nodesById[res!.nodeId];
    expect(node.move?.san).toBe("d4");
    expect(node.move?.uci).toBe("d2d4");
    expect(node.move?.ply).toBe(1);
    expect(node.move?.moveNumber).toBe(1);
    expect(node.move?.color).toBe("w");
    expect(node.mainline).toBe(false);
    // The root now has two children; the original mainline is still first.
    expect(res!.nodesById[rootId].children[0]).toBe(nodesById[rootId].children[0]);
    expect(res!.nodesById[rootId].children).toHaveLength(2);
  });

  it("navigates to an existing child instead of duplicating", () => {
    const game = makeGame();
    const { nodesById, rootId } = buildTree(game);
    // Replay the mainline 1. e4 — must return the existing node, no new node.
    const res = applyMove(nodesById, rootId, { from: "e2", to: "e4" });
    expect(res!.created).toBe(false);
    expect(res!.nodeId).toBe(nodesById[rootId].children[0]);
    expect(Object.keys(res!.nodesById)).toHaveLength(3);
  });

  it("returns null for an illegal move", () => {
    const game = makeGame();
    const { nodesById, rootId } = buildTree(game);
    expect(applyMove(nodesById, rootId, { from: "e2", to: "e5" })).toBeNull();
  });

  it("does not mutate the input nodesById", () => {
    const game = makeGame();
    const { nodesById, rootId } = buildTree(game);
    const before = nodesById[rootId].children.length;
    applyMove(nodesById, rootId, { from: "d2", to: "d4" });
    expect(nodesById[rootId].children).toHaveLength(before);
  });

  it("auto-queens a promotion", () => {
    // White pawn on e7, kings placed legally; e7e8 promotes.
    const fen = "4k3/4P3/8/8/8/8/8/4K3 w - - 0 1";
    const tree = emptyTree(fen);
    const res = applyMove(tree.nodesById, tree.rootId, { from: "e7", to: "e8" });
    expect(res!.nodeId).toBeDefined();
    expect(res!.nodesById[res!.nodeId].move?.san).toBe("e8=Q+");
    expect(res!.nodesById[res!.nodeId].move?.uci).toBe("e7e8q");
  });
});

describe("walkers", () => {
  it("mainlineNodeAtPly walks children[0] and clamps", () => {
    const tree = buildTree(makeGame());
    expect(mainlineNodeAtPly(tree, 0)).toBe(tree.rootId);
    const ply1 = mainlineNodeAtPly(tree, 1);
    expect(tree.nodesById[ply1].move?.san).toBe("e4");
    // Past the end clamps to the leaf.
    const leaf = mainlineNodeAtPly(tree, 99);
    expect(tree.nodesById[leaf].move?.san).toBe("e5");
  });

  it("lineToLeaf follows children[0] to the end", () => {
    const tree = buildTree(makeGame());
    expect(tree.nodesById[lineToLeaf(tree.nodesById, tree.rootId)].move?.san).toBe("e5");
  });

  it("nearestMainlinePly returns the node ply on the mainline and the branch point in a variation", () => {
    const tree = buildTree(makeGame());
    const ply1 = mainlineNodeAtPly(tree, 1); // after 1. e4 (mainline, ply 1)
    expect(nearestMainlinePly(tree.nodesById, ply1)).toBe(1);
    // Branch a variation off the root: 1. d4 — its nearest mainline ancestor is the root (ply 0).
    const res = applyMove(tree.nodesById, tree.rootId, { from: "d2", to: "d4" });
    expect(nearestMainlinePly(res!.nodesById, res!.nodeId)).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -C apps/web test src/lib/moveTree.test.ts`
Expected: FAIL — `Failed to resolve import "./moveTree"`.

- [ ] **Step 3: Implement `moveTree.ts`**

Create `apps/web/src/lib/moveTree.ts`:

```ts
// apps/web/src/lib/moveTree.ts — pure variation-tree algebra. No React, no store.
import { Chess } from "chess.js";
import type { Game, Move, Color } from "@chess/shared";

/** One position in the variation tree. `children[0]` is the primary continuation. */
export interface MoveNode {
  id: string;
  parentId: string | null; // null only for the root
  move: Move | null; // the move leading INTO this node (null at the root)
  fen: string; // the position AT this node
  children: string[]; // child node ids; [0] is mainline / primary
  mainline: boolean; // on the original game spine?
}

export interface MoveTree {
  nodesById: Record<string, MoveNode>;
  rootId: string;
}

/** A drag: from/to squares, optional promotion piece (defaults to queen). */
export interface DropInput {
  from: string;
  to: string;
  promotion?: string;
}

export interface ApplyResult {
  nodesById: Record<string, MoveNode>;
  nodeId: string; // node to navigate to (newly created or pre-existing)
  created: boolean; // false when the move matched an existing child
}

// Monotonic id source. Reset at the start of every buildTree/emptyTree so a fresh
// tree has deterministic ids ("n0", "n1", …); applyMove continues the sequence,
// keeping ids unique for the life of that tree. Avoids uuid/Math.random in pure code.
let counter = 0;
function nextId(): string {
  return `n${counter++}`;
}

/** The fullmove number of a position, read from its FEN's 6th field. */
function fullmoveOf(fen: string): number {
  return Number(fen.split(" ")[5]) || 1;
}

/** A tree with just a root at `startFen` — the no-game default. */
export function emptyTree(startFen: string): MoveTree {
  counter = 0;
  const rootId = nextId();
  return {
    rootId,
    nodesById: {
      [rootId]: { id: rootId, parentId: null, move: null, fen: startFen, children: [], mainline: true },
    },
  };
}

/** Build the root + mainline spine from a game's flat move list. */
export function buildTree(game: Game): MoveTree {
  counter = 0;
  const rootId = nextId();
  const nodesById: Record<string, MoveNode> = {
    [rootId]: { id: rootId, parentId: null, move: null, fen: game.startFen, children: [], mainline: true },
  };
  let prevId = rootId;
  for (const move of game.moves) {
    const id = nextId();
    nodesById[id] = { id, parentId: prevId, move, fen: move.fenAfter, children: [], mainline: true };
    nodesById[prevId].children.push(id);
    prevId = id;
  }
  return { nodesById, rootId };
}

/**
 * Validate `drop` against the node's position and either navigate to the matching
 * existing child or append a new variation child. Returns a fresh `nodesById`
 * (immutable update) or `null` when the move is illegal.
 */
export function applyMove(
  nodesById: Record<string, MoveNode>,
  nodeId: string,
  drop: DropInput,
): ApplyResult | null {
  const node = nodesById[nodeId];
  if (!node) return null;

  const chess = new Chess(node.fen);
  let played;
  try {
    played = chess.move({ from: drop.from, to: drop.to, promotion: drop.promotion ?? "q" });
  } catch {
    return null; // chess.js throws on illegal moves
  }

  const uci = played.from + played.to + (played.promotion ?? "");
  const existing = node.children.find((cid) => nodesById[cid].move?.uci === uci);
  if (existing) return { nodesById, nodeId: existing, created: false };

  const id = nextId();
  const parentPly = node.move ? node.move.ply : 0;
  const move: Move = {
    ply: parentPly + 1,
    moveNumber: fullmoveOf(node.fen),
    color: played.color as Color,
    san: played.san,
    uci,
    fenBefore: node.fen,
    fenAfter: chess.fen(),
  };
  const child: MoveNode = { id, parentId: nodeId, move, fen: move.fenAfter, children: [], mainline: false };
  const updated: Record<string, MoveNode> = {
    ...nodesById,
    [id]: child,
    [nodeId]: { ...node, children: [...node.children, id] },
  };
  return { nodesById: updated, nodeId: id, created: true };
}

/** The node `n` mainline plies from the root (follow `children[0]`); clamps at the leaf. */
export function mainlineNodeAtPly(tree: MoveTree, n: number): string {
  let id = tree.rootId;
  for (let i = 0; i < n; i++) {
    const next = tree.nodesById[id].children[0];
    if (next === undefined) break;
    id = next;
  }
  return id;
}

/** Follow `children[0]` from `nodeId` to the end of its line. */
export function lineToLeaf(nodesById: Record<string, MoveNode>, nodeId: string): string {
  let id = nodeId;
  while (nodesById[id].children[0] !== undefined) id = nodesById[id].children[0];
  return id;
}

/** Ply of the node, or — inside a variation — of its nearest mainline ancestor (the branch point). */
export function nearestMainlinePly(nodesById: Record<string, MoveNode>, nodeId: string): number {
  let node: MoveNode | undefined = nodesById[nodeId];
  while (node && !node.mainline) node = node.parentId ? nodesById[node.parentId] : undefined;
  return node?.move ? node.move.ply : 0;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C apps/web test src/lib/moveTree.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/moveTree.ts apps/web/src/lib/moveTree.test.ts
git commit -m "feat(moves): pure variation-tree module (build/apply/walk)"
```

---

### Task 2: Store — tree state, selectors, and tree-based navigation

**Files:**
- Modify: `apps/web/src/store.ts`
- Test: `apps/web/src/store.test.ts`

This task adds the tree (`nodesById`, `rootId`, `currentNodeId`), `playMove`/`gotoNode`, and the `currentNode`/`currentMainlinePly` selectors; reimplements `setGame`/`gotoPly`/`nextPly`/`prevPly`/`setBoardFromAgent` on the tree. It **keeps** the `currentPly` field, now updated in nav actions to the branch-point ply (scaffolding removed in Task 10).

- [ ] **Step 1: Write the failing tests (extend `store.test.ts`)**

In `apps/web/src/store.test.ts`, update the imports to add the new selectors and `emptyTree`:

```ts
import {
  useAnalyzerStore,
  useImportStore,
  currentFen,
  currentNode,
  currentMainlinePly,
  START_FEN,
} from "@/store";
import { emptyTree } from "@/lib/moveTree";
```

Replace the existing `beforeEach` reset block (the `useAnalyzerStore.setState({...})` that sets `currentPly: 0`) with one that resets the tree too:

```ts
beforeEach(() => {
  const t = emptyTree(START_FEN);
  useAnalyzerStore.setState({
    game: null,
    nodesById: t.nodesById,
    rootId: t.rootId,
    currentNodeId: t.rootId,
    currentPly: 0,
    orientation: "white",
    evalByPly: {},
    arrowEvalByFen: {},
    analysis: null,
    chat: [],
    streaming: false,
    agentFen: null,
  });
});
```

Add a new describe block (place it after the existing `describe("navigation", …)`):

```ts
describe("move tree", () => {
  it("setGame builds the tree and parks the cursor at the root", () => {
    const game = makeGame();
    useAnalyzerStore.getState().setGame(game);
    const s = useAnalyzerStore.getState();
    expect(s.currentNodeId).toBe(s.rootId);
    expect(currentFen(s)).toBe(game.startFen);
    expect(currentNode(s).mainline).toBe(true);
  });

  it("playMove at the root opens a variation and moves the cursor onto it", () => {
    const game = makeGame();
    useAnalyzerStore.getState().setGame(game);
    // 1. d4 instead of the mainline 1. e4.
    const ok = useAnalyzerStore.getState().playMove({ from: "d2", to: "d4" });
    expect(ok).toBe(true);
    const s = useAnalyzerStore.getState();
    expect(currentNode(s).move?.san).toBe("d4");
    expect(currentNode(s).mainline).toBe(false);
    expect(currentFen(s)).toBe(currentNode(s).fen);
    // In the variation the branch-point ply is 0 (root).
    expect(currentMainlinePly(s)).toBe(0);
  });

  it("replaying the existing move navigates without duplicating", () => {
    const game = makeGame();
    useAnalyzerStore.getState().setGame(game);
    const before = Object.keys(useAnalyzerStore.getState().nodesById).length;
    const ok = useAnalyzerStore.getState().playMove({ from: "e2", to: "e4" });
    expect(ok).toBe(true);
    const s = useAnalyzerStore.getState();
    expect(Object.keys(s.nodesById)).toHaveLength(before);
    expect(currentNode(s).move?.san).toBe("e4");
    expect(currentMainlinePly(s)).toBe(1);
  });

  it("illegal playMove is a no-op and returns false", () => {
    const game = makeGame();
    useAnalyzerStore.getState().setGame(game);
    const before = useAnalyzerStore.getState().currentNodeId;
    const ok = useAnalyzerStore.getState().playMove({ from: "e2", to: "e5" });
    expect(ok).toBe(false);
    expect(useAnalyzerStore.getState().currentNodeId).toBe(before);
  });

  it("gotoNode moves the cursor and clears agentFen", () => {
    const game = makeGame();
    useAnalyzerStore.getState().setGame(game);
    const s0 = useAnalyzerStore.getState();
    const firstId = s0.nodesById[s0.rootId].children[0];
    useAnalyzerStore.setState({ agentFen: "junk" });
    useAnalyzerStore.getState().gotoNode(firstId);
    const s = useAnalyzerStore.getState();
    expect(s.currentNodeId).toBe(firstId);
    expect(s.agentFen).toBeNull();
    expect(currentMainlinePly(s)).toBe(1);
  });

  it("currentMainlinePly is the real ply on the mainline", () => {
    const game = makeGame();
    useAnalyzerStore.getState().setGame(game);
    useAnalyzerStore.getState().gotoPly(2);
    expect(currentMainlinePly(useAnalyzerStore.getState())).toBe(2);
  });
});
```

The existing `describe("navigation", …)` assertions on `useAnalyzerStore.getState().currentPly` stay as-is and must still pass (the scaffolding keeps `currentPly` accurate on the mainline).

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -C apps/web test src/store.test.ts`
Expected: FAIL — `currentNode`/`currentMainlinePly`/`playMove`/`gotoNode` undefined.

- [ ] **Step 3: Implement the store changes**

In `apps/web/src/store.ts`:

(a) Add imports at the top (below the existing `@chess/shared` import):

```ts
import {
  type MoveNode,
  type MoveTree,
  type DropInput,
  buildTree,
  emptyTree,
  applyMove,
  mainlineNodeAtPly,
  nearestMainlinePly,
} from "@/lib/moveTree";
```

(`lineToLeaf` is not imported here — it is used only in `useBoardShortcuts` in Task 9.)

(b) In the `AnalyzerState` interface, add the tree fields next to `currentPly` (keep `currentPly` for now) and declare the new actions. Find:

```ts
  game: Game | null;
  currentPly: number;
  orientation: Orientation;
```

Replace with:

```ts
  game: Game | null;
  currentPly: number; // scaffolding: branch-point ply, synced from currentNodeId (removed in a later pass)
  nodesById: Record<string, MoveNode>;
  rootId: string;
  currentNodeId: string;
  orientation: Orientation;
```

In the actions section of the interface, find `gotoPly: (n: number) => void;` and add below it:

```ts
  gotoNode: (id: string) => void;
  playMove: (drop: DropInput) => boolean;
```

(c) Initialize the tree in the store creator. Find the start of `create<AnalyzerState>`:

```ts
export const useAnalyzerStore = create<AnalyzerState>((set, get) => ({
  game: null,
  currentPly: 0,
  orientation: "white",
```

Replace with:

```ts
const INITIAL_TREE: MoveTree = emptyTree(START_FEN);

export const useAnalyzerStore = create<AnalyzerState>((set, get) => ({
  game: null,
  currentPly: 0,
  nodesById: INITIAL_TREE.nodesById,
  rootId: INITIAL_TREE.rootId,
  currentNodeId: INITIAL_TREE.rootId,
  orientation: "white",
```

(d) Reimplement `setGame`. Find:

```ts
  setGame: (game) =>
    set({
      game,
      currentPly: 0,
      analysis: game.analysis ?? null,
      evalByPly: {},
      arrowEvalByFen: {},
      agentFen: null,
      // A fresh game ends any review in progress.
      coach: IDLE_COACH,
    }),
```

Replace with:

```ts
  setGame: (game) => {
    const tree = buildTree(game);
    set({
      game,
      nodesById: tree.nodesById,
      rootId: tree.rootId,
      currentNodeId: tree.rootId,
      currentPly: 0,
      analysis: game.analysis ?? null,
      evalByPly: {},
      arrowEvalByFen: {},
      agentFen: null,
      // A fresh game ends any review in progress.
      coach: IDLE_COACH,
    });
  },
```

(e) Replace the navigation actions. Find the `gotoPly`/`nextPly`/`prevPly` block:

```ts
  gotoPly: (n) => set({ currentPly: clampPly(get().game, n), agentFen: null }),

  nextPly: () =>
    set({
      currentPly: clampPly(get().game, get().currentPly + 1),
      agentFen: null,
    }),

  prevPly: () =>
    set({
      currentPly: clampPly(get().game, get().currentPly - 1),
      agentFen: null,
    }),
```

Replace with:

```ts
  gotoNode: (id) => {
    const s = get();
    if (!s.nodesById[id]) return;
    set({ currentNodeId: id, currentPly: nearestMainlinePly(s.nodesById, id), agentFen: null });
  },

  playMove: (drop) => {
    const s = get();
    const res = applyMove(s.nodesById, s.currentNodeId, drop);
    if (!res) return false;
    set({
      nodesById: res.nodesById,
      currentNodeId: res.nodeId,
      currentPly: nearestMainlinePly(res.nodesById, res.nodeId),
      agentFen: null,
    });
    return true;
  },

  gotoPly: (n) => {
    const s = get();
    const id = mainlineNodeAtPly({ nodesById: s.nodesById, rootId: s.rootId }, n);
    set({ currentNodeId: id, currentPly: nearestMainlinePly(s.nodesById, id), agentFen: null });
  },

  nextPly: () => {
    const s = get();
    const next = s.nodesById[s.currentNodeId].children[0];
    if (next === undefined) return;
    set({ currentNodeId: next, currentPly: nearestMainlinePly(s.nodesById, next), agentFen: null });
  },

  prevPly: () => {
    const s = get();
    const parentId = s.nodesById[s.currentNodeId].parentId;
    if (parentId === null) return;
    set({ currentNodeId: parentId, currentPly: nearestMainlinePly(s.nodesById, parentId), agentFen: null });
  },
```

(f) Reimplement `setBoardFromAgent`. Find:

```ts
  setBoardFromAgent: (fen, ply) =>
    set((s) => ({
      currentPly: ply !== undefined ? clampPly(s.game, ply) : s.currentPly,
      // When the agent supplies a matching ply we let the board derive its FEN
      // from the game; otherwise we surface the raw agent FEN directly.
      agentFen: ply !== undefined ? null : fen,
    })),
```

Replace with:

```ts
  setBoardFromAgent: (fen, ply) => {
    const s = get();
    if (ply !== undefined) {
      const id = mainlineNodeAtPly({ nodesById: s.nodesById, rootId: s.rootId }, ply);
      set({ currentNodeId: id, currentPly: nearestMainlinePly(s.nodesById, id), agentFen: null });
    } else {
      set({ agentFen: fen });
    }
  },
```

(g) Delete the now-unused `clampPly` helper (the `function clampPly(...)` block above the store creator) — `mainlineNodeAtPly` handles clamping.

(h) Replace the `currentFen` selector and add the two new selectors. Find:

```ts
export function currentFen(state: AnalyzerState): string {
  if (state.agentFen) return state.agentFen;
  const { game, currentPly } = state;
  if (!game) return START_FEN;
  if (currentPly > 0) return game.moves[currentPly - 1].fenAfter;
  return game.startFen;
}
```

Replace with:

```ts
/** The active tree node (always defined — the store seeds an empty-tree root). */
export function currentNode(state: AnalyzerState): MoveNode {
  return state.nodesById[state.currentNodeId];
}

/**
 * The FEN to render. An agent-pushed off-game FEN wins; otherwise the active
 * node's position (the empty-tree root is the standard start position).
 */
export function currentFen(state: AnalyzerState): string {
  if (state.agentFen) return state.agentFen;
  return currentNode(state).fen;
}

/** Ply of the active node, or — in a variation — its branch-point mainline ply. */
export function currentMainlinePly(state: AnalyzerState): number {
  return nearestMainlinePly(state.nodesById, state.currentNodeId);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C apps/web test src/store.test.ts`
Expected: PASS (new `move tree` block + all existing navigation/setGame/agent tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm -C apps/web typecheck`
Expected: PASS — consumers still read the retained `currentPly` field and the unchanged `currentFen` signature.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/store.ts apps/web/src/store.test.ts
git commit -m "feat(store): variation tree state, playMove/gotoNode, derived selectors"
```

---

### Task 3: Board — drag a piece to play a move

**Files:**
- Modify: `apps/web/src/components/board/BoardPanel.tsx`

No test file exists for `BoardPanel`; the move logic is already covered by `playMove` in `store.test.ts`. Verify via typecheck plus a manual board check.

- [ ] **Step 1: Add the free-move drop handler**

In `apps/web/src/components/board/BoardPanel.tsx`, add a handler next to `onCoachDrop` (after that function):

```ts
/**
 * Normal-mode drop: play `from→to` on the current tree node via the store. An
 * illegal move returns false so react-chessboard snaps the piece back; a legal
 * one appends/navigates a tree node (variation or existing continuation). All
 * validation lives in the store's `playMove` (chess.js, auto-queen).
 */
function onFreeMoveDrop({ sourceSquare, targetSquare }: PieceDropHandlerArgs): boolean {
  if (!targetSquare) return false;
  return useAnalyzerStore.getState().playMove({ from: sourceSquare, to: targetSquare });
}
```

- [ ] **Step 2: Make the board draggable in normal mode**

In `BoardPanel`, read `agentFen` from the store. Find:

```ts
  const coach = useAnalyzerStore((s) => s.coach);
  const arrows = useBestMoveArrows();
```

Replace with:

```ts
  const coach = useAnalyzerStore((s) => s.coach);
  const agentFen = useAnalyzerStore((s) => s.agentFen);
  const arrows = useBestMoveArrows();
```

Then find the normal-mode branch of the `options` memo:

```ts
    // Normal review: the SVG overlay owns the best-move arrows, so the library's
    // `arrows` prop stays empty.
    return {
      ...base,
      position: fen,
      allowDragging: false,
      arrows: [],
    };
  }, [fen, orientation, coach]);
```

Replace with:

```ts
    // Normal review: the SVG overlay owns the best-move arrows (library `arrows`
    // stays empty). The board is draggable so the user can branch off any move;
    // it yields (no dragging) while the agent is driving an off-game position.
    const draggable = agentFen == null;
    return {
      ...base,
      position: fen,
      allowDragging: draggable,
      onPieceDrop: draggable ? onFreeMoveDrop : undefined,
      arrows: [],
    };
  }, [fen, orientation, coach, agentFen]);
```

- [ ] **Step 3: Typecheck**

Run: `pnpm -C apps/web typecheck`
Expected: PASS.

- [ ] **Step 4: Manual verification**

Run the app (`pnpm -C apps/web dev`), load/import a game, and on the board drag a legal move that differs from the mainline. Expected: the piece stays, the board advances to the new position, and the eval bar/arrows update for it. Drag an illegal move → it snaps back.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/board/BoardPanel.tsx
git commit -m "feat(board): drag a piece to play a move / open a variation"
```

---

### Task 4: EvalBar — node-aware eval lookup

**Files:**
- Modify: `apps/web/src/components/board/EvalBar.tsx`
- Test: `apps/web/src/components/board/EvalBar.test.tsx`

- [ ] **Step 1: Update the test (migrate off `currentPly`, add a variation case)**

In `apps/web/src/components/board/EvalBar.test.tsx`:

Update the import:

```ts
import { useAnalyzerStore, currentFen, START_FEN } from "@/store";
import { emptyTree } from "@/lib/moveTree";
```

Replace the `beforeEach` with a tree-aware reset:

```ts
beforeEach(() => {
  const t = emptyTree(START_FEN);
  useAnalyzerStore.setState({
    game: null,
    nodesById: t.nodesById,
    rootId: t.rootId,
    currentNodeId: t.rootId,
    orientation: "white",
    evalByPly: {},
    arrowEvalByFen: {},
    agentFen: null,
  });
});
```

In the "prefers the per-ply eval over the arrow cache" test, drop the now-removed `currentPly` key (the root node is ply 0, so `evalByPly[0]` is what the bar reads on the mainline). Find:

```ts
    useAnalyzerStore.setState({
      currentPly: 0,
      evalByPly: { 0: evalAt(200) }, // +2.0 from the full-game scan
      arrowEvalByFen: { [START_FEN]: evalAt(-200) }, // would read −2.0
    });
```

Replace with:

```ts
    useAnalyzerStore.setState({
      evalByPly: { 0: evalAt(200) }, // +2.0 from the full-game scan (root = ply 0)
      arrowEvalByFen: { [START_FEN]: evalAt(-200) }, // would read −2.0
    });
```

Add a new test at the end of `describe("EvalBar any-position fallback", …)`:

```ts
  it("ignores mainline evalByPly while in a variation, using the FEN cache", () => {
    const game = makeGame();
    useAnalyzerStore.getState().setGame(game);
    // Open a variation (1. d4) and prove the bar reads the variation's FEN eval,
    // not a stale mainline entry that happens to share the branch-point ply.
    useAnalyzerStore.getState().playMove({ from: "d2", to: "d4" });
    const fen = currentFen(useAnalyzerStore.getState());
    useAnalyzerStore.setState({
      evalByPly: { 0: evalAt(-500) }, // mainline ply-0 eval — must be ignored here
      arrowEvalByFen: { [fen]: evalAt(120) }, // the variation's own eval
    });

    render(<EvalBar />);
    expect(screen.getByText("+1.2")).toBeTruthy();
  });
```

Extend the existing contract import to bring in `Game` — change
`import type { EngineEval } from "@chess/shared";` to:

```ts
import type { EngineEval, Game } from "@chess/shared";
```

Add the `makeGame` helper near the top of the file (after `evalAt`):

```ts
function makeGame(): Game {
  const fenAfterE4 = "rnbqkbnr/pppppppp/8/4P3/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
  const fenAfterE5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
  return {
    id: "g1",
    headers: {},
    startFen: START_FEN,
    moves: [
      { ply: 1, moveNumber: 1, color: "w", san: "e4", uci: "e2e4", fenBefore: START_FEN, fenAfter: fenAfterE4 },
      { ply: 2, moveNumber: 1, color: "b", san: "e5", uci: "e7e5", fenBefore: fenAfterE4, fenAfter: fenAfterE5 },
    ],
  };
}
```

- [ ] **Step 2: Run it to verify the new test fails**

Run: `pnpm -C apps/web test src/components/board/EvalBar.test.tsx`
Expected: FAIL — the variation test reads `evalByPly[0]` (−5.0, Black ahead) instead of the FEN eval (+1.2), because `EvalBar` still keys on `currentPly`.

- [ ] **Step 3: Implement the node-aware lookup**

In `apps/web/src/components/board/EvalBar.tsx`, update the import:

```ts
import { useAnalyzerStore, currentFen, currentNode, currentMainlinePly } from "@/store";
```

Replace:

```ts
  const currentPly = useAnalyzerStore((s) => s.currentPly);
  const evaluation = useAnalyzerStore(
    (s) => s.evalByPly[s.currentPly] ?? s.arrowEvalByFen[currentFen(s)],
  );
```

with:

```ts
  const currentPly = useAnalyzerStore(currentMainlinePly);
  const evaluation = useAnalyzerStore((s) => {
    const node = currentNode(s);
    // A mainline node may carry a full-scan eval keyed by its ply (root = 0);
    // a variation node never does, so it always falls through to the FEN cache.
    const mainEval = node.mainline ? s.evalByPly[currentMainlinePly(s)] : undefined;
    return mainEval ?? s.arrowEvalByFen[currentFen(s)];
  });
```

(`currentPly` remains used by the `data-ply` attribute; it now comes from the selector.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C apps/web test src/components/board/EvalBar.test.tsx`
Expected: PASS (sign tests, fallback, prefers-per-ply, and the new variation test).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm -C apps/web typecheck` → PASS.

```bash
git add apps/web/src/components/board/EvalBar.tsx apps/web/src/components/board/EvalBar.test.tsx
git commit -m "feat(board): eval bar follows variations via node-aware lookup"
```

---

### Task 5: MoveList — render the tree (mainline rows + variation runs)

**Files:**
- Modify: `apps/web/src/components/moves/MoveList.tsx`
- Test: `apps/web/src/components/moves/MoveList.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/moves/MoveList.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Game } from "@chess/shared";

import { MoveList } from "./MoveList";
import { useAnalyzerStore, currentNode, START_FEN } from "@/store";
import { emptyTree } from "@/lib/moveTree";

function makeGame(): Game {
  const fenAfterE4 = "rnbqkbnr/pppppppp/8/4P3/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
  const fenAfterE5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
  return {
    id: "g1",
    headers: {},
    startFen: START_FEN,
    moves: [
      { ply: 1, moveNumber: 1, color: "w", san: "e4", uci: "e2e4", fenBefore: START_FEN, fenAfter: fenAfterE4 },
      { ply: 2, moveNumber: 1, color: "b", san: "e5", uci: "e7e5", fenBefore: fenAfterE4, fenAfter: fenAfterE5 },
    ],
  };
}

beforeEach(() => {
  const t = emptyTree(START_FEN);
  useAnalyzerStore.setState({
    game: null,
    nodesById: t.nodesById,
    rootId: t.rootId,
    currentNodeId: t.rootId,
    analysis: null,
  });
});

afterEach(() => cleanup());

describe("MoveList tree", () => {
  it("shows an empty state with no game", () => {
    render(<MoveList />);
    expect(screen.getByText(/no game loaded/i)).toBeTruthy();
  });

  it("renders the mainline moves", () => {
    useAnalyzerStore.getState().setGame(makeGame());
    render(<MoveList />);
    expect(screen.getByRole("button", { name: /\be4\b/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /\be5\b/ })).toBeTruthy();
  });

  it("renders a variation run and navigates on click", () => {
    useAnalyzerStore.getState().setGame(makeGame());
    // Go to the root and branch: 1. d4 becomes a variation under the root.
    useAnalyzerStore.getState().gotoPly(0);
    useAnalyzerStore.getState().playMove({ from: "d2", to: "d4" });
    render(<MoveList />);

    const d4 = screen.getByRole("button", { name: /\bd4\b/ });
    expect(d4).toBeTruthy();

    // Move the cursor away, then click the variation token to come back.
    useAnalyzerStore.getState().gotoPly(0);
    fireEvent.click(d4);
    expect(currentNode(useAnalyzerStore.getState()).move?.san).toBe("d4");
  });

  it("marks the active node with aria-current", () => {
    useAnalyzerStore.getState().setGame(makeGame());
    useAnalyzerStore.getState().gotoPly(1); // after 1. e4
    render(<MoveList />);
    const active = screen.getByRole("button", { name: /\be4\b/ });
    expect(active.getAttribute("aria-current")).toBe("true");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -C apps/web test src/components/moves/MoveList.test.tsx`
Expected: FAIL — current `MoveList` reads `game.moves`/`currentPly` and renders no variation; the variation test and aria-current/button-name queries fail.

- [ ] **Step 3: Rewrite `MoveList.tsx`**

Replace the entire contents of `apps/web/src/components/moves/MoveList.tsx` with:

```tsx
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import type { Move, MoveClassification, MoveEval } from "@chess/shared";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAnalyzerStore } from "@/store";
import type { MoveNode } from "@/lib/moveTree";
import { cn } from "@/lib/utils";
import { formatScore } from "@/lib/eval";

/** Glyph + tone for the classifications worth surfacing in the move list. */
const CLASSIFICATION_GLYPH: Partial<Record<MoveClassification, string>> = {
  inaccuracy: "?!",
  mistake: "?",
  blunder: "??",
};

function classificationColor(c: MoveClassification): string {
  switch (c) {
    case "blunder":
      return "text-[var(--class-blunder)]";
    case "mistake":
      return "text-[var(--class-mistake)]";
    case "inaccuracy":
      return "text-[var(--class-inaccuracy)]";
    default:
      return "";
  }
}

function formatEval(evaluation: MoveEval): string | null {
  return formatScore(evaluation.scoreCpAfter);
}

/** The mainline chain (root excluded), following `children[0]`. */
function mainlineNodes(nodesById: Record<string, MoveNode>, rootId: string): MoveNode[] {
  const out: MoveNode[] = [];
  let id: string | undefined = nodesById[rootId]?.children[0];
  while (id) {
    const node = nodesById[id];
    out.push(node);
    id = node.children[0];
  }
  return out;
}

/** A mainline ply cell: classification glyph + post-move eval, like the old list. */
function MoveCell({
  node,
  evaluation,
  active,
  onSelect,
}: {
  node: MoveNode;
  evaluation?: MoveEval;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const classification = evaluation?.classification;
  const glyph = classification ? CLASSIFICATION_GLYPH[classification] : undefined;
  const evalText = evaluation ? formatEval(evaluation) : null;
  const color = classification ? classificationColor(classification) : "";
  const san = node.move?.san ?? "";

  return (
    <button
      type="button"
      onClick={() => onSelect(node.id)}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex w-full items-baseline gap-1 rounded px-2 py-1 text-left tabular-nums hover:bg-accent",
        active && "bg-primary/15 font-medium ring-1 ring-primary/40",
      )}
    >
      <span className={cn("truncate", color)}>
        {san}
        {glyph ? <span className="ml-0.5 font-semibold">{glyph}</span> : null}
      </span>
      {evalText ? (
        <span className="ml-auto text-xs text-muted-foreground">{evalText}</span>
      ) : null}
    </button>
  );
}

/** An inline variation token: move number (white, or first-in-run) + SAN. */
function VarToken({
  node,
  first,
  active,
  onSelect,
}: {
  node: MoveNode;
  first: boolean;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const mv = node.move as Move;
  const showNumber = mv.color === "w" || first;
  const label = mv.color === "w" ? `${mv.moveNumber}.` : `${mv.moveNumber}…`;
  return (
    <button
      type="button"
      onClick={() => onSelect(node.id)}
      aria-current={active ? "true" : undefined}
      className={cn(
        "rounded px-1 py-0.5 tabular-nums hover:bg-accent",
        active && "bg-primary/15 font-medium ring-1 ring-primary/40",
      )}
    >
      {showNumber ? <span className="mr-0.5 text-muted-foreground">{label}</span> : null}
      {mv.san}
    </button>
  );
}

/**
 * One variation line: an inline run following `children[0]`, with any nested
 * variations rendered as deeper indented blocks (a full-width child forces a
 * line break inside the flex-wrap container).
 */
function VariationLine({
  startId,
  nodesById,
  currentNodeId,
  onSelect,
  depth = 0,
}: {
  startId: string;
  nodesById: Record<string, MoveNode>;
  currentNodeId: string;
  onSelect: (id: string) => void;
  depth?: number;
}) {
  const els: ReactNode[] = [];
  let id: string | undefined = startId;
  let first = true;
  while (id) {
    const node = nodesById[id];
    els.push(
      <VarToken
        key={node.id}
        node={node}
        first={first}
        active={node.id === currentNodeId}
        onSelect={onSelect}
      />,
    );
    // Nested variations branch off this node's primary continuation.
    if (node.children.length > 1) {
      for (const vid of node.children.slice(1)) {
        els.push(
          <div key={`nv-${vid}`} className="w-full">
            <VariationLine
              startId={vid}
              nodesById={nodesById}
              currentNodeId={currentNodeId}
              onSelect={onSelect}
              depth={depth + 1}
            />
          </div>,
        );
      }
    }
    first = false;
    id = node.children[0];
  }
  return (
    <div
      className="my-1 flex flex-wrap items-baseline gap-x-1 gap-y-0.5 border-l-2 border-border bg-muted/30 py-1 pl-2 text-[0.8125rem] text-muted-foreground"
      style={{ marginLeft: depth * 10 }}
    >
      {els}
    </div>
  );
}

/**
 * The move list as a tree. The mainline renders as two-column White/Black rows;
 * wherever a node carries variations (alternatives to its primary continuation),
 * an inset run is emitted right after the row of that continuation. Any token
 * navigates the tree on click; the active node is highlighted and auto-scrolled.
 */
export function MoveList() {
  const nodesById = useAnalyzerStore((s) => s.nodesById);
  const rootId = useAnalyzerStore((s) => s.rootId);
  const currentNodeId = useAnalyzerStore((s) => s.currentNodeId);
  const gotoNode = useAnalyzerStore((s) => s.gotoNode);
  const analysis = useAnalyzerStore((s) => s.analysis);

  const mainline = useMemo(() => mainlineNodes(nodesById, rootId), [nodesById, rootId]);
  const evalByPly = useMemo(() => {
    const map = new Map<number, MoveEval>();
    for (const e of analysis ?? []) map.set(e.ply, e);
    return map;
  }, [analysis]);

  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    containerRef.current
      ?.querySelector('[aria-current="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [currentNodeId, mainline]);

  if (mainline.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        No game loaded.
      </div>
    );
  }

  // Assemble ordered render items: 2-col rows interleaved with variation blocks.
  const out: ReactNode[] = [];
  let rowNum = 0;
  let whiteEl: ReactNode = null;
  let blackEl: ReactNode = null;
  let key = 0;

  const flushRow = () => {
    if (whiteEl || blackEl) {
      out.push(
        <li key={`row-${key++}`} className="flex items-stretch gap-1">
          <span className="w-8 shrink-0 select-none py-1 pr-1 text-right text-muted-foreground">
            {rowNum}.
          </span>
          <div className="grid min-w-0 flex-1 grid-cols-2 gap-1">
            {whiteEl ?? <span aria-hidden />}
            {blackEl ?? <span aria-hidden />}
          </div>
        </li>,
      );
    }
    whiteEl = null;
    blackEl = null;
  };

  for (const node of mainline) {
    const mv = node.move as Move;
    const cell = (
      <MoveCell
        node={node}
        evaluation={evalByPly.get(mv.ply)}
        active={node.id === currentNodeId}
        onSelect={gotoNode}
      />
    );
    if (mv.color === "w") {
      flushRow();
      rowNum = mv.moveNumber;
      whiteEl = cell;
    } else {
      if (rowNum !== mv.moveNumber) {
        flushRow();
        rowNum = mv.moveNumber;
      }
      blackEl = cell;
      flushRow();
    }

    // Variations are alternatives to THIS node (its parent's non-primary children).
    const parent = node.parentId ? nodesById[node.parentId] : null;
    if (parent && parent.children.length > 1 && parent.children[0] === node.id) {
      flushRow();
      for (const vid of parent.children.slice(1)) {
        out.push(
          <li key={`var-${vid}`} className="list-none">
            <VariationLine
              startId={vid}
              nodesById={nodesById}
              currentNodeId={currentNodeId}
              onSelect={gotoNode}
            />
          </li>,
        );
      }
    }
  }
  flushRow();

  return (
    <ScrollArea className="h-full">
      <ol ref={containerRef} className="flex flex-col p-2 text-sm">
        {out}
      </ol>
    </ScrollArea>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C apps/web test src/components/moves/MoveList.test.tsx`
Expected: PASS (empty state, mainline, variation run + navigation, aria-current).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm -C apps/web typecheck` → PASS.

```bash
git add apps/web/src/components/moves/MoveList.tsx apps/web/src/components/moves/MoveList.test.tsx
git commit -m "feat(moves): render the move list as a Lichess-style variation tree"
```

---

### Task 6: BoardControls — tree-based counter and disabled states

**Files:**
- Modify: `apps/web/src/components/board/BoardControls.tsx`

No test file exists; verify via typecheck and a manual check.

- [ ] **Step 1: Migrate to the tree selectors**

In `apps/web/src/components/board/BoardControls.tsx`, update the import:

```ts
import { useAnalyzerStore, currentMainlinePly, currentNode } from "@/store";
```

Find:

```ts
  const currentPly = useAnalyzerStore((s) => s.currentPly);
  const moveCount = useAnalyzerStore((s) => s.game?.moves.length ?? 0);
  const analysis = useAnalyzerStore((s) => s.analysis);

  const nextMistake = useMemo(
    () => nextMistakePly(analysis, currentPly),
    [analysis, currentPly],
  );

  const atStart = currentPly <= 0;
  const atEnd = currentPly >= moveCount;
```

Replace with:

```ts
  const currentPly = useAnalyzerStore(currentMainlinePly);
  const moveCount = useAnalyzerStore((s) => s.game?.moves.length ?? 0);
  const analysis = useAnalyzerStore((s) => s.analysis);
  // Start/end are tree facts: at the root there is no parent; at a leaf there is
  // no primary continuation. (atEnd covers variation leaves too, not just ply count.)
  const atRoot = useAnalyzerStore((s) => currentNode(s).parentId === null);
  const atLeaf = useAnalyzerStore((s) => currentNode(s).children[0] === undefined);

  const nextMistake = useMemo(
    () => nextMistakePly(analysis, currentPly),
    [analysis, currentPly],
  );

  const atStart = atRoot;
  const atEnd = atLeaf;
```

The counter `{currentPly} / {moveCount}` and the first/last buttons (`gotoPly(0)` / `gotoPly(moveCount)`) stay as-is — `currentPly` is now the branch-point ply selector, and `gotoPly` is tree-aware.

- [ ] **Step 2: Typecheck**

Run: `pnpm -C apps/web typecheck`
Expected: PASS.

- [ ] **Step 3: Manual verification**

In the running app: at the start, "first/prev" are disabled; at the last mainline move, "next/last" are disabled. Step into a variation with → ; at the variation's last move "next/last" disable.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/board/BoardControls.tsx
git commit -m "feat(board): controls use tree cursor for counter and bounds"
```

---

### Task 7: AdvantageChart — playhead at the branch-point ply

**Files:**
- Modify: `apps/web/src/components/chart/AdvantageChart.tsx`
- Test: `apps/web/src/components/chart/AdvantageChart.test.tsx`

- [ ] **Step 1: Update the test (drop the removed `currentPly` key)**

In `apps/web/src/components/chart/AdvantageChart.test.tsx`, the store no longer has a writable `currentPly` field. In every `useAnalyzerStore.setState({ … currentPly: 0 … })` call, remove the `currentPly: 0` property. There are seven occurrences (the `afterEach` reset and six per-test `setState` calls). For example, find:

```ts
  useAnalyzerStore.setState({ game: null, analysis: null, currentPly: 0 });
```

Replace with:

```ts
  useAnalyzerStore.setState({ game: null, analysis: null });
```

And in the per-test blocks, e.g. find:

```ts
    useAnalyzerStore.setState({
      game: GAME,
      analysis: ANALYSIS,
      currentPly: 0,
    });
```

Replace with:

```ts
    useAnalyzerStore.setState({
      game: GAME,
      analysis: ANALYSIS,
    });
```

Apply the same removal to the remaining `currentPly: 0` lines (including the `gotoPly`-stub test, which keeps its `gotoPly` key and only drops `currentPly`). The chart cursor sits at ply 0 by default (the empty-tree root), which these tests already assume.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -C apps/web test src/components/chart/AdvantageChart.test.tsx`
Expected: FAIL — TypeScript rejects `currentPly` in `setState` (and the component still reads `s.currentPly`), so the file does not compile/run.

- [ ] **Step 3: Migrate the component**

In `apps/web/src/components/chart/AdvantageChart.tsx`, update the import:

```ts
import { useAnalyzerStore, currentMainlinePly } from "@/store";
```

Find:

```ts
  const currentPly = useAnalyzerStore((s) => s.currentPly);
```

Replace with:

```ts
  const currentPly = useAnalyzerStore(currentMainlinePly);
```

(`cursorX = xPx(currentPly / n)` is unchanged — it now tracks the branch point while you explore a variation.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C apps/web test src/components/chart/AdvantageChart.test.tsx`
Expected: PASS (all five rendering/wiring tests).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm -C apps/web typecheck` → PASS.

```bash
git add apps/web/src/components/chart/AdvantageChart.tsx apps/web/src/components/chart/AdvantageChart.test.tsx
git commit -m "feat(chart): advantage playhead reads the branch-point ply"
```

---

### Task 8: ChatPanel — send the branch-point ply to the agent

**Files:**
- Modify: `apps/web/src/components/chat/ChatPanel.tsx`

No test file exists; verify via typecheck.

- [ ] **Step 1: Migrate the ply source**

In `apps/web/src/components/chat/ChatPanel.tsx`, update the import to add the selector:

```ts
import { useAnalyzerStore, currentMainlinePly } from "@/store";
```

(If the existing import is `import { useAnalyzerStore } from "@/store";`, replace it with the line above.)

Find:

```ts
    const store = useAnalyzerStore.getState();
    const { sessionId, game, currentPly } = store;
```

Replace with:

```ts
    const store = useAnalyzerStore.getState();
    const { sessionId, game } = store;
    // Branch-point mainline ply: in a variation the agent reasons about the
    // nearest mainline position (variation-aware chat is a documented follow-up).
    const currentPly = currentMainlinePly(store);
```

The `api.sendAgentMessage(..., { text, gameId: game?.id, ply: currentPly })` call is unchanged.

- [ ] **Step 2: Typecheck**

Run: `pnpm -C apps/web typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/chat/ChatPanel.tsx
git commit -m "feat(chat): send the branch-point ply from the tree cursor"
```

---

### Task 9: Keyboard shortcuts — End jumps to the line leaf, m uses the branch ply

**Files:**
- Modify: `apps/web/src/hooks/useBoardShortcuts.ts`

No test file exists; verify via typecheck and a manual check.

- [ ] **Step 1: Migrate the handler**

In `apps/web/src/hooks/useBoardShortcuts.ts`, add an import:

```ts
import { lineToLeaf } from "@/lib/moveTree";
```

The handler reads `store = useAnalyzerStore.getState()`. Replace the `ArrowDown`/`End` branch:

```ts
        case "ArrowDown":
        case "End":
          store.gotoPly(lastPly);
          break;
```

with:

```ts
        case "ArrowDown":
        case "End":
          store.gotoNode(lineToLeaf(store.nodesById, store.currentNodeId));
          break;
```

The `lastPly` variable is now only referenced by the (removed) End branch; delete its declaration:

```ts
      const lastPly = store.game?.moves.length ?? 0;
```

Bring in the selector by extending the existing store import — change
`import { useAnalyzerStore } from "@/store";` to:

```ts
import { useAnalyzerStore, currentMainlinePly } from "@/store";
```

In the `m` (next-mistake) branch, replace `store.currentPly` with the selector:

```ts
            case "m": {
              const ply = nextMistakePly(store.analysis, currentMainlinePly(store));
              if (ply !== null) store.gotoPly(ply);
              break;
            }
```

- [ ] **Step 2: Typecheck**

Run: `pnpm -C apps/web typecheck`
Expected: PASS.

- [ ] **Step 3: Manual verification**

In the app: `→` steps forward along the current line, `←` back; `End` jumps to the leaf of the current line (including inside a variation); `Home` to the start; `m` jumps to the next mainline mistake.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/hooks/useBoardShortcuts.ts
git commit -m "feat(board): End jumps to the current line's leaf; m uses branch ply"
```

---

### Task 10: Remove the `currentPly` scaffolding field

**Files:**
- Modify: `apps/web/src/store.ts`
- Modify: `apps/web/src/store.test.ts`

By now every consumer reads `currentMainlinePly`/`currentNode`; only the store and `store.test.ts` still mention the field.

- [ ] **Step 1: Verify nothing outside the store/test reads the field**

Run: `grep -rn "currentPly" apps/web/src --include="*.ts" --include="*.tsx" | grep -v "currentMainlinePly"`
Expected: matches only in `apps/web/src/store.ts` and `apps/web/src/store.test.ts`. If anything else appears, migrate it to `currentMainlinePly` before continuing.

- [ ] **Step 2: Remove the field from the store**

In `apps/web/src/store.ts`:

- In the `AnalyzerState` interface, delete the line:
  ```ts
  currentPly: number; // scaffolding: branch-point ply, synced from currentNodeId (removed in a later pass)
  ```
- In the store creator's initial object, delete `currentPly: 0,`.
- In `setGame`, delete the `currentPly: 0,` line.
- In `gotoNode`, `playMove`, `gotoPly`, `nextPly`, `prevPly`, and `setBoardFromAgent`, remove the `currentPly: nearestMainlinePly(...)` property from each `set({...})` call (leave the rest of each call intact). After this, those actions set only `currentNodeId`/`nodesById`/`agentFen`.

- [ ] **Step 3: Migrate the remaining test references**

In `apps/web/src/store.test.ts`:

- In `beforeEach`, delete the `currentPly: 0,` line.
- In `describe("navigation", …)`, the clamp and next/prev tests assert `useAnalyzerStore.getState().currentPly`. Replace each `useAnalyzerStore.getState().currentPly` with `currentMainlinePly(useAnalyzerStore.getState())`. For example:
  ```ts
  useAnalyzerStore.getState().gotoPly(99);
  expect(currentMainlinePly(useAnalyzerStore.getState())).toBe(2);
  ```
  Apply to all five occurrences in that block.
- In `describe("setGame", …)`, the dirtying `setState({ currentPly: 5, … })` and the `expect(s.currentPly).toBe(0)` assertion: remove `currentPly: 5,` from the `setState`, and replace the assertion with `expect(currentMainlinePly(s)).toBe(0)`.
- In `describe("eval cache + setBoardFromAgent ply path", …)`, replace `expect(s.currentPly).toBe(1)` with `expect(currentMainlinePly(s)).toBe(1)`.

(`currentMainlinePly` is already imported from Task 2.)

- [ ] **Step 4: Full typecheck + full test suite**

Run: `pnpm -C apps/web typecheck`
Expected: PASS (no references to a `currentPly` field remain).

Run: `pnpm -C apps/web test`
Expected: PASS — the whole web suite, including `moveTree`, `store`, `MoveList`, `EvalBar`, `AdvantageChart`, and the untouched suites.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/store.ts apps/web/src/store.test.ts
git commit -m "refactor(store): drop the currentPly field for the node cursor"
```

---

### Task 11: Whole-feature verification

**Files:** none (verification only).

- [ ] **Step 1: Build + full suite**

Run: `pnpm -C apps/web typecheck && pnpm -C apps/web test && pnpm -C apps/web build`
Expected: all PASS (typecheck clean, every test green, production build succeeds).

- [ ] **Step 2: Manual end-to-end check**

Run `pnpm -C apps/web dev`, import or open a game, then confirm:
- Dragging a legal off-mainline move creates a variation; the move list shows it as an inset run after the branch row.
- The eval bar and best-move arrows update for the variation position.
- Clicking any mainline or variation token jumps the board there; the active token is highlighted and scrolled into view.
- `←/→/Home/End`, flip, arrows toggle, and "next mistake" all still work; `End` lands on the current line's leaf.
- Replaying an existing move just navigates (no duplicate node); an illegal drag snaps back.
- Loading a different game / reload resets the tree (variations are ephemeral).

- [ ] **Step 3: Final branch wrap-up**

If everything is green, the feature is complete. Use `superpowers:finishing-a-development-branch` to decide on merge/PR.

---

## Self-review (spec coverage)

| Spec item | Task |
|---|---|
| `MoveNode` tree model | Task 1 |
| `buildTree` / `emptyTree` / `applyMove` / walkers | Task 1 |
| Store: `nodesById`/`rootId`/`currentNodeId`, `playMove`, `gotoNode` | Task 2 |
| Selectors `currentFen`/`currentNode`/`currentMainlinePly`; field removed | Tasks 2 (added) + 10 (field removed) |
| `setGame` builds tree; `setBoardFromAgent` retargets onto tree | Task 2 |
| Tree-term navigation (next/prev/first/last, gotoPly) | Tasks 2 (store) + 9 (End→leaf) |
| Board free-move drag (normal mode, gated on agentFen; auto-queen) | Task 3 |
| Coach question/reveal unchanged | Task 3 (left intact) |
| Move list → tree (mainline rows + inset variation runs, nested, active highlight, auto-scroll, click-to-nav) | Task 5 |
| EvalBar node-aware lookup (mainline eval only on mainline) | Task 4 |
| BoardControls counter + bounds from the tree | Task 6 |
| AdvantageChart cursor at branch-point ply; KeyMoments unchanged | Task 7 |
| ChatPanel sends branch-point ply (agent v1 limitation noted) | Task 8 |
| Eval bar + arrows follow variations; advantage chart/key moments mainline-only | Tasks 3–7 (FEN-keyed; chart stays on `currentMainlinePly`) |
| Tests: moveTree, store, MoveList, EvalBar (+ migrated AdvantageChart) | Tasks 1, 2, 4, 5, 7, 10 |
| Ephemeral (reset on setGame, lost on reload); no shared/server changes | Task 2 (`setGame` rebuild); no server task exists |
| Out of scope (delete/promote, comments, underpromotion picker, persistence, variation-aware agent) | not implemented (by design) |
