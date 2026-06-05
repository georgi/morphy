/**
 * Eval-cache FEN normalization.
 *
 * The cache key keeps only the first FOUR FEN fields — piece placement, side to
 * move, castling availability, and the en-passant target square. The halfmove
 * clock and fullmove number are dropped, so transpositions and shared openings
 * collide on the same key (and 50-move-rule edge positions are treated as
 * identical — an accepted tradeoff, see the design spec).
 *
 * `'startpos'` is expanded to the standard start FEN's normalized form so it
 * keys identically to the explicit start position.
 */
const START_FEN_NORM = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';

export function normalizeFen(fen: string): string {
  if (fen === 'startpos') return START_FEN_NORM;
  return fen.trim().split(/\s+/).slice(0, 4).join(' ');
}
