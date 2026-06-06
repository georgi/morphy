import type { MoveEval } from "@chess/shared";
import { whiteWinProb } from "./eval";

/** The classifications that earn a dot on the advantage chart. */
export type MarkerKind = "inaccuracy" | "mistake" | "blunder" | "brilliant";

/** One curve sample: a ply, its normalized x (0..1), and White's win prob (0..1). */
export interface ChartPoint {
  ply: number;
  x: number;
  whiteProb: number;
}

/** A classified move, positioned on the curve. */
export interface ChartMarker extends ChartPoint {
  kind: MarkerKind;
  san: string;
}

export interface ChartModel {
  points: ChartPoint[];
  markers: ChartMarker[];
  /** Number of plies (moves) in the game; 0 when there is nothing to draw. */
  plyCount: number;
}

/** Tactical SAN flavor: a capture, check/mate, or promotion. */
function isTactical(san: string): boolean {
  return /[x+#=]/.test(san);
}

/** Centipawn threshold below which a position still counts as "competitive". */
const COMPETITIVE_CP = 300;

/**
 * Which dot (if any) a move earns. The three mistake tiers always mark. A `best`
 * move earns the green "brilliant" dot only when it actually mattered — a
 * tactical move (capture / check / promotion) found in a still-competitive
 * position (|eval before| ≤ 300cp) — so green stays rare instead of one-per-move.
 * Plain `best` / `good` / `book` get no dot.
 */
export function markerFor(ev: MoveEval): MarkerKind | null {
  switch (ev.classification) {
    case "blunder":
      return "blunder";
    case "mistake":
      return "mistake";
    case "inaccuracy":
      return "inaccuracy";
    case "best": {
      const before = ev.scoreCpBefore;
      const competitive = before == null || Math.abs(before) <= COMPETITIVE_CP;
      return competitive && isTactical(ev.san) ? "brilliant" : null;
    }
    default:
      return null;
  }
}

/**
 * Build the advantage-chart model from a game's per-move analysis. Emits one
 * curve point per ply plus a leading point at ply 0 (the start position), and a
 * marker for every move that earns a dot. `x` is normalized 0..1 across all plies
 * so the chart scales to any width.
 */
export function buildChartModel(
  analysis: MoveEval[] | null | undefined,
): ChartModel {
  const moves = analysis ?? [];
  const n = moves.length;
  if (n === 0) return { points: [], markers: [], plyCount: 0 };

  const xOf = (ply: number): number => ply / n;

  // Carry the last known eval forward across null scores. Terminal positions
  // (checkmate / game over) report no score, and a decisive game must not dip
  // back to "equal" at the end — it should hold at the winning side's level.
  let last = whiteWinProb(moves[0].scoreCpBefore);
  const points: ChartPoint[] = [{ ply: 0, x: 0, whiteProb: last }];
  const markers: ChartMarker[] = [];

  for (const ev of moves) {
    const whiteProb =
      ev.scoreCpAfter != null ? whiteWinProb(ev.scoreCpAfter) : last;
    last = whiteProb;
    const x = xOf(ev.ply);
    points.push({ ply: ev.ply, x, whiteProb });
    const kind = markerFor(ev);
    if (kind) markers.push({ ply: ev.ply, x, whiteProb, kind, san: ev.san });
  }

  return { points, markers, plyCount: n };
}

/**
 * Nearest ply (0..plyCount) for a pointer `x` within a chart of `width` pixels.
 * Isolated from the component so the scrub mapping can be unit-tested.
 */
export function plyAtX(x: number, width: number, plyCount: number): number {
  if (plyCount <= 0 || width <= 0 || !Number.isFinite(x)) return 0;
  const ply = Math.round((x / width) * plyCount);
  return Math.max(0, Math.min(plyCount, ply));
}
