// node test-rival.mjs
import { generateRegion, neighbors } from './map.mjs';
import {
  createRival, advanceRival, resolveBorder, nextMoveEta, rivalArmyFor, rivalStrength, rivalOwners,
  RIVAL_TUNE, RIVAL_FORMATIONS,
} from './rival.mjs';
import { readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('ok   ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); }
}
function assert(c, msg) { if (!c) throw new Error(msg || 'assertion failed'); }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const SEEDS = ['checkmarch', 'alpha', 'beta-7', 'zugzwang', 'r42', 'tempo', 'gambit', 'x1', 'outpost', 'q9'];

// a scripted "player": captures one frontier node every `every` seconds (deterministic), resolves
// border battles by a deterministic coin. Returns the full trace.
function playScript(seed, { seconds = 3600, every = 150, online = true, coin = 'h' } = {}) {
  const region = generateRegion(seed, 1);
  let rv = createRival(region, { seed });
  let held = [region.keepId];
  const trace = [];
  const all = [];
  for (let t = 1; t <= seconds; t++) {
    const r = advanceRival(rv, region, held, 1, null, { online });
    for (const ev of r.events) {
      assert(ev.type !== 'capture' || !held.includes(ev.nodeId), 'silent capture of player node ' + ev.nodeId);
      all.push(ev);
    }
    rv = r.state;
    // invariant: rival never holds a player node (except a handover the game has not applied yet)
    if (rv.status !== 'won') for (const id of rv.held) assert(!held.includes(id) || id === rv.handover, 'overlap on ' + id);
    if (rv.pending) {
      const won = (rivalStrength(rv) * 1000 + rv.moves + (coin === 'h' ? 0 : 1)) % 2 < 1;
      const id = rv.pending.nodeId;
      rv = resolveBorder(rv, id, won);
      if (!won && id !== region.keepId) held = held.filter(x => x !== id);
    }
    if (t % every === 0 && rv.status === 'active') {
      const R = new Set(rv.held), H = new Set(held);
      const opts = [];
      for (const h of held) for (const v of neighbors(region, h)) if (!H.has(v) && !R.has(v) && v !== region.citadelId) opts.push(v);
      if (opts.length) { held = [...new Set([...held, Math.min(...opts)])].sort((a, b) => a - b); }
    }
    trace.push(rv);
  }
  return { region, rv, held, events: all, trace };
}

test('determinism: same inputs give the same states and events', () => {
  for (const seed of SEEDS.slice(0, 4)) {
    const a = playScript(seed, { seconds: 2400 });
    const b = playScript(seed, { seconds: 2400 });
    assert(eq(a.rv, b.rv), 'state differs for ' + seed);
    assert(eq(a.events, b.events), 'events differ for ' + seed);
    assert(a.events.length > 3, 'expected some events for ' + seed);
  }
});

test('first capture lands about 90 s in, and the cadence slows as territory grows', () => {
  for (const seed of SEEDS) {
    const region = generateRegion(seed, 1);
    const rv = createRival(region, { seed });
    const r = advanceRival(rv, region, [0], 3 * 3600, null, { online: true });
    const caps = r.events.filter(e => e.type === 'capture');
    assert(caps.length >= 4, 'expected captures');
    assert(caps[0].at >= 82 && caps[0].at <= 98, 'first capture at ' + caps[0].at);
    const gaps = []; for (let i = 1; i < 5; i++) gaps.push(caps[i].at - caps[i - 1].at);
    assert(gaps[3] > gaps[0], 'cadence should slow: ' + gaps.join(','));
  }
});

test('offline catch-up of 8 h equals 8 h of 1 s ticks (offline semantics)', () => {
  for (const seed of SEEDS.slice(0, 5)) {
    const region = generateRegion(seed, 1);
    // player holds the keep plus the first two column-0 nodes
    const held = [region.keepId, ...neighbors(region, region.keepId).slice(0, 2)].sort((a, b) => a - b);
    const start = createRival(region, { seed });
    const big = advanceRival(start, region, held, 8 * 3600, 1e12, { online: false });
    let s = start; const evs = [];
    for (let i = 0; i < 8 * 3600; i++) { const r = advanceRival(s, region, held, 1, null, { online: false }); s = r.state; evs.push(...r.events); }
    assert(eq(big.state, s), 'end states differ for ' + seed + '\n' + JSON.stringify(big.state) + '\n' + JSON.stringify(s));
    const strip = (e) => e.map(({ wall, ...x }) => x);
    assert(eq(strip(big.events), evs), 'event lists differ for ' + seed);
    assert(big.events.every(e => e.wall <= 1e12), 'wall stamps not after now');
    assert(big.events.filter(e => e.type === 'borderBattle').length <= 1, 'more than one pending battle offline');
    assert(!big.events.some(e => e.type === 'keepAssault'), 'keep assault offline');
  }
});

test('catch-up with fractional dt matches integer split (ms quantised, fraction carried)', () => {
  const region = generateRegion('checkmarch', 1);
  let a = createRival(region), b = createRival(region);
  for (let i = 0; i < 6000; i++) a = advanceRival(a, region, [0], 0.25, null, { online: true }).state;
  b = advanceRival(b, region, [0], 1500, null, { online: true }).state;
  assert(eq(a, b), 'quarter-second ticks differ from one call');
});

test('offline: the rival stops at the player frontier edge and never assaults the keep', () => {
  for (const seed of SEEDS) {
    const region = generateRegion(seed, 1);
    const r = advanceRival(createRival(region, { seed }), region, [region.keepId], 24 * 3600, null, { online: false });
    assert(!r.events.some(e => e.type === 'keepAssault'), 'keepAssault offline for ' + seed);
    for (const id of r.state.held) assert(region.nodes[id].dist >= RIVAL_TUNE.offlineMinDist, 'took node too close to keep: ' + id);
    // default online flag for a big dt is false as well
    const d = advanceRival(createRival(region, { seed }), region, [region.keepId], 24 * 3600);
    assert(eq(d.state, r.state), 'default flag for large dt should be offline');
  }
});

test('keepAssault fires only while online', () => {
  let fired = 0;
  for (const seed of SEEDS) {
    const region = generateRegion(seed, 1);
    let s = advanceRival(createRival(region, { seed }), region, [region.keepId], 24 * 3600, null, { online: false }).state;
    let sawAssault = false;
    for (let t = 0; t < 6 * 3600 && !sawAssault; t += 5) {
      const r = advanceRival(s, region, [region.keepId], 5, null, { online: true });
      s = r.state;
      if (r.events.some(e => e.type === 'keepAssault')) sawAssault = true;
    }
    assert(sawAssault, 'expected an online keep assault for ' + seed);
    assert(s.pending && s.pending.type === 'keepAssault', 'assault should be pending');
    fired++;
    // while it is pending, nothing else happens, online or off
    const r2 = advanceRival(s, region, [region.keepId], 3600, null, { online: true });
    assert(r2.events.length === 0, 'rival must pause while a battle is pending');
    // repelled: cooldown, then no assault offline even after a long time
    const rep = resolveBorder(r2.state, region.keepId, true);
    assert(rep.pending == null && rep.cooldown[region.keepId] > rep.ms, 'cooldown after repelled assault');
    const off = advanceRival(rep, region, [region.keepId], 8 * 3600, null, { online: false });
    assert(!off.events.some(e => e.type === 'keepAssault'), 'assault offline after repel');
    // lost: rival wins the region
    const lost = resolveBorder(r2.state, region.keepId, false);
    assert(lost.status === 'won' && nextMoveEta(lost) == null, 'rival should win');
  }
  assert(fired === SEEDS.length);
});

test('border battles: no silent captures, retreat + cooldown, or the rival takes the node', () => {
  for (const seed of SEEDS) {
    const { region, events } = playScript(seed, { seconds: 7200, every: 120 });
    assert(events.some(e => e.type === 'borderBattle'), 'expected a border battle for ' + seed);
  }
  const region = generateRegion('checkmarch', 1);
  // give the player everything except the citadel: the rival can only fight
  const held = region.nodes.map(n => n.id).filter(id => id !== region.citadelId);
  let s = createRival(region);
  const r = advanceRival(s, region, held, 600, null, { online: false });
  assert(r.events.length === 1 && r.events[0].type === 'borderBattle', 'expected exactly one border battle');
  const id = r.events[0].nodeId;
  assert(region.nodes[id].type === 'mine' || !neighbors(region, region.citadelId).some(v => region.nodes[v].type === 'mine'), 'prefers mines');
  const won = resolveBorder(r.state, id, true);
  assert(won.cooldown[id] > won.ms && !won.held.includes(id), 'retreat');
  const eta = nextMoveEta(won);
  assert(eta > 0, 'eta after retreat');
  const lost = resolveBorder(r.state, id, false);
  assert(lost.held.includes(id) && lost.handover === id, 'rival takes node on win');
  // handover survives a sync before the game removed the node, then clears after
  const a = advanceRival(lost, region, held, 1, null, { online: true });
  assert(a.state.held.includes(id), 'handover kept');
  const b = advanceRival(a.state, region, held.filter(x => x !== id), 1, null, { online: true });
  assert(b.state.handover == null && b.state.held.includes(id), 'handover cleared');
  // mismatched resolve is a no-op
  assert(eq(resolveBorder(r.state, -5, true), r.state), 'mismatched resolve should not change state');
});

test('player recaptures sync out of rival territory; taking the seat defeats the rival', () => {
  const region = generateRegion('alpha', 1);
  let s = advanceRival(createRival(region, { seed: 'alpha' }), region, [0], 2 * 3600, null, { online: true }).state;
  const taken = s.held.find(id => id !== s.seat);
  const r = advanceRival(s, region, [0, taken], 1, null, { online: true });
  assert(!r.state.held.includes(taken) && r.state.lost === s.lost + 1, 'node should leave rival territory');
  const d = advanceRival(r.state, region, [0, taken, region.citadelId], 3600, null, { online: true });
  assert(d.state.status === 'defeated' && d.events.length === 0 && nextMoveEta(d.state) == null, 'defeated');
});

test('strength and dwellings never decrease', () => {
  for (const seed of SEEDS.slice(0, 5)) {
    const { trace } = playScript(seed, { seconds: 7200, every: 100 });
    let ps = 0, pd = 0;
    for (const s of trace) {
      assert(s.strength >= ps - 1e-12, 'strength fell');
      assert(s.dwellings >= pd, 'dwellings fell');
      ps = s.strength; pd = s.dwellings;
    }
    assert(ps > 1.5, 'strength should grow, got ' + ps);
  }
});

test('events are sorted by time', () => {
  for (const seed of SEEDS.slice(0, 5)) {
    const { events } = playScript(seed, { seconds: 7200, every: 90 });
    for (let i = 1; i < events.length; i++) assert(events[i].at >= events[i - 1].at, 'unsorted events');
    for (const e of events) {
      assert(['capture', 'borderBattle', 'sortie', 'keepAssault'].includes(e.type), 'bad type');
      assert(Number.isInteger(e.nodeId) && Number.isFinite(e.at) && Number.isFinite(e.rivalStrength), 'bad event shape');
    }
  }
  const region = generateRegion('beta-7', 1);
  const r = advanceRival(createRival(region), region, [0], 10 * 3600, 5e12, { online: false });
  for (let i = 1; i < r.events.length; i++) assert(r.events[i].at > r.events[i - 1].at && r.events[i].wall > r.events[i - 1].wall, 'unsorted catch-up events');
});

test('JSON round-trip of state, mid-game, gives identical futures', () => {
  for (const seed of SEEDS.slice(0, 4)) {
    const { region, rv, held } = playScript(seed, { seconds: 1800 });
    const back = JSON.parse(JSON.stringify(rv));
    assert(eq(back, rv), 'round-trip changed state');
    const a = advanceRival(rv, region, held, 4000, null, { online: true });
    const b = advanceRival(back, region, new Set(held), 4000, null, { online: true });
    assert(eq(a, b), 'future differs after round-trip');
  }
});

test('rivalArmyFor: deterministic, king present, unique squares on the enemy side, budget tracks strength', () => {
  for (const f of RIVAL_FORMATIONS) {
    const sq = [f.k, ...f.s.split(' ').map(x => x.slice(1))];
    assert(new Set(sq).size === sq.length, 'duplicate square in ' + f.name);
    assert(sq.every(x => /^[a-h][678]$/.test(x)), 'bad square in ' + f.name);
  }
  const region = generateRegion('gambit', 1);
  const s0 = createRival(region, { seed: 'gambit' });
  const s1 = advanceRival(s0, region, [0], 6 * 3600, null, { online: false }).state;
  let prev = -1;
  for (const s of [s0, s1]) {
    for (const id of [0, 3, s.held[0]]) {
      const a = rivalArmyFor(s, id, region), b = rivalArmyFor(JSON.parse(JSON.stringify(s)), id, region);
      assert(eq(a, b), 'army not deterministic');
      assert(a.pieces.filter(p => p.type === 'K').length === 1, 'one king');
      assert(new Set(a.pieces.map(p => p.square)).size === a.pieces.length, 'duplicate squares');
      assert(a.pieces.every(p => /^[a-h][678]$/.test(p.square) && p.sq >= 40), 'enemy side');
      assert(Math.abs(a.units - a.budget) <= 2.5 || a.units < a.budget, 'units near budget');
    }
    const b = rivalArmyFor(s, 3);
    assert(b.budget > prev, 'budget should rise with strength');
    prev = b.budget;
  }
  const k = rivalArmyFor(s1, region.keepId, region);
  assert(k.role === 'keepAssault' && k.name === "Lord's Court" && k.depth >= 2, 'keep assault army');
  assert(rivalArmyFor(s1, s1.held[0], region).role === 'garrison', 'garrison role');
});

test('owners map + region mismatch guard', () => {
  const region = generateRegion('tempo', 1);
  const s = advanceRival(createRival(region), region, [0, 1], 3600, null, { online: true }).state;
  const o = rivalOwners(s, region, [0, 1]);
  assert(o[0] === 'player' && o[region.citadelId] === 'rival', 'owners');
  let threw = false;
  try { advanceRival(s, generateRegion('tempo', 2), [0], 1); } catch (_) { threw = true; }
  assert(threw, 'should reject a state from another region');
});

test('rival-demo.html is fresh and its script passes node --check', () => {
  const p = join(here, 'rival-demo.html');
  assert(existsSync(p), 'missing rival-demo.html');
  execFileSync(process.execPath, [join(here, 'build-demo.mjs'), '--check'], { stdio: 'pipe' });
  const html = readFileSync(p, 'utf8');
  assert(html.startsWith('<title>Checkmarch Rival Demo</title>'), 'title first');
  assert(!/<!doctype|<html[\s>]|<head[\s>]|<body[\s>]/i.test(html), 'no document skeleton tags');
  assert(!/https?:\/\//.test(html.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '')), 'no external URLs');
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  assert(m, 'inline script missing');
  const tmp = join(tmpdir(), 'checkmarch-rival-demo-check-' + process.pid + '.js');
  writeFileSync(tmp, m[1]);
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); } finally { rmSync(tmp, { force: true }); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
