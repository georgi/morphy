// Adversarial PGN format probe — LICHESS exports category.
// Wraps two known-LEGAL base games in Lichess formatting variants and POSTs each.
// A rejection => format-handling gap (moves are always legal).

const URL = 'http://localhost:3001/api/games';

const A =
  '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O';
const B =
  '1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0';

// Each variant: { label, pgn, legitimate } where `legitimate` = a real chess
// tool (Lichess/chess.com/standard) emits this and it SHOULD import.
const variants = [
  // 1. plain "PGN" export — clean, headers, no comments
  {
    label: 'plain PGN export (headers, no comments)',
    legitimate: true,
    pgn:
      '[Event "Rated Blitz game"]\n[Site "https://lichess.org/abcd1234"]\n[White "alice"]\n[Black "bob"]\n[Result "1-0"]\n[UTCDate "2026.01.01"]\n[ECO "C41"]\n\n' +
      B,
  },
  // 2. single per-move clock comment
  {
    label: 'single per-move {[%clk]} comment',
    legitimate: true,
    pgn:
      '1. e4 { [%clk 0:03:00] } e5 { [%clk 0:02:58] } 2. Nf3 { [%clk 0:02:55] } Nc6 { [%clk 0:02:57] } 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O',
  },
  // 3. per-move clock + eval as TWO consecutive comments (the classic Lichess clk+eval)
  {
    label: 'consecutive {[%clk]} {[%eval]} double comments per move',
    legitimate: true,
    pgn:
      '1. e4 { [%clk 0:03:00] } { [%eval 0.3] } e5 { [%clk 0:03:00] } { [%eval 0.2] } 2. Nf3 { [%clk 0:02:58] } { [%eval 0.25] } Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O',
  },
  // 4. eval+clk combined inside ONE comment
  {
    label: 'single comment combining [%eval][%clk]',
    legitimate: true,
    pgn:
      '1. e4 { [%eval 0.17] [%clk 0:00:30] } e5 { [%eval 0.2] [%clk 0:00:29] } 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O',
  },
  // 5. eval with MATE score (#-3) and forced-mate annotation
  {
    label: 'eval with mate score {[%eval #-3]}',
    legitimate: true,
    pgn:
      '1. e4 { [%eval #-3] } e5 { [%eval 0.3] } 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O',
  },
  // 6. consecutive clk comment + opening-name label comment (study/opening explorer)
  {
    label: 'consecutive {[%clk]} {D10 Opening Name} comments',
    legitimate: true,
    pgn:
      '1. e4 { [%clk 0:03:00] } { C60 Ruy Lopez } e5 2. Nf3 { [%clk 0:02:58] } { C60 } Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O',
  },
  // 7. arrow/circle annotations [%cal] [%csl]
  {
    label: 'arrow/circle {[%cal Gd1d4] [%csl Re4]} annotations',
    legitimate: true,
    pgn:
      '1. e4 { [%cal Gd1d4] [%csl Re4] } e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O',
  },
  // 8. multi-shape cal/csl + consecutive clk comment
  {
    label: 'multi-shape {[%cal ...]} then {[%clk]} consecutive',
    legitimate: true,
    pgn:
      '1. e4 { [%cal Ge2e4,Gd2d4][%csl Re5,Ye4] } { [%clk 0:03:00] } e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O',
  },
  // 9. triple consecutive comments (eval, clk, cal)
  {
    label: 'triple consecutive comments {eval}{clk}{cal}',
    legitimate: true,
    pgn:
      '1. e4 { [%eval 0.2] } { [%clk 0:03:00] } { [%cal Gd1d4] } e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O',
  },
  // 10. analysis with nested variations + eval comments (Lichess "analysis" export)
  {
    label: 'nested variations with {[%eval]} comments (analysis)',
    legitimate: true,
    pgn:
      '1. e4 { [%eval 0.2] } e5 { [%eval 0.3] } 2. Nf3 { [%eval 0.25] } (2. f4 { [%eval -0.1] } exf4 (2... d5 3. exd5)) 2... Nc6 3. Bb5 { [%eval 0.2] } a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O',
  },
  // 11. variation containing TWO consecutive comments (forces normalize path)
  {
    label: 'variation with consecutive comments inside RAV',
    legitimate: true,
    pgn:
      '1. e4 e5 2. Nf3 (2. Nc3 { [%eval 0.1] } { Vienna } Nc6) 2... Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O',
  },
  // 12. NAG glyphs ($1 good move etc.) — standard PGN, Lichess emits on annotated games
  {
    label: 'NAG glyphs ($1 $6 etc.)',
    legitimate: true,
    pgn:
      '1. e4 e5 2. Nf3 Nc6 $1 3. Bb5 $6 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O $10',
  },
  // 13. comment BEFORE the first move (study chapter intro)
  {
    label: 'comment before first move',
    legitimate: true,
    pgn:
      '[Event "Study: Ruy Lopez"]\n[Result "*"]\n\n{ This chapter walks through the main line of the Ruy Lopez. } 1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O *',
  },
  // 14. comment before first move that needs normalize (pre-comment + later double comment)
  {
    label: 'pre-move comment + later consecutive comments',
    legitimate: true,
    pgn:
      '{ Intro } 1. e4 { [%clk 0:03:00] } { [%eval 0.1] } e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O',
  },
  // 15. study / multi-game file: 3 games concatenated (blank-line separated, standard)
  {
    label: 'study multi-game file (3 games concatenated)',
    legitimate: true,
    pgn:
      '[Event "Chapter 1"]\n[Result "*"]\n\n' +
      A +
      ' *\n\n[Event "Chapter 2"]\n[Result "1-0"]\n\n' +
      B +
      '\n\n[Event "Chapter 3"]\n[Result "*"]\n\n' +
      A +
      ' *',
  },
  // 16. multi-game where first game carries consecutive clk+eval comments
  {
    label: 'multi-game, first game has clk+eval double comments',
    legitimate: true,
    pgn:
      '[Event "Chapter 1"]\n\n1. e4 { [%clk 0:03:00] } { [%eval 0.1] } e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O\n\n[Event "Chapter 2"]\n\n' +
      B,
  },
  // 17. Chess960 / variant header (Lichess emits [Variant] + [FEN]/[SetUp])
  {
    label: 'Variant header (From Position) with SetUp+FEN, standard startpos',
    legitimate: true,
    pgn:
      '[Event "Casual"]\n[Variant "From Position"]\n[SetUp "1"]\n[FEN "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"]\n\n' +
      A,
  },
  // 18. Variant "Standard" header label (Lichess tags every game with [Variant])
  {
    label: 'Variant "Standard" header label',
    legitimate: true,
    pgn: '[Event "Rated"]\n[Variant "Standard"]\n[Result "1-0"]\n\n' + B,
  },
  // 19. full realistic Lichess blitz game: headers + clk on every move + result
  {
    label: 'full Lichess blitz: headers + per-move clk + result',
    legitimate: true,
    pgn:
      '[Event "Rated Blitz"]\n[Result "1-0"]\n[TimeControl "180+0"]\n[Variant "Standard"]\n\n1. e4 { [%clk 0:03:00] } e5 { [%clk 0:03:00] } 2. Nf3 { [%clk 0:02:58] } d6 { [%clk 0:02:59] } 3. d4 { [%clk 0:02:55] } Bg4 { [%clk 0:02:56] } 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0',
  },
  // 20. CRLF line endings (Windows download of a Lichess PGN)
  {
    label: 'CRLF line endings (Windows download)',
    legitimate: true,
    pgn:
      '[Event "x"]\r\n[White "a"]\r\n[Black "b"]\r\n[Result "1-0"]\r\n\r\n' + B,
  },
  // 21. NEGATIVE CONTROL: two games concatenated with NO blank line between them
  //     (malformed — real tools always blank-line-separate games; correct to reject)
  {
    label: 'NEG: two games concatenated WITHOUT blank-line separator',
    legitimate: false,
    pgn: '[Event "G1"]\n' + A + '\n[Event "G2"]\n' + B,
  },
];

async function post(pgn) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pgn }),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, body };
}

const failures = [];
for (const v of variants) {
  const { status, body } = await post(v.pgn);
  const ok = status >= 200 && status < 300;
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${status} ${v.label}`);
  if (!ok) {
    const msg = body && body.message ? body.message : '(no message)';
    console.log(`        message: ${Array.isArray(msg) ? msg.join('; ') : msg}`);
    failures.push({
      label: v.label,
      status,
      message: Array.isArray(msg) ? msg.join('; ') : msg,
      legitimate: v.legitimate,
      pgnSnippet: v.pgn.slice(0, 120),
    });
  }
}

console.log(`\nTested: ${variants.length}  Failures: ${failures.length}`);
console.log(JSON.stringify({ tested: variants.length, failures }, null, 2));
