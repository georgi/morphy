import { GameHeader } from "@/components/review/GameHeader";
import { KeyMoments } from "@/components/review/KeyMoments";
import { MoveList } from "@/components/moves/MoveList";
import { AdvantageChart } from "@/components/chart/AdvantageChart";

/**
 * A small uppercase section label, matching the "MOVES" / "ADVANTAGE" dividers
 * in the mockup: Plex-Sans label type, muted, with a hairline rule beneath.
 */
function SectionLabel({ children }: { children: string }) {
  return (
    <div className="border-b border-border px-4 py-2 text-[0.6875rem] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * The center review surface: the game's story top to bottom. Game header and
 * Key Moments sit at the top, the full move list scrolls in the middle (taking
 * all remaining height), and the advantage curve is pinned to the bottom so the
 * arc of the game is always in view while scrubbing the moves.
 */
export function ReviewPanel() {
  return (
    <div className="flex h-full flex-col bg-card">
      <div className="shrink-0 space-y-4 border-b border-border p-4">
        <GameHeader />
        <KeyMoments />
      </div>

      {/* MOVES — scrolls and absorbs all leftover vertical space. */}
      <SectionLabel>Moves</SectionLabel>
      <div className="min-h-0 flex-1">
        <MoveList />
      </div>

      {/* ADVANTAGE — pinned to the bottom, never scrolls away. */}
      <SectionLabel>Advantage</SectionLabel>
      <div className="shrink-0 p-3">
        <AdvantageChart />
      </div>
    </div>
  );
}
