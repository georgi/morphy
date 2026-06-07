import { useEffect } from "react";
import type { MoveEval } from "@chess/shared";
import { useAnalyzerStore } from "@/store";

/** First ply strictly after `from` flagged a mistake/blunder, or null. */
function nextMistakePly(analysis: MoveEval[] | null, from: number): number | null {
  if (!analysis) return null;
  for (const e of analysis) {
    if (
      e.ply > from &&
      (e.classification === "mistake" || e.classification === "blunder")
    ) {
      return e.ply;
    }
  }
  return null;
}

/**
 * Global keyboard shortcuts for the analysis board. Installed once; the handler
 * reads the store fresh per keystroke (no stale closure, stable listener). It is
 * inert while the user is typing in a field, while a modifier is held, or during
 * a coach review (the board is pinned to a fixed position then).
 *
 *   ← / →        previous / next move
 *   ↑ / Home     jump to the start
 *   ↓ / End      jump to the end
 *   f            flip the board
 *   a            toggle the best-move arrows
 *   m            jump to the next mistake
 */
export function useBoardShortcuts(): void {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }

      const store = useAnalyzerStore.getState();
      if (store.coach.mode !== "idle") return;

      const lastPly = store.game?.moves.length ?? 0;
      let handled = true;

      switch (e.key) {
        case "ArrowLeft":
          store.prevPly();
          break;
        case "ArrowRight":
          store.nextPly();
          break;
        case "ArrowUp":
        case "Home":
          store.gotoPly(0);
          break;
        case "ArrowDown":
        case "End":
          store.gotoPly(lastPly);
          break;
        default: {
          switch (e.key.toLowerCase()) {
            case "f":
              store.flip();
              break;
            case "a":
              store.toggleArrows();
              break;
            case "m": {
              const ply = nextMistakePly(store.analysis, store.currentPly);
              if (ply !== null) store.gotoPly(ply);
              break;
            }
            default:
              handled = false;
          }
        }
      }

      if (handled) e.preventDefault();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
