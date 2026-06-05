const URL = 'http://localhost:3001/api/games';
const A = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O';
const B = '1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0';
const variants = [];
const add=(label,pgn,legitimate)=>variants.push({label,pgn,legitimate});

// E1: chess.com black-to-move clk where move number is repeated with "..." after a comment break:
// chess.com writes "1... e5" only mid-stream rarely, but analysis exports do: "8... O-O".
add('Black move-number continuation "N... move" with clk',
  `[Event "Live Chess"]\n[Site "Chess.com"]\n[White "A"]\n[Black "B"]\n[Result "1-0"]\n\n1. e4 {[%clk 0:09:58]} 1... e5 {[%clk 0:09:55]} 2. Nf3 {[%clk 0:09:50]} 2... d6 {[%clk 0:09:48]} 3. d4 {[%clk 0:09:40]} 3... Bg4 {[%clk 0:09:38]} 4. dxe5 {[%clk 0:09:30]} 4... Bxf3 {[%clk 0:09:28]} 5. Qxf3 {[%clk 0:09:20]} 5... dxe5 {[%clk 0:09:18]} 6. Bc4 6... Nf6 7. Qb3 7... Qe7 8. Nc3 8... c6 9. Bg5 9... b5 10. Nxb5 10... cxb5 11. Bxb5+ 11... Nbd7 12. O-O-O 12... Rd8 13. Rxd7 13... Rxd7 14. Rd1 14... Qe6 15. Bxd7+ 15... Nxd7 16. Qb8+ 16... Nxb8 17. Rd8# 1-0`, true);

// E2: header value containing a quote-escape (chess.com escapes \" in names) — PGN spec mandates backslash-escape.
add('Header with escaped quote in player name',
  `[Event "Live Chess"]\n[Site "Chess.com"]\n[White "Alice \\"The Crusher\\" CC"]\n[Black "B"]\n[Result "1-0"]\n\n${B}`, true);

// E3: trailing whitespace lines + BOM at start (Windows export with UTF-8 BOM).
add('UTF-8 BOM prefix + trailing spaces',
  '﻿' + `[Event "Live Chess"]   \n[Site "Chess.com"]\n[White "A"]\n[Black "B"]\n[Result "1-0"]\n\n${B}   `, true);

// E4: clk with centiseconds (chess.com bullet): {[%clk 0:00:09.9]}
add('clk with centiseconds {[%clk 0:00:09.9]}',
  `[Event "Live Chess"]\n[Site "Chess.com"]\n[White "A"]\n[Black "B"]\n[Result "1-0"]\n\n1. e4 {[%clk 0:00:09.9]} e5 {[%clk 0:00:08.7]} 2. Nf3 {[%clk 0:00:07.5]} Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O`, true);

// E5: NAG annotations from chess.com analysis ($1 good, $2 mistake) interleaved.
add('NAG glyphs $1/$2/$6 with clk',
  `[Event "Live Chess"]\n[Site "Chess.com"]\n[White "A"]\n[Black "B"]\n[Result "1-0"]\n\n1. e4 $1 {[%clk 0:09:58]} e5 $1 2. Nf3 $6 d6 $2 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0`, true);

// E6: chess.com sometimes emits result on its own line after a blank line.
add('Result token on separate trailing line',
  `[Event "Live Chess"]\n[Site "Chess.com"]\n[White "A"]\n[Black "B"]\n[Result "1-0"]\n\n${B.replace(' 1-0','')}\n\n1-0`, true);

// E7: clk comment with eval annotation chess.com analysis: {[%clk 0:09:58][%eval 0.24]}
add('Combined clk+eval in one comment',
  `[Event "Live Chess"]\n[Site "Chess.com"]\n[White "A"]\n[Black "B"]\n[Result "1-0"]\n\n1. e4 {[%clk 0:09:58][%eval 0.24]} e5 {[%clk 0:09:55][%eval 0.31]} 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O`, true);

// E8: lowercase result-ish but actually the proper token; test "½-½" unicode draw (some GUIs emit this).
add('Unicode draw token ½-½',
  `[Event "X"]\n[White "A"]\n[Black "B"]\n[Result "1/2-1/2"]\n\n${A} ½-½`, false);

async function run(){
  const failures=[];
  for(const v of variants){
    let status=0,message='';
    try{
      const res=await fetch(URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pgn:v.pgn})});
      status=res.status;
      if(status<200||status>=300){let b;try{b=await res.json();message=Array.isArray(b?.message)?b.message.join('; '):(b?.message??JSON.stringify(b));}catch{message=await res.text();}}
    }catch(e){status=-1;message='fetch error: '+e.message;}
    const ok=status>=200&&status<300;
    console.log(`${ok?'PASS':'FAIL'} [${status}] ${v.label}${ok?'':' :: '+message}`);
    if(!ok)failures.push({label:v.label,status,message,legitimate:v.legitimate,pgnSnippet:v.pgn.slice(0,120)});
  }
  console.log(`\n=== Tested ${variants.length}, failures ${failures.length} ===`);
  console.log(JSON.stringify({tested:variants.length,failures},null,2));
}
run();
