// node test-terrain.mjs  — terrain module tests (no dependencies).
// Engine integration is tested against a copy of ../checkmarch/engine.mjs patched in memory exactly
// as TERRAIN-API.md describes (the original file is only read, never written).
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as T from './terrain.mjs';

let pass = 0, fail = 0;
function ok(c, msg) { if (c) pass++; else { fail++; console.log('  FAIL: ' + msg); } }
function section(name) { console.log('- ' + name); }
const sqOf = (s) => (s.charCodeAt(0) - 97) + (parseInt(s.slice(1), 10) - 1) * 8;
const fromList = (list, kind = 'rock', N = 8) => {
  const t = { v: 1, n: N, biome: 'plains', tier: 10, type: 'garrison', blocked: [], kind: {} };
  for (const x of list) { const [name, k] = x.split(':'); const s = sqOf(name); t.blocked.push(s); t.kind[s] = k || kind; }
  t.blocked.sort((a, b) => a - b); return t;
};
const sorted = (a) => a.slice().sort((x, y) => x - y);
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

// independent connectivity check (union-find; does not share code with terrainConnected)
function ufConnected(blocked, N) {
  const par = Array.from({ length: N * N }, (_, i) => i), bl = new Set(blocked);
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  for (let s = 0; s < N * N; s++) {
    if (bl.has(s)) continue;
    const r = Math.floor(s / N), f = s % N;
    for (const [dr, df] of [[0, 1], [1, -1], [1, 0], [1, 1]]) {
      const rr = r + dr, ff = f + df;
      if (rr < N && ff >= 0 && ff < N && !bl.has(rr * N + ff)) par[find(s)] = find(rr * N + ff);
    }
  }
  const roots = new Set();
  for (let s = 0; s < N * N; s++) if (!bl.has(s)) roots.add(find(s));
  return roots.size <= 1;
}

// ---------------------------------------------------------------- determinism
section('determinism');
{
  let differs = 0;
  for (let seed = 0; seed < 200; seed++) for (const biome of T.TERRAIN_BIOME_KEYS) {
    const a = T.generateTerrain(seed, 'n' + seed, 8, biome, { tier: 12 });
    const b = T.generateTerrain(seed, 'n' + seed, 8, biome, { tier: 12 });
    ok(JSON.stringify(a) === JSON.stringify(b), `same input same output seed ${seed} ${biome}`);
    const c = T.generateTerrain(seed + 1, 'n' + seed, 8, biome, { tier: 12 });
    if (JSON.stringify(a.blocked) !== JSON.stringify(c.blocked)) differs++;
  }
  ok(differs > 500, `different seeds give different layouts (${differs}/600 differ)`);
  const a = T.generateTerrain(7, 3, 8, 'marsh', { tier: 20 }), b = T.generateTerrain(7, 4, 8, 'marsh', { tier: 20 });
  let nd = 0; for (let i = 0; i < 100; i++) if (JSON.stringify(T.generateTerrain(7, i, 8, 'marsh', { tier: 20 }).blocked) !== JSON.stringify(T.generateTerrain(7, i + 1, 8, 'marsh', { tier: 20 }).blocked)) nd++;
  ok(nd > 90, `node id is part of the seed (${nd}/100 neighbouring ids differ)`);
  ok(JSON.parse(JSON.stringify(a)).blocked.length === a.blocked.length, 'JSON round-trip');
  ok(Array.isArray(a.blocked) && T.terrainBlockedSet(a) instanceof Set, 'blocked serializes as an array; Set view available');
  const fixed = T.generateTerrain('golden', 'n5', 8, 'highland', { tier: 18 });
  console.log('  golden sample (seed "golden", node n5, highland, tier 18):', JSON.stringify(fixed.blocked), JSON.stringify(fixed.kind));
}

// ---------------------------------------------------------------- guarantees sweep
section('guarantees: 500 seeds x tiers 1-30 x 3 biomes (+ citadel/keep/avoid passes)');
{
  const N = 8, stats = {}, kinds = { rock: 0, water: 0 }, byBiome = {};
  let n = 0, problems = 0, centerAll = 0, deploy = 0, disc = 0, early = 0, range = 0, fort = 0;
  const skirm = 'Nc6 Pe7 Bf6 Pd7 Pc5 Pf7 Nh6 Pb7 Bb6 Pg7 Ra8 Rh8 Pa7 Ph7 Qd8'.split(' ').map(x => sqOf(x.slice(1)));
  for (let seed = 0; seed < 500; seed++) for (let tier = 1; tier <= 30; tier++) for (const biome of T.TERRAIN_BIOME_KEYS) {
    const type = tier % 10 === 0 ? 'citadel' : 'garrison';
    const avoid = seed % 5 === 0 ? skirm : undefined;
    const t = T.generateTerrain(seed * 7919 + 13, 'node-' + (seed % 37), N, biome, { tier, type, avoid });
    n++;
    const c = t.blocked.length;
    (stats[tier] = stats[tier] || []).push(c);
    (byBiome[biome] = byBiome[biome] || []).push(c);
    for (const s of t.blocked) kinds[t.kind[s]]++;
    if (T.terrainProblems(t, { avoid }).length) problems++;
    if (tier < 3 && c !== 0) early++;
    if (tier >= 3 && (c < 2 || c > 6)) range++;
    if (type === 'citadel' && c > 3) fort++;
    for (const s of t.blocked) { const r = s >> 3; if (r < 2 || r > 5) deploy++; }
    if ([27, 28, 35, 36].every(s => t.blocked.includes(s))) centerAll++;
    if (!ufConnected(t.blocked, N)) disc++;
    if (avoid) for (const s of avoid) if (t.blocked.includes(s)) problems++;
  }
  for (const type of ['citadel', 'keep']) for (let seed = 0; seed < 500; seed++) for (const biome of T.TERRAIN_BIOME_KEYS) {
    const tier = 3 + (seed % 28);
    const t = T.generateTerrain(seed, 'f' + seed, N, biome, { tier, type });
    n++;
    if (t.blocked.length > 3 || t.blocked.length < 2) fort++;
    if (T.terrainProblems(t).length) problems++;
    if (!ufConnected(t.blocked, N)) disc++;
  }
  ok(early === 0, `0 terrain below tier 3 (violations ${early})`);
  ok(range === 0, `2-6 squares from tier 3 (violations ${range})`);
  ok(fort === 0, `citadel/keep 2-3 squares (violations ${fort})`);
  ok(deploy === 0, `deployment ranks 1,2,7,8 clear (violations ${deploy})`);
  ok(centerAll === 0, `never all four centre squares (violations ${centerAll})`);
  ok(disc === 0, `open squares king-connected, union-find proof (violations ${disc})`);
  ok(problems === 0, `terrainProblems() clean + avoid squares respected (violations ${problems})`);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const line = [1, 2, 3, 5, 8, 10, 12, 15, 18, 20, 22, 25, 28, 30].map(t => `t${t}:${mean(stats[t]).toFixed(2)}`).join(' ');
  console.log(`  ${n} terrains checked. mean blocked by tier: ${line}`);
  console.log(`  mean by biome: ${T.TERRAIN_BIOME_KEYS.map(b => b + ' ' + mean(byBiome[b]).toFixed(2)).join(', ')}; kinds rock ${kinds.rock} / water ${kinds.water}`);
  let mono = true;
  for (let t = 4; t <= 29; t++) if (t % 10 && (t + 1) % 10 && mean(stats[t + 1]) + 0.05 < mean(stats[t])) mono = false;
  ok(mono, 'mean count is non-decreasing over garrison tiers (gentle scaling)');
  ok(mean(stats[3]) < 2.6 && mean(stats[29]) > 4.5, 'scales from ~2 at tier 3 to ~5-6 by tier 29');
  ok(Math.abs(mean(stats[4]) - mean(stats[3])) < 0.5, 'no big jumps tier to tier');
  // marsh is water-heavy, highland rock-heavy
  let mw = 0, mt = 0, hw = 0, ht = 0;
  for (let s = 0; s < 300; s++) {
    const m = T.generateTerrain(s, 'x', 8, 'marsh', { tier: 20 }), h = T.generateTerrain(s, 'x', 8, 'highland', { tier: 20 });
    for (const q of m.blocked) { mt++; if (m.kind[q] === 'water') mw++; }
    for (const q of h.blocked) { ht++; if (h.kind[q] === 'water') hw++; }
  }
  ok(mw / mt > 0.6 && hw / ht < 0.3, `biome flavour: marsh ${(100 * mw / mt).toFixed(0)}% water, highland ${(100 * hw / ht).toFixed(0)}% water`);
  // other board sizes still honour the rules
  let other = 0;
  for (const N2 of [6, 7, 9, 10]) for (let s = 0; s < 100; s++) {
    const t = T.generateTerrain(s, 'o', N2, 'plains', { tier: 25 });
    if (T.terrainProblems(t).length || !ufConnected(t.blocked, N2)) other++;
  }
  ok(other === 0, `boards 6/7/9/10 also satisfy every guarantee (violations ${other})`);
  ok(T.generateTerrain(1, 'x', 8, 'nonsense', { tier: 10 }).biome === 'plains', 'unknown biome falls back to plains');
}

// ---------------------------------------------------------------- connectivity checker
section('connectivity checker');
{
  const m = new Uint8Array(64);
  ok(T.terrainConnected(m, 8), 'empty board connected');
  // pocket: a4 (sq 24) sealed by a3? no — a3/b3 are rank 3 (allowed): wall a5,b5,b4,b3,a3
  for (const s of ['a5', 'b5', 'b4', 'b3', 'a3']) m[sqOf(s)] = 1;
  ok(!T.terrainConnected(m, 8), 'sealed a4 pocket detected as disconnected');
  ok(!ufConnected(['a5', 'b5', 'b4', 'b3', 'a3'].map(sqOf), 8), 'union-find agrees');
  m[sqOf('b3')] = 0;
  ok(T.terrainConnected(m, 8), 'opening b3 reconnects it');
  // diagonal gap counts as connected for king moves
  const d = new Uint8Array(64); for (const s of ['a4', 'b5', 'c5', 'b3']) d[sqOf(s)] = 1;
  ok(T.terrainConnected(d, 8) === ufConnected(['a4', 'b5', 'c5', 'b3'].map(sqOf), 8), 'checkers agree on a diagonal-gap case');
  // random agreement
  let agree = 0;
  const rnd = T.terrMulberry32(99);
  for (let i = 0; i < 3000; i++) {
    const bl = []; const mk = new Uint8Array(64);
    for (let s = 16; s < 48; s++) if (rnd() < 0.3) { bl.push(s); mk[s] = 1; }
    if (T.terrainConnected(mk, 8) === ufConnected(bl, 8)) agree++;
  }
  ok(agree === 3000, `terrainConnected == union-find on 3000 random masks (${agree})`);
}

// ---------------------------------------------------------------- movement probe
section('movement probe');
{
  const P = (t, sq, type, color = 0, occ = null) => T.terrainProbe(t, sqOf(sq), type, color, occ).moves.map(s => 'abcdefgh'[s & 7] + ((s >> 3) + 1));
  const rock = fromList(['d5'], 'rock');
  const r1 = P(rock, 'd3', 'R');
  ok(r1.includes('d4') && !r1.includes('d5') && !r1.includes('d6') && !r1.includes('d8'), 'rook stops before rock (d3 up: d4 only)');
  ok(r1.includes('a3') && r1.includes('h3') && r1.includes('d1'), 'rook other rays unaffected');
  const water = fromList(['e4:water']);
  const b1 = P(water, 'c2', 'B');
  ok(b1.includes('d3') && !b1.includes('e4') && !b1.includes('f5') && !b1.includes('h7'), 'bishop cannot cross water (c2 -> d3 only on that diagonal)');
  const q1 = P(water, 'e2', 'Q');
  ok(q1.includes('e3') && !q1.includes('e4') && !q1.includes('e5'), 'queen file ray stops before water');
  // knight leaps: surround a knight with walls, it still jumps
  const ring = fromList(['c3', 'd3', 'e3', 'c4', 'e4', 'c5', 'd5', 'e5']);
  const n1 = P(ring, 'd4', 'N');
  ok(same(n1.map(sqOf), ['b3', 'b5', 'c2', 'c6', 'e2', 'e6', 'f3', 'f5'].map(sqOf)), 'knight leaps over a full ring of rock');
  const nb = fromList(['c6', 'e6']);
  const n2 = P(nb, 'd4', 'N');
  ok(!n2.includes('c6') && !n2.includes('e6') && n2.length === 6, 'knight cannot land on blocked squares');
  const k1 = P(fromList(['d5', 'e5:water']), 'd4', 'K');
  ok(!k1.includes('d5') && !k1.includes('e5') && k1.length === 6, 'king cannot step onto rock or water');
  const pw = fromList(['e3']);
  ok(P(pw, 'e2', 'P').length === 0, 'pawn cannot push onto rock');
  const pw2 = fromList(['e4:water']);
  ok(same(P(pw2, 'e2', 'P').map(sqOf), [sqOf('e3')]), 'pawn double push blocked by water on the 2nd square');
  const bp = P(fromList(['d5']), 'd6', 'P', 1);
  ok(bp.length === 0, 'black pawn blocked by rock below it');
  const pc = T.terrainProbe(fromList(['d3']), sqOf('e2'), 'P', 0, { [sqOf('f3')]: 1 });
  ok(same(pc.captures, [sqOf('f3')]) && !pc.pawnAttacks.includes(sqOf('d3')), 'pawn captures normally; no attack onto rock');
  // no landing on blocked, ever: random terrains x all pieces x all squares
  let landed = 0, fromWall = 0;
  for (let s = 0; s < 120; s++) {
    const t = T.generateTerrain(s, 'p', 8, T.TERRAIN_BIOME_KEYS[s % 3], { tier: 28 });
    for (let sq = 0; sq < 64; sq++) for (const ty of ['P', 'N', 'B', 'R', 'Q', 'K']) for (const col of [0, 1]) {
      const r = T.terrainProbe(t, sq, ty, col);
      if (T.isBlocked(t, sq) && (r.moves.length || r.captures.length)) fromWall++;
      for (const x of r.moves.concat(r.captures, r.pawnAttacks)) if (T.isBlocked(t, x)) landed++;
      if (ty === 'R' || ty === 'B' || ty === 'Q') {
        // every slider target's path is clear
        const fr = sq >> 3, ff = sq & 7;
        for (const x of r.moves) {
          const dr = Math.sign((x >> 3) - fr), df = Math.sign((x & 7) - ff);
          for (let y = sq + dr * 8 + df; y !== x; y += dr * 8 + df) if (T.isBlocked(t, y)) landed++;
        }
      }
    }
  }
  ok(landed === 0, `no move lands on or slides through a wall across 120 terrains x 6 pieces x 64 squares (${landed})`);
  ok(fromWall === 0, 'a blocked square generates no moves');
  ok(T.isBlocked(rock, sqOf('d5')) && !T.isBlocked(rock, sqOf('d4')) && !T.isBlocked(null, 0), 'isBlocked adapter');
  ok(T.terrainKind(water, sqOf('e4')) === 'water' && T.terrainKind(water, 0) === null, 'terrainKind adapter');
}

// ---------------------------------------------------------------- engine integration (patched copy)
section('engine integration (in-memory patched copy of ../checkmarch/engine.mjs)');
{
  const engineSrc = readFileSync(new URL('../checkmarch/engine.mjs', import.meta.url), 'utf8');
  const PATCH = [
    ['const KN = [], KG = [], RAYS = [], PAWN_FROM = [[], []];', 'const KN = [], KG = [], RAYS = [], PAWN_FROM = [[], []], WALL = new Uint8Array(64);'],
    ['        if (!b[to]) {', '        if (!b[to] && !WALL[to]) {'],
    ['r === startR && !b[to + dir])', 'r === startR && !b[to + dir] && !WALL[to + dir])'],
  ];
  let src = engineSrc, applied = 0;
  // each patch line is either applied here (pristine engine) or already present (engine ships patched since M5)
  for (const [a, b] of PATCH) { if (src.includes(b)) applied++; else if (src.split(a).length === 2) { src = src.replace(a, b); applied++; } }
  ok(applied === PATCH.length, `all ${PATCH.length} patch anchors found or already applied in engine.mjs (${applied})`);
  const alreadyExported = src.includes('export function setTerrainGeometry');
  if (!alreadyExported) src += `
// ---------- terrain (from TERRAIN-API.md) ----------
export function setTerrainGeometry(g) {
  for (let sq = 0; sq < 64; sq++) { KN[sq] = g.KN[sq]; KG[sq] = g.KG[sq]; RAYS[sq] = g.RAYS[sq]; PAWN_FROM[0][sq] = g.PAWN_FROM[0][sq]; PAWN_FROM[1][sq] = g.PAWN_FROM[1][sq]; }
  WALL.set(g.WALL);
}
`;
  const tmp = new URL('./.engine-patched.tmp.mjs', import.meta.url);
  writeFileSync(tmp, src);
  let E;
  try { E = await import(tmp.href); } finally { unlinkSync(tmp); }

  // empty terrain reproduces the stock engine
  E.setTerrainGeometry(T.terrainGeometry(null));
  const st = E.startPos();
  const pf = [1, 2, 3].map(d => E.perft(st, d));
  ok(pf.join() === '20,400,8902', `perft with empty terrain: ${pf.join(', ')}`);

  const pos = (pieces, side = 0) => { const p = E.emptyPos(); for (const [c, t, s] of pieces) E.setPiece(p, sqOf(s), c, E.CH_TYPE[t]); p.side = side; return p; };
  const names = (ms) => ms.map(m => E.sqName(E.mTo(m)));
  const withT = (t, fn) => { E.setTerrainGeometry(T.terrainGeometry(t)); try { return fn(); } finally { E.setTerrainGeometry(T.terrainGeometry(null)); } };

  // rook stops before rock
  withT(fromList(['d5']), () => {
    const p = pos([[0, 'K', 'a1'], [1, 'K', 'h8'], [0, 'R', 'd3'], [1, 'Q', 'd7']]);
    const to = names(E.legalMoves(p).filter(m => E.mFrom(m) === sqOf('d3')));
    ok(to.includes('d4') && !to.includes('d5') && !to.includes('d7'), 'engine: rook stops before rock, cannot reach the queen behind it');
  });
  // bishop can't cross water; and water shields the king from check
  withT(fromList(['e4:water']), () => {
    const p = pos([[0, 'K', 'h1'], [1, 'K', 'g6'], [0, 'B', 'c2']], 1);
    ok(!E.inCheck(p, 1), 'engine: bishop on c2 does not check through water at e4');
    const to = names(E.legalMoves(pos([[0, 'K', 'h1'], [1, 'K', 'a8'], [0, 'B', 'c2']])).filter(m => E.mFrom(m) === sqOf('c2')));
    ok(to.includes('d3') && !to.includes('e4') && !to.includes('f5'), 'engine: bishop cannot cross water');
  });
  // knight leaps, cannot land
  withT(fromList(['c3', 'd3', 'e3', 'c4', 'e4', 'c5', 'd5', 'e5', 'f5']), () => {
    const p = pos([[0, 'K', 'a1'], [1, 'K', 'h8'], [0, 'N', 'd4']]);
    const to = names(E.legalMoves(p).filter(m => E.mFrom(m) === sqOf('d4')));
    ok(same(to.map(sqOf), ['b3', 'b5', 'c2', 'c6', 'e2', 'e6', 'f3'].map(sqOf)), 'engine: knight leaps over the ring, not onto f5');
    const q = pos([[0, 'K', 'a1'], [1, 'K', 'e6'], [0, 'N', 'd4']], 1);
    ok(E.inCheck(q, 1), 'engine: knight still gives check over terrain');
  });
  // pawn push / double push
  withT(fromList(['e4:water', 'd3']), () => {
    const p = pos([[0, 'K', 'a1'], [1, 'K', 'h8'], [0, 'P', 'e2'], [0, 'P', 'd2']]);
    const to = names(E.legalMoves(p).filter(m => (p.b[E.mFrom(m)] & 7) === E.P));
    ok(same(to.map(sqOf), [sqOf('e3')]), `engine: pawns honour walls (moves ${to.join(',')})`);
  });
  // perft and random self-play with terrain: nothing ever lands on a wall; search respects terrain
  let bad = 0, games = 0, plies = 0;
  for (let s = 0; s < 40; s++) {
    const t = T.generateTerrain(s, 'g', 8, T.TERRAIN_BIOME_KEYS[s % 3], { tier: 26 });
    withT(t, () => {
      const p = E.startPos();
      const rng = T.terrMulberry32(s);
      for (let i = 0; i < 80; i++) {
        const ms = E.legalMoves(p); if (!ms.length) break;
        for (const m of ms) if (T.isBlocked(t, E.mTo(m))) bad++;
        const m = i % 10 === 9 ? (E.search(p, { maxDepth: 2, timeMs: 50 }).move || ms[0]) : ms[(rng() * ms.length) | 0];
        E.makeMove(p, m); plies++;
        for (const x of t.blocked) if (p.b[x]) bad++;
      }
      games++;
    });
  }
  ok(bad === 0, `engine: ${games} terrain games / ${plies} plies (random + search), no move onto a wall (${bad})`);
  // engine movegen agrees with terrainProbe for lone pieces
  let mismatch = 0;
  for (let s = 0; s < 30; s++) {
    const t = T.generateTerrain(s, 'm', 8, 'plains', { tier: 30 });
    withT(t, () => {
      for (let sq = 16; sq < 48; sq++) for (const ty of ['N', 'B', 'R', 'Q']) {
        if (T.isBlocked(t, sq)) continue;
        const kw = sq === 0 ? 7 : 0, kb = 63;
        if (sq === kw || sq === kb) continue;
        const p = pos([[0, 'K', 'a1'], [1, 'K', 'h8']]);
        E.setPiece(p, sq, 0, E.CH_TYPE[ty]);
        const eng = E.genMoves(p, [], false).filter(m => E.mFrom(m) === sq).map(E.mTo);
        const occ = { 0: 0, 63: 1 };
        const pr = T.terrainProbe(t, sq, ty, 0, occ);
        if (!same(eng, pr.moves.concat(pr.captures))) mismatch++;
      }
    });
  }
  ok(mismatch === 0, `engine genMoves == terrainProbe for lone N/B/R/Q on 30 terrains (${mismatch} mismatches)`);
  ok(E.perft(E.startPos(), 3) === 8902, 'tables restored after terrain battles (perft 3 = 8902)');
}

// ---------------------------------------------------------------- geometry tables
section('geometry tables');
{
  const g = T.terrainGeometry(null, 8);
  ok(g.KN[0].length === 2 && g.KG[27].length === 8 && g.RAYS[0][0].length === 7, 'null terrain = full board tables');
  const t = fromList(['d5']), h = T.terrainGeometry(t, 8);
  ok(h.RAYS[sqOf('d3')][0].length === 1 && h.KN[sqOf('d5')].length === 0 && h.WALL[sqOf('d5')] === 1, 'rays truncated, wall square empty');
}

// ---------------------------------------------------------------- demo page contract
section('demo page contract (terrain-demo.html)');
{
  const html = readFileSync(new URL('./terrain-demo.html', import.meta.url), 'utf8');
  ok(html.startsWith('<title>Checkmarch Terrain Demo</title>'), 'starts with the title');
  ok(!/<!doctype|<html[\s>]|<head[\s>]|<body[\s>]/i.test(html), 'no doctype/html/head/body tags');
  ok(!/(src|href)\s*=\s*["']?(https?:)?\/\//i.test(html) && !/@import|url\(\s*['"]?https?:/i.test(html), 'no external resources');
  ok(/:root\s*{[^}]*--bg/.test(html) && html.includes('@media (prefers-color-scheme: dark)') && html.includes(':root:not([data-theme="light"])') && html.includes(':root[data-theme="dark"]'), 'theme tokens light/dark/forced');
  ok(!/\balert\(|\bconfirm\(|\bprompt\(/.test(html), 'no alert/confirm/prompt');
  const src = readFileSync(new URL('./terrain.mjs', import.meta.url), 'utf8');
  const body = src.replace(/^import\s[^;]*;\s*$/gm, '').replace(/^export\s+(?=(async\s+)?(function|const|let|class)\b)/gm, '');
  ok(html.includes(body.trim()), 'demo inlines the current terrain.mjs (run node build-demo.mjs if this fails)');
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  const tmp = new URL('./.demo-check.tmp.js', import.meta.url);
  writeFileSync(tmp, m[1]);
  try { execFileSync(process.execPath, ['--check', tmp.pathname]); ok(true, ''); } catch (e) { ok(false, 'node --check demo script'); } finally { unlinkSync(tmp); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
