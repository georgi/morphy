import { PgnSplitter } from '../pgn-splitter';

/**
 * Incrementally split a streamed PGN body into single-game PGN strings without
 * buffering the whole file. Used by the streaming remote sources (lichess study /
 * broadcast / user games can be large). The web standard `Response.body` is a
 * `ReadableStream<Uint8Array>`; we decode it to text, accumulate, and flush each
 * complete game as a blank-line-delimited boundary is crossed, holding back the
 * trailing partial game until more data (or end-of-stream) arrives.
 *
 * The actual boundary logic is delegated to {@link PgnSplitter} so streamed and
 * whole-text imports split identically (and inherit the probe-proven robustness:
 * CRLF, comment-embedded `[`, multi-game files, movetext-only paste).
 */
export async function* splitPgnStream(
  body: ReadableStream<Uint8Array> | null,
  splitter: PgnSplitter = new PgnSplitter(),
): AsyncIterable<string> {
  if (!body) return;

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const drainComplete = function* (): Generator<string> {
    // Split what we have; the LAST game may still be growing, so keep it in the
    // buffer and only yield the games before it once a clear boundary exists.
    const games = splitter.split(buffer);
    if (games.length <= 1) return; // nothing safely complete yet
    for (const game of games.slice(0, -1)) yield game;
    buffer = games[games.length - 1];
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Only attempt a split when we just saw a blank line (cheap heuristic that
      // a game may have ended); otherwise keep accumulating.
      if (buffer.includes('\n\n') || buffer.includes('\r\n\r\n')) {
        yield* drainComplete();
      }
    }
  } finally {
    reader.releaseLock();
  }

  buffer += decoder.decode(); // flush any multibyte remainder
  for (const game of splitter.split(buffer)) yield game;
}
