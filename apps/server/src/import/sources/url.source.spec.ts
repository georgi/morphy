import { gzipSync } from 'node:zlib';
import type { StartImportRequest } from '@chess/shared';
import { UrlSource } from './url.source';

const A =
  '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O';
const TWO_GAMES =
  '[Event "G1"]\n[White "A"]\n[Black "B"]\n[Result "*"]\n\n' +
  A +
  ' *\n\n[Event "G2"]\n[White "C"]\n[Black "D"]\n[Result "*"]\n\n' +
  A +
  ' *';

async function collect(source: UrlSource, req: StartImportRequest): Promise<string[]> {
  const out: string[] = [];
  for await (const pgn of source.fetch(req)) out.push(pgn);
  return out;
}

/** A minimal Response stand-in for the global fetch mock. */
function fakeResponse(
  body: Buffer | string,
  init: { ok?: boolean; status?: number; statusText?: string; headers?: Record<string, string> } = {},
): Response {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const headers = new Map(
    Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  } as unknown as Response;
}

describe('UrlSource', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('splits pasted multi-game PGN without touching the network', async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new Error('network must not be called for a paste');
    }) as unknown as typeof fetch;

    const source = new UrlSource();
    const games = await collect(source, { source: 'url', pgn: TWO_GAMES });
    expect(games).toHaveLength(2);
    expect(games[0]).toContain('[Event "G1"]');
  });

  it('fetches and splits a plain .pgn URL', async () => {
    globalThis.fetch = jest.fn(async () =>
      fakeResponse(TWO_GAMES),
    ) as unknown as typeof fetch;

    const source = new UrlSource();
    const games = await collect(source, {
      source: 'url',
      url: 'http://example.test/games.pgn',
    });
    expect(games).toHaveLength(2);
  });

  it('gunzips a .pgn.gz URL', async () => {
    const gz = gzipSync(Buffer.from(TWO_GAMES, 'utf8'));
    globalThis.fetch = jest.fn(async () =>
      fakeResponse(gz),
    ) as unknown as typeof fetch;

    const source = new UrlSource();
    const games = await collect(source, {
      source: 'url',
      url: 'http://example.test/games.pgn.gz',
    });
    expect(games).toHaveLength(2);
    expect(games[1]).toContain('[Event "G2"]');
  });

  it('gunzips by gzip magic bytes even without a .gz extension', async () => {
    const gz = gzipSync(Buffer.from(A, 'utf8'));
    globalThis.fetch = jest.fn(async () =>
      fakeResponse(gz),
    ) as unknown as typeof fetch;

    const source = new UrlSource();
    const games = await collect(source, {
      source: 'url',
      url: 'http://example.test/download',
    });
    expect(games).toHaveLength(1);
  });

  it('throws on a non-2xx response (source-level failure)', async () => {
    globalThis.fetch = jest.fn(async () =>
      fakeResponse('not found', { ok: false, status: 404, statusText: 'Not Found' }),
    ) as unknown as typeof fetch;

    const source = new UrlSource();
    await expect(collect(source, { source: 'url', url: 'http://x/missing.pgn' })).rejects.toThrow(
      /404/,
    );
  });

  it('throws when neither url nor pgn is provided', async () => {
    const source = new UrlSource();
    await expect(collect(source, { source: 'url' })).rejects.toThrow(/url.*pgn/i);
  });
});
