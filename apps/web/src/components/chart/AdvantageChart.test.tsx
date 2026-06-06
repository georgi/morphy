import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Game, Move, MoveEval } from "@chess/shared";

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
});

import { AdvantageChart } from "./AdvantageChart";
import { useAnalyzerStore } from "@/store";

function move(ply: number, san: string): Move {
  return {
    ply,
    moveNumber: Math.ceil(ply / 2),
    color: ply % 2 === 1 ? "w" : "b",
    san,
    uci: "e2e4",
    fenBefore: "x",
    fenAfter: "y",
  };
}

function mev(ply: number, partial: Partial<MoveEval>): MoveEval {
  return {
    ply,
    san: "e4",
    scoreCpBefore: 0,
    scoreCpAfter: 0,
    cpLoss: 0,
    classification: "good",
    bestMove: null,
    bestLine: [],
    ...partial,
  };
}

const GAME: Game = {
  id: "g1",
  headers: {},
  startFen: "startpos",
  moves: [move(1, "e4"), move(2, "e5"), move(3, "Qh5"), move(4, "Nc6")],
};

const ANALYSIS: MoveEval[] = [
  mev(1, { san: "e4", classification: "good", scoreCpAfter: 20 }),
  mev(2, { san: "e5", classification: "good", scoreCpAfter: 10 }),
  mev(3, { san: "Qh5", classification: "blunder", scoreCpAfter: -300 }),
  mev(4, {
    san: "Nxe4+",
    classification: "best",
    scoreCpBefore: 50,
    scoreCpAfter: 0,
  }),
];

afterEach(() => {
  cleanup();
  useAnalyzerStore.setState({ game: null, analysis: null, currentPly: 0 });
});

describe("AdvantageChart", () => {
  it("shows a placeholder until the game is analyzed", () => {
    useAnalyzerStore.setState({ game: GAME, analysis: null, currentPly: 0 });
    render(<AdvantageChart />);
    expect(screen.getByText(/analyze game to see evaluation/i)).toBeDefined();
  });

  it("renders a placeholder when no game is loaded", () => {
    useAnalyzerStore.setState({ game: null, analysis: null, currentPly: 0 });
    render(<AdvantageChart />);
    expect(screen.getByText(/no game loaded/i)).toBeDefined();
  });

  it("draws one dot per classified move, colored by severity token", () => {
    useAnalyzerStore.setState({
      game: GAME,
      analysis: ANALYSIS,
      currentPly: 0,
    });
    const { container } = render(<AdvantageChart />);

    expect(screen.getByRole("img", { name: /evaluation/i })).toBeDefined();
    const dots = container.querySelectorAll("[data-kind]");
    // One blunder + one brilliant (tactical best in a competitive position).
    expect(dots).toHaveLength(2);
    const byKind = Object.fromEntries(
      [...dots].map((d) => [d.getAttribute("data-kind"), d]),
    );
    expect(Object.keys(byKind).sort()).toEqual(["blunder", "brilliant"]);

    // Shape-coded, not uniform circles: brilliant = triangle (3 points),
    // blunder = diamond (4 points). This is the colorblind-safety guard.
    const brilliant = byKind.brilliant;
    const blunder = byKind.blunder;
    expect(brilliant.tagName.toLowerCase()).toBe("polygon");
    expect(blunder.tagName.toLowerCase()).toBe("polygon");
    expect(brilliant.getAttribute("points")!.trim().split(/\s+/)).toHaveLength(
      3,
    );
    expect(blunder.getAttribute("points")!.trim().split(/\s+/)).toHaveLength(4);

    // Markers carry the welded severity tokens, never raw hex.
    const fills = [...dots].map((d) => d.getAttribute("fill"));
    expect(fills).toContain("var(--class-blunder)");
    expect(fills).toContain("var(--class-brilliant)");
  });

  it("paints the area/curve with advantage tokens (no raw hex)", () => {
    useAnalyzerStore.setState({
      game: GAME,
      analysis: ANALYSIS,
      currentPly: 0,
    });
    const { container } = render(<AdvantageChart />);

    const fills = [...container.querySelectorAll("path")].map((p) =>
      p.getAttribute("fill"),
    );
    expect(fills).toContain("var(--eval-white)");

    // The ember playhead and equal midline use design tokens, not hex.
    const strokes = [...container.querySelectorAll("line")].map((l) =>
      l.getAttribute("stroke"),
    );
    expect(strokes).toContain("var(--primary)");
    expect(strokes).toContain("var(--border)");
    expect(strokes.some((s) => s?.startsWith("#"))).toBe(false);
  });

  it("shows a compact severity legend with glyphs", () => {
    useAnalyzerStore.setState({
      game: GAME,
      analysis: ANALYSIS,
      currentPly: 0,
    });
    const { container } = render(<AdvantageChart />);

    const legend = container.textContent ?? "";
    expect(legend).toMatch(/brilliant/i);
    expect(legend).toMatch(/inaccuracy/i);
    expect(legend).toMatch(/blunder/i);
    // Glyphs travel with the labels (shape, not color alone).
    expect(legend).toContain("▲");
    expect(legend).toContain("○");
    expect(legend).toContain("◆");
  });

  it("scrubs the board on click (wires the pointer to gotoPly)", () => {
    // jsdom doesn't carry clientX through synthetic pointer events reliably, so
    // assert the WIRING (pointer → gotoPly) here; the coordinate→ply math is
    // covered exhaustively by the plyAtX unit tests.
    const gotoPly = vi.fn();
    useAnalyzerStore.setState({
      game: GAME,
      analysis: ANALYSIS,
      currentPly: 0,
      gotoPly,
    });
    render(<AdvantageChart />);
    const svg = screen.getByRole("img", { name: /evaluation/i });
    svg.getBoundingClientRect = vi.fn(
      () =>
        ({
          left: 0,
          top: 0,
          width: 400,
          height: 80,
          right: 400,
          bottom: 80,
        }) as DOMRect,
    );

    fireEvent.pointerDown(svg, { clientX: 400, pointerId: 1 });

    expect(gotoPly).toHaveBeenCalledTimes(1);
    const ply = gotoPly.mock.calls[0][0] as number;
    expect(Number.isInteger(ply)).toBe(true);
    expect(ply).toBeGreaterThanOrEqual(0);
    expect(ply).toBeLessThanOrEqual(GAME.moves.length);
  });
});
