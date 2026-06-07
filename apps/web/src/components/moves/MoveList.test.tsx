import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Game } from "@chess/shared";

import { MoveList } from "./MoveList";
import { useAnalyzerStore, currentNode, START_FEN } from "@/store";
import { emptyTree } from "@/lib/moveTree";

// jsdom does not implement scrollIntoView; the list auto-scrolls the active node.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
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
