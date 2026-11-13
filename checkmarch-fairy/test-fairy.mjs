// node test-fairy.mjs: fairy module tests (no dependencies). Exit code 0 = all pass.
// Engine integration runs against ../checkmarch/engine.mjs patched in memory by engine-patch.mjs (the original
// file is only read). Walls come from ../checkmarch-terrain/terrain.mjs terrainGeometry (read-only import).
// Move generation and attack detection are cross-checked against a NAIVE oracle written here from the piece
// descriptions (coordinates and loops, no shared tables, no Betza parser).
import * as F from './fairy.mjs';
import { loadPatchedEngine, ENCODING_RULES } from './engine-patch.mjs';
import { readFileSync } from 'node:fs';
import { terrainGeometry } from '../checkmarch-terrain/terrain.mjs';

let pass = 0, fail = 0;
function ok(c, msg) { if (c) pass++; else { fail++; console.log('  FAIL: ' + msg); } }
const section = s => console.log('- ' + s);
const sqOf = s => (s.charCodeAt(0) - 97) + (parseInt(s.slice(1), 10) - 1) * 8;
const nm = q => 'abcdefgh'[q & 7] + ((q >> 3) + 1);
const setEq = (a, b) => { const x = [...new Set(a)].sort(), y = [...new Set(b)].sort(); return a.length === x.length && JSON.stringify(x) === JSON.stringify(y); };

// ../checkmarch/engine.mjs may already carry the patch in source (the game applied it, like the terrain patch):
// then it is imported as it is and the test checks the patch is really there (no 3-bit codes left, every hook);
// an unpatched engine is patched in memory as before.
const ENG_URL = new URL('../checkmarch/engine.mjs', import.meta.url), ENG_SRC = readFileSync(ENG_URL, 'utf8');
const APPLIED = ENG_SRC.includes('export function setFairyHooks(h)');
const { E, log } = APPLIED
  ? { E: await import(ENG_URL.href), log: ['applied in source: ' + ENCODING_RULES.map(r => (ENG_SRC.match(r.re) || []).length).join('+') + ' unpatched codes left'] }
  : await loadPatchedEngine(ENG_URL);
if (APPLIED) {
  ok(ENCODING_RULES.slice(0, 5).every(r => !(ENG_SRC.match(r.re) || []).length) && !/\(m >> 13\) & (7|15)\b/.test(ENG_SRC), 'engine.mjs carries the widened encoding in source (no color<<3 / 3-bit type reads left)');
  ok(['if (FX && FX.attacked(b, sq, by)) return true;', '} else if (t > 7) {\n      if (FX) FX.gen(b, sq, t, side, out, capturesOnly);', 'default: if (t > 7 && FX) v += FX.evalPiece(b, sq, c, t, endgame);', 'if (FX) s += FX.evalAdjust(b);'].every(x => ENG_SRC.includes(x)), 'engine.mjs carries the four fairy hooks in source');
}
const ALL = F.FAIRY_ROSTER.map(d => d.id), TY = id => F.FAIRY_BY_ID[id].type;
const CH = { P: 1, N: 2, B: 3, R: 4, Q: 5, K: 6 }; for (const d of F.FAIRY_ROSTER) CH[d.ch] = d.type;
const code = (c, t) => c << 5 | t;
const walls = list => E.setTerrainGeometry(terrainGeometry(list && list.length ? { blocked: list.map(x => typeof x === 'string' ? sqOf(x) : x) } : null));
// position from 'wKe1 bCe8 ...' (letters: PNBRQK + fairy letters M H W C J A E G Z)
function posFrom(list, side = 0) {
  const pos = E.emptyPos();
  for (const s of list.split(/\s+/).filter(Boolean)) E.setPiece(pos, sqOf(s.slice(2)), s[0] === 'w' ? 0 : 1, CH[s[1]]);
  pos.side = side; return pos;
}
const movesFrom = (pos, sq) => E.genMoves(pos, [], false).filter(m => (m & 63) === sq);
const tos = ms => ms.map(m => nm(m >> 6 & 63));
const caps = ms => ms.filter(m => (m >> 13) & 63).map(m => nm(m >> 6 & 63));

section('patch + encoding: ' + log.join(', '));
ok(typeof E.setFairyHooks === 'function', 'patched engine exports setFairyHooks');
{
  const p = E.emptyPos(); E.setPiece(p, 0, 1, E.K); ok(p.b[0] === 38, 'black king code is 1<<5|6 = 38 in the widened encoding');
  ok(F.migrateBoardCodes([0, 9, 14, 6]).join() === '0,33,38,6', 'migrateBoardCodes maps old 3-bit codes');
  ok(F.migrateMove(12 | 20 << 6 | 9 << 13) === (12 | 20 << 6 | 33 << 13), 'migrateMove rewrites the captured field');
}

// ---------------------------------------------------------------- standard chess unchanged
section('standard perft unchanged');
const PERFT = [20, 400, 8902];
for (let d = 1; d <= 3; d++) ok(E.perft(E.startPos(), d) === PERFT[d - 1], `perft ${d} (hooks not installed)`);
E.setFairyHooks(F.fairyHooks);
F.setFairyPieces([]);
for (let d = 1; d <= 3; d++) ok(E.perft(E.startPos(), d) === PERFT[d - 1], `perft ${d} (hooks installed, no fairy active)`);
F.setFairyPieces(ALL);
for (let d = 1; d <= 3; d++) ok(E.perft(E.startPos(), d) === PERFT[d - 1], `perft ${d} (all 9 fairy types active, none on board)`);
ok(E.perft(E.startPos(), 4) === 197281, 'perft 4 = 197281 with all fairy types active');
ok(E.VAL[TY('amazon')] === 1150 && E.TYPE_CH[TY('cannon')] === 'C' && E.CH_TYPE.J === 12 && E.UNITS.A === 8, 'engine VAL / TYPE_CH / CH_TYPE / UNITS extended in place');

// ---------------------------------------------------------------- Betza parser
section('Betza parser');
{
  const sig = s => F.parseBetza(s).map(c => `${c.mode}${c.hop ? 'p' : ''}:${c.range}:${c.vecs.length}${c.bent ? ':bent' + c.bent.map(l => l.length).join('') : ''}`).join(' ');
  ok(sig('WF') === '3:1:4 3:1:4', 'WF = two 4-way steps');
  ok(sig('WAD') === '3:1:4 3:1:4 3:1:4', 'WAD = three 4-way leaps');
  ok(sig('FC') === '3:1:4 3:1:8', 'FC: camel has 8 vectors');
  ok(sig('mRcpR') === '1:0:4 2p:0:4', 'mRcpR: move-only rook + capture-only hopping rook');
  ok(sig('NN') === '3:0:8' && sig('NN2') === '3:2:8' && sig('R3') === '3:3:4', 'doubling = rider, number = range cap');
  ok(sig('QN') === '3:0:4 3:0:4 3:1:8' && sig('BN') === '3:0:4 3:1:8' && sig('RN') === '3:0:4 3:1:8', 'Q R B shorthands');
  ok(sig('t[FR]') === '3:1:4:bent2222', 't[FR]: 4 diagonal steps, 2 outward rook legs each');
  ok(sig('K') === '3:1:4 3:1:4', 'K = WF');
  let threw = 0; for (const bad of ['X', 'pW', 't[FR', 'fN']) { try { F.parseBetza(bad); } catch (e) { threw++; } }
  ok(threw === 4, 'unsupported Betza is rejected (X, pW, t[FR, fN)');
  for (const d of F.FAIRY_ROSTER) ok(F.parseBetza(d.betza).length > 0 && d.plainWords.length > 40 && d.value > 0, `roster row ${d.id} parses and has text + value`);
}

// ---------------------------------------------------------------- hand-computed move sets
section('move sets: empty board centre (d4) and corner (a1), hand-computed');
const L = s => s.split(' ');
const ROOK_D4 = 'd1 d2 d3 d5 d6 d7 d8 a4 b4 c4 e4 f4 g4 h4', BISH_D4 = 'c3 b2 a1 e5 f6 g7 h8 c5 b6 a7 e3 f2 g1', KN_D4 = 'b3 b5 c2 c6 e2 e6 f3 f5';
const CENTRE = {
  commoner: 'c3 d3 e3 c4 e4 c5 d5 e5',
  champion: 'd5 d3 c4 e4 d6 d2 b4 f4 b2 f2 b6 f6',
  wizard: 'c3 e3 c5 e5 g5 g3 a5 a3 e7 c7 e1 c1',
  cannon: ROOK_D4,
  nightrider: 'f5 h6 e6 f8 f3 h2 e2 b5 c6 b8 b3 c2',
  archbishop: BISH_D4 + ' ' + KN_D4,
  chancellor: ROOK_D4 + ' ' + KN_D4,
  gryphon: 'e5 e6 e7 e8 f5 g5 h5 c5 c6 c7 c8 b5 a5 e3 e2 e1 f3 g3 h3 c3 c2 c1 b3 a3',
  amazon: ROOK_D4 + ' ' + BISH_D4 + ' ' + KN_D4,
};
const CORNER = { commoner: 3, champion: 5, wizard: 3, cannon: 14, nightrider: 6, archbishop: 9, chancellor: 16, gryphon: 13, amazon: 23 };
const CORNER_SET = { nightrider: 'b3 c2 c5 e3 d7 g4', gryphon: 'b2 b3 b4 b5 b6 b7 b8 c2 d2 e2 f2 g2 h2', wizard: 'b2 b4 d2' };
const summary = [];
walls(null);
for (const id of ALL) {
  const d = F.FAIRY_BY_ID[id];
  const p1 = posFrom(`w${d.ch}d4`), m1 = movesFrom(p1, sqOf('d4'));
  ok(setEq(tos(m1), L(CENTRE[id])), `${id} d4: ${m1.length} moves = hand set (${L(CENTRE[id]).length})`);
  const p2 = posFrom(`w${d.ch}a1`), m2 = movesFrom(p2, 0);
  ok(m2.length === CORNER[id], `${id} a1: ${m2.length} moves (hand count ${CORNER[id]})`);
  if (CORNER_SET[id]) ok(setEq(tos(m2), L(CORNER_SET[id])), `${id} a1 set`);
  const dg = F.moveDiagram(id);
  ok(dg.sq === 27 && setEq(dg.moves.map(nm), L(CENTRE[id])), `moveDiagram(${id}) matches the d4 set`);
  ok(id === 'cannon' ? dg.captures.length === 0 && setEq(dg.example.captures.map(nm), ['d7', 'd8']) : setEq(dg.captures.map(nm), L(CENTRE[id])), `moveDiagram(${id}) capture pattern`);
  summary.push(`${id} ${m1.length}/${m2.length}`);
}
console.log('  centre/corner counts: ' + summary.join(', '));
{
  const g = F.moveDiagram('cannon').grid;
  ok(g.length === 8 && g[4] === 'mmm@mmmm' && g[2] === '...#....' && g[1] === '...o....' && g[0] === '...o....', 'cannon diagram grid: rook moves, screen on d6, captures on d7/d8 only');
  const z = F.moveDiagram('amazon', { N: 10 }), c10 = F.moveDiagram('cannon', { N: 10 }), m10 = F.moveDiagram('commoner', { N: 10 });
  ok(z.N === 10 && z.sq === 44 && z.moves.length === 43 && c10.moves.length === 18 && m10.moves.length === 8, '10x10 diagrams from e5: amazon 43, cannon 18, commoner 8');
}

section('move sets with blockers and walls, hand-computed');
{
  // cannon d4: own pawn d6 (screen) + black knight d8 (target); black rook d2 is a screen with nothing behind;
  // wall f4 stops the ray and is no screen for the black queen on h4
  walls(['f4']);
  let p = posFrom('wCd4 wPd6 bNd8 bRd2 bQh4'), m = movesFrom(p, sqOf('d4'));
  ok(setEq(tos(m), L('d5 d8 d3 a4 b4 c4 e4')) && setEq(caps(m), ['d8']), `cannon with screens + wall: ${tos(m).join(' ')}`);
  // gryphon d4: own e5 blocks that branch; enemy c5 is captured, no continuation; wall c3 kills that branch;
  // enemy g3 ends the e3-east leg
  walls(['c3']);
  p = posFrom('wGd4 wPe5 bNc5 bNg3'); m = movesFrom(p, sqOf('d4'));
  ok(setEq(tos(m), L('c5 e3 e2 e1 f3 g3')) && setEq(caps(m), L('c5 g3')), `gryphon two-leg blocking: ${tos(m).join(' ')}`);
  // nightrider d4: own f5 blocks (1,2); enemy e6 captured, f8 unreachable; wall c6 blocks (2,-1); e5 is jumped over
  walls(['c6']);
  p = posFrom('wJd4 wPf5 bNe6 wPe5'); m = movesFrom(p, sqOf('d4'));
  ok(m.length === 7 && setEq(caps(m), ['e6']) && setEq(tos(m), L('e6 f3 h2 e2 b5 b3 c2')), `nightrider blockers + wall: ${tos(m).join(' ')}`);
  // champion d4: walls d5 and f6 remove landings, d6 jump passes the d5 wall; own b4, enemy c4
  walls(['d5', 'f6']);
  p = posFrom('wHd4 wPb4 bPc4'); m = movesFrom(p, sqOf('d4'));
  ok(m.length === 9 && setEq(caps(m), ['c4']) && tos(m).includes('d6') && !tos(m).includes('d5'), `champion walls: ${tos(m).join(' ')}`);
  // chancellor a1 walled in on a2 b1 b2: rook part dead, knight part leaps out (b3 c2)
  walls(['a2', 'b1', 'b2']);
  p = posFrom('wEa1'); m = movesFrom(p, 0);
  ok(setEq(tos(m), L('b3 c2')), 'chancellor walled in: only knight leaps');
  // archbishop d4 with wall e5: NE bishop ray gone
  walls(['e5']);
  p = posFrom('wAd4'); m = movesFrom(p, sqOf('d4'));
  ok(m.length === 17 && !tos(m).includes('f6'), 'archbishop wall stops the bishop ray');
  // wizard and commoner never land on walls
  walls(['e5', 'g5', 'c3']);
  ok(movesFrom(posFrom('wWd4'), sqOf('d4')).length === 9 && movesFrom(posFrom('wMd4'), sqOf('d4')).length === 6, 'leapers lose walled landings only');
  // amazon a1 with wall b3: knight b3 gone, c2 stays; rays unaffected
  walls(['b3']);
  ok(movesFrom(posFrom('wZa1'), 0).length === 22, 'amazon a1 with wall b3: 22');
  walls(null);
}

// ---------------------------------------------------------------- cannon check geometry
section('cannon check / screen cases');
{
  let p = posFrom('wKe1 bCe8 bKa8');
  ok(!E.inCheck(p, 0), 'no check along an empty line');
  p = posFrom('wKe1 wNe4 bCe8 bKa8');
  ok(E.inCheck(p, 0), 'one screen (own knight) between cannon and king = check');
  p = posFrom('wKe1 wNe4 bPe6 bCe8 bKa8');
  ok(!E.inCheck(p, 0), 'two screens = no check');
  // the screen capture removes the check; moving the screen off the line removes it too
  p = posFrom('wKe1 bPe5 wNf3 bCe8 bKa8', 0);
  ok(E.inCheck(p, 0), 'enemy pawn as screen gives check');
  let lm = E.legalMoves(p).map(E.moveName);
  ok(!lm.includes('f3e5'), 'Nxe5 does not help: the capturer becomes the new screen');
  p = posFrom('wKe1 bPe2 bCe8 bKa8', 0); lm = E.legalMoves(p).map(E.moveName);
  ok(E.inCheck(p, 0) && lm.includes('e1e2'), 'Kxe2 captures the screen and so removes the check');
  E.makeMove(p, E.legalMoves(p).find(x => E.moveName(x) === 'e1e2')); ok(!E.inCheck(p, 0), 'after Kxe2 the line is empty: no check');
  p = posFrom('wKe1 wNe4 bCe8 bKa8', 0); lm = E.legalMoves(p).map(E.moveName);
  ok(lm.includes('e4c5') && lm.includes('e1d1') && !lm.includes('e1e2'), 'moving the screen away is legal; Ke2 stays on the hurdle line');
  // interposing a second screen blocks the check
  p = posFrom('wKe1 wNe4 wRa6 bCe8 bKa8', 0); lm = E.legalMoves(p).map(E.moveName);
  ok(lm.includes('a6e6'), 'interposing a second piece blocks a cannon check');
  // landing a piece on the empty line gives check (white cannon e1 vs black king e8)
  p = posFrom('wCe1 wNc3 wKa1 bKe8', 0);
  const m = E.legalMoves(p).find(x => E.moveName(x) === 'c3e4'); E.makeMove(p, m);
  ok(E.inCheck(p, 1), 'a knight landing on the cannon line gives check (Ne4+)');
  // and moving your own piece onto the line in front of your king is illegal (it becomes the screen)
  p = posFrom('wKe1 wRa4 bCe8 bKa8', 0); lm = E.legalMoves(p).map(E.moveName);
  ok(!lm.includes('a4e4') && lm.includes('a4b4'), 'a piece may not step onto the enemy cannon line in front of its own king');
  // walls: a wall is not a screen, and a wall beyond the screen blocks
  walls(['e4']);
  p = posFrom('wKe1 bCe8 bKa8'); ok(!E.inCheck(p, 0), 'a wall is never a screen');
  p = posFrom('wKe1 wPe2 bCe8 bKa8'); ok(!E.inCheck(p, 0), 'screen e2 with a wall e4 between cannon and screen: no check');
  walls(null);
  // the cannon cannot capture the adjacent king (no screen)
  p = posFrom('wKe1 bCe2 bKa8'); ok(!E.inCheck(p, 0), 'adjacent cannon does not check');
  // search finds a cannon mate: Nd8# (screen on d8, cannon a8 hits h8 and covers g8)
  p = posFrom('wCa8 wNc6 wKa1 bKh8 bPg7 bPh7', 0);
  const r = E.search(E.clonePos(p), { maxDepth: 2 });
  ok(E.moveName(r.move) === 'c6d8' && r.score > E.MATE - 10, `search finds the cannon mate: ${E.moveName(r.move)} (${r.score})`);
  const q = E.clonePos(p); E.makeMove(q, E.legalMoves(q).find(x => E.moveName(x) === 'c6d8'));
  ok(E.gameState(q) === 'mate', 'Nd8 is checkmate by the cannon');
}

section('gryphon / nightrider / compound checks');
{
  let p = posFrom('wKe1 bGa6 bKa8'); // a6 -> b5, then b4..b1 or c5..h5
  ok(!E.inCheck(p, 0), 'gryphon a6 does not reach e1');
  p = posFrom('wKd1 bGc6 bKa8'); // c6 -> d5 (step), then down d4 d3 d2 d1
  ok(E.inCheck(p, 0), 'gryphon checks along its second leg (c6-d5-d1)');
  p = posFrom('wKd1 wPd3 bGc6 bKa8'); ok(!E.inCheck(p, 0), 'interposing on the second leg blocks');
  p = posFrom('wKd1 wPd5 bGc6 bKa8'); ok(!E.inCheck(p, 0), 'an occupied step square kills the whole branch');
  walls(['d5']); p = posFrom('wKd1 bGc6 bKa8'); ok(!E.inCheck(p, 0), 'a wall on the step square kills the branch'); walls(null);
  p = posFrom('wKd1 bGc2 bKa8'); ok(E.inCheck(p, 0), 'gryphon diagonal step checks');
  p = posFrom('wKd7 bJa1 bKa8'); ok(E.inCheck(p, 0), 'nightrider a1 checks d7 via b3, c5');
  p = posFrom('wKd7 wPc5 bJa1 bKa8'); ok(!E.inCheck(p, 0), 'a piece on the landing square c5 blocks it');
  p = posFrom('wKd7 wPb4 wPc4 bJa1 bKa8'); ok(E.inCheck(p, 0), 'pieces between landings do not block');
  p = posFrom('wKd5 bEc3 bKa8'); ok(E.inCheck(p, 0), 'chancellor knight check');
}

// ---------------------------------------------------------------- naive oracle
const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]], DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]], KNI = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
const NAIVE = {
  1: null, 2: { leap: KNI }, 3: { ride: DIAG }, 4: { ride: ORTH }, 5: { ride: ORTH.concat(DIAG) }, 6: { leap: ORTH.concat(DIAG) },
  8: { leap: ORTH.concat(DIAG) },
  9: { leap: ORTH.concat([[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [2, -2], [-2, 2], [-2, -2]]) },
  10: { leap: DIAG.concat([[1, 3], [3, 1], [-1, 3], [-3, 1], [1, -3], [3, -1], [-1, -3], [-3, -1]]) },
  11: { cannon: true }, 12: { ride: KNI }, 13: { ride: DIAG, leap: KNI }, 14: { ride: ORTH, leap: KNI }, 15: { gryphon: true }, 16: { ride: ORTH.concat(DIAG), leap: KNI },
};
// pseudo-legal [from,to] pairs for the piece on sq (b: codes, W: wall array)
function naiveMoves(b, W, sq) {
  const p = b[sq], c = p >> 5, t = p & 31, r0 = sq >> 3, f0 = sq & 7, out = [];
  const on = (r, f) => r >= 0 && r < 8 && f >= 0 && f < 8, at = (r, f) => r * 8 + f;
  const enemy = s => b[s] && (b[s] >> 5) !== c;
  const ride = (r, f, dr, df, mv, cp) => { for (let rr = r + dr, ff = f + df; on(rr, ff); rr += dr, ff += df) { const s = at(rr, ff); if (W[s]) return; if (b[s]) { if (cp && enemy(s)) out.push(s); return; } if (mv) out.push(s); } };
  if (t === 1) {
    const dir = c ? -1 : 1, r1 = r0 + dir;
    if (on(r1, f0) && !b[at(r1, f0)] && !W[at(r1, f0)]) { out.push(at(r1, f0)); const r2 = r1 + dir; if (r0 === (c ? 6 : 1) && !b[at(r2, f0)] && !W[at(r2, f0)]) out.push(at(r2, f0)); }
    for (const df of [-1, 1]) if (on(r1, f0 + df) && enemy(at(r1, f0 + df))) out.push(at(r1, f0 + df));
    return out;
  }
  const n = NAIVE[t];
  if (n.leap) for (const [dr, df] of n.leap) { const r = r0 + dr, f = f0 + df; if (!on(r, f)) continue; const s = at(r, f); if (W[s]) continue; if (!b[s] || enemy(s)) out.push(s); }
  if (n.ride) for (const [dr, df] of n.ride) ride(r0, f0, dr, df, true, true);
  if (n.cannon) for (const [dr, df] of ORTH) {
    let rr = r0 + dr, ff = f0 + df, screen = false;
    for (; on(rr, ff); rr += dr, ff += df) {
      const s = at(rr, ff); if (W[s]) break;
      if (!screen) { if (b[s]) screen = true; else out.push(s); }
      else if (b[s]) { if (enemy(s)) out.push(s); break; }
    }
  }
  if (n.gryphon) for (const [dr, df] of DIAG) {
    const r = r0 + dr, f = f0 + df; if (!on(r, f)) continue; const s = at(r, f); if (W[s]) continue;
    if (b[s]) { if (enemy(s)) out.push(s); continue; }
    out.push(s); ride(r, f, dr, 0, true, true); ride(r, f, 0, df, true, true);
  }
  return out;
}
function naiveAttacked(b, W, sq, by) {
  const keep = b[sq]; b[sq] = code(by ^ 1, 1); let hit = false;
  for (let s = 0; s < 64 && !hit; s++) {
    const p = b[s]; if (!p || (p >> 5) !== by) continue;
    if ((p & 31) === 1) { const r = (s >> 3) + (by ? -1 : 1); hit = r === (sq >> 3) && Math.abs((s & 7) - (sq & 7)) === 1; }
    else hit = naiveMoves(b, W, s).includes(sq);
  }
  b[sq] = keep; return hit;
}
function naivePerft(b, W, side, k, depth) {
  if (depth === 0) return 1;
  let n = 0;
  for (let s = 0; s < 64; s++) {
    const p = b[s]; if (!p || (p >> 5) !== side) continue;
    for (const to of naiveMoves(b, W, s)) {
      const nb = Int8Array.from(b); nb[to] = (p & 31) === 1 && (to >> 3) === (side ? 0 : 7) ? code(side, 5) : p; nb[s] = 0;
      const nk = k.slice(); if ((p & 31) === 6) nk[side] = to;
      if (naiveAttacked(nb, W, nk[side], side ^ 1)) continue;
      n += naivePerft(nb, W, side ^ 1, nk, depth - 1);
    }
  }
  return n;
}

section('engine movegen + isAttacked vs naive oracle (random positions with walls)');
{
  const rng = E.mulberry(20261112);
  const pick = n => Math.floor(rng() * n);
  const types = [1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  let positions = 0, moveMis = 0, atkMis = 0, squares = 0, moves = 0;
  for (let it = 0; it < 400; it++) {
    const W = new Uint8Array(64), wl = [];
    const nW = pick(5); for (let i = 0; i < nW; i++) { const s = 16 + pick(32); if (!W[s]) { W[s] = 1; wl.push(s); } }
    walls(wl);
    const pos = E.emptyPos(), free = () => { for (;;) { const s = pick(64); if (!pos.b[s] && !W[s]) return s; } };
    E.setPiece(pos, free(), 0, 6); E.setPiece(pos, free(), 1, 6);
    const nP = 3 + pick(10);
    for (let i = 0; i < nP; i++) { const t = types[pick(types.length)], s = free(); if (t === 1 && ((s >> 3) === 0 || (s >> 3) === 7)) continue; E.setPiece(pos, s, pick(2), t); }
    pos.side = pick(2); positions++;
    const eng = new Map();
    for (const m of E.genMoves(pos, [], false)) { const k = m & 63; if (!eng.has(k)) eng.set(k, []); eng.get(k).push(m >> 6 & 63); }
    for (let s = 0; s < 64; s++) {
      const p = pos.b[s]; if (!p || (p >> 5) !== pos.side) continue;
      const nv = naiveMoves(pos.b, W, s), ev = eng.get(s) || []; moves += nv.length;
      if (!setEq(ev, nv)) { moveMis++; if (moveMis < 4) console.log(`    gen mismatch ${nm(s)} t${p & 31}: engine ${ev.map(nm)} naive ${nv.map(nm)}`); }
    }
    for (let s = 0; s < 64; s++) for (const by of [0, 1]) {
      if (W[s]) continue; squares++;
      const a = E.isAttacked(pos.b, s, by), n = naiveAttacked(pos.b, W, s, by);
      if (a !== n) { atkMis++; if (atkMis < 4) console.log(`    attack mismatch ${nm(s)} by ${by}: engine ${a} naive ${n}`); }
    }
  }
  walls(null);
  ok(moveMis === 0, `genMoves = oracle on ${positions} positions (${moves} moves)`);
  ok(atkMis === 0, `isAttacked = oracle on ${squares} square/side checks`);
  console.log(`  oracle: ${positions} positions, ${moves} moves, ${squares} attack checks, mismatches gen ${moveMis} / attack ${atkMis}`);
}

// ---------------------------------------------------------------- perft on fairy positions
section('fairy perft: engine = oracle, stable across runs');
{
  const cases = [
    ['wKe1 wCa1 wJb1 wHc1 wWf1 wMg1 wPd2 wPe2 bKe8 bAc8 bGf8 bEh8 bZd8 bPd7 bPe7', 0, 3, []],
    ['wKg1 wCd1 wPd4 wGb2 wNf3 bKg8 bCd8 bPd5 bWc6 bWf6 bJb8', 1, 3, ['e5', 'd6']],
    ['wKa1 wZh4 wEb3 bKh8 bAa8 bCh1 bMe5', 0, 3, ['c4']],
  ];
  const counts = [];
  for (const [list, side, depth, wl] of cases) {
    walls(wl);
    const W = new Uint8Array(64); for (const s of wl) W[sqOf(s)] = 1;
    const pos = posFrom(list, side), before = Array.from(pos.b).join();
    const a = E.perft(pos, depth), b2 = E.perft(pos, depth);
    const nv = naivePerft(Int8Array.from(pos.b), W, side, pos.k.slice(), depth);
    ok(a === b2 && Array.from(pos.b).join() === before, `perft ${depth} stable and position restored (${a})`);
    ok(a === nv, `perft ${depth} = oracle perft (${a} vs ${nv})`);
    counts.push(a);
  }
  walls(null);
  console.log('  fairy perft counts: ' + counts.join(', '));
}

// ---------------------------------------------------------------- make / unmake round-trip
section('make/unmake round-trip for each piece');
{
  const rng = E.mulberry(7);
  for (const id of ALL) {
    const ch = F.FAIRY_BY_ID[id].ch; let n = 0, bad = 0;
    for (let g = 0; g < 6; g++) {
      const pos = posFrom(`wKe1 w${ch}d4 w${ch}b2 bKe8 b${ch}e5 bNc6 bPf7 wPg2 bRh8`, g & 1);
      for (let ply = 0; ply < 30; ply++) {
        const lm = E.legalMoves(pos); if (!lm.length) break;
        for (const m of lm) {
          const b0 = Array.from(pos.b).join(), k0 = pos.k.join(), s0 = pos.side;
          E.makeMove(pos, m); E.unmakeMove(pos, m); n++;
          if (Array.from(pos.b).join() !== b0 || pos.k.join() !== k0 || pos.side !== s0) bad++;
        }
        E.makeMove(pos, lm[Math.floor(rng() * lm.length)]);
      }
    }
    ok(bad === 0 && n > 100, `${id}: ${n} make/unmake pairs restore board, kings, side`);
  }
}

// ---------------------------------------------------------------- evaluation
section('evaluation hooks');
{
  ok(F.cannonValue(32) === 450 && F.cannonValue(8) === 350 && F.cannonValue(20) === 400, 'cannon 450 full board, 350 near-empty');
  const pair = posFrom('wKe1 wWc1 wWf1 bKe8'), same = posFrom('wKe1 wWc1 wWe1 bKe8'.replace('wWe1', 'wWa3'));
  ok(F.evalAdjust(pair.b) - F.evalAdjust(same.b) === 40, 'opposite-colour wizard pair +40 (c1 dark + f1 light vs c1 + a3 both dark)');
  const lone = posFrom('wKe1 wZd4 bKe8'), crowd = posFrom('wKe1 wZd4 bKe8 bNb8 bNg8 bBc8 bBf8 bRa8 bRh8 bPa7 bPb7 bPc7 bPd7 bPe7 bPf7 bPg7 bPh7');
  ok(F.evalAdjust(lone.b) === 0 && F.evalAdjust(crowd.b) === -48, `amazon leveling: 0 vs bare king, ${F.evalAdjust(crowd.b)} vs a full army`);
  const st = E.startPos(); ok(E.evaluate(st) === E.evaluate(E.startPos()) && Number.isFinite(E.evaluate(posFrom('wKe1 wCd4 wGa1 bKe8 bJh8'))), 'evaluate is finite with fairy pieces');
  const fv = F.fairyValueTable(10); ok(fv.commoner === 276 && fv.chancellor === 875 && fv.gryphon === 663, '10x10 re-band: leapers -8%, rook family kept');
  // search plays a whole fairy game without errors or illegal states
  let p = posFrom('wKe1 wCa1 wJb1 wHc1 wWf1 wMg1 wPa2 wPb2 wPc2 wPd2 wPe2 bKe8 bAc8 bGf8 bEh8 bZd8 bPa7 bPb7 bPc7 bPd7', 0), plies = 0, okk = true;
  for (; plies < 40; plies++) { const r = E.search(p, { maxDepth: 2, maxNodes: 3000 }); if (!r.move) break; E.makeMove(p, r.move); if (E.inCheck(p, p.side ^ 1)) okk = false; }
  ok(okk && plies > 10, `search self-play ${plies} plies with all fairy types, never leaves own king in check`);
}

// ---------------------------------------------------------------- economy, mirror, gating
section('economy, enemy mirror, gating helpers');
{
  ok(F.fairyBasePrice('commoner') === 88 && F.fairyBasePrice('amazon') > F.fairyBasePrice('chancellor') && F.fairyPrice('cannon', 1) === Math.round(F.fairyBasePrice('cannon') * 1.7), 'prices: value^1.75 anchored on the queen, x1.7 per copy');
  ok(F.fairyCanBuy('commoner', 9) && F.fairyCanBuy('champion', 1) && !F.fairyCanBuy('champion', 2) && F.fairyCanBuy('wizard', 0) && !F.fairyCanBuy('wizard', 1) && !F.fairyCanBuy('amazon', 1), 'copy caps (wizard pair counts as two)');
  const un = { commoner: 1, champion: 2, cannon: 3 };
  ok(F.enemyFairyPool(un, 1).length === 0 && F.enemyFairyPool(un, 2).join() === 'commoner' && F.enemyFairyPool(un, 4).join() === 'commoner,champion,cannon', 'enemy band lags the player by one region');
  ok(F.enemyFairyPool(un, 4, { rival: true }).includes('wizard'), 'the rival previews the next locked piece');
  ok(F.enemyFairyPool({}, 7, { boss: true }).includes('amazon') && !F.enemyFairyPool({}, 7).includes('amazon'), 'amazon: bosses field it first');
  ok(F.enemyFairyPool(un, 5, { band: 0, minBand: 1 }).length === 0, 'low elo bands stay frozen');
  // gating: chancellor waits behind b1; the knight leaving b1 may gate it in
  const gates = [{ color: 0, sq: 1, t: 14 }];
  const pos = E.startPos(); const lm = E.legalMoves(pos), ex = F.expandGates(lm, gates, 0);
  ok(ex.length === 22, 'expandGates adds one gate variant per move off b1 (Na3, Nc3)');
  const gm = ex.find(m => m & F.GATE_FLAG); E.makeMove(pos, gm & 0x7ffff); F.gateDrop(pos.b, gm, 0);
  ok(pos.b[1] === code(0, 14) && F.gatesAfter(gates, gm, 0).length === 0, 'gate move drops the chancellor on b1 and consumes the right');
  F.gateLift(pos.b, gm); E.unmakeMove(pos, gm & 0x7ffff); ok(Array.from(pos.b).join() === Array.from(E.startPos().b).join(), 'gate lift + unmake restore the start');
  const quiet = lm.find(m => (m & 63) === 1);
  ok(F.gatesAfter(gates, quiet, 0).length === 0, 'leaving the home square without gating lapses the right (caller drops the variant)');
  ok(F.gatesAfter(gates, 2 | 1 << 6 | code(0, 2) << 13, 1).length === 0 && F.gatesAfter(gates, 2 | 3 << 6, 1).length === 1, 'a capture on the home square lapses it; other moves do not');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
