// Checkmarch battle terrain: impassable squares (rock, water) on the battle board.
// Pure ES module, no DOM access, no imports. Inline-friendly for build.mjs: every top-level
// name is unique to this module (prefixed terr*/TERR_* or terrain*), and the only exports are
// `export function` / `export const`, which build.mjs's toScript() strips.
//
// Square indexing matches engine.mjs: sq = rank * N + file, rank 0 = white's back rank.
//
// RULES (see TERRAIN-API.md for the engine patch):
//   * A blocked square is a wall. No piece may stand on it, land on it, or capture onto it.
//   * Sliders (bishop, rook, queen) stop BEFORE a wall; their ray ends there.
//   * Kings move one square and simply cannot step onto a wall.
//   * Pawns cannot push onto a wall; a double push is blocked if either square is a wall.
//     (Pawn captures never land on a wall because no piece can stand on one.)
//   * KNIGHTS LEAP OVER TERRAIN. A knight's jump is not a path, it is a leap (the chess-natural
//     reading: a knight is never blocked by what stands between), so walls only remove a knight's
//     landing square, never its route.
//   * Terrain is static for a whole battle and never changes the side to move or the rules of check;
//     attacks are computed with the same wall-truncated rays, so a wall also shields from checks.

// ---------- tuning ----------
export const TERRAIN_MIN_TIER = 3;     // tier < 3: never any terrain
export const TERRAIN_MIN = 2;          // tier >= 3: at least this many blocked squares...
export const TERRAIN_MAX = 6;          // ...and at most this many
export const TERRAIN_FORT_MAX = 3;     // citadel / keep battles: at most this many
export const TERRAIN_DEPLOY_RANKS = 2; // ranks on each side that always stay clear
export const TERRAIN_FORT_TYPES = ['citadel', 'keep'];

// waterShare: chance a new cluster is water; grow: chance to extend the current cluster rather than
// start a new one; maxCluster: largest cluster; bias: added to the tier curve before rounding.
export const TERRAIN_BIOMES = {
  plains:   { label: 'Plains',   waterShare: 0.35, grow: 0.45, maxCluster: 2, bias: -0.35 },
  highland: { label: 'Highland', waterShare: 0.10, grow: 0.55, maxCluster: 3, bias: 0.45 },
  marsh:    { label: 'Marsh',    waterShare: 0.80, grow: 0.70, maxCluster: 3, bias: 0.15 },
};
export const TERRAIN_BIOME_KEYS = ['plains', 'highland', 'marsh'];

// ---------- rng (FNV-1a + murmur finalizer -> mulberry32), self-contained ----------
export function terrHash(str) {
  const s = String(str);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return h >>> 0;
}
export function terrMulberry32(a) {
  a = a >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- counts and zones ----------
/** Target number of blocked squares for a node (before feasibility). Deterministic given rng. */
export function terrainCount(tier, type, biome, rng) {
  tier = tier | 0;
  if (tier < TERRAIN_MIN_TIER) return 0;
  const b = TERRAIN_BIOMES[biome] || TERRAIN_BIOMES.plains;
  // gentle curve: ~2 at tier 3, ~4 at tier 16, 6 by the high 20s; +/- a little noise per node
  const base = 2 + (tier - TERRAIN_MIN_TIER) / 6.5 + b.bias + (rng ? rng() * 0.9 - 0.3 : 0);
  let n = Math.max(TERRAIN_MIN, Math.min(TERRAIN_MAX, Math.floor(base)));
  if (TERRAIN_FORT_TYPES.includes(type)) n = Math.min(n, TERRAIN_FORT_MAX);
  return n;
}
/** True if terrain may ever be placed on rank r of an N board (deployment zones stay clear). */
export function terrainRankAllowed(r, N = 8) { return r >= TERRAIN_DEPLOY_RANKS && r < N - TERRAIN_DEPLOY_RANKS; }
/** The central squares (2x2 on even boards, the single centre on odd boards). */
export function terrainCenter(N = 8) {
  if (N % 2) { const c = (N - 1) / 2; return [c * N + c]; }
  const a = N / 2 - 1, b = N / 2;
  return [a * N + a, a * N + b, b * N + a, b * N + b];
}

// ---------- connectivity (king-move adjacency over open squares) ----------
/** mask: Uint8Array(N*N), nonzero = blocked. Returns true if every open square is reachable. */
export function terrainConnected(mask, N = 8) {
  const total = N * N;
  let start = -1, open = 0;
  for (let i = 0; i < total; i++) if (!mask[i]) { open++; if (start < 0) start = i; }
  if (open === 0) return true;
  const seen = new Uint8Array(total), stack = [start];
  seen[start] = 1;
  let n = 0;
  while (stack.length) {
    const s = stack.pop(); n++;
    const r = (s / N) | 0, f = s % N;
    for (let dr = -1; dr <= 1; dr++) for (let df = -1; df <= 1; df++) {
      if (!dr && !df) continue;
      const rr = r + dr, ff = f + df;
      if (rr < 0 || rr >= N || ff < 0 || ff >= N) continue;
      const t = rr * N + ff;
      if (!mask[t] && !seen[t]) { seen[t] = 1; stack.push(t); }
    }
  }
  return n === open;
}

// ---------- generation ----------
/**
 * generateTerrain(seed, nodeId, boardN = 8, biome = 'plains', opts = {})
 *   opts.tier  : node tier (default 1 -> no terrain)
 *   opts.type  : node type ('garrison' | 'mine' | 'citadel' | 'keep' | 'raid' ...); citadel/keep cap 3
 *   opts.avoid : extra squares that must stay open (e.g. the enemy formation's squares, some of
 *                which sit on black's ranks 6 and 5, outside the guaranteed-clear zone)
 * Returns a plain JSON-safe object:
 *   { v: 1, n, biome, tier, type, blocked: [sorted square indices], kind: { [sq]: 'rock'|'water' } }
 * Deterministic: same (seed, nodeId, boardN, biome, opts) -> same terrain.
 */
export function generateTerrain(seed, nodeId, boardN = 8, biome = 'plains', opts = {}) {
  const N = Math.max(1, boardN | 0);
  if (!TERRAIN_BIOMES[biome]) biome = 'plains';
  const B = TERRAIN_BIOMES[biome];
  const tier = opts.tier == null ? 1 : opts.tier | 0;
  const type = opts.type || 'garrison';
  const out = { v: 1, n: N, biome, tier, type, blocked: [], kind: {} };
  const rng = terrMulberry32(terrHash(seed + '|' + nodeId + '|' + N + '|' + biome));
  const target = terrainCount(tier, type, biome, rng);
  if (!target) return out;

  const total = N * N, mask = new Uint8Array(total), keepOpen = new Uint8Array(total);
  for (const s of opts.avoid || []) if (s >= 0 && s < total) keepOpen[s] = 1;
  const center = terrainCenter(N);
  const allowed = [];
  for (let s = 0; s < total; s++) if (terrainRankAllowed((s / N) | 0, N) && !keepOpen[s]) allowed.push(s);

  const ok = (s) => {
    if (s < 0 || s >= total || mask[s] || keepOpen[s] || !terrainRankAllowed((s / N) | 0, N)) return false;
    mask[s] = 1;
    let good = !center.every(c => mask[c]) && terrainConnected(mask, N);
    mask[s] = 0;
    return good;
  };
  const neigh = (s, diag) => {
    const r = (s / N) | 0, f = s % N, res = [];
    for (let dr = -1; dr <= 1; dr++) for (let df = -1; df <= 1; df++) {
      if (!dr && !df) continue;
      if (!diag && dr && df) continue;
      const rr = r + dr, ff = f + df;
      if (rr >= 0 && rr < N && ff >= 0 && ff < N) res.push(rr * N + ff);
    }
    return res;
  };
  const place = (s, k) => { mask[s] = k; out.blocked.push(s); out.kind[s] = k === 2 ? 'water' : 'rock'; };

  // clustered growth: water spreads orthogonally (ponds, streams), rock also diagonally (outcrops)
  let cluster = null, kind = 1, placed = 0;
  for (let tries = 0; placed < target && tries < 300; tries++) {
    const extend = cluster && cluster.length < B.maxCluster && rng() < B.grow;
    let cand;
    if (extend) {
      const pool = [];
      for (const c of cluster) for (const t of neigh(c, kind === 1)) if (ok(t) && !pool.includes(t)) pool.push(t);
      if (!pool.length) { cluster = null; continue; }
      cand = pool[(rng() * pool.length) | 0];
    } else {
      cand = allowed[(rng() * allowed.length) | 0];
      if (!ok(cand)) continue;
      // a fresh cluster does not touch an existing one of the other kind (keeps glyphs readable)
      kind = rng() < B.waterShare ? 2 : 1;
      if (neigh(cand, true).some(t => mask[t] && mask[t] !== kind)) kind = 3 - kind;
      cluster = [];
    }
    place(cand, kind); cluster.push(cand); placed++;
  }
  // fallback sweep (enforces the minimum even if the random walk was unlucky)
  if (placed < target) {
    const order = allowed.slice();
    for (let i = order.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; [order[i], order[j]] = [order[j], order[i]]; }
    for (const s of order) { if (placed >= target) break; if (ok(s)) { place(s, 1); placed++; } }
  }
  out.blocked.sort((a, b) => a - b);
  const kinds = {};
  for (const s of out.blocked) kinds[s] = out.kind[s];
  out.kind = kinds;
  return out;
}

// ---------- adapters ----------
const terrMaskCache = new WeakMap();
/** Uint8Array(N*N): 0 open, 1 rock, 2 water. Cached per terrain object. null/undefined -> all open. */
export function terrainMask(terrain, N) {
  N = N || (terrain && terrain.n) || 8;
  if (!terrain) return new Uint8Array(N * N);
  let m = terrMaskCache.get(terrain);
  if (m && m.length === N * N) return m;
  m = new Uint8Array(N * N);
  for (const s of terrain.blocked || []) if (s >= 0 && s < N * N) m[s] = terrain.kind && terrain.kind[s] === 'water' ? 2 : 1;
  terrMaskCache.set(terrain, m);
  return m;
}
/** Live Set view of the blocked squares (the canonical serialized form is the sorted array). */
export function terrainBlockedSet(terrain) { return new Set(terrain ? terrain.blocked : []); }
export function isBlocked(terrain, sq) { return !!terrain && terrainMask(terrain)[sq] > 0; }
export function terrainKind(terrain, sq) { return terrain && terrain.kind ? terrain.kind[sq] || null : null; }
/** Validate a terrain object (e.g. from a save) against every guarantee. Returns [] or a list of problems. */
export function terrainProblems(terrain, opts = {}) {
  const errs = [], N = terrain.n, tier = terrain.tier, type = terrain.type, bl = terrain.blocked;
  const max = tier < TERRAIN_MIN_TIER ? 0 : TERRAIN_FORT_TYPES.includes(type) ? TERRAIN_FORT_MAX : TERRAIN_MAX;
  const min = tier < TERRAIN_MIN_TIER ? 0 : Math.min(TERRAIN_MIN, max);
  if (bl.length < min || bl.length > max) errs.push(`count ${bl.length} outside [${min},${max}]`);
  for (let i = 1; i < bl.length; i++) if (bl[i] <= bl[i - 1]) errs.push('blocked not strictly sorted');
  for (const s of bl) {
    if (!terrainRankAllowed((s / N) | 0, N)) errs.push(`square ${s} in a deployment rank`);
    if (terrain.kind[s] !== 'rock' && terrain.kind[s] !== 'water') errs.push(`square ${s} has no kind`);
  }
  if (Object.keys(terrain.kind).length !== bl.length) errs.push('kind map size mismatch');
  for (const s of opts.avoid || []) if (bl.includes(s)) errs.push(`avoid square ${s} blocked`);
  const m = new Uint8Array(N * N); for (const s of bl) m[s] = 1;
  if (terrainCenter(N).every(c => m[c])) errs.push('all central squares blocked');
  if (!terrainConnected(m, N)) errs.push('open squares not connected');
  return errs;
}

// ---------- geometry tables in engine.mjs format ----------
// Engine direction order: [dr, df] = N, S, E, W (rook, d < 4), then NE, NW, SE, SW (bishop, d >= 4).
const TERR_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const TERR_KNIGHT = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
/**
 * Wall-aware move tables, same shape and order as engine.mjs's KN / KG / RAYS / PAWN_FROM, plus WALL.
 * With terrain = null this reproduces the engine's own tables exactly.
 *   KN[sq]  knight targets, landing on walls removed (knights leap over terrain)
 *   KG[sq]  king targets, walls removed
 *   RAYS[sq][d]  slider rays, each truncated before its first wall
 *   PAWN_FROM[c][sq]  squares from which a pawn of color c attacks sq (wall origins removed)
 *   WALL    Uint8Array(N*N), 1 = blocked (used for pawn pushes)
 * A wall square's own entries are empty arrays (nothing can stand there).
 */
export function terrainGeometry(terrain, N = 8) {
  const W = new Uint8Array(N * N);
  if (terrain) for (const s of terrain.blocked) if (s >= 0 && s < N * N) W[s] = 1;
  const okSq = (r, f) => r >= 0 && r < N && f >= 0 && f < N && !W[r * N + f];
  const KN = [], KG = [], RAYS = [], PAWN_FROM = [[], []];
  for (let sq = 0; sq < N * N; sq++) {
    const r = (sq / N) | 0, f = sq % N;
    if (W[sq]) { KN[sq] = []; KG[sq] = []; RAYS[sq] = TERR_DIRS.map(() => []); PAWN_FROM[0][sq] = []; PAWN_FROM[1][sq] = []; continue; }
    KN[sq] = TERR_KNIGHT.filter(([a, b]) => okSq(r + a, f + b)).map(([a, b]) => (r + a) * N + f + b);
    KG[sq] = TERR_DIRS.filter(([a, b]) => okSq(r + a, f + b)).map(([a, b]) => (r + a) * N + f + b);
    RAYS[sq] = TERR_DIRS.map(([a, b]) => { const o = []; let rr = r + a, ff = f + b; while (okSq(rr, ff)) { o.push(rr * N + ff); rr += a; ff += b; } return o; });
    PAWN_FROM[0][sq] = [-1, 1].filter(d => okSq(r - 1, f + d)).map(d => (r - 1) * N + f + d);
    PAWN_FROM[1][sq] = [-1, 1].filter(d => okSq(r + 1, f + d)).map(d => (r + 1) * N + f + d);
  }
  return { N, WALL: W, KN, KG, RAYS, PAWN_FROM };
}

// ---------- movement probe (single piece; used by the demo and the tests) ----------
/**
 * Pseudo-legal target squares for one piece standing on `sq`, honoring terrain.
 *   type: 'P' | 'N' | 'B' | 'R' | 'Q' | 'K'; color: 0 white (moves up), 1 black
 *   occ (optional): Map/obj sq -> 0|1 color of other pieces on the board (blockers / captures)
 * Returns { moves: [sq...], captures: [sq...], pawnAttacks: [sq...] } (pawnAttacks = diagonal squares a
 * pawn threatens, whether or not something stands there). Returns empty lists if sq itself is blocked.
 */
export function terrainProbe(terrain, sq, type, color = 0, occ = null, N) {
  N = N || (terrain && terrain.n) || 8;
  const g = terrainGeometry(terrain, N), W = g.WALL;
  const who = (s) => occ == null ? null : occ instanceof Map ? (occ.has(s) ? occ.get(s) : null) : (s in occ ? occ[s] : null);
  const res = { moves: [], captures: [], pawnAttacks: [] };
  if (sq < 0 || sq >= N * N || W[sq]) return res;
  const add = (t) => { const c = who(t); if (c == null) res.moves.push(t); else if (c !== color) res.captures.push(t); return c == null; };
  if (type === 'N' || type === 'K') { for (const t of (type === 'N' ? g.KN : g.KG)[sq]) add(t); }
  else if (type === 'B' || type === 'R' || type === 'Q') {
    const d0 = type === 'B' ? 4 : 0, d1 = type === 'R' ? 4 : 8;
    for (let d = d0; d < d1; d++) for (const t of g.RAYS[sq][d]) if (!add(t)) break;
  } else if (type === 'P') {
    const dir = color === 0 ? N : -N, r = (sq / N) | 0, f = sq % N, startR = color === 0 ? 1 : N - 2, to = sq + dir;
    if (to >= 0 && to < N * N) {
      if (!W[to] && who(to) == null) {
        res.moves.push(to);
        const t2 = to + dir;
        if (r === startR && t2 >= 0 && t2 < N * N && !W[t2] && who(t2) == null) res.moves.push(t2);
      }
      for (const df of [-1, 1]) {
        const ff = f + df; if (ff < 0 || ff >= N) continue;
        const c = to + df; if (W[c]) continue;
        res.pawnAttacks.push(c);
        const o = who(c); if (o != null && o !== color) res.captures.push(c);
      }
    }
  }
  return res;
}

// ---------- rendering ----------
export const TERRAIN_PALETTE_KEYS = ['rock', 'rockHi', 'rockLo', 'rockEdge', 'water', 'waterHi', 'waterLo', 'shadow', 'bed'];
export const TERRAIN_PALETTES = {
  light: {
    rock: '#9a958a', rockHi: '#c3beb1', rockLo: '#6f6a60', rockEdge: 'rgba(45,38,28,0.35)',
    water: '#5f9fbf', waterHi: 'rgba(238,248,252,0.85)', waterLo: '#3f7f9f',
    shadow: 'rgba(40,25,10,0.22)', bed: 'rgba(120,95,60,0.10)',
  },
  dark: {
    rock: '#7c8591', rockHi: '#a5aeb9', rockLo: '#535b66', rockEdge: 'rgba(0,0,0,0.45)',
    water: '#3d7393', waterHi: 'rgba(200,228,245,0.70)', waterLo: '#2a5470',
    shadow: 'rgba(0,0,0,0.38)', bed: 'rgba(10,15,20,0.18)',
  },
};
/** Fill any missing palette key from the built-in light/dark palette for `theme`. */
export function terrainPalette(palette, theme = 'light') {
  const base = TERRAIN_PALETTES[theme === 'dark' ? 'dark' : 'light'], o = {};
  for (const k of TERRAIN_PALETTE_KEYS) o[k] = (palette && palette[k]) || base[k];
  return o;
}
/** Read `--terr-<kebab-key>` custom properties from a computed style (getComputedStyle result). */
export function terrainPaletteFromStyle(cs, theme = 'light') {
  const p = {};
  for (const k of TERRAIN_PALETTE_KEYS) { const v = cs.getPropertyValue('--terr-' + k.replace(/[A-Z]/g, m => '-' + m.toLowerCase())).trim(); if (v) p[k] = v; }
  return terrainPalette(p, theme);
}

// Shape geometry in unit-cell coordinates (0..1), deterministic per square, shared by canvas + SVG.
export function terrainRockShape(sq) {
  const rnd = terrMulberry32(terrHash('rock|' + sq));
  const cx = 0.5 + (rnd() - 0.5) * 0.06, cy = 0.54, n = 7, pts = [];
  for (let i = 0; i < n; i++) {
    const a = Math.PI + (i / (n - 1)) * Math.PI;             // upper half arc, left -> right
    const rx = 0.34 + rnd() * 0.05, ry = 0.30 + rnd() * 0.08;
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  pts.push([cx + 0.36, cy + 0.16], [cx - 0.36, cy + 0.16]); // flat base
  const hi = [pts[1], pts[2], pts[3], [cx + 0.02, cy - 0.02], [cx - 0.2, cy + 0.04]];
  const crack = [[cx + 0.08, cy - 0.22], [cx + 0.03, cy - 0.06], [cx + 0.12, cy + 0.06]];
  const pebble = [cx + (rnd() < 0.5 ? -0.3 : 0.3), cy + 0.2, 0.06];
  return { pts, hi, crack, pebble, shadow: [cx, cy + 0.17, 0.4, 0.09] };
}
export function terrainWaterWaves(sq) {
  const rnd = terrMulberry32(terrHash('water|' + sq)), off = (rnd() - 0.5) * 0.12;
  return [[0.24 + off, 0.40], [0.46 - off, 0.62]]; // left ends of two wave strokes (width 0.3)
}

function terrCellXY(sq, N, cell, flip, x0, y0) {
  const r = (sq / N) | 0, f = sq % N;
  return flip ? [x0 + (N - 1 - f) * cell, y0 + r * cell] : [x0 + f * cell, y0 + (N - 1 - r) * cell];
}

/**
 * drawTerrain(ctx, terrain, cellPx, palette, theme = 'light', opts = {})
 *   Draws every blocked square onto a 2D canvas context, flat vector style.
 *   Call after the squares and before highlights/pieces. palette may be partial; missing keys come
 *   from TERRAIN_PALETTES[theme]. opts: { x0 = 0, y0 = 0, flip = false (black at the bottom) }.
 *   Water cells that touch orthogonally are bridged so ponds and streams read as one body.
 */
export function drawTerrain(ctx, terrain, cellPx, palette, theme = 'light', opts = {}) {
  if (!terrain || !terrain.blocked.length) return;
  const pal = terrainPalette(palette, theme), N = terrain.n, c = cellPx;
  const x0 = opts.x0 || 0, y0 = opts.y0 || 0, flip = !!opts.flip, m = terrainMask(terrain, N);
  const waters = terrain.blocked.filter(s => m[s] === 2), rocks = terrain.blocked.filter(s => m[s] === 1);
  ctx.save();
  // ---- water: bodies first (with bridges), then rims and waves
  const pad = c * 0.07, rad = c * 0.22;
  const body = (inset) => {
    ctx.beginPath();
    for (const s of waters) {
      const [x, y] = terrCellXY(s, N, c, flip, x0, y0);
      terrRoundRect(ctx, x + pad - inset, y + pad - inset, c - 2 * pad + 2 * inset, c - 2 * pad + 2 * inset, rad);
      const r = (s / N) | 0, f = s % N;
      // bridge to the east / north neighbour (screen direction depends on flip)
      if (f + 1 < N && m[s + 1] === 2) { const [x2] = terrCellXY(s + 1, N, c, flip, x0, y0); const xa = Math.min(x, x2) + c / 2; ctx.rect(xa, y + pad - inset, c, c - 2 * pad + 2 * inset); }
      if (r + 1 < N && m[s + N] === 2) { const [, y2] = terrCellXY(s + N, N, c, flip, x0, y0); const ya = Math.min(y, y2) + c / 2; ctx.rect(x + pad - inset, ya, c - 2 * pad + 2 * inset, c); }
    }
    ctx.fill();
  };
  if (waters.length) {
    ctx.fillStyle = pal.waterLo; body(c * 0.035);
    ctx.fillStyle = pal.water; body(0);
    ctx.strokeStyle = pal.waterHi; ctx.lineCap = 'round'; ctx.lineWidth = Math.max(1.2, c * 0.045);
    for (const s of waters) {
      const [x, y] = terrCellXY(s, N, c, flip, x0, y0);
      for (const [wx, wy] of terrainWaterWaves(s)) {
        ctx.beginPath();
        ctx.moveTo(x + wx * c, y + wy * c);
        ctx.quadraticCurveTo(x + (wx + 0.075) * c, y + (wy - 0.06) * c, x + (wx + 0.15) * c, y + wy * c);
        ctx.quadraticCurveTo(x + (wx + 0.225) * c, y + (wy + 0.06) * c, x + (wx + 0.3) * c, y + wy * c);
        ctx.stroke();
      }
    }
  }
  // ---- rock: soft ground bed + shadow, boulder, facet, crack, pebble
  for (const s of rocks) {
    const [x, y] = terrCellXY(s, N, c, flip, x0, y0), sh = terrainRockShape(s);
    const P = ([u, v]) => [x + u * c, y + v * c];
    ctx.fillStyle = pal.bed; ctx.beginPath(); terrRoundRect(ctx, x + pad, y + pad, c - 2 * pad, c - 2 * pad, rad); ctx.fill();
    ctx.fillStyle = pal.shadow; ctx.beginPath(); ctx.ellipse(x + sh.shadow[0] * c, y + sh.shadow[1] * c, sh.shadow[2] * c, sh.shadow[3] * c, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = pal.rock; ctx.strokeStyle = pal.rockEdge; ctx.lineWidth = Math.max(1, c * 0.025); ctx.lineJoin = 'round';
    terrPoly(ctx, sh.pts.map(P)); ctx.fill(); ctx.stroke();
    ctx.fillStyle = pal.rockHi; terrPoly(ctx, sh.hi.map(P)); ctx.fill();
    ctx.strokeStyle = pal.rockLo; ctx.lineWidth = Math.max(1, c * 0.03); ctx.lineCap = 'round';
    ctx.beginPath(); sh.crack.map(P).forEach(([px, py], i) => i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)); ctx.stroke();
    ctx.fillStyle = pal.rockLo; ctx.beginPath(); ctx.arc(x + sh.pebble[0] * c, y + sh.pebble[1] * c, sh.pebble[2] * c, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}
function terrPoly(ctx, pts) { ctx.beginPath(); pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); }
function terrRoundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

/**
 * terrainSquareSVG(terrain, sq, palette, theme) -> SVG markup string (viewBox 0 0 100 100) for one
 * blocked square, or '' if open. For the game's DOM board (.sq divs): drop it inside the square,
 * absolutely positioned, pointer-events:none. Same shapes as drawTerrain (no water bridging).
 */
export function terrainSquareSVG(terrain, sq, palette, theme = 'light') {
  const k = terrainKind(terrain, sq); if (!k) return '';
  const pal = terrainPalette(palette, theme), u = (v) => (v * 100).toFixed(1);
  const pts = (a) => a.map(([x, y]) => u(x) + ',' + u(y)).join(' ');
  let g;
  if (k === 'water') {
    const waves = terrainWaterWaves(sq).map(([x, y]) => `<path d="M${u(x)} ${u(y)}q7.5 -6 15 0t15 0" fill="none" stroke="${pal.waterHi}" stroke-width="4.5" stroke-linecap="round"/>`).join('');
    g = `<rect x="3.5" y="3.5" width="93" height="93" rx="22" fill="${pal.waterLo}"/><rect x="7" y="7" width="86" height="86" rx="22" fill="${pal.water}"/>${waves}`;
  } else {
    const sh = terrainRockShape(sq);
    g = `<rect x="7" y="7" width="86" height="86" rx="22" fill="${pal.bed}"/>`
      + `<ellipse cx="${u(sh.shadow[0])}" cy="${u(sh.shadow[1])}" rx="${u(sh.shadow[2])}" ry="${u(sh.shadow[3])}" fill="${pal.shadow}"/>`
      + `<polygon points="${pts(sh.pts)}" fill="${pal.rock}" stroke="${pal.rockEdge}" stroke-width="2.5" stroke-linejoin="round"/>`
      + `<polygon points="${pts(sh.hi)}" fill="${pal.rockHi}"/>`
      + `<polyline points="${pts(sh.crack)}" fill="none" stroke="${pal.rockLo}" stroke-width="3" stroke-linecap="round"/>`
      + `<circle cx="${u(sh.pebble[0])}" cy="${u(sh.pebble[1])}" r="${u(sh.pebble[2])}" fill="${pal.rockLo}"/>`;
  }
  return `<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">${g}</svg>`;
}
