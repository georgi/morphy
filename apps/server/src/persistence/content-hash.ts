import { createHash } from 'node:crypto';
import type { Game } from '@chess/shared';

/**
 * Normalize a SAN string for hashing: drop check/mate marks (`+`/`#`) and the
 * annotation glyphs (`!`, `?`) that vary between exports of the same game, so two
 * exports of one game with different decorations still collide.
 */
function normalizeSan(san: string): string {
  return san.replace(/[+#!?]/g, '');
}

/** Build the normalized SAN list (space-joined) used as the hash's move spine. */
export function normalizedSanList(game: Game): string {
  return game.moves.map((m) => normalizeSan(m.san)).join(' ');
}

/**
 * Global dedup key for a game:
 * `sha256(normalizedSanList + '|' + white + '|' + black + '|' + date + '|' + result)`.
 * Missing headers contribute the empty string so the shape is stable. A duplicate
 * import (same moves + same players/date/result) hashes identically and is skipped.
 */
export function contentHash(game: Game): string {
  const h = game.headers;
  const parts = [
    normalizedSanList(game),
    h.white ?? '',
    h.black ?? '',
    h.date ?? '',
    h.result ?? '',
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex');
}
