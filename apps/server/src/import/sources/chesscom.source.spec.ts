import type { StartImportRequest } from '@chess/shared';
import { ChessComSource } from './chesscom.source';
import type { FetchFn } from './http';

const A =
  '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O';
const B =
  '1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0';

// Recorded chess.com PGN payloads (the headers + per-move {[%clk]} chess.com
// emits, proven legal by adversarial-chesscom.mjs).
const CC_PGN_1 =
  '[Event "Live Chess"]\n[Site "Chess.com"]\n[Date "2024.01.15"]\n[White "AliceCC"]\n[Black "BobCC"]\n[Result "1-0"]\n[TimeControl "600"]\n[Variant "Standard"]\n\n' +
  '1. e4 {[%clk 0:09:58]} e5 {[%clk 0:09:55]} 2. Nf3 {[%clk 0:09:50]} d6 {[%clk 0:09:48]} 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0';
const CC_PGN_2 =
  '[Event "Live Chess"]\n[Site "Chess.com"]\n[Date "2024.02.03"]\n[White "AliceCC"]\n[Black "Eve"]\n[Result "*"]\n[TimeControl "600"]\n\n' +
  A +
  ' *';
const CC_PGN_3 =
  '[Event "Live Chess"]\n[Site "Chess.com"]\n[Date "2024.02.20"]\n[White "Eve"]\n[Black "AliceCC"]\n[Result "1/2-1/2"]\n\n' +
  A +
  ' 1/2-1/2';

const ARCHIVES_INDEX = {
  archives: [
    'https://api.chess.com/pub/player/alicecc/games/2024/01',
    'https://api.chess.com/pub/player/alicecc/games/2024/02',
  ],
};
const ARCHIVE_JAN = { games: [{ pgn: CC_PGN_1 }] };
const ARCHIVE_FEB = { games: [{ pgn: CC_PGN_2 }, { pgn: CC_PGN_3 }] };

/** A JSON fetch stub routing by URL suffix; records every requested URL+headers. */
function jsonFetch(
  routes: Record<string, unknown>,
  init: { missing404?: boolean } = {},
): { fetchFn: FetchFn; calls: Array<{ url: string; headers?: Record<string, string> }> } {
  const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
  const fetchFn: FetchFn = async (url, opts) => {
    calls.push({ url, headers: opts?.headers });
    const key = Object.keys(routes).find((k) => url.endsWith(k));
    if (key === undefined) {
      return {
        ok: !init.missing404,
        status: init.missing404 ? 404 : 200,
        statusText: init.missing404 ? 'Not Found' : 'OK',
        headers: { get: () => null },
        json: async () => ({}),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
      json: async () => routes[key],
    } as unknown as Response;
  };
  return { fetchFn, calls };
}

async function collect(source: ChessComSource, req: StartImportRequest): Promise<string[]> {
  const out: string[] = [];
  for await (const pgn of source.fetch(req)) out.push(pgn);
  return out;
}

describe('ChessComSource', () => {
  it('yields every game across all monthly archives', async () => {
    const { fetchFn, calls } = jsonFetch({
      '/games/archives': ARCHIVES_INDEX,
      '/games/2024/01': ARCHIVE_JAN,
      '/games/2024/02': ARCHIVE_FEB,
    });
    const source = new ChessComSource(fetchFn);

    const games = await collect(source, { source: 'chesscom', username: 'AliceCC' });

    expect(games).toHaveLength(3);
    // Newest-first: February's later game (2024.02.20), then its earlier game
    // (2024.02.03), then January's (2024.01.15). The archive index and each
    // month's game list arrive oldest-first, so both are reversed.
    expect(games[0]).toContain('2024.02.20');
    expect(games[1]).toContain('2024.02.03');
    expect(games[2]).toContain('2024.01.15');
    expect(games[2]).toContain('BobCC');
    // Username is lowercased into the archive index URL.
    expect(calls[0].url).toBe(
      'https://api.chess.com/pub/player/alicecc/games/archives',
    );
    // The required descriptive User-Agent is sent on every request.
    expect(calls.every((c) => (c.headers?.['User-Agent'] ?? '').length > 0)).toBe(true);
  });

  it('filters archives by months (YYYY/MM and YYYY-MM both accepted)', async () => {
    const { fetchFn, calls } = jsonFetch({
      '/games/archives': ARCHIVES_INDEX,
      '/games/2024/01': ARCHIVE_JAN,
      '/games/2024/02': ARCHIVE_FEB,
    });
    const source = new ChessComSource(fetchFn);

    const games = await collect(source, {
      source: 'chesscom',
      username: 'alicecc',
      months: ['2024-02'],
    });

    // Only February's two games; January's archive is never fetched.
    expect(games).toHaveLength(2);
    expect(calls.some((c) => c.url.endsWith('/games/2024/01'))).toBe(false);
    expect(calls.some((c) => c.url.endsWith('/games/2024/02'))).toBe(true);
  });

  it('throws a source-level error when the archive index 404s', async () => {
    const { fetchFn } = jsonFetch({}, { missing404: true });
    const source = new ChessComSource(fetchFn);
    await expect(
      collect(source, { source: 'chesscom', username: 'ghost' }),
    ).rejects.toThrow(/404|failed/i);
  });

  it('throws when no username is provided', async () => {
    const { fetchFn } = jsonFetch({});
    const source = new ChessComSource(fetchFn);
    await expect(
      collect(source, { source: 'chesscom', username: '  ' }),
    ).rejects.toThrow(/username/i);
  });

  it('skips empty/whitespace pgn entries', async () => {
    const { fetchFn } = jsonFetch({
      '/games/archives': {
        archives: ['https://api.chess.com/pub/player/x/games/2024/01'],
      },
      '/games/2024/01': { games: [{ pgn: '   ' }, { pgn: CC_PGN_1 }, {}] },
    });
    const source = new ChessComSource(fetchFn);
    const games = await collect(source, { source: 'chesscom', username: 'x' });
    expect(games).toHaveLength(1);
  });

  it('skips a single failing monthly archive and keeps importing the rest', async () => {
    // Index lists three months; February's archive 404s mid-stream. January and
    // March must still yield — one bad archive is never fatal (SPEC §8). A 404 is
    // non-retryable, so there is no backoff delay.
    const index = {
      archives: [
        'https://api.chess.com/pub/player/alicecc/games/2024/01',
        'https://api.chess.com/pub/player/alicecc/games/2024/02',
        'https://api.chess.com/pub/player/alicecc/games/2024/03',
      ],
    };
    const ok = (body: unknown): Response =>
      ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null },
        json: async () => body,
      }) as unknown as Response;
    const fetchFn: FetchFn = async (url) => {
      if (url.endsWith('/games/archives')) return ok(index);
      if (url.endsWith('/games/2024/01')) return ok(ARCHIVE_JAN); // 1 game
      if (url.endsWith('/games/2024/03')) return ok(ARCHIVE_FEB); // 2 games
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: { get: () => null },
        json: async () => ({}),
      } as unknown as Response; // February
    };
    const source = new ChessComSource(fetchFn);

    const games = await collect(source, { source: 'chesscom', username: 'alicecc' });

    // January's 1 + March's 2 = 3; February (the 404) is skipped, not fatal.
    expect(games).toHaveLength(3);
  });
});
