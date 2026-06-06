import { Badge } from "@/components/ui/badge";
import { useAnalyzerStore } from "@/store";
import type { GameHeaders } from "@chess/shared";

/**
 * Read a header field by its string key, treating blank strings as absent so the
 * UI can fall back gracefully. PGN exports routinely emit `"?"` placeholders for
 * unknown tags; those are dropped too.
 */
function field(headers: GameHeaders, key: string): string | undefined {
  const raw = headers[key]?.trim();
  if (!raw || raw === "?") return undefined;
  return raw;
}

/** Join the present parts with a separator, skipping empties. */
function joinParts(parts: Array<string | undefined>, sep: string): string {
  return parts.filter((p): p is string => Boolean(p)).join(sep);
}

/**
 * One player line: a side dot (○ outline for White, ● filled for Black), the
 * name (falling back to the side label), and the rating when known.
 */
function Player({
  dot,
  name,
  rating,
}: {
  dot: string;
  name: string;
  rating?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className="text-muted-foreground">
        {dot}
      </span>
      <span className="font-medium text-foreground">{name}</span>
      {rating && (
        <span className="font-mono text-sm text-muted-foreground tabular-nums">
          {rating}
        </span>
      )}
    </span>
  );
}

/**
 * Compact header for the active game: the two players with color dots and
 * ratings, a result badge, and a muted subtitle of opening · event/site, date.
 * Purely presentational; degrades gracefully when PGN tags are missing.
 */
export function GameHeader() {
  const game = useAnalyzerStore((s) => s.game);
  if (!game) return null;

  const { headers } = game;
  const white = field(headers, "white") ?? "White";
  const black = field(headers, "black") ?? "Black";
  const whiteElo = field(headers, "whiteElo");
  const blackElo = field(headers, "blackElo");
  const result = field(headers, "result");

  const eco = field(headers, "eco");
  const opening = field(headers, "opening");
  const venue = field(headers, "event") ?? field(headers, "site");
  const date = field(headers, "date");

  // "{eco} {opening}" then " · {venue}" then ", {date}" — each part optional.
  const openingLine = joinParts([eco, opening], " ");
  const venueDate = joinParts([venue, date], ", ");
  const subtitle = joinParts([openingLine, venueDate], " · ");

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          {/* ○ outline dot = White, ● filled dot = Black. */}
          <Player dot="○" name={white} rating={whiteElo} />
          <span className="text-muted-foreground">vs</span>
          <Player dot="●" name={black} rating={blackElo} />
        </div>
        {result && (
          <Badge
            variant="secondary"
            className="shrink-0 border-border font-mono tabular-nums"
          >
            {result}
          </Badge>
        )}
      </div>
      {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
    </div>
  );
}
