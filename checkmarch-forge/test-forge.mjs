// node test-forge.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as F from './forge.mjs';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('ok   ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.message)); }
}
const H = F.HOUR_MS, T0 = Date.UTC(2026, 10, 12, 9, 0, 0); // 2026-11-12 09:00 UTC
const mines = [{ id: 'm1', resource: 'tin' }, { id: 'm2', resource: 'coal' }, { id: 'm3', resource: 'iron' }, { id: 'm4', resource: 'shards' }];

test('createForge is plain JSON and round-trips', () => {
  const s = F.createForge(T0);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  assert.equal(s.lastTs, T0);
});

test('trickle: 1h with one mine each = RATES exactly', () => {
  const s = F.tickForge(F.createForge(T0), mines, T0 + H);
  assert.deepEqual(s.stock, { tin: 8, coal: 8, iron: 7, shards: 6 });
  for (const r of F.RESOURCES) assert.equal(s.frac[r], 0);
});

test('determinism: one big tick == 7200 one-second ticks == irregular ticks', () => {
  const a = F.tickForge(F.createForge(T0), mines, T0 + 2 * H + 1234);
  let b = F.createForge(T0);
  for (let i = 1; i <= 7200; i++) b = F.tickForge(b, mines, T0 + i * 1000);
  b = F.tickForge(b, mines, T0 + 2 * H + 1234);
  let c = F.createForge(T0), t = T0, k = 1;
  while (t < T0 + 2 * H + 1234) { t = Math.min(T0 + 2 * H + 1234, t + (k * 7919) % 61000 + 1); c = F.tickForge(c, mines, t); k++; }
  assert.deepEqual(a, b); assert.deepEqual(a, c);
});

test('partial units: 7.5 minutes of tin = 1 whole unit + half remainder', () => {
  const s = F.tickForge(F.createForge(T0), [mines[0]], T0 + 7.5 * 60000 + 3.75 * 60000);
  assert.equal(s.stock.tin, 1); assert.equal(F.stockFraction(s, 'tin'), 0.5);
});

test('two mines of a resource double the rate; duplicate ids count once', () => {
  const two = [{ id: 'a', resource: 'tin' }, { id: 'b', resource: 'tin' }, { id: 'b', resource: 'tin' }];
  const s = F.tickForge(F.createForge(T0), two, T0 + H);
  assert.equal(s.stock.tin, 16); assert.equal(s.stock.coal, 0);
});

test('offline cap: 3 days away pays only 8h', () => {
  const s = F.tickForge(F.createForge(T0), mines, T0 + 72 * H);
  assert.deepEqual(s.stock, { tin: 64, coal: 64, iron: 56, shards: 48 });
  assert.equal(s.lastTs, T0 + 72 * H);
});

test('stockpile cap: 24h worth per mine, frac zeroed at cap, granularity-independent', () => {
  let s = F.createForge(T0);
  for (let i = 1; i <= 30; i++) s = F.tickForge(s, mines, T0 + i * H); // 30h online
  assert.equal(s.stock.tin, 8 * 24); assert.equal(s.frac.tin, 0);
  assert.equal(s.stock.shards, 6 * 24);
  let u = F.createForge(T0);
  for (let i = 1; i <= 30 * 60; i++) u = F.tickForge(u, mines, T0 + i * 60000);
  assert.deepEqual(s, u);
});

test('clock going backwards accrues nothing and keeps lastTs', () => {
  const s = F.tickForge(F.createForge(T0), mines, T0 + H);
  const back = F.tickForge(s, mines, T0);
  assert.deepEqual(back, s);
  const fwd = F.tickForge(back, mines, T0 + 2 * H);
  assert.equal(fwd.stock.tin, 16);
});

test('tickForge does not mutate input', () => {
  const s = F.createForge(T0), snap = JSON.stringify(s);
  F.tickForge(s, mines, T0 + H); assert.equal(JSON.stringify(s), snap);
});

test('recipe consumption: iron 3 tin + 2 coal, steel 3 iron + 3 coal, obsidian 4 shards', () => {
  let s = F.tickForge(F.createForge(T0), mines, T0 + H); // tin 8 coal 8 iron 7 shards 6
  s.smelt.level = 2; // 3/day
  let r = F.smelt(s, 'iron', T0 + H); assert.ok(r.ok); s = r.state;
  assert.equal(s.stock.tin, 5); assert.equal(s.stock.coal, 6); assert.equal(s.bars.iron, 1);
  r = F.smelt(s, 'steel', T0 + H); assert.ok(r.ok); s = r.state;
  assert.equal(s.stock.iron, 4); assert.equal(s.stock.coal, 3); assert.equal(s.bars.steel, 1);
  r = F.smelt(s, 'obsidian', T0 + H); assert.ok(r.ok); s = r.state;
  assert.equal(s.stock.shards, 2); assert.equal(s.bars.obsidian, 1);
});

test('smelt fails on missing ore without consuming anything or a daily use', () => {
  const s = F.createForge(T0);
  const r = F.smelt(s, 'iron', T0);
  assert.equal(r.ok, false); assert.equal(r.reason, 'missing-tin'); assert.equal(r.state.smelt.used, 0);
  assert.equal(F.smelt(s, 'gold', T0).reason, 'unknown-recipe');
});

test('daily smelt cap 1/day, resets at 00:00 UTC, upgradeable', () => {
  let s = F.tickForge(F.createForge(T0), mines, T0 + 8 * H); // 17:00 UTC
  const now = T0 + 8 * H;
  let r = F.smelt(s, 'iron', now); assert.ok(r.ok); s = r.state;
  r = F.smelt(s, 'iron', now); assert.equal(r.ok, false); assert.equal(r.reason, 'daily-cap');
  const lateNight = Date.UTC(2026, 10, 12, 23, 59, 59, 999);
  assert.equal(F.smelt(s, 'iron', lateNight).reason, 'daily-cap');
  const midnight = Date.UTC(2026, 10, 13, 0, 0, 0, 0);
  assert.equal(F.nextResetAt(now), midnight);
  r = F.smelt(s, 'iron', midnight); assert.ok(r.ok); s = r.state;
  assert.equal(F.smeltsLeft(s, midnight), 0);
  s = F.upgradeSmeltCap(s).state;
  assert.equal(F.smeltsPerDay(s), 2); assert.equal(F.smeltsLeft(s, midnight), 1);
  for (let i = 0; i < 5; i++) s = F.upgradeSmeltCap(s).state;
  assert.equal(s.smelt.level, F.MAX_SMELT_LEVEL);
});

test('DST-safe: US DST end (2026-11-01) does not affect UTC-day reset or trickle', () => {
  // 2026-11-01 05:00 UTC = 01:00 EDT; 06:00 UTC = 01:00 EST (local clock repeats an hour)
  const a = Date.UTC(2026, 10, 1, 5, 0), b = Date.UTC(2026, 10, 1, 7, 0);
  const s = F.tickForge(F.createForge(a), mines, b);
  assert.equal(s.stock.tin, 16); // exactly 2 real hours, even though local wall clock advanced 1h
  let st = F.tickForge(F.createForge(Date.UTC(2026, 9, 31, 12)), mines, Date.UTC(2026, 9, 31, 20));
  st = F.smelt(st, 'iron', Date.UTC(2026, 9, 31, 20)).state;
  assert.equal(F.smeltsLeft(st, Date.UTC(2026, 9, 31, 23, 59)), 0);
  assert.equal(F.smeltsLeft(st, Date.UTC(2026, 10, 1, 0, 0)), 1);
});

test('applyBar: one tier at a time, consumes matching bar', () => {
  let s = F.createForge(T0); s.bars = { iron: 1, steel: 1, obsidian: 0 };
  let r = F.applyBar(s, 'p1', 'wood'); assert.ok(r.ok); assert.equal(r.newMaterial, 'iron'); s = r.state;
  assert.equal(s.bars.iron, 0); assert.equal(F.materialOf(s, 'p1'), 'iron');
  r = F.applyBar(s, 'p1', 'wood'); assert.equal(r.reason, 'material-mismatch');
  r = F.applyBar(s, 'p1', 'iron'); assert.ok(r.ok); assert.equal(r.newMaterial, 'steel'); s = r.state;
  r = F.applyBar(s, 'p1', 'steel'); assert.equal(r.ok, false); assert.equal(r.reason, 'no-obsidian-bar');
  s.bars.obsidian = 1; r = F.applyBar(s, 'p1'); assert.ok(r.ok); assert.equal(r.newMaterial, 'obsidian'); s = r.state;
  r = F.applyBar(s, 'p1'); assert.equal(r.reason, 'max-tier');
  r = F.applyBar(s, 'p2', 'wood'); assert.equal(r.reason, 'no-iron-bar');
});

test('losePiece: perma-death drops invested bars', () => {
  let s = F.createForge(T0); s.mats.q = 'steel';
  const r = F.losePiece(s, 'q');
  assert.deepEqual(r.lostBars, ['iron', 'steel']); assert.equal(F.materialOf(r.state, 'q'), 'wood');
  assert.deepEqual(r.state.lost, { iron: 1, steel: 1, obsidian: 0 });
});

test('counterCheck: only exactly one tier above, chance 0.25', () => {
  const always0 = () => 0, calls = { n: 0 }, spy = () => { calls.n++; return 0; };
  for (const a of F.MATERIALS) for (const t of F.MATERIALS) {
    const r = F.counterCheck(a, t, spy);
    const applies = F.tierOf(t) === F.tierOf(a) + 1;
    assert.equal(r.chance, applies ? 0.25 : 0, a + '->' + t); assert.equal(r.fails, applies);
  }
  assert.equal(calls.n, 3); // rng consumed only when the rule applies
  assert.equal(F.counterCheck('wood', 'iron', () => 0.25).fails, false);
  assert.equal(F.counterCheck('wood', 'iron', () => 0.2499).fails, true);
  assert.equal(F.counterCheck('wood', 'steel', always0).fails, false);
});

test('counterCheck: seeded rng fails ~25% over 10k', () => {
  const rng = F.mulberry32(12345); let f = 0;
  for (let i = 0; i < 10000; i++) if (F.counterCheck('iron', 'steel', rng).fails) f++;
  console.log('     10k rolls iron->steel: ' + f + ' fails (' + (f / 100).toFixed(2) + '%)');
  assert.ok(f > 2350 && f < 2650);
  const r1 = F.mulberry32(7), r2 = F.mulberry32(7);
  for (let i = 0; i < 50; i++) assert.deepEqual(F.counterCheck('wood', 'iron', r1), F.counterCheck('wood', 'iron', r2));
});

// geometry helpers: sq = rank*8 + file
const sq = n => 'abcdefgh'.indexOf(n[0]) + (n[1] - 1) * 8, nm = s => 'abcdefgh'[s & 7] + ((s >> 3) + 1);
const fb = (from, to, piece, blocked) => nm(F.captureFallback({ from: sq(from), to: sq(to), piece }, 8, blocked ? s => blocked.includes(nm(s)) : undefined));

test('captureFallback: rook / bishop / queen stop one short along the path', () => {
  assert.equal(fb('a1', 'a8', 'R'), 'a7');
  assert.equal(fb('h4', 'b4', 'R'), 'c4');
  assert.equal(fb('c1', 'h6', 'B'), 'g5');
  assert.equal(fb('f8', 'a3', 'B'), 'b4');
  assert.equal(fb('d1', 'd7', 'Q'), 'd6');
  assert.equal(fb('d1', 'h5', 'Q'), 'g4');
  assert.equal(fb('d4', 'a7', 'Q'), 'b6');
  assert.equal(fb('e5', 'e2', 5), 'e3'); // numeric engine type
});

test('captureFallback: adjacent capture stays on origin', () => {
  assert.equal(fb('d4', 'd5', 'R'), 'd4');
  assert.equal(fb('d4', 'e5', 'B'), 'd4');
  assert.equal(fb('d4', 'c3', 'Q'), 'd4');
});

test('captureFallback: knight, pawn, king stay on origin', () => {
  assert.equal(fb('g1', 'f3', 'N'), 'g1');
  assert.equal(fb('e4', 'd5', 'P'), 'e4');
  assert.equal(fb('e1', 'e2', 'K'), 'e1');
});

test('captureFallback: blockedFn and array form; non-slide geometry falls back to origin', () => {
  assert.equal(fb('a1', 'a8', 'R', ['a5']), 'a4');
  assert.equal(fb('a1', 'a8', 'R', ['a2']), 'a1');
  assert.deepEqual(F.captureFallback({ from: [0, 0], to: [5, 5], piece: 'B' }, 8), [4, 4]);
  assert.deepEqual(F.captureFallback({ from: [0, 0], to: [0, 9], piece: 'R' }, 10), [0, 8]); // 10x10 board
  assert.equal(fb('a1', 'b3', 'Q'), 'a1');
  assert.equal(fb('a1', 'c3', 'R'), 'a1');
});

test('evalBonus: 0/15/30/45 cp', () => {
  assert.deepEqual(F.MATERIALS.map(F.evalBonus), [0, 15, 30, 45]);
  assert.equal(F.evalBonus(undefined), 0);
});

test('JSON round-trip of a used state + loadForge sanitizes', () => {
  let s = F.tickForge(F.createForge(T0), mines, T0 + 5 * H + 777);
  s = F.smelt(s, 'iron', T0 + 5 * H + 777).state;
  s = F.applyBar(s, 'pawn-3', 'wood').state;
  const j = JSON.parse(JSON.stringify(s));
  assert.deepEqual(j, s);
  assert.deepEqual(F.loadForge(j, 0), s);
  assert.deepEqual(F.tickForge(j, mines, T0 + 6 * H), F.tickForge(s, mines, T0 + 6 * H));
  const junk = F.loadForge({ stock: { tin: -5, coal: 'x' }, mats: { a: 'gold', b: 'steel' }, smelt: { level: 99 } }, T0);
  assert.equal(junk.stock.tin, 0); assert.equal(junk.stock.coal, 0);
  assert.deepEqual(junk.mats, { b: 'steel' }); assert.equal(junk.smelt.level, F.MAX_SMELT_LEVEL);
  assert.deepEqual(F.loadForge(null, T0), F.createForge(T0));
});

test('forge-demo.html inlines the current forge.mjs (no drift)', () => {
  const demo = readFileSync(new URL('./forge-demo.html', import.meta.url), 'utf8');
  const body = readFileSync(new URL('./forge.mjs', import.meta.url), 'utf8').replace(/^export /gm, '');
  assert.ok(demo.includes(body), 'run: node build-demo.mjs');
  assert.ok(demo.startsWith('<title>Checkmarch Forge Demo</title>'));
  assert.ok(!/<(!doctype|html|head|body)\b/i.test(demo));
  assert.ok(!/(src|href)\s*=\s*["']https?:/i.test(demo));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
