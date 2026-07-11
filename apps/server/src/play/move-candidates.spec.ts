import type { EngineEval } from "@chess/shared";
import { buildCandidates } from "./move-candidates";

const engineEval = (lines: Array<[string, number | null, number | null]>): EngineEval => ({
  fen: "irrelevant",
  bestMove: lines[0]?.[0] ?? null,
  depth: 12,
  lines: lines.map(([uci, scoreCp, mate], i) => ({
    pv: [uci],
    scoreCp,
    mate,
    rank: i + 1,
  })),
});

const base = {
  sideToMove: "w" as const,
  evalWindowCp: 50,
  blunderRate: 0,
  legalSans: ["e4", "d4", "Nf3", "a3"],
  uciToSan: (uci: string) =>
    ({ e2e4: "e4", d2d4: "d4", g1f3: "Nf3", a2a3: "a3" })[uci] ?? null,
  sanToUci: (san: string) =>
    ({ e4: "e2e4", d4: "d2d4", Nf3: "g1f3", a3: "a2a3" })[san] ?? null,
  rng: () => 0.99,
};

describe("buildCandidates", () => {
  it("keeps only lines within the eval window (side-to-move POV)", () => {
    const result = buildCandidates({
      ...base,
      engineEval: engineEval([
        ["e2e4", 40, null],
        ["d2d4", 10, null], // 30cp below best: kept
        ["g1f3", -30, null], // 70cp below best: dropped
      ]),
    });
    expect(result.map((c) => c.uci)).toEqual(["e2e4", "d2d4"]);
    expect(result[0]).toEqual({
      uci: "e2e4", san: "e4", scoreCp: 40, mate: null, offbeat: false,
    });
  });

  it("flips POV for black to move", () => {
    const result = buildCandidates({
      ...base,
      sideToMove: "b",
      engineEval: engineEval([
        ["e2e4", -40, null], // best for black
        ["d2d4", 30, null], // 70cp worse for black: dropped
      ]),
    });
    expect(result.map((c) => c.uci)).toEqual(["e2e4"]);
  });

  it("injects an offbeat legal move when rng() < blunderRate", () => {
    const result = buildCandidates({
      ...base,
      blunderRate: 0.1,
      rng: () => 0.05,
      engineEval: engineEval([["e2e4", 40, null]]),
    });
    const offbeat = result.filter((c) => c.offbeat);
    expect(offbeat).toHaveLength(1);
    expect(offbeat[0].uci).not.toBe("e2e4");
    expect(offbeat[0].scoreCp).toBeNull();
  });

  it("drops lines whose uci does not convert, never returning zero candidates", () => {
    const result = buildCandidates({
      ...base,
      engineEval: engineEval([
        ["e2e4", 40, null],
        ["zzzz", 39, null],
      ]),
    });
    expect(result.map((c) => c.uci)).toEqual(["e2e4"]);
  });
});
