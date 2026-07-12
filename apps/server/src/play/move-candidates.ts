import type { Color, EngineEval } from "@chess/shared";

export interface Candidate {
  uci: string;
  san: string;
  scoreCp: number | null; // White-POV, null for mate lines and injected moves
  mate: number | null;
  offbeat: boolean; // true for the injected dubious move
}

export interface CandidateInput {
  engineEval: EngineEval;
  sideToMove: Color;
  evalWindowCp: number;
  blunderRate: number;
  legalSans: string[];
  uciToSan: (uci: string) => string | null;
  sanToUci: (san: string) => string | null;
  rng: () => number; // injectable for determinism
}

/** Side-to-move POV score; mate lines map to a huge +/- so they sort/window sanely. */
function povScore(scoreCp: number | null, mate: number | null, side: Color): number {
  const whitePov = mate !== null ? Math.sign(mate) * 100_000 : (scoreCp ?? 0);
  return side === "w" ? whitePov : -whitePov;
}

export function buildCandidates(input: CandidateInput): Candidate[] {
  const { engineEval, sideToMove, evalWindowCp, blunderRate, rng } = input;

  const converted = engineEval.lines
    .filter((l) => l.pv.length > 0)
    .map((l) => {
      const uci = l.pv[0];
      const san = input.uciToSan(uci);
      return san
        ? {
            uci,
            san,
            scoreCp: l.scoreCp,
            mate: l.mate,
            offbeat: false,
            pov: povScore(l.scoreCp, l.mate, sideToMove),
          }
        : null;
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  if (converted.length === 0) return [];
  const best = Math.max(...converted.map((c) => c.pov));
  const candidates = converted
    .filter((c) => best - c.pov <= evalWindowCp || c.pov === best)
    .map(({ pov: _pov, ...c }) => c);

  if (rng() < blunderRate) {
    const taken = new Set(candidates.map((c) => c.san));
    const pool = input.legalSans.filter((san) => !taken.has(san));
    if (pool.length > 0) {
      const san = pool[Math.floor(rng() * pool.length) % pool.length];
      const uci = input.sanToUci(san);
      if (uci) {
        candidates.push({ uci, san, scoreCp: null, mate: null, offbeat: true });
      }
    }
  }
  return candidates;
}
