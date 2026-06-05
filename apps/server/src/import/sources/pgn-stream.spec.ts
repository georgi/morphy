import { splitPgnStream } from './pgn-stream';
import { PgnSplitter } from '../pgn-splitter';

/** Build a web ReadableStream that emits each string as its own UTF-8 chunk. */
function streamOfChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= chunks.length) {
        c.close();
        return;
      }
      c.enqueue(enc.encode(chunks[i++]));
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const g of splitPgnStream(stream, new PgnSplitter())) out.push(g);
  return out;
}

// A lichess-style game: starts with [Event], ends with the result followed by the
// blank-line run lichess emits between games. Lichess streams ONE game per network
// chunk, which is the exact delivery shape that exposed the boundary bug (the
// previous game, trimmed on carry-over, got the next game's [Event] welded onto
// its result line: `... 1-0[Event ...]`).
const game = (n: number, result: string): string =>
  `[Event "rated rapid game"]\n[Site "https://lichess.org/g${n}"]\n` +
  `[White "a${n}"]\n[Black "b${n}"]\n[Result "${result}"]\n\n` +
  `1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 ${result}\n\n\n`;

describe('splitPgnStream', () => {
  it('keeps games separate when each arrives as its own chunk (lichess one-game-per-chunk)', async () => {
    const chunks = [
      game(1, '1-0'),
      game(2, '0-1'),
      game(3, '1/2-1/2'),
      game(4, '1-0'),
    ];

    const games = await collect(streamOfChunks(chunks));

    expect(games).toHaveLength(4);
    for (const g of games) {
      // Each emitted game must be exactly one game: it starts with its own
      // [Event] header and carries no second header welded on from the next chunk.
      expect(g.trimStart().startsWith('[Event ')).toBe(true);
      expect((g.match(/^\[Event /gm) || []).length).toBe(1);
      // The result token must never be glued directly to a header tag.
      expect(g).not.toMatch(/(?:1-0|0-1|1\/2-1\/2)\[/);
    }
  });

  it('still splits a multi-game body delivered as one chunk', async () => {
    const whole = [game(1, '1-0') + game(2, '0-1')];
    const games = await collect(streamOfChunks(whole));
    expect(games).toHaveLength(2);
  });

  it('reassembles a game fragmented mid-movetext across chunks', async () => {
    const g = game(1, '1-0');
    const cut = Math.floor(g.length / 2);
    const games = await collect(streamOfChunks([g.slice(0, cut), g.slice(cut)]));
    expect(games).toHaveLength(1);
    expect((games[0].match(/^\[Event /gm) || []).length).toBe(1);
  });
});
