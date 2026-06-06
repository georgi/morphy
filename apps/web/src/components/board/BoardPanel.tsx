import { useMemo } from "react";
import { toast } from "sonner";
import { Chess } from "chess.js";
import {
  Chessboard,
  type ChessboardOptions,
  type Arrow,
  type PieceDropHandlerArgs,
} from "react-chessboard";
import { useAnalyzerStore, currentFen } from "@/store";
import { EvalBar } from "@/components/board/EvalBar";
import { BoardControls } from "@/components/board/BoardControls";
import { BestMoveArrows } from "@/components/board/BestMoveArrows";
import { CoachBanner } from "@/components/coach/CoachBanner";
import { useBestMoveArrows } from "@/hooks/useBestMoveArrows";
import * as api from "@/lib/api";

/** Ember accent for the coach-reveal arrow (DESIGN.md, rank-1 best-move color). */
const EMBER = "oklch(0.63 0.14 48)";

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
  const arrows = useBestMoveArrows();

  const options: ChessboardOptions = useMemo(() => {
    const base: ChessboardOptions = {
      boardOrientation: orientation,
      allowDrawingArrows: false,
      showAnimations: true,
      animationDurationInMs: 200,
      clearArrowsOnPositionChange: true,
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

    // Normal review: the SVG overlay owns the best-move arrows, so the library's
    // `arrows` prop stays empty.
    return {
      ...base,
      position: fen,
      allowDragging: false,
      arrows: [],
    };
  }, [fen, orientation, coach]);

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      {coach.mode !== "idle" && <CoachBanner />}
      <div className="flex min-h-0 flex-1 items-center justify-center gap-3">
        <EvalBar />
        <div className="relative aspect-square w-full max-w-[560px]">
          <Chessboard options={options} />
          <BestMoveArrows arrows={arrows} orientation={orientation} />
        </div>
      </div>
      <BoardControls />
    </div>
  );
}
