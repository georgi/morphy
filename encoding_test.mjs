// Adversarial ENCODING & STRUCTURE test for the PGN importer.
// Wraps two known-legal base games in encoding/structure variants and POSTs each.

const URL = 'http://localhost:3001/api/games';

// BASE GAME A: Ruy Lopez, 16 plies, legal, no result.
const A = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O';

// BASE GAME B: Opera Game, legal, ends in mate, result 1-0.
const B = '1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0';

// A full header block (Lichess/chess.com style) + movetext for game A.
function headeredA(headerLines, moves = A) {
  return headerLines.join('\n') + '\n\n' + moves + '\n';
}

const BOM = '﻿';

// Figurine version of A (white pieces) and B uses both colors.
// ♘ = N, ♗ = B, ♖ = R, ♕ = Q, ♔ = K.
const A_FIG = '1. e4 e5 2. ♘f3 ♘c6 3. ♗b5 a6 4. ♗a4 ♘f6 5. O-O ♗e7 6. ♖e1 b5 7. ♗b3 d6 8. c3 O-O';
const B_FIG = '1. e4 e5 2. ♘f3 d6 3. d4 ♗g4 4. dxe5 ♗xf3 5. ♕xf3 dxe5 6. ♗c4 ♘f6 7. ♕b3 ♕e7 8. ♘c3 c6 9. ♗g5 b5 10. ♘xb5 cxb5 11. ♗xb5+ ♘bd7 12. O-O-O ♖d8 13. ♖xd7 ♖xd7 14. ♖d1 ♕e6 15. ♗xd7+ ♘xd7 16. ♕b8+ ♘xb8 17. ♖d8# 1-0';

const variants = [
  // 1. UTF-8 BOM prefix before a bare movetext.
  {
    label: 'BOM prefix on bare movetext',
    pgn: BOM + A,
  },
  // 2. UTF-8 BOM prefix before a headered PGN (most common real export shape).
  {
    label: 'BOM prefix on headered PGN',
    pgn: BOM + headeredA([
      '[Event "Test"]',
      '[White "Alice"]',
      '[Black "Bob"]',
      '[Result "*"]',
    ]),
  },
  // 3. Leading blank lines before headers.
  {
    label: 'leading blank lines before headers',
    pgn: '\n\n\n' + headeredA(['[Event "Test"]', '[Result "*"]']),
  },
  // 4. Trailing blank lines after movetext.
  {
    label: 'trailing blank lines after movetext',
    pgn: headeredA(['[Event "Test"]', '[Result "*"]']) + '\n\n\n\n',
  },
  // 5. Windows CRLF line endings throughout a headered PGN.
  {
    label: 'Windows CRLF line endings',
    pgn: headeredA(['[Event "Test"]', '[White "Alice"]', '[Result "*"]']).replace(/\n/g, '\r\n'),
  },
  // 6. CRLF in bare movetext that itself spans lines.
  {
    label: 'CRLF in multi-line bare movetext',
    pgn: ('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6\r\n5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O'),
  },
  // 7. Trailing spaces at the end of every line (header + movetext).
  {
    label: 'trailing spaces on every line',
    pgn: ['[Event "Test"]   ', '[Result "*"]  ', '   ', '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6   ', '5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O   '].join('\n'),
  },
  // 8. Figurine notation, white pieces, game A.
  {
    label: 'figurine notation (white glyphs)',
    pgn: A_FIG,
  },
  // 9. Figurine notation, both colors, full mate game B.
  {
    label: 'figurine notation (full game, both colors, mate)',
    pgn: B_FIG,
  },
  // 10. Figurine notation inside a headered PGN.
  {
    label: 'figurine notation in headered PGN',
    pgn: headeredA(['[Event "Figurine"]', '[Result "*"]'], A_FIG),
  },
  // 11. Unicode (accented) names in header VALUES.
  {
    label: 'unicode accented header values',
    pgn: headeredA([
      '[Event "Championnat de Paris"]',
      '[White "Magnús Örn Carlsen"]',
      '[Black "Wesley Sø"]',
      '[Site "São Paulo"]',
      '[Result "*"]',
    ]),
  },
  // 12. Three concatenated games (PGN database export). Should import (first game).
  {
    label: '3 concatenated games',
    pgn: [
      headeredA(['[Event "G1"]', '[Result "*"]']),
      headeredA(['[Event "G2"]', '[Result "1-0"]'], B),
      headeredA(['[Event "G3"]', '[Result "*"]']),
    ].join('\n'),
  },
  // 13. Stray blank line in the middle of the movetext.
  {
    label: 'stray blank line inside movetext',
    pgn: headeredA(['[Event "Test"]', '[Result "*"]'],
      '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6\n\n5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O'),
  },
  // 14. Stray blank line inside bare movetext (no headers).
  {
    label: 'stray blank line inside bare movetext (no headers)',
    pgn: '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6\n\n5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O',
  },
  // 15. Tabs as separators between move tokens.
  {
    label: 'tabs as token separators',
    pgn: '1.\te4\te5\t2.\tNf3\tNc6\t3.\tBb5\ta6\t4.\tBa4\tNf6\t5.\tO-O\tBe7\t6.\tRe1\tb5\t7.\tBb3\td6\t8.\tc3\tO-O',
  },
  // 16. Tabs separating header tags from movetext (CRLF + tab indentation).
  {
    label: 'tab-indented headers + tab-separated moves, CRLF',
    pgn: '[Event "Tabbed"]\r\n[Result "*"]\r\n\r\n1.\te4\te5\t2.\tNf3\tNc6\t3.\tBb5\ta6\t4.\tBa4\tNf6\t5.\tO-O\tBe7\t6.\tRe1\tb5\t7.\tBb3\td6\t8.\tc3\tO-O\r\n',
  },
];

async function run() {
  const failures = [];
  for (const v of variants) {
    let status = 0;
    let message = '';
    try {
      const res = await fetch(URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pgn: v.pgn }),
      });
      status = res.status;
      if (status < 200 || status >= 300) {
        let body;
        try { body = await res.json(); } catch { body = { message: await res.text() }; }
        message = Array.isArray(body?.message) ? body.message.join('; ') : (body?.message ?? '');
      }
    } catch (e) {
      status = -1;
      message = 'request error: ' + (e?.message ?? String(e));
    }
    const ok = status >= 200 && status < 300;
    console.log(`${ok ? 'PASS' : 'FAIL'} [${status}] ${v.label}`);
    if (!ok) {
      failures.push({
        label: v.label,
        status,
        message,
        pgnSnippet: v.pgn.slice(0, 120),
      });
    }
  }
  console.log('\n=== SUMMARY ===');
  console.log('tested:', variants.length, 'failures:', failures.length);
  console.log(JSON.stringify(failures, null, 2));
}

run();
