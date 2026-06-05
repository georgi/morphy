import { useEffect, useMemo, useRef } from "react";
import type { Move, MoveClassification, MoveEval } from "@chess/shared";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAnalyzerStore } from "@/store";
import { cn } from "@/lib/utils";

/** A single move-number row: the white ply and (optionally) the black ply. */
interface MoveRow {
  moveNumber: number;
  white?: Move;
  black?: Move;
}

/** Glyph + tone for the classifications worth surfacing in the move list. */
const CLASSIFICATION_GLYPH: Partial<Record<MoveClassification, string>> = {
  inaccuracy: "?!",
  mistake: "?",
  blunder: "??",
};

/** Text color for a classified move. Blunders/mistakes get the strongest tone. */
function classificationColor(c: MoveClassification): string {
  switch (c) {
    case "blunder":
      return "text-destructive";
    case "mistake":
      return "text-orange-500 dark:text-orange-400";
    case "inaccuracy":
      return "text-yellow-600 dark:text-yellow-500";
    default:
      return "";
  }
}

/** Format a centipawn score from White's perspective as a +/- pawn readout. */
function formatEval(evaluation: MoveEval): string | null {
  if (evaluation.scoreCpAfter === null) return null;
  const pawns = evaluation.scoreCpAfter / 100;
  const sign = pawns > 0 ? "+" : "";
  return `${sign}${pawns.toFixed(1)}`;
}

/** Group the flat ply list into White/Black rows keyed by move number. */
function toRows(moves: Move[]): MoveRow[] {
  const rows: MoveRow[] = [];
  let current: MoveRow | undefined;
  for (const move of moves) {
    if (move.color === "w" || !current || current.moveNumber !== move.moveNumber) {
      current = { moveNumber: move.moveNumber };
      rows.push(current);
    }
    if (move.color === "w") current.white = move;
    else current.black = move;
  }
  return rows;
}

/** A single clickable ply cell, with optional classification glyph + eval. */
function MoveCell({
  move,
  evaluation,
  active,
  onSelect,
  activeRef,
}: {
  move: Move;
  evaluation?: MoveEval;
  active: boolean;
  onSelect: (ply: number) => void;
  activeRef: React.Ref<HTMLButtonElement>;
}) {
  const classification = evaluation?.classification;
  const glyph = classification ? CLASSIFICATION_GLYPH[classification] : undefined;
  const evalText = evaluation ? formatEval(evaluation) : null;
  const color = classification ? classificationColor(classification) : "";

  return (
    <button
      ref={active ? activeRef : undefined}
      type="button"
      onClick={() => onSelect(move.ply)}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex w-full items-baseline gap-1 rounded px-2 py-1 text-left tabular-nums hover:bg-accent",
        active && "bg-accent font-medium",
      )}
    >
      <span className={cn("truncate", color)}>
        {move.san}
        {glyph ? <span className="ml-0.5 font-semibold">{glyph}</span> : null}
      </span>
      {evalText ? (
        <span className="ml-auto text-xs text-muted-foreground">{evalText}</span>
      ) : null}
    </button>
  );
}

/**
 * Middle column: the move list. Renders the game's plies in standard two-column
 * (White/Black) move-number rows, highlights the current ply, and navigates on
 * click. When analysis is present each move shows a classification glyph
 * (?! inaccuracy, ? mistake, ?? blunder) and its post-move eval; mistakes and
 * blunders are colored. The active move auto-scrolls into view.
 */
export function MoveList() {
  const moves = useAnalyzerStore((s) => s.game?.moves);
  const analysis = useAnalyzerStore((s) => s.analysis);
  const currentPly = useAnalyzerStore((s) => s.currentPly);
  const gotoPly = useAnalyzerStore((s) => s.gotoPly);

  const rows = useMemo(() => toRows(moves ?? []), [moves]);
  const evalByPly = useMemo(() => {
    const map = new Map<number, MoveEval>();
    for (const e of analysis ?? []) map.set(e.ply, e);
    return map;
  }, [analysis]);

  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [currentPly, rows]);

  if (!moves || moves.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        No game loaded.
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <ol className="flex flex-col p-2 text-sm">
        {rows.map((row) => (
          <li key={row.moveNumber} className="flex items-stretch gap-1">
            <span className="w-8 shrink-0 select-none py-1 pr-1 text-right text-muted-foreground">
              {row.moveNumber}.
            </span>
            <div className="grid min-w-0 flex-1 grid-cols-2 gap-1">
              {row.white ? (
                <MoveCell
                  move={row.white}
                  evaluation={evalByPly.get(row.white.ply)}
                  active={row.white.ply === currentPly}
                  onSelect={gotoPly}
                  activeRef={activeRef}
                />
              ) : (
                <span aria-hidden />
              )}
              {row.black ? (
                <MoveCell
                  move={row.black}
                  evaluation={evalByPly.get(row.black.ply)}
                  active={row.black.ply === currentPly}
                  onSelect={gotoPly}
                  activeRef={activeRef}
                />
              ) : (
                <span aria-hidden />
              )}
            </div>
          </li>
        ))}
      </ol>
    </ScrollArea>
  );
}
