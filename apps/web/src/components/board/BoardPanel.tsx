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
import { CoachBanner } from "@/components/coach/CoachBanner";
import * as api from "@/lib/api";

/** UCI move (e.g. "e2e4", "g7g8q") → a green best-move arrow, or null if invalid. */
function bestMoveArrow(uci: string | null | undefined): Arrow | null {
  if (!uci || uci.length < 4) return null;
  return {
    startSquare: uci.slice(0, 2),
    endSquare: uci.slice(2, 4),
    color: "#15803d",
  };
}

/**
 * SAN best move (e.g. "Nf3", "exd8=Q") played from `fen` → a green arrow, or
 * null if the move doesn't apply. Squares are derived client-side via chess.js.
 */
function sanArrow(fen: string, san: string | null): Arrow | null {
  if (!san) return null;
  try {
    const move = new Chess(fen).move(san);
    return { startSquare: move.from, endSquare: move.to, color: "#15803d" };
  } catch {
    return null;
  }
}

/**
 * Drop handler for quiz mode: validate from→to against `coach.current.fen` with
 * chess.js (auto-queening promotions). An illegal move returns false so the
 * piece snaps back; a legal one is sent to the agent as the user's guess.
 */
function onCoachDrop({ sourceSquare, targetSquare }: PieceDropHandlerArgs): boolean {
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
 * `currentFen` selector and `orientation`, with a single best-move arrow drawn
 * from the current ply's evaluation. During a review (`coach.mode`):
 * - `question` → the board shows the turning point and pieces become draggable
 *   so the user can play a better move (validated + sent in {@link onCoachDrop}).
 * - `reveal`   → the board stays on the reviewed position and overlays the
 *   engine's best move as an arrow.
 * The {@link CoachBanner} sits above the board in both review modes.
 */
export function BoardPanel() {
  const fen = useAnalyzerStore(currentFen);
  const orientation = useAnalyzerStore((s) => s.orientation);
  const bestMove = useAnalyzerStore((s) => s.evalByPly[s.currentPly]?.bestMove);
  const coach = useAnalyzerStore((s) => s.coach);

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
      const arrow = sanArrow(coach.current.fen, coach.lastReveal?.bestMove ?? null);
      return {
        ...base,
        position: coach.current.fen,
        allowDragging: false,
        arrows: arrow ? [arrow] : [],
      };
    }

    const arrow = bestMoveArrow(bestMove);
    return {
      ...base,
      position: fen,
      allowDragging: false,
      arrows: arrow ? [arrow] : [],
    };
  }, [fen, orientation, bestMove, coach]);

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      {coach.mode !== "idle" && <CoachBanner />}
      <div className="flex min-h-0 flex-1 items-center justify-center gap-3">
        <EvalBar />
        <div className="aspect-square w-full max-w-[560px]">
          <Chessboard options={options} />
        </div>
      </div>
      <BoardControls />
    </div>
  );
}
