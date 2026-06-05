/**
 * Split a multi-game PGN string into individual single-game PGN strings.
 *
 * PGN has no length-prefixing: games are delimited structurally. A new game
 * begins at a **header tag line** (`[Event "…"]`) that follows the previous
 * game's movetext across a blank line. We therefore scan line by line and start
 * a new game whenever a header tag appears *after* we have already seen movetext
 * for the current game — exactly the boundary `ChessService.normalizePgn` uses
 * to keep only the first game.
 *
 * Robustness this must preserve (proven by `lichess_import_probe.mjs` and
 * `adversarial-chesscom.mjs`):
 *  - CRLF line endings (Windows downloads) — normalized to LF.
 *  - Header tags inside comments are NOT real headers — a `[` only starts a
 *    header when it is the first non-space character of a line *and* the line is
 *    structurally a tag; movetext lines beginning with a brace comment that
 *    contains `[%clk …]` never start with `[` at column 0 after trimming because
 *    they are part of a movetext line. We additionally require the tag shape
 *    `[A-Za-z…  "…"]` so `[%eval]`-style content is excluded.
 *  - A run of consecutive header lines belongs to one game's header block; only
 *    the *first* header after movetext opens a new game.
 *  - Movetext-only paste (no headers at all) yields exactly one game.
 *  - Comments / variations / NAGs / blank lines inside a game are passed through
 *    untouched (the downstream parser handles them).
 */

/** Matches a structurally valid PGN header tag line, e.g. `[White "Carlsen"]`. */
const HEADER_LINE = /^\[[A-Za-z][A-Za-z0-9_]*\s+"[^]*"\s*\]\s*$/;

/** A line that carries movetext (move numbers, SAN, results, comments, RAVs). */
function isMovetextLine(line: string): boolean {
  const t = line.trim();
  if (t.length === 0) return false;
  return !HEADER_LINE.test(t);
}

/**
 * Split `text` into single-game PGN strings. Whitespace-only input yields an
 * empty array. Each returned game is trimmed of leading/trailing blank lines but
 * otherwise byte-for-byte the original content.
 */
export function splitPgn(text: string): string[] {
  // Normalize line endings; keep content otherwise intact.
  const normalized = text.replace(/\r\n?/g, '\n');
  if (normalized.trim().length === 0) return [];

  const lines = normalized.split('\n');
  const games: string[] = [];
  let current: string[] = [];
  // Whether the in-progress game has already accumulated movetext. A header tag
  // is only a *boundary* once movetext has been seen for the current game.
  let sawMovetext = false;

  const flush = (): void => {
    const game = current.join('\n').trim();
    if (game.length > 0) games.push(game);
    current = [];
    sawMovetext = false;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const isHeader = HEADER_LINE.test(trimmed);

    if (isHeader && sawMovetext) {
      // Header after movetext → the previous game ended; start a new one.
      flush();
    }

    current.push(line);
    if (isMovetextLine(line)) sawMovetext = true;
  }
  flush();

  return games;
}

/** Class wrapper so the splitter can be injected / mocked like the sources. */
export class PgnSplitter {
  split(text: string): string[] {
    return splitPgn(text);
  }
}
