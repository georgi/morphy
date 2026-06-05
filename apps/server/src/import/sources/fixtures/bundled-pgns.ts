/**
 * Bundled classic games — the offline fallback for catalog entries marked
 * `bundled: true`. These are checked-in TypeScript string modules (rather than
 * loose `.pgn` files) so they survive `nest build` without any asset-copy config
 * and are guaranteed present at runtime regardless of the working directory.
 *
 * Each value is a single-game PGN (headers + movetext) for a famous, public-domain
 * classic. {@link import('../catalog.source').CatalogSource} reads these when a
 * catalog entry is `bundled` (or when the remote fetch fails), splits them with
 * {@link import('../../pgn-splitter').PgnSplitter} (a no-op for one game), and
 * yields the result through the normal import pipeline.
 *
 * The keys are catalog entry ids (see `catalog.json`).
 */
export const BUNDLED_PGNS: Record<string, string> = {
  // Paul Morphy vs Duke Karl / Count Isouard, Paris 1858 — "The Opera Game".
  'morphy-opera-1858':
    '[Event "Paris"]\n' +
    '[Site "Paris FRA"]\n' +
    '[Date "1858.??.??"]\n' +
    '[Round "?"]\n' +
    '[White "Paul Morphy"]\n' +
    '[Black "Duke Karl / Count Isouard"]\n' +
    '[Result "1-0"]\n' +
    '[ECO "C41"]\n' +
    '[Opening "Philidor Defense"]\n\n' +
    '1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 ' +
    '7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 ' +
    '12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 ' +
    '17. Rd8# 1-0',

  // Adolf Anderssen vs Lionel Kieseritzky, London 1851 — "The Immortal Game".
  'anderssen-immortal-1851':
    '[Event "London"]\n' +
    '[Site "London ENG"]\n' +
    '[Date "1851.06.21"]\n' +
    '[Round "?"]\n' +
    '[White "Adolf Anderssen"]\n' +
    '[Black "Lionel Kieseritzky"]\n' +
    '[Result "1-0"]\n' +
    '[ECO "C33"]\n' +
    '[Opening "King\'s Gambit Accepted"]\n\n' +
    '1. e4 e5 2. f4 exf4 3. Bc4 Qh4+ 4. Kf1 b5 5. Bxb5 Nf6 6. Nf3 Qh6 ' +
    '7. d3 Nh5 8. Nh4 Qg5 9. Nf5 c6 10. g4 Nf6 11. Rg1 cxb5 12. h4 Qg6 ' +
    '13. h5 Qg5 14. Qf3 Ng8 15. Bxf4 Qf6 16. Nc3 Bc5 17. Nd5 Qxb2 ' +
    '18. Bd6 Bxg1 19. e5 Qxa1+ 20. Ke2 Na6 21. Nxg7+ Kd8 22. Qf6+ Nxf6 ' +
    '23. Be7# 1-0',
};
