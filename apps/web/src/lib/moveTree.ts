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
