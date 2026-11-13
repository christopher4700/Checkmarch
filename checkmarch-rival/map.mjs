// Checkmarch world map: region generation + territory/fog helpers.
// Pure ES module, no DOM, no dependencies. Deterministic from (seed, regionNumber).
// Inline-friendly: no imports; every top-level name is prefixed or map-specific.

export const MAP_W = 1000;
export const MAP_H = 600;
export const TIERS_PER_REGION = 10;
export const NODE_TYPES = ['keep', 'garrison', 'mine', 'town', 'shrine', 'citadel'];

// ---------- RNG ----------
export function mapHashSeed(seed) {
  const s = String(seed);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return h >>> 0;
}

export function mapMulberry32(a) {
  a = a >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- geometry ----------
function mapOrient(ax, ay, bx, by, cx, cy) {
  const v = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  return v > 1e-9 ? 1 : v < -1e-9 ? -1 : 0;
}
// Proper crossing of segments p1p2 and p3p4 (shared endpoints do not count).
export function mapSegmentsCross(p1, p2, p3, p4) {
  if (p1 === p3 || p1 === p4 || p2 === p3 || p2 === p4) return false;
  const o1 = mapOrient(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
  const o2 = mapOrient(p1.x, p1.y, p2.x, p2.y, p4.x, p4.y);
  const o3 = mapOrient(p3.x, p3.y, p4.x, p4.y, p1.x, p1.y);
  const o4 = mapOrient(p3.x, p3.y, p4.x, p4.y, p2.x, p2.y);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

// ---------- names ----------
const MAP_NAME_A = ['Ash', 'Bram', 'Cold', 'Dun', 'Elder', 'Fen', 'Gal', 'Hollow', 'Iron', 'Kes',
  'Lark', 'Mor', 'Nor', 'Oak', 'Pell', 'Raven', 'Salt', 'Thorn', 'Vale', 'Wolf', 'Yew', 'Gris',
  'Brack', 'Stone', 'Wyn', 'Har', 'Mire', 'Rook', 'Cinder', 'Glen', 'Hart', 'Quill'];
const MAP_NAME_B = ['ford', 'moor', 'wick', 'stead', 'holm', 'reach', 'gate', 'fell', 'mere',
  'by', 'ham', 'crest', 'dale', 'barrow', 'combe', 'ley', 'thorpe', 'hollow', 'field', 'ridge'];
const MAP_BOSS = ['the Ivory Regent', 'the Ashen Queen', 'the Pale Bishop', 'the Iron Castellan',
  'the Hollow King', 'the Twin Rooks', 'the Gray Marshal', 'the Night Knight', 'the Salt Tyrant',
  'the Thorn Duchess', 'the Last Vizier', 'the Black Abbot'];

function mapPick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

function mapMakeName(rng, type, used) {
  for (let tries = 0; tries < 40; tries++) {
    const stem = mapPick(rng, MAP_NAME_A) + mapPick(rng, MAP_NAME_B);
    let name;
    const v = rng();
    switch (type) {
      case 'keep': name = stem + ' Keep'; break;
      case 'garrison': name = v < 0.5 ? 'Fort ' + stem : stem + ' Garrison'; break;
      case 'mine': name = stem + (v < 0.5 ? ' Mine' : v < 0.8 ? ' Quarry' : ' Pits'); break;
      case 'town': name = v < 0.6 ? stem : stem + ' Market'; break;
      case 'shrine': name = v < 0.5 ? 'Shrine of ' + stem : stem + ' Chapel'; break;
      case 'citadel': name = 'Citadel of ' + stem; break;
      default: name = stem;
    }
    if (!used.has(name)) { used.add(name); return name; }
  }
  const fallback = type + ' ' + used.size;
  used.add(fallback);
  return fallback;
}

// ---------- generation ----------
const MAP_TYPE_WEIGHTS = {
  rich: [['garrison', 0.36], ['mine', 0.38], ['shrine', 0.16], ['town', 0.10]],
  mid: [['garrison', 0.55], ['mine', 0.18], ['town', 0.15], ['shrine', 0.12]],
  lean: [['garrison', 0.66], ['town', 0.20], ['mine', 0.09], ['shrine', 0.05]],
};

function mapWeighted(rng, table) {
  let r = rng();
  for (const [k, w] of table) { if ((r -= w) < 0) return k; }
  return table[table.length - 1][0];
}

/**
 * generateRegion(seed, regionNumber) -> region
 * region = { seed, regionNumber, width, height, keepId, citadelId, richBand,
 *            nodes: [{id,x,y,type,tier,name,col,band,dist,boss?}], roads: [[a,b], ...] (a<b) }
 */
export function generateRegion(seed, regionNumber = 1) {
  regionNumber = Math.max(1, Math.floor(Number(regionNumber) || 1));
  const rng = mapMulberry32(mapHashSeed(String(seed) + '|region|' + regionNumber));
  const nameRng = mapMulberry32(mapHashSeed(String(seed) + '|names|' + regionNumber));

  const total = 20 + Math.floor(rng() * 11);           // 20..30 nodes incl. keep + citadel
  const middle = total - 2;
  const C = Math.max(Math.ceil(middle / 4), Math.min(8, Math.round(middle / 3.2)));
  // column sizes: 2..4, outer columns capped at 3
  const sizes = new Array(C).fill(2);
  let left = middle - 2 * C;
  let guard = 0;
  while (left > 0 && guard++ < 1000) {
    const k = Math.floor(rng() * C);
    const cap = (k === 0 || k === C - 1) ? 3 : 4;
    if (sizes[k] < cap) { sizes[k]++; left--; }
  }
  // (C chosen so capacity always suffices; guard is belt and braces)

  // ---- positions ----
  const nodes = [];
  const used = new Set();
  const X0 = 60, X1 = 940;
  nodes.push({ id: 0, x: X0 + Math.round((rng() - 0.5) * 30), y: 300 + Math.round((rng() - 0.5) * 80), col: -1 });
  const spacing = (X1 - X0) / (C + 1);
  const columns = [];
  for (let k = 0; k < C; k++) {
    const n = sizes[k];
    const slot = 470 / n;
    const col = [];
    for (let i = 0; i < n; i++) {
      const x = X0 + spacing * (k + 1) + (rng() - 0.5) * spacing * 0.36;
      const y = 65 + slot * (i + 0.5) + (rng() - 0.5) * slot * 0.45;
      const node = { id: nodes.length, x: Math.round(x), y: Math.round(y), col: k };
      nodes.push(node);
      col.push(node);
    }
    columns.push(col);
  }
  const citadel = { id: nodes.length, x: X1 + Math.round((rng() - 0.5) * 30), y: 300 + Math.round((rng() - 0.5) * 80), col: C };
  nodes.push(citadel);
  const keep = nodes[0];

  // ---- roads ----
  const roadSet = new Set();
  const roads = [];
  const addRoad = (a, b) => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const key = lo * 1000 + hi;
    if (lo === hi || roadSet.has(key)) return false;
    roadSet.add(key);
    roads.push([lo, hi]);
    return true;
  };
  const removeRoad = (a, b) => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    roadSet.delete(lo * 1000 + hi);
    const i = roads.findIndex(r => r[0] === lo && r[1] === hi);
    if (i >= 0) roads.splice(i, 1);
  };
  const crossesAny = (a, b) => {
    for (const [c, d] of roads) {
      if (mapSegmentsCross(nodes[a], nodes[b], nodes[c], nodes[d])) return true;
    }
    return false;
  };

  for (const n of columns[0]) addRoad(keep.id, n.id);
  for (const n of columns[C - 1]) addRoad(citadel.id, n.id);

  const rightDeg = new Map(), leftDeg = new Map();
  for (let k = 0; k < C - 1; k++) {
    const L = columns[k], R = columns[k + 1];
    const gap = [];
    let i = 0, j = 0;
    gap.push([L[0], R[0]]);
    while (i < L.length - 1 || j < R.length - 1) {
      if (i === L.length - 1) j++;
      else if (j === R.length - 1) i++;
      else {
        const dy = L[i + 1].y - R[j + 1].y;
        if (Math.abs(dy) < 20) { if (rng() < 0.5) i++; else j++; }
        else if (dy < 0) i++; else j++;
      }
      gap.push([L[i], R[j]]);
    }
    for (const [a, b] of gap) {
      addRoad(a.id, b.id);
      rightDeg.set(a.id, (rightDeg.get(a.id) || 0) + 1);
      leftDeg.set(b.id, (leftDeg.get(b.id) || 0) + 1);
    }
    // prune interior staircase edges (first + last always survive => two disjoint
    // outer routes, north and south). R must keep a left edge (connectivity);
    // L may become a dead-end pocket rarely.
    const interior = gap.slice(1, -1);
    for (let t = interior.length - 1; t > 0; t--) {
      const s = Math.floor(rng() * (t + 1));
      [interior[t], interior[s]] = [interior[s], interior[t]];
    }
    for (const [a, b] of interior) {
      if (rng() > 0.8) continue;
      if ((leftDeg.get(b.id) || 0) <= 1) continue;
      if ((rightDeg.get(a.id) || 0) <= 1 && rng() > 0.25) continue;
      removeRoad(a.id, b.id);
      rightDeg.set(a.id, rightDeg.get(a.id) - 1);
      leftDeg.set(b.id, leftDeg.get(b.id) - 1);
    }
  }
  // a few north-south links inside a column (detours / cross-overs between routes)
  for (let k = 0; k < C; k++) {
    const col = columns[k];
    for (let i = 0; i + 1 < col.length; i++) {
      if (rng() < 0.12 && !crossesAny(col[i].id, col[i + 1].id)) addRoad(col[i].id, col[i + 1].id);
    }
  }
  roads.sort((p, q) => p[0] - q[0] || p[1] - q[1]);

  // ---- distances ----
  const adj = mapAdjacency(nodes.length, roads);
  const dist = mapBfs(adj, keep.id);

  // ---- bands, types ----
  const richBand = rng() < 0.5 ? 'north' : 'south';
  const bandOf = (y) => (y < 255 ? 'north' : y > 345 ? 'south' : 'mid');
  for (const n of nodes) {
    if (n === keep) { n.type = 'keep'; n.band = 'mid'; continue; }
    if (n === citadel) { n.type = 'citadel'; n.band = 'mid'; continue; }
    const geo = bandOf(n.y);
    n.band = geo === 'mid' ? 'mid' : (geo === richBand ? 'rich' : 'lean');
    n.type = mapWeighted(rng, MAP_TYPE_WEIGHTS[n.band]);
  }
  const mids = nodes.filter(n => n.type !== 'keep' && n.type !== 'citadel');
  // Column 0 is a gentle start: no shrines/towns adjacent to the keep, at least one garrison.
  for (const n of columns[0]) if (n.type === 'shrine') n.type = 'garrison';
  if (!columns[0].some(n => n.type === 'garrison')) columns[0][0].type = 'garrison';
  // Guarantees: >=2 mines, >=1 town, >=1 shrine, rich band clearly richer than lean band.
  const ensure = (type, count, prefer) => {
    let have = mids.filter(n => n.type === type).length;
    const pool = mids.filter(n => n.type === 'garrison' && n.col > 0)
      .sort((a, b) => (prefer(b) - prefer(a)) || (a.id - b.id));
    for (const n of pool) {
      if (have >= count) break;
      n.type = type; have++;
    }
  };
  const richFirst = (n) => (n.band === 'rich' ? 2 : n.band === 'mid' ? 1 : 0);
  const leanFirst = (n) => (n.band === 'lean' ? 2 : n.band === 'mid' ? 1 : 0);
  ensure('mine', 2, richFirst);
  ensure('shrine', 1, richFirst);
  ensure('town', 1, leanFirst);
  const econ = (band) => mids.filter(n => n.band === band && (n.type === 'mine' || n.type === 'shrine')).length;
  let fix = 0;
  while (econ('rich') < econ('lean') + 2 && fix++ < 20) {
    const leanMine = mids.find(n => n.band === 'lean' && (n.type === 'mine' || n.type === 'shrine'));
    const richGar = mids.find(n => n.band === 'rich' && n.type === 'garrison' && n.col > 0);
    if (leanMine && econ('lean') > 0 && mids.filter(n => n.type === 'mine').length > 2) { leanMine.type = 'garrison'; continue; }
    if (richGar) { richGar.type = 'mine'; continue; }
    break;
  }

  // ---- tiers ----
  const base = (regionNumber - 1) * TIERS_PER_REGION;
  let maxTier = base;
  for (const n of nodes) {
    n.dist = dist[n.id];
    if (n === keep) { n.tier = base; continue; }
    if (n === citadel) continue;
    n.tier = base + dist[n.id] + (n.band === 'rich' && n.col > 0 ? 1 : 0);
    if (n.tier > maxTier) maxTier = n.tier;
  }
  citadel.tier = Math.max(base + TIERS_PER_REGION, maxTier + 1);

  // ---- names ----
  for (const n of nodes) n.name = mapMakeName(nameRng, n.type, used);
  citadel.boss = mapPick(nameRng, MAP_BOSS);

  const outNodes = nodes.map(n => {
    const o = { id: n.id, x: n.x, y: n.y, type: n.type, tier: n.tier, name: n.name, col: n.col, band: n.band, dist: n.dist };
    if (n.boss) o.boss = n.boss;
    return o;
  });
  return {
    seed: String(seed), regionNumber, width: MAP_W, height: MAP_H,
    keepId: keep.id, citadelId: citadel.id, richBand,
    nodes: outNodes, roads,
  };
}

// ---------- graph helpers ----------
export function mapAdjacency(nodeCount, roads) {
  const adj = Array.from({ length: nodeCount }, () => []);
  for (const [a, b] of roads) { adj[a].push(b); adj[b].push(a); }
  for (const l of adj) l.sort((p, q) => p - q);
  return adj;
}

export function mapBfs(adj, from) {
  const d = new Array(adj.length).fill(Infinity);
  d[from] = 0;
  const q = [from];
  for (let h = 0; h < q.length; h++) {
    const u = q[h];
    for (const v of adj[u]) if (d[v] === Infinity) { d[v] = d[u] + 1; q.push(v); }
  }
  return d;
}

export function neighbors(region, id) {
  const out = [];
  for (const [a, b] of region.roads) { if (a === id) out.push(b); else if (b === id) out.push(a); }
  return out.sort((p, q) => p - q);
}

export function roadDistances(region, fromId = region.keepId) {
  return mapBfs(mapAdjacency(region.nodes.length, region.roads), fromId);
}

// ---------- territory / fog ----------
function mapHeldSet(held) {
  if (held instanceof Set) return held;
  return new Set(held || []);
}

/** Fresh map state for a region: only the keep is held. */
export function initialMapState(region) {
  return { region, held: [region.keepId] };
}

/** frontier(state) -> sorted ids of unheld nodes adjacent (by road) to a held node. */
export function frontier(state) {
  const held = mapHeldSet(state.held);
  const out = new Set();
  for (const [a, b] of state.region.roads) {
    if (held.has(a) && !held.has(b)) out.add(b);
    else if (held.has(b) && !held.has(a)) out.add(a);
  }
  return [...out].sort((p, q) => p - q);
}

/** visibility(state) -> array indexed by node id: 'held' | 'frontier' | 'fog'. */
export function visibility(state) {
  const held = mapHeldSet(state.held);
  const vis = state.region.nodes.map(n => (held.has(n.id) ? 'held' : 'fog'));
  for (const id of frontier(state)) vis[id] = 'frontier';
  return vis;
}

/** canCapture(state, id): node is on the frontier (attackable). */
export function canCapture(state, id) {
  return frontier(state).includes(id);
}

/** capture(state, id) -> new state with id held (immutable). Throws if not on the frontier. */
export function capture(state, id) {
  if (!canCapture(state, id)) throw new Error('node ' + id + ' is not on the frontier');
  return { ...state, held: [...mapHeldSet(state.held), id].sort((p, q) => p - q) };
}

/**
 * fogView(state) -> what the player may know about each node.
 * held/frontier: full node + {vis}; fog: silhouette {id,x,y,vis:'fog',silhouette:true,big}
 * (big = true for the citadel, whose silhouette is always recognisable).
 */
export function fogView(state) {
  const vis = visibility(state);
  return state.region.nodes.map(n => {
    if (vis[n.id] !== 'fog') return { ...n, vis: vis[n.id] };
    return { id: n.id, x: n.x, y: n.y, vis: 'fog', silhouette: true, big: n.type === 'citadel' };
  });
}
