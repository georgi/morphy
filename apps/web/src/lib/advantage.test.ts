import { describe, expect, it } from "vitest";
import type { MoveEval, MoveClassification } from "@chess/shared";
import { buildChartModel, markerFor, plyAtX } from "./advantage";

function ev(partial: Partial<MoveEval> & { ply: number }): MoveEval {
  return {
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

describe("markerFor", () => {
  const cases: Array<[MoveClassification, string | null]> = [
    ["blunder", "blunder"],
    ["mistake", "mistake"],
    ["inaccuracy", "inaccuracy"],
    ["good", null],
    ["book", null],
  ];
  it.each(cases)("maps classification %s → %s", (classification, expected) => {
    expect(markerFor(ev({ ply: 1, classification }))).toBe(expected);
  });

  it("marks a tactical best move in a competitive position as brilliant", () => {
    expect(
      markerFor(
        ev({ ply: 1, classification: "best", san: "Nxe5+", scoreCpBefore: 80 }),
      ),
    ).toBe("brilliant");
  });

  it("does not mark a quiet best move", () => {
    expect(
      markerFor(
        ev({ ply: 1, classification: "best", san: "Nf3", scoreCpBefore: 20 }),
      ),
    ).toBeNull();
  });

  it("does not mark a best move played from an already-decided position", () => {
    expect(
      markerFor(
        ev({
          ply: 1,
          classification: "best",
          san: "Qxh7#",
          scoreCpBefore: 900,
        }),
      ),
    ).toBeNull();
  });
});

describe("buildChartModel", () => {
  it("returns an empty model for no analysis", () => {
    expect(buildChartModel(null)).toEqual({
      points: [],
      markers: [],
      plyCount: 0,
    });
    expect(buildChartModel([])).toEqual({
      points: [],
      markers: [],
      plyCount: 0,
    });
  });

  it("emits a leading point plus one per ply, normalized 0..1", () => {
    const analysis = [
      ev({ ply: 1, scoreCpAfter: 0 }),
      ev({ ply: 2, scoreCpAfter: 350 }),
      ev({ ply: 3, scoreCpAfter: -350 }),
    ];
    const model = buildChartModel(analysis);

    expect(model.plyCount).toBe(3);
    expect(model.points).toHaveLength(4); // leading + 3 moves
    expect(model.points[0]).toMatchObject({ ply: 0, x: 0 });
    expect(model.points.at(-1)).toMatchObject({ ply: 3, x: 1 });

    // cp 0 → 0.5; +350 → sigmoid(1) ≈ 0.731; −350 → ≈ 0.269.
    expect(model.points[1].whiteProb).toBeCloseTo(0.5, 5);
    expect(model.points[2].whiteProb).toBeCloseTo(0.731, 2);
    expect(model.points[3].whiteProb).toBeCloseTo(0.269, 2);
  });

  it("carries the last known eval across null scores (terminal positions)", () => {
    const analysis = [
      ev({ ply: 1, scoreCpAfter: 800 }), // White winning
      ev({ ply: 2, scoreCpAfter: null }), // mate / game over → no score
      ev({ ply: 3, scoreCpAfter: null }),
    ];
    const model = buildChartModel(analysis);
    const winning = model.points[1].whiteProb;
    expect(winning).toBeGreaterThan(0.9);
    // Null plies hold at the winning level rather than snapping back to 0.5.
    expect(model.points[2].whiteProb).toBe(winning);
    expect(model.points[3].whiteProb).toBe(winning);
  });

  it("collects a marker for each classified move", () => {
    const analysis = [
      ev({ ply: 1, classification: "good" }),
      ev({ ply: 2, classification: "blunder", san: "Qxa1" }),
      ev({ ply: 3, classification: "best", san: "Nxe5+", scoreCpBefore: 50 }),
    ];
    const model = buildChartModel(analysis);
    expect(model.markers.map((m) => [m.ply, m.kind])).toEqual([
      [2, "blunder"],
      [3, "brilliant"],
    ]);
  });
});

describe("plyAtX", () => {
  it("maps pointer x to the nearest ply, clamped", () => {
    expect(plyAtX(0, 200, 10)).toBe(0);
    expect(plyAtX(100, 200, 10)).toBe(5);
    expect(plyAtX(200, 200, 10)).toBe(10);
    expect(plyAtX(999, 200, 10)).toBe(10); // clamp high
    expect(plyAtX(-50, 200, 10)).toBe(0); // clamp low
  });

  it("is safe for degenerate inputs", () => {
    expect(plyAtX(50, 0, 10)).toBe(0);
    expect(plyAtX(50, 200, 0)).toBe(0);
    expect(plyAtX(NaN, 200, 10)).toBe(0);
  });
});
