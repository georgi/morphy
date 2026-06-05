import { Check, Target, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAnalyzerStore } from "@/store";

/** Short, human label for each reveal verdict. */
const VERDICT_LABEL = {
  correct: "Correct",
  close: "Close",
  off: "Not quite",
  revealed: "Revealed",
} as const;

/**
 * Compact status banner that sits near the board during an interactive review.
 * - `question` mode → whose turn it is plus the review progress.
 * - `reveal`   mode → a ✓/✗ verdict with the engine's best move.
 * - `idle`     mode → nothing.
 */
export function CoachBanner() {
  const coach = useAnalyzerStore((s) => s.coach);

  if (coach.mode === "question" && coach.current) {
    const { sideToMove, index, total } = coach.current;
    const side = sideToMove === "w" ? "White" : "Black";
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border bg-primary/10 px-3 py-2 text-sm">
        <span className="flex items-center gap-2 font-medium text-primary">
          <Target className="size-4 shrink-0" />
          Your turn — find a better move for {side}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {index + 1} / {total}
        </span>
      </div>
    );
  }

  if (coach.mode === "reveal" && coach.lastReveal) {
    const { verdict, bestMove } = coach.lastReveal;
    const good = verdict === "correct" || verdict === "close";
    return (
      <div
        className={cn(
          "flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm",
          good
            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            : "bg-destructive/10 text-destructive",
        )}
      >
        <span className="flex items-center gap-2 font-medium">
          {good ? (
            <Check className="size-4 shrink-0" />
          ) : (
            <X className="size-4 shrink-0" />
          )}
          {VERDICT_LABEL[verdict]}
        </span>
        {bestMove && (
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            Best: {bestMove}
          </span>
        )}
      </div>
    );
  }

  return null;
}
