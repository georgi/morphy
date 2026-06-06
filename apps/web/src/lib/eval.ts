/**
 * Shared evaluation → win-probability mapping, used by both the vertical
 * {@link EvalBar} and the horizontal advantage chart so they stay consistent.
 */

/** Logistic mapping from White-relative centipawns to a 0..1 win probability. */
export function winProbability(cp: number): number {
  return 1 / (1 + Math.exp(-cp / 350));
}

/**
 * White win-probability (0 = Black winning … 1 = White winning) for a White-POV
 * score. A forced mate clamps fully to the mating side; a null score is even.
 * Engine scores that fold mate into a large centipawn value simply saturate the
 * sigmoid, so callers without an explicit `mate` can pass `null` and rely on that.
 */
export function whiteWinProb(
  scoreCp: number | null,
  mate: number | null = null,
): number {
  if (mate != null) return mate > 0 ? 1 : 0;
  if (scoreCp != null) return winProbability(scoreCp);
  return 0.5;
}

/**
 * Format a White-POV engine score as a compact readout, shared by the eval bar,
 * the move list, and the best-move arrow chips so they render identically.
 * `scoreCp`/`mate` are already White-POV: mate renders `M3` (White mating) or
 * `−M3` (Black mating); centipawns render `+1.4` / `−2.3` to one decimal, using
 * the U+2212 minus. Returns `null` when there is no score so each caller can
 * pick its own placeholder.
 */
export function formatScore(
  scoreCp: number | null,
  mate: number | null = null,
): string | null {
  if (mate != null) return mate > 0 ? `M${mate}` : `−M${Math.abs(mate)}`;
  if (scoreCp != null) {
    const pawns = scoreCp / 100;
    return `${pawns >= 0 ? "+" : "−"}${Math.abs(pawns).toFixed(1)}`;
  }
  return null;
}
