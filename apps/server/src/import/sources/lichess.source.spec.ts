import type { StartImportRequest } from '@chess/shared';
import { LichessSource } from './lichess.source';
import type { FetchFn } from './http';

const A =
  '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O';
const B =
  '1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0';

// A recorded Lichess study export: three chapters, blank-line separated, with the
// per-move {[%clk]} / variant headers Lichess actually emits (proven legal by
// lichess_import_probe.mjs).
const LICHESS_STUDY_PGN =
  '[Event "Study: Ruy Lopez — Chapter 1"]\n[Site "https://lichess.org/study/abcd1234/c1"]\n[White "alice"]\n[Black "bob"]\n[Result "1-0"]\n[Variant "Standard"]\n[ECO "C41"]\n\n' +
  '1. e4 { [%clk 0:03:00] } e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0\n\n' +
  '[Event "Study: Ruy Lopez — Chapter 2"]\n[Site "https://lichess.org/study/abcd1234/c2"]\n[White "carl"]\n[Black "dana"]\n[Result "*"]\n[Variant "Standard"]\n\n' +
  A +
  ' *\n\n' +
  '[Event "Study: Ruy Lopez — Chapter 3"]\n[Result "*"]\n\n' +
  '{ This chapter walks through a side line. } 1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 *';

/** A fetch stub that records the URL/headers and streams `body` text in chunks. */
function streamingFetch(
  body: string,
  init: { ok?: boolean; status?: number; statusText?: string; chunkSize?: number } = {},
): { fetchFn: FetchFn; calls: Array<{ url: string; headers?: Record<string, string> }> } {
  const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
  const chunkSize = init.chunkSize ?? 64;
  const fetchFn: FetchFn = async (url, opts) => {
    calls.push({ url, headers: opts?.headers });
    const bytes = Buffer.from(body, 'utf8');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += chunkSize) {
          controller.enqueue(new Uint8Array(bytes.subarray(i, i + chunkSize)));
        }
        controller.close();
      },
    });
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      statusText: init.statusText ?? 'OK',
      body: stream,
    } as unknown as Response;
  };
  return { fetchFn, calls };
}

async function collect(source: LichessSource, req: StartImportRequest): Promise<string[]> {
  const out: string[] = [];
  for await (const pgn of source.fetch(req)) out.push(pgn);
  return out;
}

describe('LichessSource', () => {
  const savedToken = process.env.LICHESS_TOKEN;
  afterEach(() => {
    if (savedToken === undefined) delete process.env.LICHESS_TOKEN;
    else process.env.LICHESS_TOKEN = savedToken;
  });

  it('streams and splits a study PGN export into its chapters', async () => {
    const { fetchFn, calls } = streamingFetch(LICHESS_STUDY_PGN);
    const source = new LichessSource(fetchFn);

    const games = await collect(source, { source: 'lichess', kind: 'study', id: 'abcd1234' });

    expect(games).toHaveLength(3);
    expect(games[0]).toContain('Chapter 1');
    expect(games[2]).toContain('Chapter 3');
    expect(calls[0].url).toBe('https://lichess.org/api/study/abcd1234.pgn');
    expect(calls[0].headers?.Accept).toContain('chess-pgn');
  });

  it('hits the user games endpoint with the max param', async () => {
    const { fetchFn, calls } = streamingFetch(
      '[Event "Rated Blitz"]\n[Result "1-0"]\n\n' + B,
    );
    const source = new LichessSource(fetchFn);

    const games = await collect(source, {
      source: 'lichess',
      kind: 'user',
      id: 'DrNykterstein',
      max: 5,
    });

    expect(games).toHaveLength(1);
    expect(calls[0].url).toBe('https://lichess.org/api/games/user/DrNykterstein?max=5');
  });

  it('hits the broadcast round PGN endpoint', async () => {
    const { fetchFn, calls } = streamingFetch('[Event "Broadcast"]\n[Result "*"]\n\n' + A + ' *');
    const source = new LichessSource(fetchFn);

    await collect(source, { source: 'lichess', kind: 'broadcast', id: 'round42' });
    expect(calls[0].url).toBe('https://lichess.org/api/broadcast/round/round42.pgn');
  });

  it('sends a Bearer token only when LICHESS_TOKEN is set', async () => {
    process.env.LICHESS_TOKEN = 'lip_secret';
    const { fetchFn, calls } = streamingFetch('[Event "x"]\n\n' + A);
    const source = new LichessSource(fetchFn);

    await collect(source, { source: 'lichess', kind: 'study', id: 's' });
    expect(calls[0].headers?.Authorization).toBe('Bearer lip_secret');
  });

  it('does not send Authorization when no token is configured', async () => {
    delete process.env.LICHESS_TOKEN;
    const { fetchFn, calls } = streamingFetch('[Event "x"]\n\n' + A);
    const source = new LichessSource(fetchFn);

    await collect(source, { source: 'lichess', kind: 'study', id: 's' });
    expect(calls[0].headers?.Authorization).toBeUndefined();
  });

  it('retries on 429 then succeeds (exponential backoff, no real waiting)', async () => {
    let attempt = 0;
    const fetchFn: FetchFn = async (_url) => {
      attempt += 1;
      if (attempt < 3) {
        return {
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          headers: { get: () => null },
        } as unknown as Response;
      }
      const bytes = Buffer.from('[Event "x"]\n\n' + A, 'utf8');
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array(bytes));
            c.close();
          },
        }),
      } as unknown as Response;
    };
    // Inject a no-op splitter default; the source uses its own retry with a fast
    // sleep is internal — to avoid real delays, monkeypatch global timers.
    const source = new LichessSource(fetchFn);
    const realSetTimeout = global.setTimeout;
    (global as { setTimeout: typeof setTimeout }).setTimeout = ((
      fn: (...a: unknown[]) => void,
    ) => realSetTimeout(fn, 0)) as unknown as typeof setTimeout;

    try {
      const games = await collect(source, { source: 'lichess', kind: 'study', id: 's' });
      expect(games).toHaveLength(1);
      expect(attempt).toBe(3);
    } finally {
      (global as { setTimeout: typeof setTimeout }).setTimeout = realSetTimeout;
    }
  });

  it('throws a source-level error on a non-retryable failure (404)', async () => {
    const { fetchFn } = streamingFetch('not found', {
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });
    const source = new LichessSource(fetchFn);
    await expect(
      collect(source, { source: 'lichess', kind: 'study', id: 'missing' }),
    ).rejects.toThrow(/404/);
  });

  it('throws when no id is provided', async () => {
    const { fetchFn } = streamingFetch('');
    const source = new LichessSource(fetchFn);
    await expect(
      collect(source, { source: 'lichess', kind: 'study', id: '  ' }),
    ).rejects.toThrow(/id/i);
  });
});
