import { LichessSource } from './lichess.source';
import { ChessComSource } from './chesscom.source';
import { CatalogSource } from './catalog.source';
import { CATALOG } from '../catalog.manifest';

/**
 * Opt-in network smoke tests for the remote import sources, mirroring the
 * standalone probe scripts. They hit the REAL Lichess / Chess.com / catalog
 * endpoints, so they are skipped by default and only run when
 * `RUN_NETWORK_TESTS=1`. The deterministic behavior is covered by the recorded-
 * fixture specs alongside each source — this is just a live wiring sanity check.
 */
const live = process.env.RUN_NETWORK_TESTS ? describe : describe.skip;

async function first(source: AsyncIterable<string>, n: number): Promise<string[]> {
  const out: string[] = [];
  for await (const pgn of source) {
    out.push(pgn);
    if (out.length >= n) break;
  }
  return out;
}

live('remote sources (network smoke)', () => {
  jest.setTimeout(30_000);

  it('lichess: streams a few of a known user\'s games', async () => {
    const source = new LichessSource();
    const games = await first(
      source.fetch({ source: 'lichess', kind: 'user', id: 'DrNykterstein', max: 2 }),
      2,
    );
    expect(games.length).toBeGreaterThan(0);
    expect(games[0]).toContain('[Event ');
  });

  it('chesscom: yields games from a public player archive', async () => {
    const source = new ChessComSource();
    const games = await first(
      source.fetch({ source: 'chesscom', username: 'hikaru', months: ['2023/01'] }),
      2,
    );
    expect(games.length).toBeGreaterThan(0);
  });

  it('catalog: downloads a remote (non-bundled) manifest entry', async () => {
    const remote = CATALOG.find((e) => !e.bundled)!;
    const source = new CatalogSource();
    const games = await first(source.fetch({ source: 'catalog', entryId: remote.id }), 1);
    expect(games.length).toBeGreaterThan(0);
  });
});
