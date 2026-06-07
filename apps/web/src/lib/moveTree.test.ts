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
    // White pawn on e7, kings placed legally (black king off the promotion square); e7e8 promotes.
    const fen = "6k1/4P3/8/8/8/8/8/4K3 w - - 0 1";
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
