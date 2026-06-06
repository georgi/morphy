/**
 * The "brain" behind the best-move arrow overlay: reads the current position
 * from the store and yields the ranked {@link ArrowSpec}s to draw, fetching a
 * live engine evaluation (cache-first, debounced) for positions that have none.
 */
import { useEffect, useMemo, useRef } from "react";

import { useAnalyzerStore, currentFen } from "@/store";
import { bestMoveArrows, type ArrowSpec } from "@/lib/arrows";
import * as api from "@/lib/api";

/** How long the live FEN must stay put before we spend an engine call on it. */
const DEBOUNCE_MS = 250;

/**
 * Best-move arrows for the current board position.
 *
 * Gating (returns `[]`, the "yield to agent/coach" rule): the toggle is off, a
 * coach review is in progress (`coach.mode !== "idle"`), or the agent is driving
 * an off-game variation (`agentFen != null`).
 *
 * Otherwise cache-first: if `arrowEvalByFen[fen]` is present it is used straight
 * away; on a miss a debounced MultiPV-3 / depth-14 analysis is fetched and
 * stored under its FEN. Because results are keyed by FEN, a late/slow response
 * can never paint the wrong position. Errors (e.g. no Stockfish, 503) are
 * swallowed: the board must never break.
 */
export function useBestMoveArrows(): ArrowSpec[] {
  const fen = useAnalyzerStore(currentFen);
  const arrowsEnabled = useAnalyzerStore((s) => s.arrowsEnabled);
  const coachMode = useAnalyzerStore((s) => s.coach.mode);
  const agentFen = useAnalyzerStore((s) => s.agentFen);
  const evaluation = useAnalyzerStore((s) => s.arrowEvalByFen[fen]);
  const setArrowEval = useAnalyzerStore((s) => s.setArrowEval);

  const gated = !arrowsEnabled || coachMode !== "idle" || agentFen != null;

  // FENs with an analysis request currently in flight, so rapid stepping (and
  // the cache miss → fetch race) never spawns duplicate calls for one position.
  const inFlight = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (gated || evaluation || inFlight.current.has(fen)) return;

    const timer = setTimeout(() => {
      inFlight.current.add(fen);
      api
        .analyzePosition({ fen, multipv: 3, depth: 14 })
        .then((result) => setArrowEval(fen, result))
        .catch(() => {
          // No arrows for this position; the board stays intact.
        })
        .finally(() => {
          inFlight.current.delete(fen);
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
    // `evaluation` is intentionally excluded: once it lands the early-return on
    // re-render covers it, and including it would re-arm the debounce on every
    // cache write. Keyed on the position + gate per the spec's data flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fen, gated]);

  // Memoized so referential identity is stable while inputs are unchanged,
  // keeping the SVG overlay from re-rendering on unrelated store updates.
  return useMemo(
    () => (gated ? [] : bestMoveArrows(evaluation)),
    [gated, evaluation],
  );
}
