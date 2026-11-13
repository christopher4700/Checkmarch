import * as E from './engine.mjs';
import { readFileSync } from 'node:fs';
import { slimJs } from './build.mjs';
let fail = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fail++; };

// perft (castling and en passant are not part of Checkmarch; counts to depth 3 are unaffected)
const expect = [20, 400, 8902];
for (let d = 1; d <= 3; d++) {
  const t = Date.now(), n = E.perft(E.startPos(), d);
  ok(n === expect[d - 1], `perft(${d}) = ${n} (expected ${expect[d - 1]}, ${Date.now() - t}ms)`);
}
const n4 = E.perft(E.startPos(), 4);
console.log(`info perft(4) = ${n4} (standard 197281; ep/castling cannot occur by depth 4)`);
ok(n4 === 197281, 'perft(4) = 197281');

function fromList(side, list) {
  const pos = E.emptyPos();
  for (const s of list.split(' ')) { const c = s[0] === 'w' ? 0 : 1; E.setPiece(pos, E.parseSq(s.slice(2)), c, E.CH_TYPE[s[1]]); }
  pos.side = side; return pos;
}
// mate in 1: back-rank. White Ra1, Kg1; black Kg8, pawns f7 g7 h7. Ra8#
{
  const pos = fromList(0, 'wKg1 wRa1 bKg8 bPf7 bPg7 bPh7');
  for (const depth of [2, 3]) {
    const r = E.search(E.clonePos(pos), { maxDepth: depth });
    ok(E.moveName(r.move) === 'a1a8' && r.score > E.MATE - 10, `mate-in-1 found at depth ${depth}: ${E.moveName(r.move)} score ${r.score}`);
  }
  const p2 = E.clonePos(pos); E.makeMove(p2, E.legalMoves(p2).find(m => E.moveName(m) === 'a1a8'));
  ok(E.gameState(p2) === 'mate', 'position after Ra8 detected as checkmate');
}
// mate in 1 for black (queen + king): Qh2# style. Black Kf3? use: white Kh1, Pg2? -> black Qa2? simple: wKh1 wPg2 wPh2? Black Qd1# needs back rank.
{
  const pos = fromList(1, 'wKh1 wPg2 wPh2 bKg8 bQd8');
  const r = E.search(E.clonePos(pos), { maxDepth: 2 });
  ok(E.moveName(r.move) === 'd8d1', `black mate-in-1 found: ${E.moveName(r.move)}`);
}
// stalemate: black Ka8, white Qb6 Kc1 (black to move) -> stalemate
{
  const pos = fromList(1, 'bKa8 wQb6 wKc1');
  ok(E.gameState(pos) === 'stalemate', 'stalemate detected (Ka8 vs Qb6)');
  ok(!E.inCheck(pos), 'stalemated king not in check');
}
// promotion is temporary (M4): queen for the rest of the battle, a pawn again on the roster
{
  const st = E.newState(0, 1); const run = st.run;
  run.formation = {}; const kid = run.roster.find(r => r.t === 'K').id, pid = run.roster.find(r => r.t === 'P').id;
  run.roster = run.roster.filter(r => r.id === kid || r.id === pid);
  run.formation[E.parseSq('e1')] = kid;
  run.formation[E.parseSq('e2')] = pid;
  const b = E.createBattle(run);
  // hand-craft: put pawn on a7, clear enemy, enemy king h8
  b.pos = fromList(0, 'wKe1 wPa7 bKh5 bPh7'); b.ids.fill(-1); b.ids[E.parseSq('e1')] = kid; b.ids[E.parseSq('a7')] = pid;
  b.history = new Map();
  const m = E.legalMoves(b.pos).find(x => E.moveName(x) === 'a7a8q');
  E.playMove(b, m);
  ok((b.pos.b[E.parseSq('a8')] & 7) === E.Q, 'the pawn fights on as a queen in this battle');
  const sum = E.finishBattle(st, b, 'win');
  ok(E.pieceById(run, pid).t === 'P' && sum.promoted === 1, 'promotion is temporary: back on the roster as a pawn after the battle');
}
// captured pieces are lost
{
  const st = E.newState(0, 2), run = st.run, b = E.createBattle(run);
  const victim = b.ids[E.parseSq('e2')];
  b.lost.push(victim);
  E.finishBattle(st, b, 'loss');
  ok(!E.pieceById(run, victim) && run.formation[E.parseSq('e2')] == null, 'captured piece removed from roster and formation');
}
// enemy armies are legal-ish and within budget for many tiers
{
  let good = true;
  for (let t = 1; t <= 60; t++) {
    const a = E.enemyArmy(12345, t), sqs = new Set(a.pieces.map(p => p.sq));
    if (sqs.size !== a.pieces.length || a.pieces.filter(p => p.t === 'K').length !== 1 || a.pieces.some(p => p.sq < 32)) good = false;
    if (t < 25 && Math.abs(E.armyUnits(a.pieces) - E.enemyBudget(t, a.type)) > 1.6) { good = false; console.log('budget off', t, E.armyUnits(a.pieces), E.enemyBudget(t, a.type)); }
  }
  ok(good, 'enemy armies tiers 1..60: one king, unique squares, budget tracked');
}
// time budget respected
{
  const pos = E.startPos(); const t = Date.now();
  const r = E.search(pos, { maxDepth: 30, timeMs: 100 });
  const dt = Date.now() - t;
  ok(dt < 250 && r.move, `iterative deepening respects ~100ms budget (${dt}ms, reached depth ${r.depth}, ${r.nodes} nodes)`);
}
// no drift: game.html contains engine.mjs verbatim (minus export keywords and full-line comments, build.mjs slimJs)
{
  const html = readFileSync(new URL('./game.html', import.meta.url), 'utf8');
  const eng = slimJs(readFileSync(new URL('./engine.mjs', import.meta.url), 'utf8')).replace(/^export /gm, '');
  ok(html.includes(eng), 'game.html inlines the current engine.mjs (no drift)');
  ok(html.startsWith('<title>Checkmarch</title>'), 'game.html starts with <title>');
  ok(!/<(!doctype|html|head|body)\b/i.test(html), 'no doctype/html/head/body tags');
  ok(!/(src|href)\s*=\s*["']?(https?:)?\/\//i.test(html) && !/@import|url\(\s*['"]?http/i.test(html), 'no external resources');
  ok(!/\b(alert|confirm|prompt)\s*\(/.test(html.replace(eng, '')), 'no alert/confirm/prompt');
  console.log(`info game.html size ${(html.length / 1024).toFixed(1)} KB`);
}
console.log(fail ? `\n${fail} FAILED` : '\nALL TESTS PASSED');
process.exit(fail ? 1 : 0);
