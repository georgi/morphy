import { gzipSync } from 'node:zlib';
import type { StartImportRequest } from '@chess/shared';
import { CatalogSource } from './catalog.source';
import { CATALOG, findCatalogEntry } from '../catalog.manifest';
import { BUNDLED_PGNS } from './fixtures/bundled-pgns';
import type { FetchFn } from './http';

const A =
  '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O';
const REMOTE_PGN =
  '[Event "G1"]\n[White "A"]\n[Black "B"]\n[Result "*"]\n\n' +
  A +
  ' *\n\n[Event "G2"]\n[White "C"]\n[Black "D"]\n[Result "*"]\n\n' +
  A +
  ' *';

/** A fetch stub returning a fixed buffer body, recording the requested URL. */
function bufferFetch(
  body: Buffer | string,
  init: { ok?: boolean; status?: number; statusText?: string; headers?: Record<string, string> } = {},
): { fetchFn: FetchFn; calls: string[] } {
  const calls: string[] = [];
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const headers = new Map(
    Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const fetchFn: FetchFn = async (url) => {
    calls.push(url);
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      statusText: init.statusText ?? 'OK',
      headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
      arrayBuffer: async () =>
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    } as unknown as Response;
  };
  return { fetchFn, calls };
}

/** A fetch stub that always rejects (simulates the network being down). */
const downFetch: FetchFn = async () => {
  throw new Error('network down');
};

async function collect(source: CatalogSource, req: StartImportRequest): Promise<string[]> {
  const out: string[] = [];
  for await (const pgn of source.fetch(req)) out.push(pgn);
  return out;
}

describe('catalog manifest', () => {
  it('is non-empty and every entry satisfies the CatalogEntry contract', () => {
    expect(CATALOG.length).toBeGreaterThan(0);
    for (const e of CATALOG) {
      expect(typeof e.id).toBe('string');
      expect(typeof e.title).toBe('string');
      expect(typeof e.description).toBe('string');
      expect(typeof e.url).toBe('string');
    }
    // Entry ids are unique.
    const ids = CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every bundled entry has a matching offline fixture', () => {
    const bundled = CATALOG.filter((e) => e.bundled);
    expect(bundled.length).toBeGreaterThan(0);
    for (const e of bundled) {
      expect(typeof BUNDLED_PGNS[e.id]).toBe('string');
      expect(BUNDLED_PGNS[e.id].length).toBeGreaterThan(0);
    }
  });
});

describe('CatalogSource', () => {
  it('yields a bundled classic from its offline fixture without any network', async () => {
    const bundledEntry = CATALOG.find((e) => e.bundled)!;
    let fetched = false;
    const fetchFn: FetchFn = async () => {
      fetched = true;
      throw new Error('network must not be touched for a bundled entry');
    };
    const source = new CatalogSource(fetchFn);

    const games = await collect(source, { source: 'catalog', entryId: bundledEntry.id });
    expect(fetched).toBe(false);
    expect(games).toHaveLength(1); // each bundled fixture is a single game
    expect(games[0]).toContain('[White ');
  });

  it('fetches and splits a remote (non-bundled) entry', async () => {
    const remoteEntry = CATALOG.find((e) => !e.bundled)!;
    const { fetchFn, calls } = bufferFetch(REMOTE_PGN);
    const source = new CatalogSource(fetchFn);

    const games = await collect(source, { source: 'catalog', entryId: remoteEntry.id });
    expect(games).toHaveLength(2);
    expect(calls[0]).toBe(remoteEntry.url);
  });

  it('gunzips a gzip remote body', async () => {
    const remoteEntry = CATALOG.find((e) => !e.bundled)!;
    const { fetchFn } = bufferFetch(gzipSync(Buffer.from(REMOTE_PGN, 'utf8')), {
      headers: { 'content-encoding': 'gzip' },
    });
    const source = new CatalogSource(fetchFn);
    const games = await collect(source, { source: 'catalog', entryId: remoteEntry.id });
    expect(games).toHaveLength(2);
  });

  it('falls back to the bundled fixture when a bundled entry would-be remote fetch is down', async () => {
    // A bundled entry never touches the network at all (it returns the fixture),
    // so even a dead fetch yields the offline copy.
    const bundledEntry = CATALOG.find((e) => e.bundled)!;
    const source = new CatalogSource(downFetch);
    const games = await collect(source, { source: 'catalog', entryId: bundledEntry.id });
    expect(games).toHaveLength(1);
  });

  it('throws on an unknown entryId', async () => {
    const { fetchFn } = bufferFetch(REMOTE_PGN);
    const source = new CatalogSource(fetchFn);
    await expect(
      collect(source, { source: 'catalog', entryId: 'does-not-exist' }),
    ).rejects.toThrow(/unknown catalog entry/i);
  });

  it('propagates a remote failure when there is no bundled fallback', async () => {
    const remoteEntry = CATALOG.find((e) => !e.bundled)!;
    const source = new CatalogSource(downFetch);
    await expect(
      collect(source, { source: 'catalog', entryId: remoteEntry.id }),
    ).rejects.toThrow(/network down/i);
  });

  it('findCatalogEntry resolves a known id and rejects an unknown one', () => {
    expect(findCatalogEntry(CATALOG[0].id)?.id).toBe(CATALOG[0].id);
    expect(findCatalogEntry('nope')).toBeUndefined();
  });
});
