import { useAnalyzerStore, currentFen } from "@/store";

/** Logistic mapping from white-relative centipawns to a 0..1 win probability. */
function winProbability(cp: number): number {
  return 1 / (1 + Math.exp(-cp / 350));
}

/** Which side is to move in `fen` ("w" | "b"). Defaults to white if unparseable. */
function sideToMove(fen: string): "w" | "b" {
  return fen.split(" ")[1] === "b" ? "b" : "w";
}

/**
 * Vertical engine evaluation bar.
 *
 * Engine scores are reported from the side-to-move's perspective; we re-orient
 * them to White so the bar is stable as you step through the game. The fill
 * height comes from a sigmoid (centipawns → win probability); forced mates clamp
 * the bar fully to the winning side. A compact numeric readout (e.g. `+1.4`,
 * `M3`) sits at the top or bottom depending on who stands better.
 */
export function EvalBar() {
  const currentPly = useAnalyzerStore((s) => s.currentPly);
  const fen = useAnalyzerStore(currentFen);
  const evaluation = useAnalyzerStore((s) => s.evalByPly[s.currentPly]);
  const line = evaluation?.lines[0];

  const stm = sideToMove(fen);
  const sign = stm === "w" ? 1 : -1;

  const cp = line?.scoreCp != null ? line.scoreCp * sign : null;
  const mate = line?.mate != null ? line.mate * sign : null;

  // Probability that White wins (0 = Black winning, 1 = White winning).
  let whiteProb: number;
  if (mate != null) whiteProb = mate > 0 ? 1 : 0;
  else if (cp != null) whiteProb = winProbability(cp);
  else whiteProb = 0.5;

  const hasEval = line != null;
  const whitePct = whiteProb * 100;

  let readout = "–";
  let whiteAdvantage = whiteProb >= 0.5;
  if (mate != null) {
    readout = `M${Math.abs(mate)}`;
    whiteAdvantage = mate > 0;
  } else if (cp != null) {
    const pawns = cp / 100;
    readout = `${pawns >= 0 ? "+" : "−"}${Math.abs(pawns).toFixed(1)}`;
    whiteAdvantage = cp >= 0;
  }

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
