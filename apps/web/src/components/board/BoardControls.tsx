import { useMemo } from "react";
import {
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  FlipVertical2,
  AlertTriangle,
} from "lucide-react";
import type { MoveEval } from "@chess/shared";
import { Button } from "@/components/ui/button";
import { useAnalyzerStore } from "@/store";

/** The next ply (strictly after `from`) flagged as a mistake or blunder, or null. */
function nextMistakePly(
  analysis: MoveEval[] | null,
  from: number,
): number | null {
  if (!analysis) return null;
  for (const evaluation of analysis) {
    if (
      evaluation.ply > from &&
      (evaluation.classification === "mistake" ||
        evaluation.classification === "blunder")
    ) {
      return evaluation.ply;
    }
  }
  return null;
}

/**
 * Board navigation controls: first / previous / next / last ply, flip
 * orientation, and "jump to next mistake" (advances to the next ply classified
 * as a mistake or blunder by the game analysis). All wired to store actions.
 */
export function BoardControls() {
  const gotoPly = useAnalyzerStore((s) => s.gotoPly);
  const prevPly = useAnalyzerStore((s) => s.prevPly);
  const nextPly = useAnalyzerStore((s) => s.nextPly);
  const flip = useAnalyzerStore((s) => s.flip);
  const currentPly = useAnalyzerStore((s) => s.currentPly);
  const moveCount = useAnalyzerStore((s) => s.game?.moves.length ?? 0);
  const analysis = useAnalyzerStore((s) => s.analysis);

  const nextMistake = useMemo(
    () => nextMistakePly(analysis, currentPly),
    [analysis, currentPly],
  );

  const atStart = currentPly <= 0;
  const atEnd = currentPly >= moveCount;

  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      <Button
        variant="outline"
        size="icon"
        onClick={() => gotoPly(0)}
        disabled={atStart}
        aria-label="First move"
      >
        <ChevronFirst />
      </Button>
      <Button
        variant="outline"
        size="icon"
        onClick={prevPly}
        disabled={atStart}
        aria-label="Previous move"
      >
        <ChevronLeft />
      </Button>
      <span className="min-w-16 text-center text-sm text-muted-foreground tabular-nums">
        {currentPly} / {moveCount}
      </span>
      <Button
        variant="outline"
        size="icon"
        onClick={nextPly}
        disabled={atEnd}
        aria-label="Next move"
      >
        <ChevronRight />
      </Button>
      <Button
        variant="outline"
        size="icon"
        onClick={() => gotoPly(moveCount)}
        disabled={atEnd}
        aria-label="Last move"
      >
        <ChevronLast />
      </Button>
      <Button
        variant="outline"
        size="icon"
        onClick={flip}
        aria-label="Flip board"
      >
        <FlipVertical2 />
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => nextMistake !== null && gotoPly(nextMistake)}
        disabled={nextMistake === null}
        aria-label="Jump to next mistake"
      >
        <AlertTriangle />
        Next mistake
      </Button>
    </div>
  );
}
