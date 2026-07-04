import type { GameHeaders } from "@chess/shared";
import { cn } from "@/lib/utils";

/** Board orientation — the side shown at the bottom (matches react-chessboard). */
type Orientation = "white" | "black";

/**
 * Read a header field by key, treating blank strings and PGN `"?"` placeholders as
 * absent so the plate can fall back to the side label.
 */
function field(headers: GameHeaders, key: string): string | undefined {
  const raw = headers[key]?.trim();
  if (!raw || raw === "?") return undefined;
  return raw;
}

/** One resolved plate: which side it is, its name (or side label), and rating. */
export interface BoardPlayer {
  color: "white" | "black";
  name: string;
  rating?: string;
}

/** Resolve a side to its display plate from the PGN headers. */
function playerFor(headers: GameHeaders, color: "white" | "black"): BoardPlayer {
  const label = color === "white" ? "White" : "Black";
  return {
    color,
    name: field(headers, color) ?? label,
    rating: field(headers, `${color}Elo`),
  };
}

/**
 * The two plates to show around the board, oriented like every chess UI: the side
 * you are viewing from (`orientation`) sits on the bottom, the opponent on top. So
 * flipping the board (which flips `orientation`) swaps the names too.
 */
export function boardPlayers(
  headers: GameHeaders,
  orientation: Orientation,
): { top: BoardPlayer; bottom: BoardPlayer } {
  const bottom = orientation === "white" ? "white" : "black";
  const top = bottom === "white" ? "black" : "white";
  return {
    top: playerFor(headers, top),
    bottom: playerFor(headers, bottom),
  };
}

/**
 * A single name plate for above/below the board: a side dot (○ White, ● Black), the
 * name, and the rating when known. Matches the review header's `Player` styling.
 */
export function BoardPlayerPlate({
  player,
  className,
}: {
  player: BoardPlayer;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 px-1 text-sm leading-none",
        className,
      )}
    >
      <span aria-hidden className="text-muted-foreground">
        {player.color === "white" ? "○" : "●"}
      </span>
      <span className="truncate font-medium text-foreground">
        {player.name}
      </span>
      {player.rating && (
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {player.rating}
        </span>
      )}
    </div>
  );
}
