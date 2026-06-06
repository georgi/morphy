import { useAnalyzerStore, currentFen } from "@/store";
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
  const currentPly = useAnalyzerStore((s) => s.currentPly);
  const evaluation = useAnalyzerStore(
    (s) => s.evalByPly[s.currentPly] ?? s.arrowEvalByFen[currentFen(s)],
  );
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
      className="relative flex h-full w-6 flex-col overflow-hidden rounded bg-zinc-800"
      data-ply={currentPly}
      role="img"
      aria-label={`Engine evaluation ${readout}`}
      title={hasEval ? readout : "No evaluation"}
    >
      {/* White fill grows from the bottom. */}
      <div
        className="mt-auto w-full bg-zinc-100 transition-[height] duration-200 ease-out"
        style={{ height: `${whitePct}%` }}
      />
      {hasEval && (
        <span
          className={
            "pointer-events-none absolute inset-x-0 text-center text-[9px] font-semibold tabular-nums " +
            (whiteAdvantage
              ? "bottom-0.5 text-zinc-800"
              : "top-0.5 text-zinc-100")
          }
        >
          {readout}
        </span>
      )}
    </div>
  );
}
