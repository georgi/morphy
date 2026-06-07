import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { EngineEval, Game } from "@chess/shared";

import { EvalBar } from "./EvalBar";
import { useAnalyzerStore, currentFen, START_FEN } from "@/store";
import { emptyTree } from "@/lib/moveTree";

/** A single-line White-POV eval at `cp` centipawns. */
function evalAt(cp: number): EngineEval {
  return {
    fen: "x",
    bestMove: "e2e4",
    depth: 12,
    lines: [{ pv: ["e2e4"], scoreCp: cp, mate: null, rank: 1 }],
  };
}

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

/** The fill `<div>` (first child); its inline `height` encodes the White %. */
function fillHeightPct(): number {
  const bar = screen.getByRole("img");
  const fill = bar.firstElementChild as HTMLElement;
  return parseFloat(fill.style.height);
}

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

afterEach(() => cleanup());

describe("EvalBar White-POV sign", () => {
  // Black-to-move position; the White-POV score is POSITIVE, so White is ahead.
  // The old `* sign` flip would have inverted this to read Black-ahead — this is
  // the regression guard for that bug.
  const blackToMoveFen =
    "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2";

  it("shows White ahead for a black-to-move position with positive White-POV cp", () => {
    useAnalyzerStore.setState({
      agentFen: blackToMoveFen,
      arrowEvalByFen: { [blackToMoveFen]: evalAt(300) }, // +3.0 for White
    });

    render(<EvalBar />);

    // Bar reads from the current FEN's eval (no per-ply eval present here).
    expect(currentFen(useAnalyzerStore.getState())).toBe(blackToMoveFen);

    // White fill dominates the bar (sign NOT inverted).
    expect(fillHeightPct()).toBeGreaterThan(50);

    // Readout is a White advantage: a leading "+" and no Black "−".
    const readout = screen.getByText(/\+3\.0/);
    expect(readout.textContent).toBe("+3.0");
    expect(readout.textContent).not.toContain("−");
  });

  it("shows Black ahead for a black-to-move position with negative White-POV cp", () => {
    useAnalyzerStore.setState({
      agentFen: blackToMoveFen,
      arrowEvalByFen: { [blackToMoveFen]: evalAt(-300) }, // −3.0 for White
    });

    render(<EvalBar />);

    expect(fillHeightPct()).toBeLessThan(50);
    expect(screen.getByText("−3.0")).toBeTruthy();
  });
});

describe("EvalBar any-position fallback", () => {
  it("falls back to arrowEvalByFen when evalByPly is empty for the current ply", () => {
    // No per-ply evals; the only source is the FEN-keyed arrow cache.
    useAnalyzerStore.setState({
      evalByPly: {},
      arrowEvalByFen: { [START_FEN]: evalAt(150) }, // +1.5 at the start position
    });

    expect(currentFen(useAnalyzerStore.getState())).toBe(START_FEN);

    render(<EvalBar />);

    expect(screen.getByText("+1.5")).toBeTruthy();
    expect(fillHeightPct()).toBeGreaterThan(50);
  });

  it("prefers the per-ply eval over the arrow cache when both exist", () => {
    useAnalyzerStore.setState({
      evalByPly: { 0: evalAt(200) }, // +2.0 from the full-game scan (root = ply 0)
      arrowEvalByFen: { [START_FEN]: evalAt(-200) }, // would read −2.0
    });

    render(<EvalBar />);

    expect(screen.getByText("+2.0")).toBeTruthy();
  });

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
});
