import { useAnalyzerStore, currentFen, currentNode, currentMainlinePly } from "@/store";
import { winProbability, formatScore } from "@/lib/eval";

/**
 * Vertical engine evaluation bar.
 *
 * Engine scores are already White-POV (`scoreCp`/`mate` from `toEngineEval` and
 * the move list's `scoreCpAfter`), so we read them directly — no side-to-move
 * flip. The fill height comes from a sigmoid (centipawns → win probability);
 * forced mates clamp the bar fully to the winning side. A compact numeric
 * readout (e.g. `+1.4`, `M3`) sits at the top or bottom depending on who stands
 * better.
 *
 * The eval is read from `evalByPly[currentPly]` (the full-game scan); when that
 * is absent — agent variations, manual FEN setups, mid-navigation — it falls
 * back to `arrowEvalByFen[currentFen]`, the same White-POV source that feeds the
 * best-move arrows, so the bar and the #1 arrow always agree.
 */
export function EvalBar() {
  const currentPly = useAnalyzerStore(currentMainlinePly);
  const evaluation = useAnalyzerStore((s) => {
    const node = currentNode(s);
    // A mainline node may carry a full-scan eval keyed by its ply (root = 0);
    // a variation node never does, so it always falls through to the FEN cache.
    const mainEval = node.mainline ? s.evalByPly[currentMainlinePly(s)] : undefined;
    return mainEval ?? s.arrowEvalByFen[currentFen(s)];
  });
  const line = evaluation?.lines[0];

  const cp = line?.scoreCp ?? null;
  const mate = line?.mate ?? null;

  // Probability that White wins (0 = Black winning, 1 = White winning).
  let whiteProb: number;
  if (mate != null) whiteProb = mate > 0 ? 1 : 0;
  else if (cp != null) whiteProb = winProbability(cp);
  else whiteProb = 0.5;

  const hasEval = line != null;
  const whitePct = whiteProb * 100;

  const readout = formatScore(cp, mate) ?? "–";
  const whiteAdvantage =
    mate != null ? mate > 0 : cp != null ? cp >= 0 : whiteProb >= 0.5;

  return (
    <div
      className="relative flex h-full w-6 flex-col overflow-hidden rounded [background:var(--eval-track)]"
      data-ply={currentPly}
      role="img"
      aria-label={`Engine evaluation ${readout}`}
      title={hasEval ? readout : "No evaluation"}
    >
      {/* White fill grows from the bottom. */}
      <div
        className="mt-auto w-full transition-[height] duration-200 ease-out [background:var(--eval-white)]"
        style={{ height: `${whitePct}%` }}
      />
      {hasEval && (
        <span
          className={
            "pointer-events-none absolute inset-x-0 text-center text-[9px] font-semibold tabular-nums " +
            // The readout sits over the side that's ahead, tinted to contrast
            // with that fill in either theme: over the light `--eval-white` fill
            // it uses the dark track tone; over the dark track, the white tone.
            (whiteAdvantage
              ? "bottom-0.5 [color:var(--eval-track)]"
              : "top-0.5 [color:var(--eval-white)]")
          }
        >
          {readout}
        </span>
      )}
    </div>
  );
}
