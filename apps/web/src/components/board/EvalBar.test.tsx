import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { EngineEval } from "@chess/shared";

import { EvalBar } from "./EvalBar";
import { useAnalyzerStore, currentFen, START_FEN } from "@/store";

/** A single-line White-POV eval at `cp` centipawns. */
function evalAt(cp: number): EngineEval {
  return {
    fen: "x",
    bestMove: "e2e4",
    depth: 12,
    lines: [{ pv: ["e2e4"], scoreCp: cp, mate: null, rank: 1 }],
  };
}

/** The fill `<div>` (first child); its inline `height` encodes the White %. */
function fillHeightPct(): number {
  const bar = screen.getByRole("img");
  const fill = bar.firstElementChild as HTMLElement;
  return parseFloat(fill.style.height);
}

beforeEach(() => {
  // Reset to a known clean slate; the store is a singleton across tests.
  useAnalyzerStore.setState({
    game: null,
    currentPly: 0,
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
      currentPly: 0,
      evalByPly: { 0: evalAt(200) }, // +2.0 from the full-game scan
      arrowEvalByFen: { [START_FEN]: evalAt(-200) }, // would read −2.0
    });

    render(<EvalBar />);

    expect(screen.getByText("+2.0")).toBeTruthy();
  });
});
