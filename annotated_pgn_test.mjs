// Adversarial test: CLASSIC DATABASE / annotated PGN formatting
// Base games are known-legal; we only RE-WRAP them in annotation formatting.

const URL = "http://localhost:3001/api/games";

// BASE GAME A (Ruy Lopez, 16 plies, legal, no result)
const A = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O";
// BASE GAME B (Opera Game, legal, mate, 1-0)
const B = "1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0";

const variants = [
  {
    label: "NAG codes $1 $3 $13 $255",
    legitimate: true,
    pgn:
`[Event "NAG test"]

1. e4 $1 e5 $1 2. Nf3 $3 Nc6 $13 3. Bb5 $255 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O`
  },
  {
    label: "Inline glyphs !? ?! ?? !!",
    legitimate: true,
    pgn:
`[Event "Glyph test"]

1. e4 e5 2. Nf3!? Nc6?! 3. Bb5?? a6!! 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O`
  },
  {
    label: "Inline glyphs with space before glyph",
    legitimate: true,
    pgn:
`[Event "Glyph space"]

1. e4 e5 2. Nf3 !? Nc6 ?! 3. Bb5 ?? a6 !! 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O`
  },
  {
    label: "Single RAV variation",
    legitimate: true,
    pgn:
`[Event "RAV single"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 (3... Nf6 4. O-O) 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O`
  },
  {
    label: "Nested RAV ( ... ( ... ) ... )",
    legitimate: true,
    pgn:
`[Event "RAV nested"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 (3... Nf6 4. O-O (4. d3 b5) 4... Be7) 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O`
  },
  {
    label: "Comments interleaved with variations",
    legitimate: true,
    pgn:
`[Event "Comment+RAV"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 {The Ruy Lopez} a6 (3... Nf6 {Berlin} 4. O-O Nxe4) 4. Ba4 {main line} Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O`
  },
  {
    label: "Moves-only, no headers",
    legitimate: true,
    pgn: A
  },
  {
    label: "Moves-only, no headers, with NAGs and comment",
    legitimate: true,
    pgn: "1. e4 e5 2. Nf3 $1 Nc6 {good} 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O"
  },
  {
    label: "Black-to-move continuation 12... Nf6 style (partial game start)",
    legitimate: true,
    // A real DB fragment: continuation starting at black's move. Legal from start? No.
    // Instead: full legal game but using ellipsis on black after comment forces resumption.
    pgn:
`[Event "Black continuation"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 {white develops} 3... a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O`
  },
  {
    label: "Black-to-move ellipsis after every white comment",
    legitimate: true,
    pgn:
`[Event "Ellipsis heavy"]

1. e4 {x} 1... e5 2. Nf3 {x} 2... Nc6 3. Bb5 {x} 3... a6 4. Ba4 {x} 4... Nf6 5. O-O {x} 5... Be7 6. Re1 {x} 6... b5 7. Bb3 {x} 7... d6 8. c3 {x} 8... O-O`
  },
  {
    label: "Comment containing brace-adjacent text (semicolon, parens-like text)",
    legitimate: true,
    pgn:
`[Event "Brace text"]

1. e4 e5 2. Nf3 {Comment with (parentheses) and [brackets] and a 1. e4-like string and symbols !?} Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O`
  },
  {
    label: "Semicolon end-of-line comment",
    legitimate: true,
    pgn:
`[Event "EOL comment"]

1. e4 e5 ; this is a rest-of-line comment
2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O`
  },
  {
    label: "Full annotated Opera game: NAGs + glyphs + nested RAV + comments + result",
    legitimate: true,
    pgn:
`[Event "Paris"]
[Site "Paris FRA"]
[Date "1858.??.??"]
[White "Morphy, Paul"]
[Black "Duke Karl / Count Isouard"]
[Result "1-0"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 $6 {This pins the knight} 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3!? Qe7 (7... Qd7 8. Qxb7) 8. Nc3 c6 9. Bg5 b5?? 10. Nxb5! cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7! Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ $3 Nxb8 17. Rd8# 1-0`
  },
  {
    label: "Result token with NAG immediately before it",
    legitimate: true,
    pgn:
`[Event "Result+NAG"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# $1 1-0`
  },
  {
    label: "Variation that itself ends in checkmate line",
    legitimate: true,
    pgn:
`[Event "RAV deep"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ (16. Qb4 a5) 16... Nxb8 17. Rd8# 1-0`
  },
  {
    label: "Empty comment {} between moves",
    legitimate: true,
    pgn:
`[Event "Empty comment"]

1. e4 {} e5 {} 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O`
  }
];

async function run() {
  const failures = [];
  for (const v of variants) {
    let status = 0, message = "";
    try {
      const res = await fetch(URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pgn: v.pgn })
      });
      status = res.status;
      if (status < 200 || status >= 300) {
        let body = {};
        try { body = await res.json(); } catch { body = { message: await res.text() }; }
        message = Array.isArray(body.message) ? body.message.join("; ") : (body.message || JSON.stringify(body));
      }
    } catch (e) {
      status = -1;
      message = "fetch error: " + e.message;
    }
    const ok = status >= 200 && status < 300;
    console.log(`[${ok ? "OK " : "FAIL"}] ${status} :: ${v.label}`);
    if (!ok) {
      failures.push({
        label: v.label,
        status,
        message,
        legitimate: v.legitimate,
        pgnSnippet: v.pgn.slice(0, 120)
      });
    }
  }
  console.log("\n===== SUMMARY =====");
  console.log("tested:", variants.length);
  console.log("failures:", failures.length);
  console.log(JSON.stringify(failures, null, 2));
}

run();
