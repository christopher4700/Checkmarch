// Checkmarch engine + game logic (shared by game.html and the node tests).
// Rules: standard 8x8 chess moves, NO castling, NO en passant. Promotion is always to a queen, for that battle only.
// Board: Int8Array(64), sq = rank*8 + file, rank 0 = white's back rank (rank "1").
// Piece code = color << 5 | type (white 1..6, black 33..38; fairy types 8..16 from fairy.mjs), 0 = empty. Save v6:
// before v6 the code was color * 8 + type (world.mjs migrates saved battles by version).
// Move int: from | to<<6 | promo<<12 | captured<<13 (captured = (m >> 13) & 63, 19 bits); a gate move adds
// GATE_BIT (1 << 19) | gated type << GATE_SH (20): the gated piece drops onto the vacated from-square.
// M6: permanent piece-type skills (skills.mjs) live on state.skills. world.mjs registers the module with
// setSkillsModule (like the terrain provider), so engine.mjs itself has no imports and loads standalone.
let SKM = null;
// fairy pieces (fairy.mjs): FX = fairyHooks; types > 7 go to FX.gen / FX.attacked / FX.evalPiece / FX.evalAdjust
let FX = null;
export function setFairyHooks(h) { FX = h || null; if (h) h.bind({ WALL, VAL, TYPE_CH, CH_TYPE, UNITS, PIECE_NOUN }); FX_CUR = null; }
// the active fairy set follows the battle (like useTerrain): battle.fx = 'type,type' (types on the board + gated types)
let FX_CUR = null;
export function useFairy(battle) { if (!FX) return; const k = (battle && battle.fx) || ''; if (k === FX_CUR) return; FX.setPieces(k ? k.split(',').map(Number) : []); FX_CUR = k; }
export function fairyKey(pos) { const s = new Set(); for (let i = 0; i < 64; i++) { const t = pos.b[i] & 31; if (t > 7) s.add(t); } if (pos.g) for (const g of pos.g) s.add(g.t); return [...s].sort((a, b) => a - b).join(','); }
export function setSkillsModule(m) { SKM = m || null; }

export const P = 1, N = 2, B = 3, R = 4, Q = 5, K = 6;
export const WHITE = 0, BLACK = 1;
export const TYPE_CH = ['', 'P', 'N', 'B', 'R', 'Q', 'K'];
export const CH_TYPE = { P: 1, N: 2, B: 3, R: 4, Q: 5, K: 6 };
export const VAL = [0, 100, 320, 330, 500, 900, 0];
export const UNITS = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 };
export const MATE = 100000;

// ---------- precomputed geometry ----------
const KN = [], KG = [], RAYS = [], PAWN_FROM = [[], []], WALL = new Uint8Array(64); // WALL: battle terrain (terrain.mjs)
(function init() {
  const nd = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const ok = (r, f) => r >= 0 && r < 8 && f >= 0 && f < 8;
  for (let sq = 0; sq < 64; sq++) {
    const r = sq >> 3, f = sq & 7;
    KN[sq] = nd.filter(([a, b]) => ok(r + a, f + b)).map(([a, b]) => (r + a) * 8 + f + b);
    KG[sq] = dirs.filter(([a, b]) => ok(r + a, f + b)).map(([a, b]) => (r + a) * 8 + f + b);
    RAYS[sq] = dirs.map(([a, b]) => { const out = []; let rr = r + a, ff = f + b; while (ok(rr, ff)) { out.push(rr * 8 + ff); rr += a; ff += b; } return out; });
    // squares from which a pawn of color c attacks sq
    PAWN_FROM[0][sq] = [-1, 1].filter(d => ok(r - 1, f + d)).map(d => (r - 1) * 8 + f + d);
    PAWN_FROM[1][sq] = [-1, 1].filter(d => ok(r + 1, f + d)).map(d => (r + 1) * 8 + f + d);
  }
})();

// ---------- battle terrain (terrain.mjs): walls are swapped into the geometry tables in place ----------
// setTerrainGeometry(terrainGeometry(t)) is the patch from TERRAIN-API.md. world.mjs registers the provider
// (terrain.mjs terrainGeometry) with setTerrainProvider; useTerrain(t) then switches tables only when the
// battle's terrain object changes, so playMove/thinkMove/battleLegal always see the right board.
export function setTerrainGeometry(g) {
  for (let sq = 0; sq < 64; sq++) { KN[sq] = g.KN[sq]; KG[sq] = g.KG[sq]; RAYS[sq] = g.RAYS[sq];
    PAWN_FROM[0][sq] = g.PAWN_FROM[0][sq]; PAWN_FROM[1][sq] = g.PAWN_FROM[1][sq]; }
  WALL.set(g.WALL);
}
let TERR_FN = null, TERR_CUR = null;
export function setTerrainProvider(fn) { TERR_FN = fn; TERR_CUR = null; }
export function useTerrain(t) {
  t = t || null;
  if (!TERR_FN || t === TERR_CUR) return;
  setTerrainGeometry(TERR_FN(t)); TERR_CUR = t;
}
export function isWall(sq) { return WALL[sq] === 1; }

// ---------- materials (forge.mjs): optional per-square tier table pos.m; pos.mv = white-perspective eval bonus ----------
// world.mjs registers forge.mjs counterCheck / captureFallback / evalBonus with setCaptureRules.
export const MAT_KEYS = ['wood', 'iron', 'steel', 'obsidian'];
let CAP_RULES = null; const MATCP = [0, 0, 0, 0];
export function setCaptureRules(r) { CAP_RULES = r || null; for (let t = 0; t < 4; t++) MATCP[t] = r && r.evalBonus ? r.evalBonus(MAT_KEYS[t]) : 0; }
export function matTier(name) { const i = MAT_KEYS.indexOf(name); return i < 0 ? 0 : i; }
function attachMats(pos, m) { pos.m = Int8Array.from(m); pos.ms = new Int8Array(512); pos.mp = 0; recalcMv(pos); }
function recalcMv(pos) { let v = 0; if (pos.m) for (let i = 0; i < 64; i++) { const t = pos.m[i]; if (t && pos.b[i]) v += (pos.b[i] >> 5) === WHITE ? MATCP[t] : -MATCP[t]; } pos.mv = v; }

// ---------- position ----------
export function emptyPos() { return { b: new Int8Array(64), side: WHITE, k: [-1, -1] }; }
export function setPiece(pos, sq, color, type) { pos.b[sq] = type ? (color << 5 | type) : 0; if (type === K) pos.k[color] = sq; }
export function startPos() {
  const pos = emptyPos(), back = [R, N, B, Q, K, B, N, R];
  for (let f = 0; f < 8; f++) { setPiece(pos, f, 0, back[f]); setPiece(pos, 8 + f, 0, P); setPiece(pos, 48 + f, 1, P); setPiece(pos, 56 + f, 1, back[f]); }
  return pos;
}
export function clonePos(pos) { const c = { b: new Int8Array(pos.b), side: pos.side, k: pos.k.slice() }; if (pos.m) attachMats(c, pos.m); if (pos.gs) setGates(c, pos.g); return c; }
// gates count in the key (a waiting piece changes the position): repetition stays exact
export function posKey(pos) { return String.fromCharCode.apply(null, pos.b) + pos.side + (pos.g && pos.g.length ? pos.g.map(g => g.sq + ':' + g.t).join(';') : ''); }
// ---------- gating (Seirawan-style delivery, fairy.mjs FAIRY-API.md): pos.g = [{ color, sq, t, mt, id }] ----------
// A gate: a bought piece (type t, material tier mt, roster id) waits off the board behind its home square sq. A move
// leaving sq may carry GATE_BIT | t << GATE_SH: the piece then drops onto sq. Leaving sq without gating lapses the
// right; so does a capture on sq (its occupant dies there first). pos.gs is the unmake stack (exists only with gates).
export const GATE_BIT = 1 << 19, GATE_SH = 20, MOVE_MASK = 0x7ffff;
export const gateOf = m => (m & GATE_BIT) ? (m >> GATE_SH) & 31 : 0;
export function setGates(pos, gates) { pos.g = (gates || []).map(g => ({ color: g.color | 0, sq: g.sq | 0, t: g.t | 0, mt: g.mt | 0, id: g.id | 0 })); pos.gs = []; return pos; }
function gatesAfterMove(g, m, side) {
  const from = m & 63, to = (m >> 6) & 63, cap = (m >> 13) & 63;
  let hit = false; for (const x of g) if ((x.color === side && x.sq === from) || (cap && x.color !== side && x.sq === to)) { hit = true; break; }
  return hit ? g.filter(x => !((x.color === side && x.sq === from) || (cap && x.color !== side && x.sq === to))) : g;
}
export const mFrom = m => m & 63, mTo = m => (m >> 6) & 63, mPromo = m => (m >> 12) & 1, mCap = m => (m >> 13) & 63;
export function sqName(sq) { return 'abcdefgh'[sq & 7] + ((sq >> 3) + 1); }
export function moveName(m) { return sqName(mFrom(m)) + sqName(mTo(m)) + (mPromo(m) ? 'q' : ''); }

export function isAttacked(b, sq, by) {
  const pf = PAWN_FROM[by][sq], pc = by << 5 | P;
  for (let i = 0; i < pf.length; i++) if (b[pf[i]] === pc) return true;
  const kn = KN[sq], nc = by << 5 | N;
  for (let i = 0; i < kn.length; i++) if (b[kn[i]] === nc) return true;
  const kg = KG[sq], kc = by << 5 | K;
  for (let i = 0; i < kg.length; i++) if (b[kg[i]] === kc) return true;
  const rays = RAYS[sq];
  for (let d = 0; d < 8; d++) {
    const ray = rays[d];
    for (let i = 0; i < ray.length; i++) {
      const p = b[ray[i]];
      if (!p) continue;
      if ((p >> 5) === by) { const t = p & 31; if (t === Q || (d < 4 ? t === R : t === B)) return true; }
      break;
    }
  }
  if (FX && FX.attacked(b, sq, by)) return true;
  return false;
}
export function inCheck(pos, color = pos.side) { const k = pos.k[color]; return k >= 0 && isAttacked(pos.b, k, color ^ 1); }

// pseudo-legal moves; capturesOnly also includes promotions
export function genMoves(pos, out, capturesOnly) {
  const b = pos.b, side = pos.side;
  out.length = 0;
  for (let sq = 0; sq < 64; sq++) {
    const p = b[sq];
    if (!p || (p >> 5) !== side) continue;
    const t = p & 31;
    if (t === P) {
      const dir = side === WHITE ? 8 : -8, r = sq >> 3, f = sq & 7, to = sq + dir;
      const lastR = side === WHITE ? 7 : 0, startR = side === WHITE ? 1 : 6;
      if (to >= 0 && to < 64) {
        const promo = (to >> 3) === lastR ? 1 << 12 : 0;
        if (!b[to] && !WALL[to]) {
          if (!capturesOnly || promo) out.push(sq | to << 6 | promo);
          if (!capturesOnly && r === startR && !b[to + dir] && !WALL[to + dir]) out.push(sq | (to + dir) << 6);
        }
        for (let df = -1; df <= 1; df += 2) {
          const ff = f + df; if (ff < 0 || ff > 7) continue;
          const c = to + df, q = b[c];
          if (q && (q >> 5) !== side) out.push(sq | c << 6 | promo | q << 13);
        }
      }
    } else if (t === N || t === K) {
      const tg = t === N ? KN[sq] : KG[sq];
      for (let i = 0; i < tg.length; i++) {
        const to = tg[i], q = b[to];
        if (q) { if ((q >> 5) !== side) out.push(sq | to << 6 | q << 13); }
        else if (!capturesOnly) out.push(sq | to << 6);
      }
    } else if (t > 7) {
      if (FX) FX.gen(b, sq, t, side, out, capturesOnly);
    } else {
      const d0 = t === B ? 4 : 0, d1 = t === R ? 4 : 8, rays = RAYS[sq];
      for (let d = d0; d < d1; d++) {
        const ray = rays[d];
        for (let i = 0; i < ray.length; i++) {
          const to = ray[i], q = b[to];
          if (q) { if ((q >> 5) !== side) out.push(sq | to << 6 | q << 13); break; }
          if (!capturesOnly) out.push(sq | to << 6);
        }
      }
    }
  }
  const g = pos.g;
  if (g && g.length) for (let i = 0, n = out.length; i < n; i++) { const m = out[i], from = m & 63; for (let j = 0; j < g.length; j++) if (g[j].color === side && g[j].sq === from) out.push(m | GATE_BIT | g[j].t << GATE_SH); }
  return out;
}

export function makeMove(pos, m) {
  const b = pos.b, from = m & 63, to = (m >> 6) & 63, pc = b[from];
  const mm = pos.m;
  if (mm) { const cm = mm[to]; pos.ms[pos.mp++] = cm; if (cm) pos.mv += pos.side === WHITE ? MATCP[cm] : -MATCP[cm]; mm[to] = mm[from]; mm[from] = 0; }
  b[to] = (m >> 12) & 1 ? (pos.side << 5 | Q) : pc;
  b[from] = 0;
  if ((pc & 31) === K) pos.k[pos.side] = to;
  else if (((m >> 13) & 31) === K) pos.k[pos.side ^ 1] = -1; // only possible in broken positions
  if (pos.gs) {
    const g = pos.g; pos.gs.push(g);
    if (m & GATE_BIT) {
      b[from] = pos.side << 5 | ((m >> GATE_SH) & 31);
      if (mm) { let mt = 0; for (const x of g) if (x.color === pos.side && x.sq === from) mt = x.mt; mm[from] = mt; if (mt) pos.mv += pos.side === WHITE ? MATCP[mt] : -MATCP[mt]; }
    }
    if (g.length) pos.g = gatesAfterMove(g, m, pos.side);
  }
  pos.side ^= 1;
}
export function unmakeMove(pos, m) {
  pos.side ^= 1;
  const b = pos.b, from = m & 63, to = (m >> 6) & 63;
  const pc = (m >> 12) & 1 ? (pos.side << 5 | P) : b[to];
  b[from] = pc; b[to] = (m >> 13) & 63;
  const mm = pos.m;
  if (pos.gs) { pos.g = pos.gs.pop(); if (m & GATE_BIT && mm && mm[from]) pos.mv -= pos.side === WHITE ? MATCP[mm[from]] : -MATCP[mm[from]]; }
  if (mm) { const cm = pos.ms[--pos.mp]; mm[from] = mm[to]; mm[to] = cm; if (cm) pos.mv -= pos.side === WHITE ? MATCP[cm] : -MATCP[cm]; }
  if ((pc & 31) === K) pos.k[pos.side] = from;
  if (((m >> 13) & 31) === K) pos.k[pos.side ^ 1] = to;
}

export function legalMoves(pos) {
  const out = [], res = [];
  genMoves(pos, out, false);
  const me = pos.side;
  for (const m of out) { makeMove(pos, m); if (!inCheck(pos, me)) res.push(m); unmakeMove(pos, m); }
  return res;
}

export function perft(pos, depth) {
  if (depth === 0) return 1;
  const out = genMoves(pos, [], false), me = pos.side;
  let n = 0;
  for (const m of out) {
    makeMove(pos, m);
    if (!inCheck(pos, me)) n += depth === 1 ? 1 : perft(pos, depth - 1);
    unmakeMove(pos, m);
  }
  return n;
}

// 'mate' | 'stalemate' | null for the side to move
export function gameState(pos) {
  if (legalMoves(pos).length) return null;
  return inCheck(pos) ? 'mate' : 'stalemate';
}

export function material(pos, color) {
  let s = 0; const b = pos.b;
  for (let i = 0; i < 64; i++) { const p = b[i]; if (p && (p >> 5) === color) s += VAL[p & 31]; }
  return s;
}

// ---------- evaluation (side to move perspective) ----------
const CENT = new Int8Array(64);
for (let sq = 0; sq < 64; sq++) { const r = sq >> 3, f = sq & 7; CENT[sq] = Math.round(7 - Math.abs(f - 3.5) - Math.abs(r - 3.5)); }

export function evaluate(pos) {
  const b = pos.b;
  let nonPawn = 0;
  const mat = [0, 0];
  for (let i = 0; i < 64; i++) { const p = b[i]; if (!p) continue; const t = p & 31; mat[p >> 5] += VAL[t]; if (t !== P && t !== K) nonPawn += VAL[t]; }
  const endgame = nonPawn <= 1300;
  const sc = [0, 0];
  for (let sq = 0; sq < 64; sq++) {
    const p = b[sq]; if (!p) continue;
    const c = p >> 5, t = p & 31, rr = c === WHITE ? sq >> 3 : 7 - (sq >> 3), f = sq & 7;
    let v = VAL[t];
    switch (t) {
      case P: v += (rr - 1) * (endgame ? 14 : 7) + (rr >= 5 ? (rr - 4) * 12 : 0) + (f >= 2 && f <= 5 ? 4 : 0); break;
      case N: { v += CENT[sq] * 5 - 12; const tg = KN[sq]; let mob = 0; for (let i = 0; i < tg.length; i++) { const q = b[tg[i]]; if (!q || (q >> 5) !== c) mob++; } v += mob * 2; break; }
      case B: case R: case Q: {
        const d0 = t === B ? 4 : 0, d1 = t === R ? 4 : 8, rays = RAYS[sq]; let mob = 0;
        for (let d = d0; d < d1; d++) { const ray = rays[d]; for (let i = 0; i < ray.length; i++) { const q = b[ray[i]]; if (q) { if ((q >> 5) !== c) mob++; break; } mob++; } }
        v += mob * (t === Q ? 1 : 2) + CENT[sq] * (t === B ? 3 : t === Q ? 2 : 0) + (t === R && rr === 6 ? 15 : 0);
        break;
      }
      case K:
        if (endgame) v += CENT[sq] * 6;
        else {
          v += rr === 0 ? 10 : -12 * rr;
          // pawn shield
          const fwd = c === WHITE ? 8 : -8, own = c << 5 | P;
          for (let df = -1; df <= 1; df++) {
            const ff = f + df; if (ff < 0 || ff > 7) continue;
            const s1 = sq + fwd + df, s2 = s1 + fwd;
            if (s1 >= 0 && s1 < 64 && b[s1] === own) v += 12; else if (s2 >= 0 && s2 < 64 && b[s2] === own) v += 6;
          }
        }
        break;
      default: if (t > 7 && FX) v += FX.evalPiece(b, sq, c, t, endgame);
    }
    sc[c] += v;
  }
  // mop-up: drive a nearly bare king to the edge and bring own king close
  for (let c = 0; c < 2; c++) {
    const o = c ^ 1;
    if (mat[c] - mat[o] >= 400 && mat[o] <= 330 && pos.k[c] >= 0 && pos.k[o] >= 0) {
      const ok = pos.k[o], mk = pos.k[c];
      const dist = Math.max(Math.abs((ok >> 3) - (mk >> 3)), Math.abs((ok & 7) - (mk & 7)));
      sc[c] += (7 - CENT[ok]) * 12 + (7 - dist) * 6;
    }
  }
  let s = sc[0] - sc[1];
  if (FX) s += FX.evalAdjust(b);
  if (pos.m) s += pos.mv;  // forge evalBonus: +15 cp per material tier
  if (EVD) s += doctrineAdj(pos, endgame) - EVB;
  return pos.side === WHITE ? s : -s;
}

// ---------- doctrines: biases on top of the plain eval, for one side (the searching engine) ----------
// trop: bonus per own minor/major piece near the enemy king (attack); ks: own king-safety weight;
// guard: penalty per enemy piece near own king (solid); oppMat: enemy material counts this much more
// (capture greed); ownQ: extra value on own queens ("never trade the queen").
export const DOCTRINES = {
  balanced: { label: 'Balanced', text: 'No bias: plays the position as it is.', trop: 0, ks: 1, guard: 0, oppMat: 1 },
  aggressive: { label: 'Aggressive', text: 'Swarms toward your king; careless of its own.', trop: 6, ks: 0.4, guard: 0, oppMat: 1 },
  solid: { label: 'Solid', text: 'Guards its king; slow to commit.', trop: 0, ks: 2.2, guard: 5, oppMat: 1 },
  greedy: { label: 'Material-hungry', text: 'Grabs and trades whatever it can.', trop: 0, ks: 1, guard: 0, oppMat: 1.22 },
};
export const DOCTRINE_KEYS = ['aggressive', 'solid', 'greedy'];
let EVD = null, EVC = WHITE, EVB = 0; // active doctrine, its color, root baseline (scores stay relative)
function kingTerm(b, sq, c) {
  const rr = c === WHITE ? sq >> 3 : 7 - (sq >> 3), f = sq & 7;
  let v = rr === 0 ? 10 : -12 * rr;
  const fwd = c === WHITE ? 8 : -8, own = c << 5 | P;
  for (let df = -1; df <= 1; df++) {
    const ff = f + df; if (ff < 0 || ff > 7) continue;
    const s1 = sq + fwd + df, s2 = s1 + fwd;
    if (s1 >= 0 && s1 < 64 && b[s1] === own) v += 12; else if (s2 >= 0 && s2 < 64 && b[s2] === own) v += 6;
  }
  return v;
}
const cheb = (a, b) => Math.max(Math.abs((a >> 3) - (b >> 3)), Math.abs((a & 7) - (b & 7)));
// white-perspective adjustment for the active doctrine
function doctrineAdj(pos, endgame) {
  const b = pos.b, me = EVC, op = me ^ 1, mk = pos.k[me], ok = pos.k[op], d = EVD;
  let adj = 0;
  for (let sq = 0; sq < 64; sq++) {
    const p = b[sq]; if (!p) continue;
    const c = p >> 5, t = p & 31;
    if (c === op) {
      if (t !== K) adj -= VAL[t] * (d.oppMat - 1);
      if (d.guard && t !== P && t !== K && mk >= 0) adj -= d.guard * (7 - cheb(sq, mk));
    } else {
      if (t === Q && d.ownQ) adj += d.ownQ;
      if (d.trop && t !== P && t !== K && ok >= 0) adj += d.trop * (7 - cheb(sq, ok));
    }
  }
  if (!endgame && mk >= 0 && d.ks !== 1) adj += (d.ks - 1) * kingTerm(b, mk, me);
  adj = Math.round(adj);
  return me === WHITE ? adj : -adj;
}
// resolve a doctrine key (+ standing orders) to the weights search() uses
export function doctrineWeights(key, keepQueen) {
  const base = DOCTRINES[key] || DOCTRINES.balanced;
  if (!keepQueen && base === DOCTRINES.balanced) return null;
  return Object.assign({}, base, keepQueen ? { ownQ: 450 } : null);
}

// ---------- search ----------
// opt: { maxDepth, timeMs, maxNodes, jitter (cp), rng, history: Map(key->count) }
// opt.doctrine: weights from doctrineWeights() for the side to move at the root (null = plain eval)
export function search(pos, opt = {}) {
  const prev = [EVD, EVC, EVB];
  EVD = opt.doctrine || null; EVC = pos.side; EVB = 0;
  if (EVD) { let np = 0; for (let i = 0; i < 64; i++) { const p = pos.b[i]; if (p && (p & 31) !== P && (p & 31) !== K) np += VAL[p & 31]; } EVB = doctrineAdj(pos, np <= 1300); }
  try { return searchCore(pos, opt); } finally { [EVD, EVC, EVB] = prev; }
}
const SEARCH_HARD = 16;
function searchCore(pos, opt) {
  const maxDepth = opt.maxDepth || 3, qsMax = opt.qsDepth == null ? 40 : opt.qsDepth, rng = opt.rng || Math.random, jitter = opt.jitter || 0;
  const now = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();
  const deadline = now() + (opt.timeMs || 1e9), maxNodes = opt.maxNodes || 1e12;
  let nodes = 0, stop = false, checkStop = false;
  const killers = [];
  const bufs = []; for (let i = 0; i < 64; i++) bufs.push([]);
  const sbufs = []; for (let i = 0; i < 64; i++) sbufs.push([]);

  function order(ms, sc, ply, first) {
    const k = killers[ply] || 0;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i], cap = (m >> 13) & 31;
      let s = 0;
      if (m === first) s = 1e7;
      else if (cap) s = 1e5 + VAL[cap] * (pos.m && CAP_RULES && pos.m[(m >> 6) & 63] === pos.m[m & 63] + 1 ? 7.5 : 10) - VAL[pos.b[m & 63] & 31] / 10; // a counter-able capture is worth 75%
      else if (m === k) s = 9e4;
      if ((m >> 12) & 1) s += 8e4;
      if (m & GATE_BIT) s += 5e4;
      sc[i] = s;
    }
    // insertion sort, descending
    for (let i = 1; i < ms.length; i++) {
      const m = ms[i], s = sc[i]; let j = i - 1;
      while (j >= 0 && sc[j] < s) { ms[j + 1] = ms[j]; sc[j + 1] = sc[j]; j--; }
      ms[j + 1] = m; sc[j + 1] = s;
    }
  }
  // balance pass: depth 1 always completes within its soft budget, but a huge army with deep quiescence (late
  // regions, 15 queens a side) could run depth 1 for minutes; a hard cap at SEARCH_HARD x the budget stops it
  // (the best root move searched so far is kept, else the first legal move)
  const hardDeadline = now() + (opt.timeMs || 1e9) * SEARCH_HARD, hardNodes = maxNodes * SEARCH_HARD;
  function tick() {
    nodes++;
    if ((nodes & 1023) === 0 && (checkStop ? (now() > deadline || nodes > maxNodes) : (now() > hardDeadline || nodes > hardNodes))) stop = true;
    if (checkStop && nodes > maxNodes) stop = true;
  }
  function qs(alpha, beta, ply, qd) {
    tick();
    const stand = evaluate(pos);
    if (stand >= beta || qd >= qsMax || ply > 60) return stand;
    if (stand > alpha) alpha = stand;
    const ms = genMoves(pos, bufs[ply], true), sc = sbufs[ply], me = pos.side;
    order(ms, sc, ply, 0);
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (((m >> 13) & 31) === K) return MATE - ply; // king capture (only from illegal parent)
      makeMove(pos, m);
      if (inCheck(pos, me)) { unmakeMove(pos, m); continue; }
      const v = -qs(-beta, -alpha, ply + 1, qd + 1);
      unmakeMove(pos, m);
      if (stop) return 0;
      if (v >= beta) return v;
      if (v > alpha) alpha = v;
    }
    return alpha;
  }
  function negamax(depth, alpha, beta, ply) {
    const chk = inCheck(pos);
    if (chk && ply < 12) depth++;
    if (depth <= 0) return qs(alpha, beta, ply, 0);
    tick();
    const ms = genMoves(pos, bufs[ply], false), sc = sbufs[ply], me = pos.side;
    order(ms, sc, ply, 0);
    let best = -MATE * 2, legal = 0;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      makeMove(pos, m);
      if (inCheck(pos, me)) { unmakeMove(pos, m); continue; }
      legal++;
      const v = -negamax(depth - 1, -beta, -alpha, ply + 1);
      unmakeMove(pos, m);
      if (stop) return 0;
      if (v > best) best = v;
      if (v > alpha) alpha = v;
      if (alpha >= beta) { if (!((m >> 13) & 31)) killers[ply] = m; break; }
    }
    if (!legal) return chk ? -MATE + ply : 0;
    return best;
  }

  const rootMoves = legalMoves(pos);
  if (!rootMoves.length) return { move: 0, score: inCheck(pos) ? -MATE : 0, depth: 0, nodes: 0 };
  const hist = opt.history;
  const repScore = new Map();
  if (hist) for (const m of rootMoves) {
    makeMove(pos, m); const c = hist.get(posKey(pos)) || 0; unmakeMove(pos, m);
    if (c >= 2) repScore.set(m, 0); else if (c === 1) repScore.set(m, -40);
  }
  let bestMove = rootMoves[0], bestScore = -MATE * 2, doneDepth = 0;
  let scores = new Map();
  const rsc = [];
  for (let d = 1; d <= maxDepth; d++) {
    checkStop = d > 1;
    order(rootMoves, rsc, 0, bestMove);
    let alpha = -MATE * 2, iterBest = 0, iterScore = -MATE * 2;
    const iterScores = new Map();
    for (const m of rootMoves) {
      makeMove(pos, m);
      let v;
      const full = rootMoves.length === 1 ? 0 : -negamax(d - 1, -MATE * 2, -(alpha - jitter), 1);
      v = full;
      if (repScore.has(m)) { const r = repScore.get(m); if (r === 0) { if (v > 0) v = 0; } else v += r; }
      unmakeMove(pos, m);
      if (stop) break;
      iterScores.set(m, v);
      if (v > iterScore) { iterScore = v; iterBest = m; }
      if (v > alpha) alpha = v;
    }
    if (stop) {
      // partial iteration: accept only if its best beats the previous best (best move searched first)
      if (iterBest && iterScore > bestScore && iterBest !== bestMove) { bestMove = iterBest; bestScore = iterScore; }
      break;
    }
    bestMove = iterBest; bestScore = iterScore; scores = iterScores; doneDepth = d;
    if (Math.abs(bestScore) > MATE - 100) break;
    if (rootMoves.length === 1) break;
  }
  if (jitter > 0 && Math.abs(bestScore) < MATE - 100) {
    let pick = bestMove, pv = -Infinity;
    for (const [m, v] of scores) {
      if (v < bestScore - jitter) continue;
      const jv = v + rng() * jitter;
      if (jv > pv) { pv = jv; pick = m; }
    }
    bestMove = pick;
  }
  return { move: bestMove, score: bestScore, depth: doneDepth, nodes };
}

// ---------- seeded rng ----------
export function mulberry(seed) {
  let a = seed >>> 0;
  return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function hash3(a, b, c) { let h = (a * 374761393 + b * 668265263 + c * 2246822519) >>> 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return (h ^ (h >>> 16)) >>> 0; }

// =====================================================================
// GAME LOGIC
// =====================================================================
export const TUNE = {
  enemyBudgetBase: 5, enemyBudgetGrowth: 1.045, // M4: 5 (was 8). Equal engines + one-battle promotions: material is the player's edge now
  // balance pass: budgetCurve legs. Region 1 is unchanged (1.045 below tier 12); regions 2-4 climb at 1.07 per tier
  // (they were walkovers: 99-100% garrison wins in regions 3-5), and past tier 32 the climb eases to 1.024, because the
  // formation's 16 squares and the x1.7 copy prices cap the player's army: a steep late curve became a cliff at region 7
  // (garrisons 48%, seats 4%) instead of a slope
  enemyMidTier: 12, enemyMidGrowth: 1.07, enemyLateTier: 32, enemyLateGrowth: 1.024,
  lootBase: 35,             // loot = lootBase x 1.04^tier x memory bonus (M4: 35, was 10: losses are no longer won back by promotions)
  maxPlies: 140,            // battle length cap; then adjudicated by material
  adjudicateLead: 300,      // centipawns lead needed to win on adjudication
  moveMs: 700,
  memGoldPct: 0.01,         // innate +1% gold per UNSPENT Memory (spent ones buy MEM_SHOP upgrades)
  // balance pass: run payouts are (sumTiers/10)^1.3 / memScale. The world map gives ~20 battles a region, so the old
  // payout (memScale 1) banked ~1000-3000 a run: one run bought the whole shop and the +1% per unspent Memory turned
  // into 10-130x gold. Future runs pay a fifth (the shape, and so the push-or-abdicate ratios, are unchanged); banked
  // Memories are never touched
  memScale: 5,
  mineBase: 3, mineGrowth: 1.035, // gold / minute-equivalent per held mine (x tickSec/60 per tick; M4: 3, was 2). Balance
  // pass: growth 1.06 -> 1.035. Mines are held for the whole run, so at 1.06 they paid 70-95% of all gold and region 6
  // earned 20x region 1 (52k vs 2.6k a region): everything was affordable by region 4
  townDiscount: 0.3,        // linear-road town coupon (balance bot / pre-map saves)
  mapTownDiscount: 0.1,     // world map: 10% shop discount while a town is held or on the frontier
  shrineMineBoost: 1.2,     // shrine blessing: +20% mine income for the rest of the region
  // world time is counted in TICKS: one chess move (either side, any battle) = 1 tick; marches cost ticks
  // per road step. Time passes ONLY from play: no ambient drip on the open map, no catch-up for time away (v6
  // scope). One tick is worth tickSec seconds of the old
  // real-time economy (income per tick = gold/min x tickSec / 60). Offline the world freezes, except a
  // (the world simply waits while you are away).
  tickSec: 3,
  startGold: 90,            // M4: two pawns at once (25 + 43) with change left: the first buys come fast (M3: 60)
  baseIncome: 2,            // gold / minute from the home keep, so a run can always recover
  rampStart: 0.15, rampTiers: 6, // early enemy budget ramp (tier 1 = 15% of formula: K+P, a warm-up; full from tier 6; M3: 45% -> tier 4)
  citadelMult: 1.2,         // citadel budget multiplier (M2: 1.35; the region-1 citadel was a wall on the map)
  midBoost: 0.1, midFrom: 3, midSpan: 5, // +10% enemy budget phased in over tiers 4-8 (map balance pass)
  depth2Tier: 3,            // enemy search depth is at least 2 from this tier (depth-1 captains walk into mate-in-1)
  lossRefundsPrice: true,   // piece prices count copies bought minus copies lost (no death spiral after a bad battle)
  sharpTier: 3,             // from this tier garrisons read capture sequences fully
  jitterEarly: 90, jitter0: 50, jitterDrop: 20, // enemy move noise (cp): 90 at tiers 1-2, 50 at tier 3, -20 per tier after
  // P0-3 decided battles: the enemy yields after resignStreak of its own moves in a row with its search score at or
  // below -resignCp while the player leads by resignMat or more on material (a queen); the player may claim victory
  // on the same measure (one hopeless enemy move is enough), never while their own king is in check
  resignCp: 1000, resignMat: 900, resignStreak: 3,
};

export const PIECE_BASE = { P: 25, N: 80, B: 90, R: 220, Q: 600 };
export function piecePrice(t, bought) { return Math.round(PIECE_BASE[t] * Math.pow(1.7, bought || 0)); }
export function squarePrice(extra) { return Math.round(40 * Math.pow(1.5, extra)); }
export const TACT_MAX = 3;
export function tactPrice(lvl) { return Math.round(60 * Math.pow(4, lvl)); }
export function goldMult(mem) { return 1 + (mem || 0) * TUNE.memGoldPct; }
export function lootFor(tier, mem) { return Math.round(TUNE.lootBase * Math.pow(1.04, tier) * goldMult(mem)); }
export function mineRate(tier) { return TUNE.mineBase * Math.pow(TUNE.mineGrowth, tier); }
// ---- blessings (content.mjs shrine effects): run.blessings = [{kind, v, scope: 'next'|'region'|'run', region}] ----
// A 'region' entry is active while run.map.region === its region; a 'next' entry until world.mjs consumes it
// at the start of the next battle the player fights.
export function blessActive(run, kind) {
  const L = run && run.blessings; if (!Array.isArray(L) || !L.length) return [];
  const reg = run.map ? run.map.region : 1;
  return L.filter(b => b && b.kind === kind && (b.scope !== 'region' || b.region === reg));
}
export function blessSum(run, kind) { let s = 0; for (const b of blessActive(run, kind)) s += +b.v || 0; return s; }
export function blessProd(run, kind) { let p = 1; for (const b of blessActive(run, kind)) p *= +b.v || 1; return p; }
// P0-4 the week clock (world.mjs): the current week's event modifiers ride on run.week.mods
export function weekMod(run, k, dflt) { const w = run && run.week, v = w && w.mods ? w.mods[k] : undefined; return typeof v === 'number' ? v : dflt; }
export function mineMult(run) { return (run.mineBless != null && run.map && run.mineBless === run.map.region ? TUNE.shrineMineBoost : 1) * blessProd(run, 'mineIncomeMult') * weekMod(run, 'mine', 1); }
export function incomePerMin(run, mem) { let m = 0; for (const t of run.mines) m += mineRate(t); return (TUNE.baseIncome + (run.incBonus || 0) + blessSum(run, 'incomeFlat') + weekMod(run, 'inc', 0) + m * mineMult(run)) * goldMult(mem); }
export function memoriesFor(sumTiers) { return sumTiers <= 0 ? 0 : Math.max(1, Math.floor(Math.pow(sumTiers / 10, 1.3) / TUNE.memScale)); }
export function mateMemories(sumTiers) { return Math.floor(memoriesFor(sumTiers) * 0.25); }
export function incomePerTick(run, mem) { return incomePerMin(run, mem) * TUNE.tickSec / 60; }

// ---- elo: one table maps a playing strength to engine settings (both sides use it) ----
// Rows: [elo, maxDepth, qsDepth, timeMs, jitter cp]. Depth and quiescence come from the row at or below
// the elo; time and jitter are interpolated to the next row. Calibrated with balance-bot.mjs part 0.
export const ELO_TABLE = [
  [400, 1, 0, 40, 220],
  [600, 1, 1, 50, 140],
  [800, 2, 1, 60, 90],
  [1000, 2, 3, 70, 70],
  [1200, 3, 3, 80, 60],
  [1350, 3, 6, 110, 30],
  // balance pass: each band step is a real step. The old table gave 1500 the same depth as 1200 (1500 beat 1200
  // only 69%, 1580 beat 1200 61%); now 1500 searches one ply deeper with almost no jitter: 83% over 96 games
  // (900 vs 600 85%, 1200 vs 900 88%; balance-bot.mjs part 0 and BUILD.md "Balance pass")
  [1500, 4, 6, 150, 5],
  [1700, 4, 8, 180, 0],
  [1800, 5, 8, 220, 0],
  [2100, 5, 40, 260, 0],
];
export const ELO_BANDS = [600, 900, 1200, 1500];
// perRegion: opposition drift per region; spread: +/- per node; boss: citadel / rival seat bonus;
// tactStep: each Tactician level plays this much above the opposition (level 0 = equal engines)
export const ELO_TUNE = { def: 900, perRegion: 80, spread: 40, boss: 100, tactStep: 100, min: 400, max: 2200 };
export function cleanElo(e) { e = Math.round(+e); return Number.isFinite(e) ? Math.max(ELO_TUNE.min, Math.min(ELO_TUNE.max, e)) : ELO_TUNE.def; }
export function eloCfg(elo) {
  const T = ELO_TABLE, e = cleanElo(elo);
  let i = 0; while (i < T.length - 1 && T[i + 1][0] <= e) i++;
  const a = T[i], b = T[Math.min(T.length - 1, i + 1)], f = b === a ? 0 : Math.max(0, Math.min(1, (e - a[0]) / (b[0] - a[0])));
  return { maxDepth: a[1], qsDepth: a[2], timeMs: Math.round(a[3] + (b[3] - a[3]) * f), jitter: Math.round(a[4] + (b[4] - a[4]) * f), elo: e };
}
// the opposition's elo in a region (the run's chosen band drifts up per region)
export function regionElo(base, region) { return cleanElo((base == null ? ELO_TUNE.def : base) + ELO_TUNE.perRegion * (Math.max(1, region | 0) - 1)); }
export function tactElo(lvl) { return ELO_TUNE.tactStep * (lvl | 0); }
// the player's Tactician plays at the opposition's elo (+ one step per Tactician level)
export function playerEngineCfg(lvl, orders, oppElo) {
  const c = eloCfg((oppElo == null ? ELO_TUNE.def : oppElo) + tactElo(lvl));
  if (orders) c.doctrine = doctrineWeights(orders.doctrine, orders.keepQueen);
  return c;
}

// ---- dwellings: per piece type, level 0-3; a level gives that type's trait when it is captured ----
// Traits roll only in playMove (a capture that lands on the real board), never inside search.
export const DWELL_MAX = 3;
export const DWELL_BASE = { P: 150, N: 250, B: 250, R: 350, Q: 500 };
export const DWELL_TYPES = ['P', 'N', 'B', 'R', 'Q'];
export const TRAITS = {
  P: { label: 'Stubborn', noun: 'pawn', per: 0.20, text: 'falls back one square toward home (dies if that square is taken)' },
  N: { label: 'Sidestep', noun: 'knight', per: 0.12, text: 'leaps to a random empty knight square' },
  B: { label: 'Faith', noun: 'bishop', per: 0.12, text: 'slips one square along a diagonal, away from the attacker' },
  R: { label: 'Bulwark', noun: 'rook', per: 0.10, text: 'the capture fails: the attacker goes back, its turn spent' },
  Q: { label: 'Majesty', noun: 'queen', per: 0.15, text: 'once per battle, steps to an adjacent empty square' },
};
// polish: exotic pieces ride the dwelling of their classic family at a smaller chance per level (no new dwelling,
// no save field). `how` names the classic trait whose move it borrows (P fall back, N knight square, B diagonal
// slip, R the capture fails, Q adjacent step); 'D' is the champion's own leap two squares straight or diagonal.
export const FAIRY_TRAITS = {
  M: { fam: 'P', how: 'Q', label: 'Rally', noun: 'commoner', per: 0.10, verb: 'step aside', text: 'steps to an adjacent empty square' },
  H: { fam: 'N', how: 'D', label: 'Vault', noun: 'champion', per: 0.06, verb: 'vault clear', text: 'leaps two squares, straight or diagonal, to an empty square' },
  W: { fam: 'B', how: 'B', label: 'Blink', noun: 'wizard', per: 0.06, verb: 'blink away', text: 'slips one square along a diagonal, away from the attacker' },
  C: { fam: 'R', how: 'P', label: 'Recoil', noun: 'cannon', per: 0.05, verb: 'recoil', text: 'rolls back one square toward home (dies if that square is taken)' },
  J: { fam: 'N', how: 'N', label: 'Night ride', noun: 'nightrider', per: 0.06, verb: 'ride off', text: 'leaps to a random empty knight square' },
  A: { fam: 'B', how: 'B', label: 'Sanctuary', noun: 'archbishop', per: 0.06, verb: 'slip away', text: 'slips one square along a diagonal, away from the attacker' },
  E: { fam: 'R', how: 'R', label: 'Parley', noun: 'chancellor', per: 0.05, verb: 'hold', text: 'the capture fails: the attacker goes back, its turn spent' },
};
export function fairyTraitChance(ch, lvl) { const f = FAIRY_TRAITS[ch]; return f ? Math.min(0.95, f.per * (lvl | 0)) : 0; }
export function dwellPrice(t, lvl) { return (lvl | 0) >= DWELL_MAX ? Infinity : Math.round(DWELL_BASE[t] * Math.pow(3, lvl | 0)); }
export function cleanDwell(d) { const o = {}; for (const t of DWELL_TYPES) o[t] = Math.max(0, Math.min(DWELL_MAX, (d && d[t]) | 0)); return o; }
export function traitChance(t, lvl) { return Math.min(0.95, TRAITS[t].per * (lvl | 0)); }
export function buyDwelling(run, t) {
  run.dwell = cleanDwell(run.dwell);
  if (!TRAITS[t] || run.dwell[t] >= DWELL_MAX) return false;
  if (!spend(run, dwellPrice(t, run.dwell[t]))) return false;
  run.dwell[t]++; return true;
}
// enemy trait levels from "dwelling points", handed out round-robin P, N, B, R, Q (each capped at 3)
export function traitLevels(points) {
  const o = cleanDwell(null); let p = Math.max(0, points | 0);
  for (let i = 0; p > 0 && i < 15; i++) { const t = DWELL_TYPES[i % 5]; if (o[t] < DWELL_MAX) { o[t]++; p--; } }
  return o;
}
// ordinary garrisons: one point per 4 tiers after the first 4 (region 1 tiers 5-8: a stubborn pawn line)
export function tierTraits(tier) { return traitLevels(Math.floor((Math.max(1, tier) - 1) / 4)); }
// ---- standing orders for the player's Tactician ----
export const RETREAT_AT = { off: null, cautious: -500, stubborn: -1200 };
export const DEFAULT_ORDERS = { doctrine: 'balanced', keepQueen: false, retreat: 'cautious' };
export function cleanOrders(o) {
  o = Object.assign({}, DEFAULT_ORDERS, o || {});
  if (!DOCTRINES[o.doctrine]) o.doctrine = 'balanced';
  if (!(o.retreat in RETREAT_AT)) o.retreat = 'cautious';
  o.keepQueen = !!o.keepQueen;
  return o;
}

// ---- Memories shop: permanent upgrades bought with Memories (apply to new runs) ----
export const MEM_SHOP = {
  // balance pass: bases doubled (whole shop 733 -> 1466 Memories, about 7 full runs at the new payout scale)
  pawns: { label: 'Militia', unit: 'starting pawn', base: 10, growth: 1.6, max: 5 },
  squares: { label: 'Wider camp', unit: 'starting square', base: 8, growth: 1.5, max: 6 },
  income: { label: 'Keep stores', unit: 'gold/min base', base: 6, growth: 1.45, max: 10 },
  tact: { label: 'Tutored Tactician', unit: 'starting Tactician level', base: 30, growth: 3, max: TACT_MAX },
  gold: { label: 'War chest', unit: '30 starting gold', base: 4, growth: 1.35, max: 10 },
};
export const MEM_KEYS = ['pawns', 'squares', 'income', 'tact', 'gold'];
export function memCost(key, lvl) { const u = MEM_SHOP[key]; return lvl >= u.max ? Infinity : Math.round(u.base * Math.pow(u.growth, lvl)); }
export function cleanUpgrades(up) { const o = {}; for (const k of MEM_KEYS) o[k] = Math.max(0, Math.min(MEM_SHOP[k].max, (up && up[k]) | 0)); return o; }
// a run that hasn't spent, fought or marched yet can be rebuilt with fresh upgrades
export function runPristine(run) { return !run.touched && run.wins === 0 && run.losses === 0 && run.cleared === 0; }
export function buyMemUpgrade(state, key) {
  if (!MEM_SHOP[key]) return false;
  state.upgrades = cleanUpgrades(state.upgrades);
  const c = memCost(key, state.upgrades[key]);
  if (!(state.memories >= c)) return false;
  state.memories -= c; state.upgrades[key]++; state.memSpent = (state.memSpent || 0) + c;
  if (runPristine(state.run)) rebuildRun(state);
  return true;
}
// re-create the (pristine) current run with the current upgrades; keeps seed, orders and accrued gold
export function rebuildRun(state) {
  const old = state.run, extra = Math.max(0, old.gold - (old.startGold ?? TUNE.startGold));
  state.run = newRun(old.seed, state.upgrades, old.orders, state.elo ?? old.elo);
  state.run.gold += extra;
  skillStart(state);
  // the world map of a pristine run is untouched: keep it (garrisons refer to the old roster, so drop them)
  if (old.map) state.run.map = Object.assign({}, old.map, { garrison: {} });
  return state.run;
}
// spec formula 1 + floor(tier/8), cap 4, but at least 2 from TUNE.depth2Tier (map balance: depth-1 captains walk into mate-in-1)
export function enemyDepth(tier, citadel) { return Math.max(tier >= TUNE.depth2Tier ? 2 : 1, Math.min(4, 1 + Math.floor(tier / 8))) + (citadel ? 1 : 0); }
export function enemyEngineCfg(tier, citadel) {
  const d = enemyDepth(tier, citadel);
  // garrison captains only see short capture sequences at low tiers (quiescence depth = search depth)
  return { maxDepth: d, qsDepth: tier < TUNE.sharpTier ? 1 : d + 2, timeMs: 60, jitter: tier <= 2 ? TUNE.jitterEarly : Math.max(0, Math.round(TUNE.jitter0 - TUNE.jitterDrop * (tier - 3))) };
}

// ---- road ----
export const BOSSES = ['Baron Vell of Greywatch', 'The Ash Margravine', 'Ser Ondric the Unmoved', 'Queen Ysolde of Thorns', 'The Lantern Abbot', 'Duke Corvane', 'The Twin Wardens', 'Iron Matriarch Hesk', 'The Pale Chancellor', 'King Morrow the Last'];
export function nodeType(seed, tier) {
  if (tier % 10 === 0) return 'citadel';
  if (tier <= 2) return 'garrison';
  const h = hash3(seed, tier, 11) % 100;
  return h < 22 ? 'mine' : h < 36 ? 'town' : 'garrison';
}
export function bossName(tier) { return BOSSES[(Math.floor(tier / 10) - 1) % BOSSES.length]; }

// Enemy formation templates (black side). King square + ordered slots; filled until the budget runs out.
// Squares use algebraic names from black's side (ranks 8,7,6).
export const FORMATIONS = [
  { name: 'Pawn Wall', k: 'e8', s: 'Pe7 Pd7 Pf7 Pc7 Pg7 Pb7 Nb8 Ng8 Ph7 Pa7 Bc8 Bf8 Ra8 Rh8 Qd8' },
  { name: 'Knight Rush', k: 'e8', s: 'Nc6 Nf6 Pe7 Pd7 Pf7 Pc7 Bf8 Bc8 Pg7 Pb7 Ra8 Rh8 Qd8 Ph7 Pa7' },
  { name: 'Rook Line', k: 'g8', s: 'Rd8 Pf7 Pg7 Ph7 Re8 Pe7 Pd7 Pc7 Nb8 Bc8 Pb7 Pa7 Qa8 Nh8 Bf8' },
  { name: 'Bishop Pair', k: 'e8', s: 'Bc8 Bf8 Pd7 Pe7 Pf7 Pc7 Nd8 Pg7 Pb7 Rh8 Ra8 Ph7 Pa7 Qb8 Ng8' },
  { name: 'Phalanx', k: 'e8', s: 'Pd6 Pe6 Pc7 Pf7 Bd7 Be7 Pb7 Pg7 Nc8 Nf8 Ra8 Rh8 Pa7 Ph7 Qd8' },
  { name: 'Left Hook', k: 'g8', s: 'Pf7 Pg7 Ph7 Nb6 Pa6 Pb7 Nc6 Bb8 Ra8 Pc7 Pd7 Qc8 Re8 Pe7 Bd8' },
  { name: 'Hedgehog', k: 'e8', s: 'Pd6 Pe6 Pc6 Pf6 Pb6 Pg6 Nd7 Ne7 Pa7 Ph7 Bc8 Bf8 Rd8 Rg8 Qa8' },
  { name: 'Cavalry', k: 'd8', s: 'Nb8 Ng8 Nc6 Pd7 Pc7 Pe7 Nf6 Pb7 Pf7 Ra8 Rh8 Pa7 Pg7 Ph7 Qe8' },
  { name: 'Fortress', k: 'g8', s: 'Pf7 Pg7 Ph7 Ra8 Rf8 Pe7 Pd7 Pc7 Nd8 Ne8 Pb7 Pa7 Bc8 Bb8 Qh8' },
  { name: 'Skirmishers', k: 'e8', s: 'Nc6 Pe7 Bf6 Pd7 Pc5 Pf7 Nh6 Pb7 Bb6 Pg7 Ra8 Rh8 Pa7 Ph7 Qd8' },
  { name: "Queen's Court", k: 'e8', citadel: true, s: 'Qd8 Pd7 Pe7 Pf7 Bc8 Bf8 Nb8 Ng8 Pc7 Pg7 Pb7 Ph7 Ra8 Rh8 Pa7' },
  { name: 'Iron Crown', k: 'e8', citadel: true, s: 'Ra8 Rh8 Pd7 Pe7 Qd8 Pf7 Pc7 Nb8 Ng8 Bc8 Bf8 Pg7 Pb7 Ph7 Pa7' },
];
export function parseSq(s) { return (s.charCodeAt(0) - 97) + (parseInt(s.slice(1), 10) - 1) * 8; }

export function enemyBudget(tier, type) {
  const mult = type === 'citadel' ? TUNE.citadelMult : type === 'mine' ? 0.85 : type === 'town' ? 0.9 : type === 'shrine' ? 0.85 : 1;
  // early-road ramp so the 3-pawn starting army has a fair first few fights
  const ramp = tier < TUNE.rampTiers ? TUNE.rampStart + (1 - TUNE.rampStart) * (tier - 1) / (TUNE.rampTiers - 1) : 1;
  // mid-region-1 step-up (tiers 4-8): the world map gives many more early battles than the road did
  const mid = 1 + TUNE.midBoost * Math.max(0, Math.min(1, (tier - TUNE.midFrom) / TUNE.midSpan));
  return TUNE.enemyBudgetBase * budgetCurve(tier) * mult * ramp * mid;
}
// balance pass: the growth per tier in three legs: enemyBudgetGrowth below enemyMidTier (region 1 as before), enemyMidGrowth
// up to enemyLateTier (regions 2-5: the pressure rises), then enemyLateGrowth (the formation's 16 squares cap the
// player's army, so late regions climb gently into the wall instead of hitting it at once)
export function budgetCurve(tier) {
  const a = Math.min(tier, TUNE.enemyMidTier), b = Math.max(0, Math.min(tier, TUNE.enemyLateTier) - TUNE.enemyMidTier), c = Math.max(0, tier - Math.max(TUNE.enemyMidTier, TUNE.enemyLateTier));
  return Math.pow(TUNE.enemyBudgetGrowth, a) * Math.pow(TUNE.enemyMidGrowth, b) * Math.pow(TUNE.enemyLateGrowth, c);
}
// returns { name, formation, boss, pieces: [{sq, t}] } (t as letter); king included
// opt (world map): { type, key } overrides the linear-road node type and the formation pick.
// opt.budget overrides the budget (raids)
export function enemyArmy(seed, tier, opt) {
  const type = opt && opt.type ? opt.type : nodeType(seed, tier);
  const norm = FORMATIONS.filter(f => !f.citadel), cit = FORMATIONS.filter(f => f.citadel);
  const fk = opt && opt.key != null ? opt.key : tier;
  // opt.formation (M5): an engine-shape formation {name, k, s} from the content pack (world.mjs picks it)
  const fm = opt && opt.formation ? opt.formation : type === 'citadel' ? cit[Math.max(0, Math.floor(tier / 10) - 1) % cit.length] : norm[hash3(seed, fk, 7) % norm.length];
  let budget = opt && opt.budget != null ? opt.budget : enemyBudget(tier, type);
  const slots = fm.s.split(' ').map(x => ({ t: x[0], sq: parseSq(x.slice(1)) }));
  const out = [{ sq: parseSq(fm.k), t: 'K' }];
  const unused = [];
  for (const sl of slots) {
    const v = UNITS[sl.t];
    if (v <= budget + 0.5) { out.push({ sq: sl.sq, t: sl.t }); budget -= v; }
    else if (budget >= 0.5) {
      // fill with a pawn-valued stand-in when a slot is too expensive (keeps the shape)
      if (budget >= 3 - 0.5 && (sl.t === 'R' || sl.t === 'Q')) { out.push({ sq: sl.sq, t: 'N' }); budget -= 3; }
      else unused.push(sl);
    } else unused.push(sl);
  }
  for (const sl of unused) if (budget >= 0.5) { out.push({ sq: sl.sq, t: 'P' }); budget -= 1; }
  // upgrade pass for very high tiers
  const up = { P: ['N', 2], N: ['R', 2], B: ['R', 2], R: ['Q', 4] };
  let changed = true;
  while (budget >= 2 && changed) {
    changed = false;
    for (const pc of out) {
      if (pc.t === 'P' && ((pc.sq >> 3) === 0 || (pc.sq >> 3) === 7)) continue;
      const u = up[pc.t]; if (!u || budget < u[1] - 0.25) continue;
      pc.t = u[0]; budget -= u[1]; changed = true; if (budget < 2) break;
    }
  }
  return { type, name: fm.name, boss: type === 'citadel' ? bossName(tier) : null, pieces: out };
}
export function armyUnits(pieces) { let s = 0; for (const p of pieces) s += UNITS[p.t]; return s; }

// ---- run / state ----
export const START_SQUARES = ['e1', 'd2', 'e2', 'f2'];
export const SQUARE_ORDER = ['c2', 'g2', 'd1', 'f1', 'b2', 'h2', 'c1', 'g1', 'a2', 'b1', 'a1', 'h1'];
// up: Memories-shop levels (cleanUpgrades); orders: standing orders carried over from the last run
// elo: the opposition band chosen for this run (ELO_BANDS); the Tactician plays at the same elo
export function newRun(seed, up, orders, elo) {
  up = cleanUpgrades(up);
  const startGold = TUNE.startGold + 30 * up.gold;
  const run = {
    seed: seed >>> 0, tier: 1, sumTiers: 0, cleared: 0, gold: startGold, startGold, mines: [], discounts: 0, tact: up.tact,
    bought: { P: 0, N: 0, B: 0, R: 0, Q: 0 }, squaresBought: 0, incBonus: up.income,
    owned: START_SQUARES.concat(SQUARE_ORDER.slice(0, up.squares)).map(parseSq), roster: [], formation: {}, nextId: 1,
    wins: 0, losses: 0, startedAt: 0, log: [], orders: cleanOrders(orders), touched: false,
    elo: cleanElo(elo), dwell: cleanDwell(null), battles: 0,
    ticks: 0, blessings: [], memBonus: 0, forge: null, // M5: world ticks this run (forge clock), shrine effects
  };
  const add = t => { const id = run.nextId++; run.roster.push({ id, t }); return id; };
  run.formation[parseSq('e1')] = add('K');
  run.formation[parseSq('d2')] = add('P');
  run.formation[parseSq('e2')] = add('P');
  run.formation[parseSq('f2')] = add('P');
  for (let i = 0; i < up.pawns; i++) {
    const id = add('P'), free = run.owned.filter(sq => run.formation[sq] == null).sort((a, b) => (b >> 3) - (a >> 3) || Math.abs((a & 7) - 3.5) - Math.abs((b & 7) - 3.5));
    if (free.length) run.formation[free[0]] = id;
  }
  return run;
}
// v2: world map (run.map) + shrine blessing. v3: Memories shop (state.upgrades), standing orders (run.orders),
// raids + garrisons (run.map.raid / run.map.garrison). v4: the living rival (run.map.rival), dwellings
// (run.dwell), elo bands (state.elo, run.elo). v5: forge (run.forge, run.ticks), blessings (run.blessings,
// run.memBonus), lords/caches/scouting on run.map, cosmetics (state.cosmetics). Older saves are migrated by
// world.mjs migrateState().
export const SAVE_VERSION = 6; // v6: piece codes color << 5 | type (fairy pieces), state.fairy, run.gates / run.fbought
export function newState(now, seed, elo) {
  const e = cleanElo(elo ?? ELO_TUNE.def);
  const st = { v: SAVE_VERSION, memories: 0, memSpent: 0, upgrades: cleanUpgrades(), totalRuns: 0, bestTier: 1, elo: e, eloPicked: false, run: newRun(seed ?? (now >>> 0), null, null, e), lastTs: now, settings: { theme: 'auto', sound: true, speed: 1 },
    bestRegion: 1, seats: 0, cosmetics: { unlocked: ['classic'], set: 'classic', forged: [] }, skills: SKM ? SKM.newSkills() : null };
  skillStart(st);
  return st;
}
// after every newRun (newState, endRun, rebuildRun): the skills' free starting pieces (once per run) + the derived price cache
// v6: world.mjs registers a run-start hook (fairy unlocks are account-level; the run keeps a synced copy)
let RUN_HOOK = null;
export function setRunHook(fn) { RUN_HOOK = fn || null; }
export function skillStart(state) {
  if (RUN_HOOK) RUN_HOOK(state);
  if (!SKM) return state.run;
  state.skills = SKM.cleanSkills(state.skills);
  SKM.grantStart(state.run, state.skills);
  state.run.skillMods = SKM.skillMods(state.skills);
  return state.run;
}
export function placedIds(run) { return new Set(Object.values(run.formation)); }
// pieces stationed at mines (world map garrisons) are neither in the formation nor in the reserve
export function garrisonedIds(run) {
  const s = new Set(), g = run.map && run.map.garrison;
  if (g) for (const k in g) for (const id of g[k]) s.add(id);
  return s;
}
export function reserve(run) { const p = placedIds(run), g = garrisonedIds(run); return run.roster.filter(r => !p.has(r.id) && !g.has(r.id)); }
export function pieceById(run, id) { return run.roster.find(r => r.id === id); }

function spend(run, cost) {
  const c = effPrice(run, cost);
  if (run.gold < c) return false;
  run.touched = true;
  run.gold -= c; if (run.discounts > 0) run.discounts--;
  return true;
}
// a one-shot linear-road coupon (30%) wins over the map's standing town discount (run.shopDisc, 10%)
export function effPrice(run, cost) { return run.discounts > 0 ? Math.round(cost * (1 - TUNE.townDiscount)) : run.shopDisc > 0 ? Math.round(cost * (1 - run.shopDisc)) : cost; }
// M6 skills: the per-type skill discount applies to the BASE price, before the town/blessing effPrice (they multiply).
// run.skillMods = SK.skillMods(state.skills) is refreshed at run start, on load and after every XP award.
export function pieceCost(run, t) { const sm = run.skillMods || {}; return Math.round(piecePrice(t, run.bought[t]) * (1 - (sm[t] || 0))); }
export function squareCost(run) { const sm = run.skillMods || {}; return Math.round(squarePrice(run.squaresBought) * (1 - (sm.sq || 0))); }
export function buyPiece(run, t) {
  if (!spend(run, pieceCost(run, t))) return null;
  run.bought[t]++;
  const id = run.nextId++; run.roster.push({ id, t });
  // auto-place on a free owned square (pawns prefer rank 2)
  const free = run.owned.filter(sq => run.formation[sq] == null).sort((a, b) => t === 'P' ? (b >> 3) - (a >> 3) : (a >> 3) - (b >> 3));
  if (free.length) run.formation[free[0]] = id;
  return id;
}
export function buySquare(run, sq) {
  if (sq < 0 || sq > 15 || run.owned.includes(sq)) return false;
  if (!spend(run, squareCost(run))) return false;
  run.squaresBought++; run.owned.push(sq);
  const res = reserve(run); if (res.length) run.formation[sq] = res[0].id;
  return true;
}
export function buyTact(run) {
  if (run.tact >= TACT_MAX) return false;
  if (!spend(run, tactPrice(run.tact))) return false;
  run.tact++; return true;
}
// formation edit: place id on sq (owned). Swaps if occupied. King can't be removed.
export function placePiece(run, id, sq) {
  if (!run.owned.includes(sq)) return false;
  const cur = Object.keys(run.formation).find(k => run.formation[k] === id);
  const occ = run.formation[sq];
  if (cur != null) delete run.formation[cur];
  run.formation[sq] = id;
  if (occ != null && occ !== id) { if (cur != null) run.formation[cur] = occ; }
  return true;
}
export function unplace(run, sq) {
  const id = run.formation[sq]; if (id == null) return false;
  if (pieceById(run, id).t === 'K') return false;
  delete run.formation[sq]; return true;
}

// ---- battle ----
// army (optional, world map): an enemyArmy() result carrying .tier (and .mapId); default = linear road at run.tier
//   army.elo: the opposition's elo (default: the run's band + region drift); army.traits: enemy trait levels
//   army.seed: battle seed for trait rolls (default: derived from the run seed and its battle count)
// whites (optional, raid defence): [{sq, id, t}] used instead of the formation (id 0 = a castellan, not on the roster)
export function createBattle(run, army, whites) {
  const tier = army ? army.tier : run.tier;
  army = army || enemyArmy(run.seed, tier);
  const pos = emptyPos();
  const ids = new Int32Array(64).fill(-1);
  if (whites) for (const w of whites) { setPiece(pos, w.sq, WHITE, CH_TYPE[w.t]); ids[w.sq] = w.id; }
  else for (const [sq, id] of Object.entries(run.formation)) { const pc = pieceById(run, id); setPiece(pos, +sq, WHITE, CH_TYPE[pc.t]); ids[+sq] = id; }
  // enemy pieces get ids -2, -3, ... (stable keys for the UI); -1 = empty
  army.pieces.forEach((pc, i) => { setPiece(pos, pc.sq, BLACK, CH_TYPE[pc.t]); ids[pc.sq] = -2 - i; });
  // materials (forge): roster pieces from run.forge.mats (by id), enemy pieces from army.pieces[i].m (tier)
  const mats = run.forge && run.forge.mats, mt = new Int8Array(64); let anyMat = false;
  for (let sq = 0; sq < 64; sq++) {
    const id = ids[sq]; if (id === -1 || !pos.b[sq]) continue;
    const t = id >= 0 ? (mats ? matTier(mats[id]) : 0) : (army.pieces[-id - 2].m | 0);
    if (t) { mt[sq] = t; anyMat = true; }
  }
  if (anyMat) attachMats(pos, mt);
  pos.side = WHITE;
  // a slider could already be checking the enemy king; then the garrison moves first
  if (inCheck(pos, BLACK)) pos.side = BLACK;
  const history = new Map(); history.set(posKey(pos), 1);
  run.battles = (run.battles | 0) + 1;
  const elo = army.elo != null ? cleanElo(army.elo) : cleanElo(regionElo(run.elo, Math.floor((tier - 1) / 10) + 1) + (army.type === 'citadel' ? ELO_TUNE.boss : 0));
  const seed = army.seed != null ? army.seed >>> 0 : hash3(run.seed >>> 0, run.battles, (army.mapId ?? tier) + 7);
  return { tier, node: army, pos, ids, history, plies: 0, last: 0, lost: [], over: null,
    elo, seed, traits: [cleanDwell(run.dwell), cleanDwell(army.traits)], maj: [0, 0], tlog: [], lastTrait: null,
    terrain: army.terrain || null, tactElo: 0, lastCounter: null, hope: 0, fx: fairyKey(pos), gated: [] };
}
// v6: seat waiting gated pieces on a fresh battle (world.mjs gatesFor); the start key and the fairy set follow
export function battleGates(battle, gates) {
  if (!gates || !gates.length) return battle;
  const pos = battle.pos; setGates(pos, gates);
  battle.history = new Map([[posKey(pos), 1]]); battle.fx = fairyKey(pos);
  return battle;
}
export function battleEngineCfg(run, battle, color) {
  const elo = battle.elo != null ? battle.elo : regionElo(run.elo, 1);
  if (color === WHITE) return playerEngineCfg(run.tact, run.orders, elo + (battle.tactElo | 0)); // + shrine Tactician blessings
  const c = eloCfg(elo);
  c.doctrine = doctrineWeights(battle.node.doctrine);
  return c;
}
// ---- traits: rolled when a capture lands (seeded by battle seed + ply, so replays are stable) ----
// traitCheck(battle, m) -> null | { type, color, lvl, chance, label, noun } : the roll this capture would make
export function traitCheck(battle, m) {
  const cap = mCap(m); if (!cap || !battle.traits) return null;
  const t = TYPE_CH[cap & 31], c = cap >> 5; if (t === 'K') return null;
  const fy = FAIRY_TRAITS[t];
  if (fy) { const l = (battle.traits[c] && battle.traits[c][fy.fam]) | 0; return l ? { type: t, how: fy.how, color: c, lvl: l, chance: fairyTraitChance(t, l), label: fy.label, noun: fy.noun } : null; }
  if (!TRAITS[t]) return null;
  const lvl = (battle.traits[c] && battle.traits[c][t]) | 0; if (!lvl) return null;
  if (t === 'Q' && battle.maj && battle.maj[c]) return null;
  return { type: t, color: c, lvl, chance: traitChance(t, lvl), label: TRAITS[t].label, noun: TRAITS[t].noun };
}
export function traitRoll(battle, salt) { return hash3(battle.seed >>> 0, battle.plies, salt) / 4294967296; }
// a trait's mechanic: the classic type's own, or (exotic pieces) the one it borrows
const trHow = tr => tr.how || tr.type;
export function traitAnnounce(tr) { return `${tr.label} ${tr.noun}: ${Math.round(tr.chance * 100)}% to ${FAIRY_TRAITS[tr.type] ? FAIRY_TRAITS[tr.type].verb : TRAIT_VERB[tr.type]}`; }
const TRAIT_VERB = { P: 'fall back', N: 'sidestep', B: 'slip away', R: 'hold', Q: 'step aside' };
export function traitResultText(tr) {
  const head = traitAnnounce(tr) + '... ';
  if (!tr.ok) return head + (trHow(tr) === 'R' ? 'breached.' : 'taken.');
  if (tr.blocked) return head + (trHow(tr) === 'P' ? 'the way back is blocked, it falls.' : 'no safe square, taken.');
  return head + 'saved!' + (tr.sq >= 0 ? ` (to ${sqName(tr.sq)})` : '');
}
// where a saved victim goes, on the board AFTER the capture (attacker on `to`, its origin now empty); -1 = nowhere
function traitDest(battle, m, tr) {
  const b = battle.pos.b, from = mFrom(m), to = mTo(m);
  const empty = q => q >= 0 && q < 64 && !b[q] && !WALL[q], how = trHow(tr);
  if (how === 'D') {
    // the champion's vault: two squares straight or diagonal (a jump), on the board, empty
    const r0 = to >> 3, f0 = to & 7, opts = [];
    for (const [a, c] of [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [2, -2], [-2, 2], [-2, -2]]) { const r = r0 + a, f = f0 + c; if (r >= 0 && r < 8 && f >= 0 && f < 8 && empty(r * 8 + f)) opts.push(r * 8 + f); }
    return opts.length ? opts[Math.floor(traitRoll(battle, 202) * opts.length)] : -1;
  }
  if (how === 'P') {
    const q = to + (tr.color === WHITE ? -8 : 8);
    return empty(q) ? q : -1;
  }
  if (how === 'N' || how === 'Q') {
    const opts = (how === 'N' ? KN[to] : KG[to]).filter(empty);
    return opts.length ? opts[Math.floor(traitRoll(battle, 202) * opts.length)] : -1;
  }
  if (how === 'B') {
    // away from the attacker: the diagonal(s) pointing most along (to - from); ties broken by the seeded roll
    const dr = (to >> 3) - (from >> 3), df = (to & 7) - (from & 7);
    const diag = [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([a, c]) => ({ a, c, dot: a * dr + c * df })).filter(d => d.dot > 0);
    const flip = traitRoll(battle, 303) < 0.5;
    diag.sort((x, y) => y.dot - x.dot || (flip ? 1 : -1));
    for (const d of diag) {
      const r = (to >> 3) + d.a, f = (to & 7) + d.c;
      if (r >= 0 && r < 8 && f >= 0 && f < 8 && empty(r * 8 + f)) return r * 8 + f;
    }
    return -1;
  }
  return -1;
}
// ---- forge counter rule (M5): a capture onto a piece exactly one material tier above the attacker can fail
// (forge.mjs counterCheck, 25%); the attacker then stops at captureFallback() and its turn is spent.
// Check rule: no roll at all when the failed capture would leave the mover's king attacked (the capture is
// the only way out of check, or the fallback square exposes the king): the capture simply lands.
// Seeded by battle seed + ply (salt 404), like traits; search() never sees it.
export const PIECE_NOUN = { P: 'pawn', N: 'knight', B: 'bishop', R: 'rook', Q: 'queen', K: 'king' };
export function counterInfo(battle, m) {
  const pos = battle.pos, cap = mCap(m);
  if (!CAP_RULES || !pos.m || !cap) return null;
  const from = mFrom(m), to = mTo(m), at = pos.m[from], tt = pos.m[to];
  if (tt !== at + 1) return null;
  const S = pos.side, b = pos.b, pc = b[from];
  const fb = CAP_RULES.fallback({ from, to, piece: pc & 31 }, 8, q => !!WALL[q] || (q !== from && !!b[q]));
  let unsafe;
  if (fb === from) unsafe = isAttacked(b, pos.k[S], S ^ 1);
  else { b[fb] = pc; b[from] = 0; unsafe = isAttacked(b, (pc & 31) === K ? fb : pos.k[S], S ^ 1); b[from] = pc; b[fb] = 0; }
  if (unsafe) return null;
  const chance = CAP_RULES.counter(MAT_KEYS[at], MAT_KEYS[tt], () => 1).chance;
  return { from, to, fb, att: MAT_KEYS[at], tgt: MAT_KEYS[tt], attType: TYPE_CH[pc & 31], tgtType: TYPE_CH[cap & 31], chance, side: S };
}
const capWord = w => w[0].toUpperCase() + w.slice(1);
export function counterAnnounce(ci) { return `${capWord(ci.att)} ${PIECE_NOUN[ci.attType]} strikes ${/^[aeiou]/.test(ci.tgt) ? 'an' : 'a'} ${ci.tgt} ${PIECE_NOUN[ci.tgtType]}: ${Math.round(ci.chance * 100)}% the blow glances off`; }
export function counterResultText(ci) {
  if (ci.warded) return counterAnnounce(ci) + '... warded: the blow cannot glance off, the capture lands.';
  return counterAnnounce(ci) + `... roll ${ci.roll.toFixed(2)} ${ci.fails ? '<' : '\u2265'} ${ci.chance.toFixed(2)}: ` + (ci.fails ? `the capture fails${ci.fb !== ci.from ? ` (stops on ${sqName(ci.fb)})` : ''}.` : 'the capture lands.');
}
// apply a (legal) move to the battle, tracking roster ids & captures; resolves a capture trait if one applies.
// Edge rule: a trait only takes effect when the capturing side's king is not left attacked afterwards
// (the position must stay one where the side to move cannot take a king); otherwise the capture stands.
export function playMove(battle, m) {
  useTerrain(battle.terrain); useFairy(battle);
  const from = mFrom(m), to = mTo(m), cap = mCap(m), pos = battle.pos, S = pos.side;
  const ci = counterInfo(battle, m);
  battle.lastCounter = null;
  if (battle.moves) battle.moves.push(m); // M6 rewind: battles are deterministic from (start, seed, moves)
  if (ci) {
    const r = CAP_RULES.counter(ci.att, ci.tgt, () => traitRoll(battle, 404));
    Object.assign(ci, { roll: r.roll, fails: r.fails, chance: r.chance, ply: battle.plies });
    // M6 traitWard (discovery artifact, e.g. the Obsidian Chip): the player's first wardMax counter rolls each battle cannot fail
    if (S === WHITE && (battle.ward | 0) < (battle.wardMax | 0)) { battle.ward = (battle.ward | 0) + 1; ci.warded = true; ci.fails = false; }
    battle.lastCounter = ci; if (battle.tlog) battle.tlog.push(counterResultText(ci));
    if (ci.fails) {
      if (ci.fb !== from) {
        pos.b[ci.fb] = pos.b[from]; pos.b[from] = 0; pos.m[ci.fb] = pos.m[from]; pos.m[from] = 0;
        battle.ids[ci.fb] = battle.ids[from]; battle.ids[from] = -1;
        // the bounced attacker still left its square: a gate move drops its piece there, otherwise the right lapses
        if (pos.g && pos.g.length) {
          const gt = pos.g.find(x => x.color === S && x.sq === from);
          if (gt && (m & GATE_BIT)) { pos.b[from] = S << 5 | gt.t; pos.m[from] = gt.mt | 0; battle.ids[from] = gt.id; recalcMv(pos); }
          if (gt) pos.g = pos.g.filter(x => x !== gt);
        }
      }
      pos.side ^= 1; battle.plies++; battle.last = ci.fb !== from ? (from | ci.fb << 6) : 0; battle.lastTrait = null;
      const k = posKey(pos); battle.history.set(k, (battle.history.get(k) || 0) + 1);
      battle.over = battleStatus(battle);
      return battle.over;
    }
  }
  const info = traitCheck(battle, m);
  let tr = null;
  if (info) {
    const roll = traitRoll(battle, 101);
    tr = Object.assign(info, { roll, ok: roll < info.chance, blocked: false, sq: -1, ply: battle.plies, side: S });
  }
  if (tr && tr.ok && trHow(tr) === 'R') {
    // Bulwark: nothing moves, the attacker's turn is spent
    if (isAttacked(pos.b, pos.k[S], S ^ 1)) tr.blocked = true;
    else {
      pos.side ^= 1;
      battle.plies++; battle.last = 0;
      battle.lastTrait = tr; if (battle.tlog) battle.tlog.push(traitResultText(tr));
      const k = posKey(pos); battle.history.set(k, (battle.history.get(k) || 0) + 1);
      battle.over = battleStatus(battle);
      return battle.over;
    }
  }
  const victimId = battle.ids[to], vmat = pos.m ? pos.m[to] : 0;
  const gate = (m & GATE_BIT) && pos.g ? pos.g.find(x => x.color === S && x.sq === from) : null;
  battle.ids[to] = battle.ids[from]; battle.ids[from] = gate ? gate.id : -1;
  makeMove(pos, m);
  if (pos.m) pos.mp = 0; // real moves are never unmade
  if (pos.gs) pos.gs.length = 0;
  if (gate) { battle.gated = (battle.gated || []).concat([gate.id]); if (battle.tlog) battle.tlog.push(`${capWord(PIECE_NOUN[TYPE_CH[gate.t]] || 'piece')} enters through ${sqName(from)}`); }
  let saved = false;
  if (tr && tr.ok && trHow(tr) !== 'R') {
    const dest = traitDest(battle, m, tr);
    if (dest < 0) tr.blocked = true;
    else {
      pos.b[dest] = cap;
      if (isAttacked(pos.b, pos.k[S], S ^ 1)) { pos.b[dest] = 0; tr.blocked = true; }
      else { saved = true; tr.sq = dest; battle.ids[dest] = victimId; if (pos.m) { pos.m[dest] = vmat; recalcMv(pos); } if (tr.type === 'Q' && battle.maj) battle.maj[tr.color] = 1; }
    }
  }
  if (cap && (cap >> 5) === WHITE && victimId >= 0 && !saved) battle.lost.push(victimId);
  if (tr) { battle.lastTrait = tr; if (battle.tlog) battle.tlog.push(traitResultText(tr)); }
  else battle.lastTrait = null;
  battle.plies++; battle.last = m;
  const k = posKey(pos); battle.history.set(k, (battle.history.get(k) || 0) + 1);
  battle.over = battleStatus(battle);
  return battle.over;
}
function onlyKing(pos, c) { for (let i = 0; i < 64; i++) { const p = pos.b[i]; if (p && (p >> 5) === c && (p & 31) !== K) return false; } return true; }
// result: 'win' | 'mate' (player mated: run over) | 'loss' (routed) | 'draw'
export function battleStatus(battle) {
  const pos = battle.pos, gs = gameState(pos);
  if (gs === 'mate') return pos.side === WHITE ? { result: 'mate', reason: 'Checkmate' } : { result: 'win', reason: 'Checkmate' };
  if (gs === 'stalemate') return { result: 'draw', reason: 'Stalemate' };
  if (onlyKing(pos, BLACK)) return { result: 'win', reason: 'Garrison surrendered' };
  if (onlyKing(pos, WHITE)) return { result: 'loss', reason: 'Army routed' };
  const rep = (battle.history.get(posKey(pos)) || 0) >= 3;
  if (rep || battle.plies >= TUNE.maxPlies) {
    // threefold repetition or the move cap: the side clearly ahead on material holds the field
    const d = material(pos, WHITE) - material(pos, BLACK);
    if (d >= TUNE.adjudicateLead) return { result: 'win', reason: 'Field held' };
    if (d <= -TUNE.adjudicateLead) return { result: 'loss', reason: 'Field lost' };
    return { result: 'draw', reason: rep ? 'Repetition' : 'Stalemated front' };
  }
  return null;
}
// choose a move for the side to move; returns {move, score, retreat}
// legal moves of the side to move in a battle, on that battle's terrain
export function battleLegal(battle) { useTerrain(battle.terrain); useFairy(battle); return legalMoves(battle.pos); }
export function thinkMove(run, battle, extra = {}) {
  useTerrain(battle.terrain); useFairy(battle);
  const color = battle.pos.side;
  const cfg = Object.assign({}, battleEngineCfg(run, battle, color), { history: battle.history }, extra);
  const r = search(battle.pos, cfg);
  const at = RETREAT_AT[(run.orders || DEFAULT_ORDERS).retreat];
  r.retreat = color === WHITE && at != null && r.score <= at && !(battle.node && battle.node.noRetreat);
  // P0-3: the enemy's own search keeps the "hopeless" streak; r.resign = it yields instead of moving
  if (color === BLACK && !extra.noYield) { noteEnemyEval(battle, r.score); r.resign = enemyYields(battle); }
  return r;
}
// ---- P0-3 decided battles: resignation and claim victory (same measure both ways) ----
export function matLead(pos) { return material(pos, WHITE) - material(pos, BLACK); }
// a forced mate the enemy sees is left to play out (the mating piece earns its skill XP); a lone forced reply
// (search score 0 by convention) holds the streak; a real recovery or a closing material gap resets it
export function noteEnemyEval(battle, score) {
  const lead = matLead(battle.pos);
  if (lead < TUNE.resignMat) { battle.hope = 0; return 0; }
  if (score <= -(MATE - 1000)) return battle.hope | 0;
  if (score <= -TUNE.resignCp) battle.hope = (battle.hope | 0) + 1;
  else if (!(score === 0 && battleLegal(battle).length === 1)) battle.hope = 0;
  return battle.hope | 0;
}
export function enemyYields(battle) { return !battle.over && (battle.hope | 0) >= TUNE.resignStreak && matLead(battle.pos) >= TUNE.resignMat; }
// claim victory: the enemy's last own search already called it hopeless, the player still leads by a queen or more,
// and the player's king is not in check. Returns false or true (never mutates).
export function canClaim(battle) {
  return !!battle && !battle.over && (battle.hope | 0) >= 1 && matLead(battle.pos) >= TUNE.resignMat && !inCheck(battle.pos, WHITE);
}
// ends a decided battle as a win without a move (no tick); reason 'Yielded' (the enemy resigned) or 'Victory claimed'
export function yieldBattle(battle, reason) {
  if (!battle || battle.over) return null;
  battle.over = { result: 'win', reason: reason || 'Yielded' };
  if (battle.tlog) battle.tlog.push(reason === 'Victory claimed' ? 'You claim the field: the enemy cannot recover' : 'The enemy yields the field');
  return battle.over;
}
// apply a battle's losses to the roster/formation (garrisons are cleaned by world.mjs).
// M4: promotion is TEMPORARY. A pawn that promotes fights as a queen for the rest of that battle only and
// returns to the roster as a pawn. Returns the ids of pieces that promoted during the battle (for the summary).
export function settleRoster(run, battle) {
  const lostSet = new Set(battle.lost);
  const promoted = [];
  for (let sq = 0; sq < 64; sq++) {
    const id = battle.ids[sq]; if (id < 0) continue;
    const pc = pieceById(run, id), t = TYPE_CH[battle.pos.b[sq] & 31];
    if (pc && pc.t !== t) promoted.push(id);
  }
  // replacing a fallen piece costs what it cost: each loss steps that type's price back one level
  if (TUNE.lossRefundsPrice) for (const r of run.roster) if (lostSet.has(r.id)) { const bt = r.t in run.bought ? run.bought : run.fbought; if (bt && bt[r.t] > 0) bt[r.t]--; } // v6: fairy copies (run.fbought)
  run.roster = run.roster.filter(r => !lostSet.has(r.id));
  for (const k of Object.keys(run.formation)) if (lostSet.has(run.formation[k])) delete run.formation[k];
  run.touched = true;
  return promoted;
}
export function finishBattle(state, battle, result) {
  const run = state.run, tier = battle.tier;
  const promoted = settleRoster(run, battle);
  const sum = { result, tier, type: battle.node.type, lost: battle.lost.length, promoted: promoted.length, loot: 0, mine: false, discount: false, memories: 0 };
  if (result === 'win') {
    sum.loot = lootFor(tier, state.memories);
    run.gold += sum.loot; run.sumTiers += tier; run.cleared++; run.wins++;
    if (battle.node.type === 'mine') { run.mines.push(battle.node.mineTier ?? tier); sum.mine = true; }
    if (battle.node.mapId != null) run.tier = Math.max(run.tier, tier + 1); // world map: the map module applies the capture
    else {
      if (battle.node.type === 'town') { run.discounts++; sum.discount = true; }
      run.tier++;
    }
    state.bestTier = Math.max(state.bestTier, run.tier);
  } else if (result === 'mate') {
    sum.memories = mateMemories(run.sumTiers);
  } else run.losses++;
  // safety net: a lone king gets a free levy of pawns so a run can never soft-lock
  if (result !== 'mate' && !run.roster.some(r => r.t !== 'K')) { levy(run, 2); sum.levy = 2; }
  return sum;
}
export function levy(run, n) {
  for (let i = 0; i < n; i++) {
    const id = run.nextId++; run.roster.push({ id, t: 'P' });
    const free = run.owned.filter(sq => run.formation[sq] == null).sort((a, b) => (b >> 3) - (a >> 3));
    if (free.length) run.formation[free[0]] = id;
  }
}
export function abdicateMemories(run) { return memoriesFor(run.sumTiers); }
// memBonus (shrine memoriesOnEnd) is added after the mate 25% cut, so it is never reduced. Returns the total gain.
// P0-1 punish the run, never the account: endRun only ever ADDS to state.memories; upgrades and skills are untouched.
export function endRun(state, memGain, seed) {
  memGain = Math.max(0, Math.floor(+memGain || 0)) + Math.max(0, (state.run && state.run.memBonus) | 0);
  state.memories += memGain; state.memEarned = (state.memEarned || 0) + memGain; state.totalRuns++;
  state.run = newRun(seed, state.upgrades, state.run && state.run.orders, state.elo);
  skillStart(state);
  return memGain;
}
// passive income for n world ticks; returns gold gained
export function accrueTicks(state, n) {
  const g = incomePerTick(state.run, state.memories) * Math.max(0, n || 0);
  state.run.gold += g; return g;
}

// M6 rewind: put a battle back at its start snapshot (world.mjs battleSnapshot); static fields (node, seed, traits,
// terrain, elo) stay. The caller replays the kept moves with playMove.
export function resetBattle(b, s) {
  const pos = { b: Int8Array.from(s.b), side: s.side | 0, k: s.k.slice() };
  if (Array.isArray(s.m) && s.m.some(Boolean)) attachMats(pos, s.m);
  if (Array.isArray(s.g)) setGates(pos, s.g);
  b.pos = pos; b.ids = Int32Array.from(s.ids); b.history = new Map([[posKey(pos), 1]]); b.gated = []; b.fx = fairyKey(pos);
  b.plies = 0; b.last = 0; b.lost = []; b.over = null; b.maj = [0, 0]; b.tlog = []; b.lastTrait = null; b.lastCounter = null; b.ward = 0; b.moves = []; b.hope = 0;
  return b;
}
// ---- (de)serialization for save + hot reload ----
export function serBattle(b) {
  if (!b) return null;
  return { tier: b.tier, node: b.node, b: Array.from(b.pos.b), side: b.pos.side, k: b.pos.k.slice(), ids: Array.from(b.ids), hist: Array.from(b.history), plies: b.plies, last: b.last, lost: b.lost.slice(), over: b.over,
    elo: b.elo, seed: b.seed, traits: b.traits, maj: b.maj, tlog: (b.tlog || []).slice(-12), lastTrait: b.lastTrait || null,
    m: b.pos.m ? Array.from(b.pos.m) : null, tactElo: b.tactElo | 0, next: b.next || null, lastCounter: b.lastCounter || null,
    // M6: skills tally, rewind (start snapshot, move list, charges used), traitWard, hints used
    sx: b.sx || null, start: b.start || null, moves: b.moves ? b.moves.slice() : null, rw: b.rw | 0, ward: b.ward | 0, wardMax: b.wardMax | 0, hints: b.hints | 0, hope: b.hope | 0, pk: b.pk || null,
    // v6 fairy pieces: gates waiting (pos.g) and the ids that entered through a gate
    g: b.pos.g ? b.pos.g.map(x => Object.assign({}, x)) : null, gated: b.gated ? b.gated.slice() : [] };
}
export function deserBattle(o) {
  if (!o || !Array.isArray(o.b) || o.b.length !== 64) return null;
  const pos = { b: Int8Array.from(o.b), side: o.side | 0, k: o.k.slice() };
  if (Array.isArray(o.m) && o.m.length === 64 && o.m.some(Boolean)) attachMats(pos, o.m.map(x => Math.max(0, Math.min(3, x | 0))));
  if (Array.isArray(o.g)) setGates(pos, o.g.filter(x => x && (x.t | 0) > 7));
  // v3 battles have no elo/seed/traits: they resume with no traits and the default elo
  return { tier: o.tier, node: o.node, pos, ids: Int32Array.from(o.ids), history: new Map(o.hist), plies: o.plies | 0, last: o.last | 0, lost: o.lost || [], over: o.over || null,
    elo: o.elo != null ? cleanElo(o.elo) : null, seed: (o.seed >>> 0) || hash3(o.plies | 0, o.tier | 0, 5), traits: Array.isArray(o.traits) ? [cleanDwell(o.traits[0]), cleanDwell(o.traits[1])] : [cleanDwell(null), cleanDwell(null)],
    maj: Array.isArray(o.maj) ? o.maj.slice(0, 2) : [0, 0], tlog: Array.isArray(o.tlog) ? o.tlog.slice() : [], lastTrait: o.lastTrait || null,
    terrain: (o.node && o.node.terrain) || null, tactElo: o.tactElo | 0, next: Array.isArray(o.next) ? o.next : null, lastCounter: o.lastCounter || null,
    sx: SKM ? SKM.cleanTally(o.sx) : (o.sx || null), ward: o.ward | 0, wardMax: o.wardMax | 0, hints: o.hints | 0, rw: Math.max(0, o.rw | 0), hope: Math.max(0, o.hope | 0),
    pk: o.pk && typeof o.pk === 'object' && o.pk.c && o.pk.f ? o.pk : { c: {}, f: {} },
    // a battle saved before M6 (no start snapshot) cannot be rewound; a move list that does not match plies is dropped
    start: o.start && Array.isArray(o.start.b) && o.start.b.length === 64 && Array.isArray(o.start.ids) ? o.start : null,
    moves: Array.isArray(o.moves) && o.moves.length === (o.plies | 0) && o.moves.every(x => Number.isInteger(x)) ? o.moves.slice() : null,
    gated: Array.isArray(o.gated) ? o.gated.slice() : [], fx: fairyKey(pos) };
}
