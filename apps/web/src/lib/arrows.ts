/**
 * Pure geometry + data helpers for the best-move arrow overlay. Kept free of
 * React and store access so the SVG layer ({@link BestMoveArrows}) and the hook
 * ({@link useBestMoveArrows}) can be reasoned about and unit-tested in isolation.
 */
import type { EngineEval } from "@chess/shared";
import type { Orientation } from "@/store";
import { formatScore } from "@/lib/eval";

/** A single ranked candidate-move arrow to draw on the board. */
export interface ArrowSpec {
  /** Origin square in algebraic notation, e.g. `"e2"`. */
  from: string;
  /** Target square in algebraic notation, e.g. `"e4"`. */
  to: string;
  /** 1 = engine's best, 2/3 = the next candidates (drives width + lightness). */
  rank: 1 | 2 | 3;
  /** White-POV eval chip text, e.g. `"+1.4"`, `"−2.3"`, `"M3"`, `"−M3"`. */
  evalText: string;
}

/**
 * Center of a board square in the overlay's 0–8 coordinate space (one unit per
 * square), so arrow geometry is resolution-independent and orientation is a
 * coordinate transform rather than pixel measuring.
 *
 * White orientation: file a..h → x 0.5..7.5; rank 8..1 → y 0.5..7.5 (rank 8 at
 * top). Black orientation mirrors both axes so the board reads from Black's side.
 */
export function squareToXY(
  square: string,
  orientation: Orientation,
): { x: number; y: number } {
  const file = square.charCodeAt(0) - 97; // 'a' → 0 … 'h' → 7
  const rank = Number(square[1]) - 1; // '1' → 0 … '8' → 7

  if (orientation === "black") {
    return { x: 7 - file + 0.5, y: rank + 0.5 };
  }
  return { x: file + 0.5, y: 7 - rank + 0.5 };
}

/**
 * Build up to `count` ranked arrow specs from an engine evaluation. Takes the
 * first `count` already-rank-ordered `lines`, reads each `pv[0]` (UCI such as
 * `"e2e4"` or `"e7e8q"`), and derives `from`/`to` from its first four chars.
 * Lines whose `pv[0]` is missing or too short are skipped. Returns `[]` for an
 * undefined/empty eval or terminal positions (no lines).
 */
export function bestMoveArrows(
  evalResult: EngineEval | undefined,
  count = 3,
): ArrowSpec[] {
  if (!evalResult) return [];

  const arrows: ArrowSpec[] = [];
  for (let i = 0; i < Math.min(count, evalResult.lines.length); i++) {
    const line = evalResult.lines[i];
    const uci = line.pv[0];
    if (!uci || uci.length < 4) continue;

    arrows.push({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      rank: (i + 1) as 1 | 2 | 3,
      evalText: formatScore(line.scoreCp, line.mate) ?? "",
    });
  }
  return arrows;
}
