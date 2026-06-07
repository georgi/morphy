import { useMemo } from "react";
import {
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  FlipVertical2,
  AlertTriangle,
  Waypoints,
} from "lucide-react";
import type { MoveEval } from "@chess/shared";
import { Button } from "@/components/ui/button";
import { useAnalyzerStore, currentMainlinePly, currentNode } from "@/store";

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
  const arrowsEnabled = useAnalyzerStore((s) => s.arrowsEnabled);
  const toggleArrows = useAnalyzerStore((s) => s.toggleArrows);
  const currentPly = useAnalyzerStore(currentMainlinePly);
  const moveCount = useAnalyzerStore((s) => s.game?.moves.length ?? 0);
  const analysis = useAnalyzerStore((s) => s.analysis);
  // Start/end are tree facts: at the root there is no parent; at a leaf there is
  // no primary continuation. (atEnd covers variation leaves too, not just ply count.)
  const atRoot = useAnalyzerStore((s) => currentNode(s).parentId === null);
  const atLeaf = useAnalyzerStore((s) => currentNode(s).children[0] === undefined);

  const nextMistake = useMemo(
    () => nextMistakePly(analysis, currentPly),
    [analysis, currentPly],
  );

  const atStart = atRoot;
  const atEnd = atLeaf;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      {/* Left: navigation cluster — first / prev / counter / next / last */}
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => gotoPly(0)}
          disabled={atStart}
          aria-label="First move"
        >
          <ChevronFirst />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={prevPly}
          disabled={atStart}
          aria-label="Previous move"
        >
          <ChevronLeft />
        </Button>
        <span className="min-w-16 text-center font-mono text-sm text-muted-foreground tabular-nums">
          {currentPly} / {moveCount}
        </span>
        <Button
          variant="ghost"
          size="icon"
          onClick={nextPly}
          disabled={atEnd}
          aria-label="Next move"
        >
          <ChevronRight />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => gotoPly(moveCount)}
          disabled={atEnd}
          aria-label="Last move"
        >
          <ChevronLast />
        </Button>
      </div>

      {/* Right: ember-outline flip, arrows toggle, and next-mistake */}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          onClick={flip}
          aria-label="Flip board"
          className="border-primary text-primary hover:bg-primary/10 hover:text-primary"
        >
          <FlipVertical2 />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleArrows}
          aria-pressed={arrowsEnabled}
          aria-label="Toggle best-move arrows"
          className={arrowsEnabled ? "bg-primary/10 text-primary" : undefined}
        >
          <Waypoints />
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
    </div>
  );
}
