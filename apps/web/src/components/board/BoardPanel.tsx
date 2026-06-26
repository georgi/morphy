import { useMemo, useState, type CSSProperties } from "react";
import { useBoardShortcuts } from "@/hooks/useBoardShortcuts";
import { toast } from "sonner";
import { Chess } from "chess.js";
import {
  Chessboard,
  type ChessboardOptions,
  type Arrow,
  type PieceDropHandlerArgs,
} from "react-chessboard";
import { useAnalyzerStore, currentFen, currentNode } from "@/store";
import { EvalBar } from "@/components/board/EvalBar";
import { BoardControls } from "@/components/board/BoardControls";
import { BestMoveArrows } from "@/components/board/BestMoveArrows";
import { CoachBanner } from "@/components/coach/CoachBanner";
import { useBestMoveArrows } from "@/hooks/useBestMoveArrows";
import * as api from "@/lib/api";

/** Ember accent for the coach-reveal arrow (DESIGN.md, rank-1 best-move color). */
const EMBER = "oklch(0.63 0.14 48)";

/**
 * Current-move highlight: the square the piece came from is a deep/dark yellow,
 * the square it landed on a bright yellow — so the move just made (or navigated
 * to) always reads at a glance, even after the slide animation settles.
 */
const MOVE_FROM_STYLE: CSSProperties = { backgroundColor: "oklch(0.66 0.13 88)" };
const MOVE_TO_STYLE: CSSProperties = { backgroundColor: "oklch(0.90 0.18 102)" };

/** Per-square styles for the current move's from/to, or undefined when there is none. */
function moveSquareStyles(
  move: { from: string; to: string } | null,
): Record<string, CSSProperties> | undefined {
  if (!move) return undefined;
  return { [move.from]: MOVE_FROM_STYLE, [move.to]: MOVE_TO_STYLE };
}

/**
 * SAN best move (e.g. "Nf3", "exd8=Q") played from `fen` → an ember arrow, or
 * null if the move doesn't apply. Squares are derived client-side via chess.js.
 */
function sanArrow(fen: string, san: string | null): Arrow | null {
  if (!san) return null;
  try {
    const move = new Chess(fen).move(san);
    return { startSquare: move.from, endSquare: move.to, color: EMBER };
  } catch {
    return null;
  }
}

/**
 * Drop handler for quiz mode: validate from→to against `coach.current.fen` with
 * chess.js (auto-queening promotions). An illegal move returns false so the
 * piece snaps back; a legal one is sent to the agent as the user's guess.
 */
function onCoachDrop({
  sourceSquare,
  targetSquare,
}: PieceDropHandlerArgs): boolean {
  const store = useAnalyzerStore.getState();
  const question = store.coach.current;
  if (!question || !targetSquare) return false;

  let san: string;
  try {
    const move = new Chess(question.fen).move({
      from: sourceSquare,
      to: targetSquare,
      promotion: "q",
    });
    san = move.san;
  } catch {
    // chess.js throws on illegal moves — snap the piece back.
    return false;
  }

  const text = `I'd play ${san}.`;
  store.appendUserMessage(text);
  store.startAssistantMessage();
  api
    .sendAgentMessage(store.sessionId, {
      text,
      gameId: question.gameId,
      ply: question.ply,
    })
    .catch((err: unknown) => {
      const message =
        err instanceof Error ? err.message : "Failed to reach the analyst.";
      toast.error(message);
      useAnalyzerStore.getState().endAssistantMessage();
    });
  return true;
}

/**
 * Normal-mode drop: play `from→to` on the current tree node via the store. An
 * illegal move returns false so react-chessboard snaps the piece back; a legal
 * one appends/navigates a tree node (variation or existing continuation). All
 * validation lives in the store's `playMove` (chess.js, auto-queen).
 */
function onFreeMoveDrop({ sourceSquare, targetSquare }: PieceDropHandlerArgs): boolean {
  if (!targetSquare) return false;
  return useAnalyzerStore.getState().playMove({ from: sourceSquare, to: targetSquare });
}

/**
 * Left column: vertical eval bar + analysis board + nav controls.
 *
 * Outside an interactive review the board is read-only: it follows the store's
 * `currentFen` selector and `orientation`, and the {@link BestMoveArrows} SVG
 * overlay (fed by {@link useBestMoveArrows}) draws the engine's ranked top moves
 * for the current position. The library's own `arrows` prop is left empty in this
 * mode — the overlay replaces the old single green best-move arrow. During a
 * review (`coach.mode`):
 * - `question` → the board shows the turning point and pieces become draggable
 *   so the user can play a better move (validated + sent in {@link onCoachDrop}).
 * - `reveal`   → the board stays on the reviewed position and draws the engine's
 *   best move as a single ember library arrow (the overlay self-suppresses here,
 *   since the hook yields `[]` during coach modes).
 * The {@link CoachBanner} sits above the board in both review modes.
 */
export function BoardPanel() {
  const fen = useAnalyzerStore(currentFen);
  const orientation = useAnalyzerStore((s) => s.orientation);
  const coach = useAnalyzerStore((s) => s.coach);
  const agentFen = useAnalyzerStore((s) => s.agentFen);
  const arrows = useBestMoveArrows();
  // Eval chips on the arrows are revealed only while the board is hovered.
  const [hoverBoard, setHoverBoard] = useState(false);

  // The current move's UCI (a stable primitive — selecting an object here would
  // churn the store subscription). No highlight at the root or off-tree (agent).
  const moveUci = useAnalyzerStore((s) =>
    s.agentFen ? null : (currentNode(s).move?.uci ?? null),
  );
  const lastMove = useMemo(
    () =>
      moveUci ? { from: moveUci.slice(0, 2), to: moveUci.slice(2, 4) } : null,
    [moveUci],
  );

  // ←/→ step, ↑/↓ (Home/End) jump to start/end, f flip, a arrows, m next mistake.
  useBoardShortcuts();

  const options: ChessboardOptions = useMemo(() => {
    const base: ChessboardOptions = {
      boardOrientation: orientation,
      allowDrawingArrows: false,
      showAnimations: true,
      animationDurationInMs: 200,
      clearArrowsOnPositionChange: true,
      // Warm "Lamplit Study" board (DESIGN.md §2). The CSS vars resolve through
      // the DOM, so the squares track the active theme; notation is drawn in the
      // opposite square's tint so coordinates stay legible against the felt.
      lightSquareStyle: { backgroundColor: "var(--board-light)" },
      darkSquareStyle: { backgroundColor: "var(--board-dark)" },
      lightSquareNotationStyle: { color: "var(--board-dark)" },
      darkSquareNotationStyle: { color: "var(--board-light)" },
      showNotation: true,
    };

    if (coach.mode === "question" && coach.current) {
      return {
        ...base,
        position: coach.current.fen,
        allowDragging: true,
        onPieceDrop: onCoachDrop,
      };
    }

    if (coach.mode === "reveal" && coach.current) {
      const arrow = sanArrow(
        coach.current.fen,
        coach.lastReveal?.bestMove ?? null,
      );
      return {
        ...base,
        position: coach.current.fen,
        allowDragging: false,
        arrows: arrow ? [arrow] : [],
      };
    }

    // Normal review: the SVG overlay owns the best-move arrows (library `arrows`
    // stays empty). The board is draggable so the user can branch off any move;
    // it yields (no dragging) while the agent is driving an off-game position.
    const draggable = agentFen == null;
    return {
      ...base,
      position: fen,
      allowDragging: draggable,
      onPieceDrop: draggable ? onFreeMoveDrop : undefined,
      arrows: [],
      // Yellow from/to highlight so the current move always reads (the piece
      // slides in via showAnimations, then the squares keep it marked).
      squareStyles: moveSquareStyles(lastMove),
    };
  }, [fen, orientation, coach, agentFen, lastMove]);

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      {coach.mode !== "idle" && <CoachBanner />}
      <div className="flex min-h-0 flex-1 items-center justify-center [container-type:size]">
        {/* The board fills the pane: it's sized to the largest square that fits
            in BOTH axes — height by the pane height (100cqh), width by the pane
            width minus the eval bar (w-6) and its gap (gap-3) = 2.25rem. So the
            board grows with the panel instead of stopping at a fixed cap, while
            never overflowing the pane vertically. */}
        <div
          className="flex items-stretch gap-3"
          style={{ height: "min(100cqh, 100cqw - 2.25rem)" }}
        >
          <EvalBar />
          <div
            className="relative aspect-square h-full shrink-0"
            onPointerEnter={() => setHoverBoard(true)}
            onPointerLeave={() => setHoverBoard(false)}
          >
            <Chessboard options={options} />
            <BestMoveArrows
              arrows={arrows}
              orientation={orientation}
              showEvals={hoverBoard}
            />
          </div>
        </div>
      </div>
      <BoardControls />
    </div>
  );
}
