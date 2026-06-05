// Verify that "passing" variants actually imported the MOVES, not an empty game,
// and probe a few harder structural edges in the same category.
const URL = 'http://localhost:3001/api/games';
const A = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O';
const B = '1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0';
function headeredA(h, moves = A) { return h.join('\n') + '\n\n' + moves + '\n'; }

const checks = [
  { label: 'stray blank inside movetext (headered)', pgn: headeredA(['[Event "T"]','[Result "*"]'], '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6\n\n5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O'), expectPlies: 16 },
  { label: 'stray blank inside bare movetext', pgn: '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6\n\n5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O', expectPlies: 16 },
  { label: '3 concatenated games -> first', pgn: [headeredA(['[Event "G1"]','[Result "*"]']), headeredA(['[Event "G2"]','[Result "1-0"]'], B), headeredA(['[Event "G3"]','[Result "*"]'])].join('\n'), expectPlies: 16 },
  { label: 'tabs as token separators', pgn: '1.\te4\te5\t2.\tNf3\tNc6\t3.\tBb5\ta6\t4.\tBa4\tNf6\t5.\tO-O\tBe7\t6.\tRe1\tb5\t7.\tBb3\td6\t8.\tc3\tO-O', expectPlies: 16 },
  { label: 'figurine full game B (mate)', pgn: B.replace(/N/g,'♘').replace(/B/g,'♗').replace(/R/g,'♖').replace(/Q/g,'♕').replace(/K/g,'♔'), expectPlies: 33 },
];

async function imp(pgn) {
  const res = await fetch(URL, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ pgn }) });
  let body; try { body = await res.json(); } catch { body = { raw: await res.text() }; }
  return { status: res.status, body };
}

for (const c of checks) {
  const { status, body } = await imp(c.pgn);
  const plies = body?.moves?.length;
  const ok = status >= 200 && status < 300 && plies === c.expectPlies;
  console.log(`${ok?'OK ':'BAD'} [${status}] plies=${plies} (want ${c.expectPlies})  ${c.label}`);
  if (!ok && status >= 200) console.log('   firstMoves:', (body?.moves||[]).slice(0,4).map(m=>m.san).join(' '), '| result:', body?.headers?.result);
}
