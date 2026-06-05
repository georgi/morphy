import { BadRequestException, Injectable } from '@nestjs/common';
import { Chess, validateFen } from 'chess.js';
import type { Move as ChessJsMove } from 'chess.js';
import { v4 as uuidv4 } from 'uuid';
import type {
  Color,
  Game,
  GameHeaders,
  Move,
  MoveClassification,
} from '@chess/shared';
import { CLASSIFY_THRESHOLDS } from '@chess/shared';
import { ECO_TABLE, type EcoEntry } from './eco.data';

/** Centipawn values used for the material balance count. Kings are not counted. */
const PIECE_VALUES: Record<string, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
};

/** chess.js fills unknown PGN headers with these placeholders; we drop them. */
const PLACEHOLDER_HEADER_VALUES = new Set(['?', '????.??.??', '*']);

/** Figurine piece glyphs (white ♔♕♖♗♘ and black ♚♛♜♝♞) → SAN piece letters. */
const FIGURINE_TO_SAN: Record<string, string> = {
  '♔': 'K',
  '♕': 'Q',
  '♖': 'R',
  '♗': 'B',
  '♘': 'N',
  '♚': 'K',
  '♛': 'Q',
  '♜': 'R',
  '♝': 'B',
  '♞': 'N',
};

/**
 * Normalize real-world PGN quirks that chess.js's strict parser rejects but that
 * carry no information we need (we keep only moves + headers):
 *  - keep just the first game when several are concatenated,
 *  - strip `{ … }` movetext comments — chess.js 1.x rejects two *consecutive*
 *    comments, which Lichess emits per move as `{ [%clk …] } { D10 … }`,
 *  - convert figurine piece glyphs (♞ …) to SAN letters.
 * Header tags use `[ … ]` and are untouched by comment stripping.
 */
function normalizePgn(pgn: string): string {
  // A blank line followed by a header tag (`[Event "…`) starts the next game.
  const games = pgn.split(/\r?\n[ \t]*\r?\n(?=\[[A-Za-z][\w]*\s+")/);
  let text = games.length > 1 ? games[0] : pgn;
  text = text.replace(/\{[^}]*\}/g, ' ');
  text = text.replace(/[♔-♟]/g, (ch) => FIGURINE_TO_SAN[ch] ?? ch);
  return text.replace(/[ \t]+/g, ' ');
}

/**
 * Parse a 4/5-character UCI move (`e2e4`, `a7a8q`) into the `{from,to,promotion}`
 * shape chess.js's `move` accepts. Returns `null` for anything that isn't a
 * well-formed UCI move so callers treat it as illegal rather than crashing.
 */
function parseUci(
  uci: string,
): { from: string; to: string; promotion?: string } | undefined {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return undefined;
  const move: { from: string; to: string; promotion?: string } = {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
  };
  if (uci.length === 5) move.promotion = uci[4];
  return move;
}

export interface ApplySanResult {
  /** FEN after the move was applied. */
  fen: string;
  /** Descriptor of the move that was applied. */
  move: Pick<Move, 'san' | 'uci' | 'color' | 'fenBefore' | 'fenAfter'>;
}

export interface MaterialBalance {
  /** Total centipawn-equivalent value of White's pieces (pawns=1, N/B=3, R=5, Q=9). */
  white: number;
  /** Total value of Black's pieces. */
  black: number;
  /** `white - black`. Positive favors White. */
  diff: number;
}

export interface OpeningInfo {
  eco?: string;
  name?: string;
}

@Injectable()
export class ChessService {
  /**
   * Parse a PGN into a `Game` with ordered moves and resolved headers.
   * @throws BadRequestException on invalid PGN.
   */
  importPgn(pgn: string): Game {
    const chess = this.loadPgnTolerant(pgn);

    const verbose = chess.history({ verbose: true });
    const startFen = verbose.length > 0 ? verbose[0].before : chess.fen();
    const headers = this.extractHeaders(chess.getHeaders());
    const moves = verbose.map((m, index) => this.toMove(m, index));

    // Backfill an ECO/opening label if the PGN didn't carry one.
    if (!headers.eco || !headers.opening) {
      const opening = this.identifyOpeningFromSans(verbose.map((m) => m.san));
      if (opening.eco && !headers.eco) headers.eco = opening.eco;
      if (opening.name && !headers.opening) headers.opening = opening.name;
    }

    return {
      id: uuidv4(),
      headers,
      startFen,
      moves,
    };
  }

  /**
   * Load a PGN, tolerating real-world quirks. Tries the strict parse first (so
   * well-formed PGNs are unaffected) and, only on failure, retries against a
   * {@link normalizePgn normalized} movetext. Reports the original parse error
   * if both attempts fail.
   * @throws BadRequestException when the PGN cannot be parsed either way.
   */
  private loadPgnTolerant(pgn: string): Chess {
    try {
      const chess = new Chess();
      chess.loadPgn(pgn);
      return chess;
    } catch (err) {
      const normalized = normalizePgn(pgn);
      if (normalized !== pgn) {
        try {
          const chess = new Chess();
          chess.loadPgn(normalized);
          return chess;
        } catch {
          // Fall through and report the original (more representative) error.
        }
      }
      throw new BadRequestException(
        `Invalid PGN: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Build a `Game` from a single FEN (no moves yet — the position is the start).
   * @throws BadRequestException on invalid FEN.
   */
  importFen(fen: string): Game {
    this.assertValidFen(fen);
    // Normalize through chess.js so the stored FEN is canonical.
    const chess = new Chess(fen);
    return {
      id: uuidv4(),
      headers: {},
      startFen: chess.fen(),
      moves: [],
    };
  }

  /**
   * Legal moves (SAN) from a position.
   * @throws BadRequestException on invalid FEN.
   */
  legalMoves(fen: string): string[] {
    this.assertValidFen(fen);
    return new Chess(fen).moves();
  }

  /**
   * Apply a SAN move to a position.
   * @throws BadRequestException on invalid FEN or illegal/unparseable SAN.
   */
  applySan(fen: string, san: string): ApplySanResult {
    this.assertValidFen(fen);
    const chess = new Chess(fen);
    let applied: ChessJsMove;
    try {
      applied = chess.move(san);
    } catch (err) {
      throw new BadRequestException(
        `Illegal move "${san}" for position: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return {
      fen: applied.after,
      move: {
        san: applied.san,
        uci: applied.lan,
        color: applied.color as Color,
        fenBefore: applied.before,
        fenAfter: applied.after,
      },
    };
  }

  /**
   * Convert a single UCI move (e.g. `e2e4`, `a7a8q`) to SAN in the context of
   * `fen`. Returns `null` when the UCI is malformed or illegal for that position,
   * so callers can stop a line cleanly rather than throw.
   */
  uciToSan(fen: string, uci: string): string | null {
    const parsed = parseUci(uci);
    if (!parsed) return null;
    try {
      return new Chess(fen).move(parsed).san;
    } catch {
      return null;
    }
  }

  /**
   * Convert a UCI line to SAN, walking a single `Chess(fen)` and applying each
   * move in turn. Stops (returning the SAN collected so far) as soon as a move is
   * malformed or illegal, so a truncated/garbled tail never aborts the whole line.
   */
  uciLineToSan(fen: string, uciMoves: string[]): string[] {
    const chess = new Chess(fen);
    const sans: string[] = [];
    for (const uci of uciMoves) {
      const parsed = parseUci(uci);
      if (!parsed) break;
      try {
        sans.push(chess.move(parsed).san);
      } catch {
        break;
      }
    }
    return sans;
  }

  /**
   * FEN of a game at a given ply. `ply` 0 is the starting position; `ply` N is the
   * position after the N-th half-move. Out-of-range plies clamp to the valid range.
   */
  positionAtPly(game: Game, ply: number): string {
    if (ply <= 0 || game.moves.length === 0) return game.startFen;
    const index = Math.min(ply, game.moves.length) - 1;
    return game.moves[index].fenAfter;
  }

  /**
   * Material count for both sides plus the signed difference.
   * @throws BadRequestException on invalid FEN.
   */
  materialBalance(fen: string): MaterialBalance {
    this.assertValidFen(fen);
    const board = new Chess(fen).board();
    let white = 0;
    let black = 0;
    for (const row of board) {
      for (const square of row) {
        if (!square) continue;
        const value = PIECE_VALUES[square.type] ?? 0;
        if (square.color === 'w') white += value;
        else black += value;
      }
    }
    return { white, black, diff: white - black };
  }

  /**
   * Map a centipawn loss (vs. the engine's best move) to a classification.
   * A loss at/near zero is the engine move itself → 'best'.
   * Thresholds (from @chess/shared CLASSIFY_THRESHOLDS):
   *   good < 50, inaccuracy >= 50, mistake >= 100, blunder >= 300.
   */
  classify(cpLoss: number): MoveClassification {
    const loss = Math.max(0, Math.round(cpLoss));
    if (loss <= 0) return 'best';
    if (loss >= CLASSIFY_THRESHOLDS.blunder) return 'blunder';
    if (loss >= CLASSIFY_THRESHOLDS.mistake) return 'mistake';
    if (loss >= CLASSIFY_THRESHOLDS.inaccuracy) return 'inaccuracy';
    return 'good';
  }

  /**
   * Identify the opening from either a FEN, a list of SAN moves, or a full PGN
   * string, using the small bundled ECO table. Returns `{}` when nothing matches.
   */
  identifyOpening(fenOrMoves: string | string[]): OpeningInfo {
    const sans = this.resolveSanSequence(fenOrMoves);
    if (sans === null) return {};
    return this.identifyOpeningFromSans(sans);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private toMove(m: ChessJsMove, index: number): Move {
    const ply = index + 1;
    return {
      ply,
      moveNumber: Math.floor(index / 2) + 1,
      color: m.color as Color,
      san: m.san,
      uci: m.lan,
      fenBefore: m.before,
      fenAfter: m.after,
    };
  }

  private extractHeaders(raw: Record<string, string>): GameHeaders {
    const headers: GameHeaders = {};
    const map: Record<string, keyof GameHeaders> = {
      Event: 'event',
      White: 'white',
      Black: 'black',
      Result: 'result',
      Date: 'date',
      ECO: 'eco',
      Opening: 'opening',
    };
    for (const [key, value] of Object.entries(raw)) {
      if (value == null || PLACEHOLDER_HEADER_VALUES.has(value)) continue;
      const mapped = map[key];
      if (mapped) headers[mapped] = value;
      else headers[key] = value;
    }
    return headers;
  }

  /**
   * Resolve any accepted opening input into a SAN sequence.
   * Returns `null` when the input is a position we can't trace moves from
   * (a bare FEN that isn't the standard start position has no move history).
   */
  private resolveSanSequence(fenOrMoves: string | string[]): string[] | null {
    if (Array.isArray(fenOrMoves)) return fenOrMoves;

    const text = fenOrMoves.trim();
    if (text.length === 0) return [];

    // A PGN movetext / header block: let chess.js parse it.
    if (this.looksLikePgn(text)) {
      const chess = new Chess();
      try {
        chess.loadPgn(text);
        return chess.history();
      } catch {
        return null;
      }
    }

    // Otherwise treat it as a FEN. We can only derive an opening from a FEN if it
    // is reachable by replaying — chess.js doesn't reverse-engineer history, so we
    // only match when the FEN is the standard starting position (empty sequence).
    if (validateFen(text).ok) {
      const startFen = new Chess().fen();
      return text === startFen ? [] : null;
    }

    return null;
  }

  private looksLikePgn(text: string): boolean {
    // Headers, move numbers ("1."), or a result token signal PGN movetext.
    return /\[.+\]/.test(text) || /\d+\s*\./.test(text);
  }

  private identifyOpeningFromSans(sans: string[]): OpeningInfo {
    let best: EcoEntry | undefined;
    for (const entry of ECO_TABLE) {
      if (entry.moves.length > sans.length) continue;
      const matches = entry.moves.every((mv, i) => mv === sans[i]);
      if (matches && (!best || entry.moves.length > best.moves.length)) {
        best = entry;
      }
    }
    return best ? { eco: best.eco, name: best.name } : {};
  }

  private assertValidFen(fen: string): void {
    const result = validateFen(fen);
    if (!result.ok) {
      throw new BadRequestException(`Invalid FEN: ${result.error ?? fen}`);
    }
  }
}
