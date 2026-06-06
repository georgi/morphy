import { describe, expect, it } from "vitest";
import type { EngineEval, EngineLine } from "@chess/shared";
import { bestMoveArrows, squareToXY } from "./arrows";

function line(partial: Partial<EngineLine> & { rank: number }): EngineLine {
  return { pv: ["e2e4"], scoreCp: 0, mate: null, ...partial };
}

function evalOf(lines: EngineLine[]): EngineEval {
  return {
    fen: "startpos",
    bestMove: lines[0]?.pv[0] ?? null,
    lines,
    depth: 14,
  };
}

describe("squareToXY", () => {
  it("maps corners and a center square in white orientation", () => {
    // file a..h → x 0.5..7.5; rank 8..1 → y 0.5..7.5 (rank 8 row at top).
    expect(squareToXY("a8", "white")).toEqual({ x: 0.5, y: 0.5 });
    expect(squareToXY("h1", "white")).toEqual({ x: 7.5, y: 7.5 });
    expect(squareToXY("e4", "white")).toEqual({ x: 4.5, y: 4.5 });
  });

  it("mirrors both axes in black orientation", () => {
    expect(squareToXY("a8", "black")).toEqual({ x: 7.5, y: 7.5 });
    expect(squareToXY("h1", "black")).toEqual({ x: 0.5, y: 0.5 });
    expect(squareToXY("e4", "black")).toEqual({ x: 3.5, y: 3.5 });
  });
});

describe("bestMoveArrows", () => {
  it("builds ranked arrows from a normal 3-line eval, including a negative cp", () => {
    const result = bestMoveArrows(
      evalOf([
        line({ rank: 1, pv: ["e2e4"], scoreCp: 140 }),
        line({ rank: 2, pv: ["d2d4"], scoreCp: 90 }),
        line({ rank: 3, pv: ["g1f3"], scoreCp: -230 }),
      ]),
    );

    expect(result).toEqual([
      { from: "e2", to: "e4", rank: 1, evalText: "+1.4" },
      { from: "d2", to: "d4", rank: 2, evalText: "+0.9" },
      { from: "g1", to: "f3", rank: 3, evalText: "−2.3" },
    ]);
  });

  it("formats a White mate and a Black mate from the sign of line.mate", () => {
    const result = bestMoveArrows(
      evalOf([
        line({ rank: 1, pv: ["d1h5"], scoreCp: null, mate: 3 }),
        line({ rank: 2, pv: ["f1c4"], scoreCp: null, mate: -2 }),
      ]),
    );

    expect(result[0]).toMatchObject({
      from: "d1",
      to: "h5",
      rank: 1,
      evalText: "M3",
    });
    expect(result[1]).toMatchObject({
      from: "f1",
      to: "c4",
      rank: 2,
      evalText: "−M2",
    });
  });

  it("renders as many arrows as exist when fewer than 3 lines", () => {
    const result = bestMoveArrows(
      evalOf([line({ rank: 1, pv: ["e2e4"], scoreCp: 30 })]),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ from: "e2", to: "e4", rank: 1 });
  });

  it("honors the count parameter", () => {
    const result = bestMoveArrows(
      evalOf([
        line({ rank: 1, pv: ["e2e4"] }),
        line({ rank: 2, pv: ["d2d4"] }),
        line({ rank: 3, pv: ["g1f3"] }),
      ]),
      2,
    );
    expect(result.map((a) => a.rank)).toEqual([1, 2]);
  });

  it("skips lines whose pv[0] is missing or too short", () => {
    const result = bestMoveArrows(
      evalOf([
        line({ rank: 1, pv: [] }),
        line({ rank: 2, pv: ["e2"] }),
        line({ rank: 3, pv: ["d2d4"], scoreCp: 50 }),
      ]),
    );
    expect(result).toEqual([
      { from: "d2", to: "d4", rank: 3, evalText: "+0.5" },
    ]);
  });

  it("derives from/to from the first 4 chars of a promotion UCI", () => {
    const result = bestMoveArrows(
      evalOf([line({ rank: 1, pv: ["e7e8q"], scoreCp: 900 })]),
    );
    expect(result[0]).toMatchObject({ from: "e7", to: "e8" });
  });

  it("returns [] for empty lines", () => {
    expect(bestMoveArrows(evalOf([]))).toEqual([]);
  });

  it("returns [] for an undefined eval", () => {
    expect(bestMoveArrows(undefined)).toEqual([]);
  });
});
