const URL='http://localhost:3001/api/games';
const B='1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0';
// Construct the EXACT bytes: a White tag whose value is  Alice \"The Crusher\" CC
// i.e. on the wire the tag line is:  [White "Alice \"The Crusher\" CC"]
const whiteLine = '[White "Alice \\"The Crusher\\" CC"]';
console.log('Exact White tag bytes sent:', JSON.stringify(whiteLine));
const pgn = `[Event "Live Chess"]\n[Site "Chess.com"]\n${whiteLine}\n[Black "B"]\n[Result "1-0"]\n\n${B}`;
console.log('---- full PGN ----');
console.log(pgn);
console.log('------------------');
const res=await fetch(URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pgn})});
console.log('status', res.status);
console.log('body', await res.text());

// Control: same PGN but value with NO embedded quote -> should pass, proving the quote is the trigger.
const ctl = `[Event "Live Chess"]\n[Site "Chess.com"]\n[White "Alice The Crusher CC"]\n[Black "B"]\n[Result "1-0"]\n\n${B}`;
const res2=await fetch(URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pgn:ctl})});
console.log('control (no embedded quote) status', res2.status);
