// Adversarial PGN format tester — CHESS.COM / common GUI exports category.
// Each variant wraps a KNOWN-LEGAL base game; rejection => format-handling gap.

const URL = 'http://localhost:3001/api/games';

// BASE GAME A: Ruy Lopez, 16 plies, legal, no result.
const A_MOVES =
  '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O';

// BASE GAME B: Morphy Opera Game, legal, ends in mate, 1-0.
const B_MOVES =
  '1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0';

// FEN of the start position for Base Game A's final position is not needed;
// we use the standard start FEN for [SetUp][FEN] variants and the CurrentPosition
// FEN that chess.com would emit (the position AFTER game A's last move, O-O).
// Position after: 1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Ba4 Nf6 5.O-O Be7 6.Re1 b5 7.Bb3 d6 8.c3 O-O
const A_FINAL_FEN = 'r1bq1rk1/2p1bppp/p1np1n2/1p2p3/4P3/1BP2N2/PP1P1PPP/RNBQR1K1 w - - 0 9';
const STD_START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// Helper to build a header block + movetext.
function game(headers, moves) {
  const h = headers.map(([k, v]) => `[${k} "${v}"]`).join('\n');
  return `${h}\n\n${moves}`;
}

// Standard chess.com header set.
const CC_HEADERS = (extra = []) => [
  ['Event', "Live Chess"],
  ['Site', 'Chess.com'],
  ['Date', '2024.01.15'],
  ['Round', '-'],
  ['White', 'AliceCC'],
  ['Black', 'BobCC'],
  ['Result', '1-0'],
  ...extra,
];

const variants = [];
const add = (label, pgn, legitimate) => variants.push({ label, pgn, legitimate });

// 1. [Variant "Standard"] header (chess.com always emits this for standard games).
add(
  'Variant "Standard" header',
  game(CC_HEADERS([['Variant', 'Standard'], ['TimeControl', '600']]), B_MOVES),
  true,
);

// 2. [TimeControl] header with increment notation "600+5".
add(
  'TimeControl "600+5"',
  game(CC_HEADERS([['TimeControl', '600+5']]), B_MOVES),
  true,
);

// 3. Per-move clock comments, chess.com style WITHOUT spaces inside braces: {[%clk 0:10:00]}
add(
  'clk comments no inner spaces {[%clk 0:10:00]}',
  game(CC_HEADERS([['TimeControl', '600']]),
    '1. e4 {[%clk 0:09:58]} e5 {[%clk 0:09:55]} 2. Nf3 {[%clk 0:09:50]} Nc6 {[%clk 0:09:48]} 3. Bb5 {[%clk 0:09:40]} a6 {[%clk 0:09:38]} 4. Ba4 {[%clk 0:09:30]} Nf6 {[%clk 0:09:28]} 5. O-O {[%clk 0:09:20]} Be7 {[%clk 0:09:18]} 6. Re1 {[%clk 0:09:10]} b5 {[%clk 0:09:08]} 7. Bb3 {[%clk 0:09:00]} d6 {[%clk 0:08:58]} 8. c3 {[%clk 0:08:50]} O-O {[%clk 0:08:48]}'),
  true,
);

// 4. clk comments WITH spaces inside braces: { [%clk 0:10:00] } (lichess-ish style)
add(
  'clk comments with inner spaces { [%clk 0:10:00] }',
  game(CC_HEADERS([['TimeControl', '600']]),
    '1. e4 { [%clk 0:09:58] } e5 { [%clk 0:09:55] } 2. Nf3 { [%clk 0:09:50] } Nc6 { [%clk 0:09:48] } 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O'),
  true,
);

// 5. [CurrentPosition "<fen>"] header (chess.com emits this; it is NOT a SetUp).
add(
  'CurrentPosition header (final fen)',
  game(CC_HEADERS([['CurrentPosition', A_FINAL_FEN]]), A_MOVES),
  true,
);

// 6. [SetUp "1"][FEN "<std start>"] — explicit start position equal to standard start.
add(
  'SetUp+FEN standard start position',
  game([
    ['Event', 'Live Chess'],
    ['Site', 'Chess.com'],
    ['White', 'A'],
    ['Black', 'B'],
    ['Result', '1-0'],
    ['SetUp', '1'],
    ['FEN', STD_START_FEN],
  ], B_MOVES),
  true,
);

// 7. SetUp+FEN from a non-standard mid-game position (Puzzle/analysis export).
// Use Base Game A's final FEN as the start, then play a legal continuation.
// From A_FINAL_FEN (white to move): a simple legal move d4.
add(
  'SetUp+FEN mid-game start, legal continuation',
  game([
    ['Event', 'Analysis'],
    ['Site', 'Chess.com'],
    ['White', 'A'],
    ['Black', 'B'],
    ['Result', '*'],
    ['SetUp', '1'],
    ['FEN', A_FINAL_FEN],
  ], '9. d4 exd4 10. cxd4 *'),
  true,
);

// 8. Result token "1-0" (already in B). Explicit minimal A with "1-0" appended legally? A has no result; test 1/2-1/2.
add(
  'Result token 1/2-1/2 (draw agreed on legal A)',
  game([['Event', 'Live Chess'], ['Site', 'Chess.com'], ['White', 'A'], ['Black', 'B'], ['Result', '1/2-1/2']],
    A_MOVES + ' 1/2-1/2'),
  true,
);

// 9. Result token "0-1".
add(
  'Result token 0-1 header+movetext',
  game([['Event', 'Live Chess'], ['Site', 'Chess.com'], ['White', 'A'], ['Black', 'B'], ['Result', '0-1']],
    A_MOVES + ' 0-1'),
  true,
);

// 10. Result token "*" (ongoing/unknown).
add(
  'Result token * (unfinished)',
  game([['Event', 'Live Chess'], ['Site', 'Chess.com'], ['White', 'A'], ['Black', 'B'], ['Result', '*']],
    A_MOVES + ' *'),
  true,
);

// 11. [Termination] header (chess.com style "X won by checkmate").
add(
  'Termination header (won by checkmate)',
  game(CC_HEADERS([['Termination', 'AliceCC won by checkmate']]), B_MOVES),
  true,
);

// 12. [Termination] "... won on time" with * result.
add(
  'Termination won on time, result *',
  game([['Event', 'Live Chess'], ['Site', 'Chess.com'], ['White', 'A'], ['Black', 'B'], ['Result', '*'], ['Termination', 'A won on time']],
    A_MOVES + ' *'),
  true,
);

// 13. CRLF line endings throughout (Windows GUI export).
add(
  'CRLF line endings (full chess.com header block)',
  game(CC_HEADERS([['Variant', 'Standard'], ['TimeControl', '600']]), B_MOVES).replace(/\n/g, '\r\n'),
  true,
);

// 14. CRLF + clk comments (no inner spaces) combined — realistic chess.com download.
add(
  'CRLF + clk comments combined',
  game(CC_HEADERS([['TimeControl', '600']]),
    '1. e4 {[%clk 0:09:58]} e5 {[%clk 0:09:55]} 2. Nf3 {[%clk 0:09:50]} Nc6 {[%clk 0:09:48]} 3. Bb5 {[%clk 0:09:40]} a6 {[%clk 0:09:38]} 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 1-0')
    .replace(/\n/g, '\r\n'),
  true,
);

// 15. Full realistic chess.com export: all of the above headers + clk + ECO + Link header.
add(
  'Full chess.com export (all headers + clk + ECOUrl + Link)',
  game([
    ['Event', "Live Chess"],
    ['Site', 'Chess.com'],
    ['Date', '2024.01.15'],
    ['Round', '-'],
    ['White', 'AliceCC'],
    ['Black', 'BobCC'],
    ['Result', '1-0'],
    ['CurrentPosition', 'r1bk1bnr/p4ppp/4q3/4p3/8/1QN5/PPP2PPP/2KR4 b - -'],
    ['Timezone', 'UTC'],
    ['ECO', 'C41'],
    ['ECOUrl', 'https://www.chess.com/openings/Philidor-Defense'],
    ['UTCDate', '2024.01.15'],
    ['UTCTime', '20:00:00'],
    ['WhiteElo', '1500'],
    ['BlackElo', '1480'],
    ['TimeControl', '600'],
    ['Termination', 'AliceCC won by checkmate'],
    ['StartTime', '20:00:00'],
    ['EndDate', '2024.01.15'],
    ['EndTime', '20:08:00'],
    ['Link', 'https://www.chess.com/game/live/123456789'],
    ['Variant', 'Standard'],
  ],
    '1. e4 {[%clk 0:09:58]} e5 {[%clk 0:09:55]} 2. Nf3 {[%clk 0:09:50]} d6 {[%clk 0:09:48]} 3. d4 {[%clk 0:09:40]} Bg4 {[%clk 0:09:38]} 4. dxe5 {[%clk 0:09:30]} Bxf3 {[%clk 0:09:28]} 5. Qxf3 {[%clk 0:09:20]} dxe5 {[%clk 0:09:18]} 6. Bc4 {[%clk 0:09:10]} Nf6 {[%clk 0:09:08]} 7. Qb3 {[%clk 0:09:00]} Qe7 {[%clk 0:08:58]} 8. Nc3 {[%clk 0:08:50]} c6 {[%clk 0:08:48]} 9. Bg5 {[%clk 0:08:40]} b5 {[%clk 0:08:38]} 10. Nxb5 {[%clk 0:08:30]} cxb5 {[%clk 0:08:28]} 11. Bxb5+ {[%clk 0:08:20]} Nbd7 {[%clk 0:08:18]} 12. O-O-O {[%clk 0:08:10]} Rd8 {[%clk 0:08:08]} 13. Rxd7 {[%clk 0:08:00]} Rxd7 {[%clk 0:07:58]} 14. Rd1 {[%clk 0:07:50]} Qe6 {[%clk 0:07:48]} 15. Bxd7+ {[%clk 0:07:40]} Nxd7 {[%clk 0:07:38]} 16. Qb8+ {[%clk 0:07:30]} Nxb8 {[%clk 0:07:28]} 17. Rd8# {[%clk 0:07:20]} 1-0')
    .replace(/\n/g, '\r\n'),
  true,
);

// 16. CurrentPosition WITHOUT SetUp (chess.com never sets SetUp for CurrentPosition;
// the game still starts from the standard position). Ensures it isn't misread as a start FEN.
add(
  'CurrentPosition present, no SetUp/FEN (must start from standard)',
  game([
    ['Event', 'Live Chess'],
    ['Site', 'Chess.com'],
    ['White', 'A'],
    ['Black', 'B'],
    ['Result', '*'],
    ['CurrentPosition', A_FINAL_FEN],
  ], A_MOVES + ' *'),
  true,
);

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
        try {
          body = await res.json();
          message = Array.isArray(body?.message) ? body.message.join('; ') : (body?.message ?? JSON.stringify(body));
        } catch {
          message = await res.text();
        }
      }
    } catch (e) {
      status = -1;
      message = `fetch error: ${e.message}`;
    }
    const ok = status >= 200 && status < 300;
    console.log(`${ok ? 'PASS' : 'FAIL'} [${status}] ${v.label}`);
    if (!ok) {
      failures.push({
        label: v.label,
        status,
        message,
        legitimate: v.legitimate,
        pgnSnippet: v.pgn.slice(0, 120),
      });
    }
  }
  console.log(`\n=== Tested ${variants.length}, failures ${failures.length} ===`);
  console.log(JSON.stringify({ tested: variants.length, failures }, null, 2));
}

run();
