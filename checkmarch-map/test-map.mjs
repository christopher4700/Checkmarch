// node test-map.mjs  — dependency-free tests for map.mjs (+ demo build / inline syntax).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateRegion, frontier, visibility, fogView, initialMapState, capture, canCapture,
  roadDistances, neighbors, mapSegmentsCross, MAP_W, MAP_H,
} from './map.mjs';
import { buildDemo } from './build-demo.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

const SEEDS = Array.from({ length: 50 }, (_, i) => 'seed-' + i + '-' + ((i * 2654435761) >>> 0).toString(36));
const regions = SEEDS.map((s, i) => generateRegion(s, 1 + (i % 5)));

function adjOf(r) {
  const adj = r.nodes.map(() => []);
  for (const [a, b] of r.roads) { adj[a].push(b); adj[b].push(a); }
  return adj;
}

test('same seed => identical output (deep equal), different seed => different', () => {
  for (const s of ['alpha', 'beta', 42, 'checkmarch']) {
    for (const rn of [1, 2, 7]) assert.deepStrictEqual(generateRegion(s, rn), generateRegion(s, rn));
  }
  assert.notDeepStrictEqual(generateRegion('alpha', 1).roads, generateRegion('beta', 1).roads);
  assert.notDeepStrictEqual(generateRegion('alpha', 1), generateRegion('alpha', 2));
});

test('node count in 20..30 for 50 random seeds', () => {
  for (const r of regions) assert.ok(r.nodes.length >= 20 && r.nodes.length <= 30, 'count ' + r.nodes.length);
});

test('ids are 0..n-1 in order; coords inside 0..1000 x 0..600; fields well-typed', () => {
  const types = new Set(['keep', 'garrison', 'mine', 'town', 'shrine', 'citadel']);
  for (const r of regions) {
    r.nodes.forEach((n, i) => {
      assert.equal(n.id, i);
      assert.ok(n.x >= 0 && n.x <= MAP_W && n.y >= 0 && n.y <= MAP_H, 'coords');
      assert.ok(types.has(n.type), 'type ' + n.type);
      assert.ok(Number.isInteger(n.tier) && n.tier >= 0, 'tier');
      assert.ok(typeof n.name === 'string' && n.name.length > 0, 'name');
    });
    assert.equal(new Set(r.nodes.map(n => n.name)).size, r.nodes.length, 'unique names');
  }
});

test('connectivity: BFS from keep reaches every node', () => {
  for (const r of regions) {
    const adj = adjOf(r);
    const seen = new Set([r.keepId]); const q = [r.keepId];
    while (q.length) { const u = q.shift(); for (const v of adj[u]) if (!seen.has(v)) { seen.add(v); q.push(v); } }
    assert.equal(seen.size, r.nodes.length, 'seed ' + r.seed);
  }
});

test('exactly one keep (west edge) and one citadel (east edge)', () => {
  for (const r of regions) {
    const keeps = r.nodes.filter(n => n.type === 'keep');
    const cits = r.nodes.filter(n => n.type === 'citadel');
    assert.equal(keeps.length, 1); assert.equal(cits.length, 1);
    assert.equal(keeps[0].id, r.keepId); assert.equal(cits[0].id, r.citadelId);
    assert.ok(keeps[0].x <= 100, 'keep x ' + keeps[0].x);
    assert.ok(cits[0].x >= 900, 'citadel x ' + cits[0].x);
    for (const n of r.nodes) {
      if (n.type !== 'keep') assert.ok(n.x > keeps[0].x);
      if (n.type !== 'citadel') assert.ok(n.x < cits[0].x);
    }
  }
});

test('citadel tier is the maximum (strictly); tiers rise with region number', () => {
  for (const r of regions) {
    const c = r.nodes[r.citadelId];
    for (const n of r.nodes) if (n.id !== c.id) assert.ok(n.tier < c.tier, `tier ${n.tier} >= citadel ${c.tier}`);
  }
  for (const s of ['a', 'b', 'c']) {
    const t = [1, 2, 3, 4].map(rn => generateRegion(s, rn));
    for (let i = 1; i < t.length; i++) {
      assert.ok(t[i].nodes[t[i].keepId].tier > t[i - 1].nodes[t[i - 1].keepId].tier);
      assert.ok(t[i].nodes[t[i].citadelId].tier > t[i - 1].nodes[t[i - 1].citadelId].tier);
      assert.ok(Math.min(...t[i].nodes.filter(n => n.type !== 'keep').map(n => n.tier)) >=
        t[i - 1].nodes[t[i - 1].keepId].tier);
    }
  }
});

test('tiers non-decreasing along at least one shortest path keep -> citadel', () => {
  for (const r of regions) {
    const d = roadDistances(r, r.keepId);
    const adj = adjOf(r);
    // DP over BFS layers: ok[v] = some shortest path keep->v with non-decreasing tiers
    const ok = new Array(r.nodes.length).fill(false);
    ok[r.keepId] = true;
    const order = r.nodes.map(n => n.id).sort((a, b) => d[a] - d[b]);
    for (const v of order) {
      if (v === r.keepId) continue;
      ok[v] = adj[v].some(u => d[u] === d[v] - 1 && ok[u] && r.nodes[u].tier <= r.nodes[v].tier);
    }
    assert.ok(ok[r.citadelId], 'seed ' + r.seed);
  }
});

test('tiers rise with road distance (tier - base in {dist, dist+1})', () => {
  for (const r of regions) {
    const base = r.nodes[r.keepId].tier;
    for (const n of r.nodes) {
      if (n.type === 'keep' || n.type === 'citadel') continue;
      const k = n.tier - base - n.dist;
      assert.ok(k === 0 || k === 1, 'tier offset ' + k);
    }
  }
});

test('graph shape: average degree ~2.5, no straight-line road crossings, no long roads', () => {
  let sum = 0;
  for (const r of regions) {
    const deg = 2 * r.roads.length / r.nodes.length;
    sum += deg;
    assert.ok(deg >= 2.0 && deg <= 3.3, 'avg degree ' + deg.toFixed(2));
    for (let i = 0; i < r.roads.length; i++) {
      const [a, b] = r.roads[i];
      assert.ok(a < b, 'roads normalised a<b');
      const len = Math.hypot(r.nodes[a].x - r.nodes[b].x, r.nodes[a].y - r.nodes[b].y);
      assert.ok(len < 420, 'road length ' + len.toFixed(0));
      for (let j = i + 1; j < r.roads.length; j++) {
        const [c, e] = r.roads[j];
        assert.ok(!mapSegmentsCross(r.nodes[a], r.nodes[b], r.nodes[c], r.nodes[e]), `crossing ${a}-${b} x ${c}-${e}`);
      }
    }
  }
  const avg = sum / regions.length;
  assert.ok(avg >= 2.3 && avg <= 2.8, 'mean degree ' + avg.toFixed(2));
});

test('route choice: >= 2 vertex-disjoint keep->citadel routes; rich band richer than lean', () => {
  for (const r of regions) {
    // node-split max flow, unit capacities
    const n = r.nodes.length, N = 2 * n;
    const cap = new Map();
    const key = (u, v) => u * N + v;
    const addE = (u, v, c) => cap.set(key(u, v), (cap.get(key(u, v)) || 0) + c);
    const g = Array.from({ length: N }, () => new Set());
    const link = (u, v, c) => { addE(u, v, c); g[u].add(v); g[v].add(u); };
    for (let i = 0; i < n; i++) link(2 * i, 2 * i + 1, (i === r.keepId || i === r.citadelId) ? 99 : 1);
    for (const [a, b] of r.roads) { link(2 * a + 1, 2 * b, 1); link(2 * b + 1, 2 * a, 1); }
    const s = 2 * r.keepId + 1, t = 2 * r.citadelId;
    let flow = 0;
    while (flow < 3) {
      const prev = new Array(N).fill(-1); prev[s] = s; const q = [s];
      while (q.length && prev[t] < 0) { const u = q.shift(); for (const v of g[u]) if (prev[v] < 0 && (cap.get(key(u, v)) || 0) > 0) { prev[v] = u; q.push(v); } }
      if (prev[t] < 0) break;
      for (let v = t; v !== s; v = prev[v]) { const u = prev[v]; addE(u, v, -1); addE(v, u, 1); }
      flow++;
    }
    assert.ok(flow >= 2, 'disjoint routes ' + flow + ' seed ' + r.seed);
    const econ = (band) => r.nodes.filter(x => x.band === band && (x.type === 'mine' || x.type === 'shrine')).length;
    assert.ok(econ('rich') > econ('lean'), `rich ${econ('rich')} vs lean ${econ('lean')}`);
    assert.ok(r.nodes.filter(x => x.type === 'mine').length >= 2, 'mines');
    assert.ok(r.nodes.some(x => x.type === 'town') && r.nodes.some(x => x.type === 'shrine'), 'town+shrine');
  }
});

test('frontier / visibility / fogView / capture', () => {
  const r = generateRegion('fog-test', 1);
  let st = initialMapState(r);
  assert.deepEqual(st.held, [r.keepId]);
  assert.deepEqual(frontier(st), neighbors(r, r.keepId));
  const vis = visibility(st);
  assert.equal(vis[r.keepId], 'held');
  for (const id of frontier(st)) assert.equal(vis[id], 'frontier');
  assert.equal(vis.filter(v => v === 'fog').length, r.nodes.length - 1 - frontier(st).length);
  const fv = fogView(st);
  const fogged = fv.find(n => n.vis === 'fog' && !n.big);
  assert.ok(fogged && fogged.silhouette && fogged.type === undefined && fogged.tier === undefined && fogged.name === undefined);
  assert.equal(fv[r.citadelId].big, true);
  assert.equal(fv[r.keepId].name, r.nodes[r.keepId].name);
  // Set input works the same
  assert.deepEqual(frontier({ region: r, held: new Set([r.keepId]) }), frontier(st));
  // capture is immutable and opens fog
  const target = frontier(st)[0];
  const st2 = capture(st, target);
  assert.deepEqual(st.held, [r.keepId]);
  assert.ok(st2.held.includes(target));
  assert.ok(!frontier(st2).includes(target));
  assert.throws(() => capture(st, r.citadelId));
  assert.equal(canCapture(st, r.citadelId), false);
  // greedy walk captures everything; citadel reachable
  let guard = 0;
  while (frontier(st).length && guard++ < 100) st = capture(st, frontier(st)[0]);
  assert.equal(st.held.length, r.nodes.length);
  assert.ok(visibility(st).every(v => v === 'held'));
  // generator input not mutated by helpers
  assert.deepStrictEqual(r, generateRegion('fog-test', 1));
});

test('map-demo.html is built from current sources; inline script passes node --check', () => {
  const built = buildDemo();
  const onDisk = readFileSync(join(here, 'map-demo.html'), 'utf8');
  assert.equal(onDisk, built, 'map-demo.html stale: run node build-demo.mjs');
  assert.ok(onDisk.startsWith('<title>Checkmarch Map Demo</title>'), 'title first');
  assert.ok(!/<!doctype|<html[\s>]|<head[\s>]|<body[\s>]/i.test(onDisk), 'no document skeleton tags');
  assert.ok(!/(src|href)\s*=\s*["']?https?:/i.test(onDisk) && !/@import|url\(\s*["']?https?:/i.test(onDisk), 'no external resources');
  assert.ok(!/\b(alert|confirm|prompt)\s*\(/.test(onDisk), 'no alert/confirm/prompt');
  const m = onDisk.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, 'inline script');
  const dir = mkdtempSync(join(tmpdir(), 'cm-map-'));
  const f = join(dir, 'inline.js');
  writeFileSync(f, m[1]);
  execFileSync(process.execPath, ['--check', f]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
