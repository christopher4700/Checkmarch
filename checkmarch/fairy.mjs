// fairy.mjs: data-driven fairy pieces for the Checkmarch engine. Pure logic, no DOM, no imports.
// Each piece is a row with a Betza string; parseBetza() turns it into components, compileFairy() turns those
// into per-square tables for an N x N board, and the hooks (gen / attacked / evalPiece / evalAdjust) plug into
// engine.mjs at the patch points listed in FAIRY-API.md.
//
// Piece codes use the WIDENED encoding (see FAIRY-API.md): code = color << 5 | type, type 1..31.
// Types 1..6 stay P N B R Q K; fairy types start at 8 (7 is reserved). Captured piece in a move: (m >> 13) & 63.
// Squares: sq = rank * N + file, rank 0 = white's back rank.

export const FAIRY_ENC = { CSHIFT: 5, TMASK: 31, CAPSHIFT: 13, CAPMASK: 63, FIRST: 8 };
const CS = 5, TM = 31, WHITE = 0;

// ---------------------------------------------------------------- roster (data)
// kind: leaper | rider | hopper | compound | bent. cap: copy cap per formation (0 = none).
// lag: regions after the player's unlock before the enemy band fields it. enemyFirst: bosses field it before
// the player can own it. pair: sold as an opposite-colour pair. flag: shipping caveats.
export const FAIRY_ROSTER = [
  { id: 'commoner', ch: 'M', type: 8, name: 'Commoner', betza: 'WF', value: 300, kind: 'leaper', cap: 0, lag: 1, region: 1, via: 'dwelling (Hamlet)',
    plainWords: 'Steps one square in any direction, like a king, but it is not royal: it can be captured and can walk into danger.' },
  { id: 'champion', ch: 'H', type: 9, name: 'Champion', betza: 'WAD', value: 400, kind: 'leaper', cap: 2, lag: 1, region: 2, via: 'dwelling upgrade',
    plainWords: 'Steps one square straight (up, down, left or right), or jumps exactly two squares straight or diagonally. The jump passes over anything in between.' },
  { id: 'wizard', ch: 'W', type: 10, name: 'Wizard', betza: 'FC', value: 375, kind: 'leaper', cap: 2, lag: 1, region: 2, via: 'shrine (announced roll)', pair: true,
    plainWords: 'Steps one square diagonally, or makes a long knight jump: three squares one way and one square to the side. It jumps over pieces and always stays on its own square colour, so wizards come as a pair, one for each colour.' },
  { id: 'cannon', ch: 'C', type: 11, name: 'Cannon', betza: 'mRcpR', value: 450, kind: 'hopper', cap: 2, lag: 1, region: 3, via: 'dwelling (Foundry)',
    plainWords: 'Moves like a rook when it is not capturing. To capture it must jump: along a straight line it leaps over exactly one piece (of either side, called the screen) and takes the first enemy piece behind it. With no screen it cannot capture, and it cannot check along an empty line. Rocks and water stop it and never count as a screen.' },
  { id: 'nightrider', ch: 'J', type: 12, name: 'Nightrider', betza: 'NN', value: 550, kind: 'rider', cap: 1, lag: 1, region: 4, via: 'boss reward, then dwelling',
    plainWords: 'Makes knight jumps over and over in one straight line, like a rook made of knight moves. It stops at the first piece it lands on (capturing it if it is an enemy). Pieces it jumps over between landings do not block it; a piece, rock or water on a landing square does.' },
  { id: 'archbishop', ch: 'A', type: 13, name: 'Archbishop', betza: 'BN', value: 825, kind: 'compound', cap: 1, lag: 2, region: 4, via: 'dwelling (Cathedral), gated entry',
    plainWords: 'Moves as a bishop or as a knight, its choice each turn.' },
  { id: 'chancellor', ch: 'E', type: 14, name: 'Chancellor', betza: 'RN', value: 875, kind: 'compound', cap: 1, lag: 2, region: 5, via: 'dwelling (Chancery), gated entry',
    plainWords: 'Moves as a rook or as a knight, its choice each turn.' },
  { id: 'gryphon', ch: 'G', type: 15, name: 'Gryphon', betza: 't[FR]', value: 650, kind: 'bent', cap: 1, lag: 2, region: 6, via: '10x10 region reward', flag: 'value unmeasured: ship weak, calibrate in-house',
    plainWords: 'Steps one square diagonally, then may keep going in a straight line away from where it started (up or down, or sideways, whichever points outward). The diagonal square must be empty to keep going.' },
  { id: 'amazon', ch: 'Z', type: 16, name: 'Amazon', betza: 'QN', value: 1150, kind: 'compound', cap: 1, lag: 0, region: 7, via: 'rival-lord defeat (first copy unique)', enemyFirst: true,
    plainWords: 'Moves as a queen or as a knight, its choice each turn. The strongest piece you can own.' },
];
export const FAIRY_BY_ID = Object.fromEntries(FAIRY_ROSTER.map(d => [d.id, d]));
export const FAIRY_BY_TYPE = Object.fromEntries(FAIRY_ROSTER.map(d => [d.type, d]));
export const FAIRY_BY_CH = Object.fromEntries(FAIRY_ROSTER.map(d => [d.ch, d]));
const defOf = x => typeof x === 'object' && x ? x : FAIRY_BY_ID[x] || FAIRY_BY_TYPE[x] || FAIRY_BY_CH[x] || null;

// ---------------------------------------------------------------- Betza (shipping subset)
// Atoms W F D N A H C Z G (leaps), shorthands K=WF R=WW B=FF Q=RB. Doubling (NN, WW) = rider, a trailing
// number caps range (R2, NN3). Prefixes m (move only), c (capture only), p (hop over exactly one screen).
// t[XY]: bent rider, one X step then Y rides in the directions pointing outward (dot product > 0).
// Not supported (on purpose): f/b/s/l/r direction limits, n (lame), g (grasshopper), j, a (multi-leg), igui.
const ATOM = { W: [1, 0], F: [1, 1], D: [2, 0], N: [2, 1], A: [2, 2], H: [3, 0], C: [3, 1], Z: [3, 2], G: [3, 3] };
const SHORT = { K: ['W', 1, 'F', 1], R: ['W', 0], B: ['F', 0], Q: ['W', 0, 'F', 0] };
export function atomVecs(a, b) {
  const s = new Set(), out = [];
  for (const [x, y] of [[a, b], [b, a]]) for (const sx of [1, -1]) for (const sy of [1, -1]) {
    const v = [x * sx, y * sy], k = v.join(); if (!s.has(k)) { s.add(k); out.push(v); }
  }
  return out;
}
// -> [{ atom, vecs, range (1 = leap, 0 = unlimited, k = capped rider), mode (1 move | 2 capture), hop, bent }]
export function parseBetza(str) {
  const out = []; let i = 0;
  const err = m => { throw new Error(`Betza "${str}": ${m} at ${i}`); };
  while (i < str.length) {
    let mode = 0, hop = false;
    while (i < str.length && 'mcp'.includes(str[i])) { const c = str[i++]; if (c === 'm') mode |= 1; else if (c === 'c') mode |= 2; else hop = true; }
    if (!mode) mode = 3;
    if (str[i] === 't' && str[i + 1] === '[') {
      const end = str.indexOf(']', i); if (end < 0) err('unclosed t[');
      const inner = parseBetza(str.slice(i + 2, end)); i = end + 1;
      if (inner.length < 2 || inner[0].range !== 1) err('t[XY] needs a step atom then a rider');
      const first = inner[0], legs = inner.slice(1);
      out.push({ atom: 't[' + first.atom + legs.map(l => l.atom).join('') + ']', vecs: first.vecs, range: 1, mode, hop: false,
        bent: first.vecs.map(v => legs.flatMap(l => l.vecs.filter(w => v[0] * w[0] + v[1] * w[1] > 0).map(w => ({ w, range: l.range })))) });
      continue;
    }
    const ch = str[i];
    if (SHORT[ch]) {
      i++; const sh = SHORT[ch]; let rng = null;
      const m = /^\d+/.exec(str.slice(i)); if (m) { rng = +m[0]; i += m[0].length; }
      for (let k = 0; k < sh.length; k += 2) { const r = rng != null ? rng : sh[k + 1]; out.push({ atom: sh[k] + (r === 1 ? '' : sh[k] + (r || '')), vecs: atomVecs(...ATOM[sh[k]]), range: r, mode, hop, bent: null }); }
      continue;
    }
    if (!ATOM[ch]) err(`unknown atom "${ch}"`);
    i++; let range = 1;
    if (str[i] === ch) { i++; range = 0; }
    const m = /^\d+/.exec(str.slice(i)); if (m) { range = +m[0]; i += m[0].length; }
    out.push({ atom: ch + (range === 1 ? '' : ch + (range || '')), vecs: atomVecs(...ATOM[ch]), range, mode, hop, bent: null });
  }
  for (const c of out) if (c.hop && c.range === 1) err('p (hop) needs a rider');
  return out;
}

// ---------------------------------------------------------------- geometry for an N x N board
// STEP[vi][sq] = sq + v or -1; RAY[vi][sq] = the squares stepping by v until the edge (walls checked at walk time,
// because the engine swaps its WALL table in place per battle and this module holds a reference to it).
export function makeGeometry(N = 8) {
  const vid = new Map(), VEC = [], STEP = [], RAY = [];
  const id = (dr, df) => {
    const k = dr + ',' + df; if (vid.has(k)) return vid.get(k);
    const i = VEC.length, st = new Int16Array(N * N), ry = [];
    for (let sq = 0; sq < N * N; sq++) {
      const r = Math.floor(sq / N), f = sq % N, ok = (a, b) => a >= 0 && a < N && b >= 0 && b < N;
      st[sq] = ok(r + dr, f + df) ? (r + dr) * N + f + df : -1;
      const ray = []; let rr = r + dr, ff = f + df; while (ok(rr, ff)) { ray.push(rr * N + ff); rr += dr; ff += df; } ry.push(ray);
    }
    vid.set(k, i); VEC.push([dr, df]); STEP.push(st); RAY.push(ry); return i;
  };
  const CENT = new Int8Array(N * N), c = (N - 1) / 2;
  for (let sq = 0; sq < N * N; sq++) CENT[sq] = Math.round(N - 1 - Math.abs(sq % N - c) - Math.abs(Math.floor(sq / N) - c));
  return { N, id, VEC, STEP, RAY, CENT };
}

// compile one def -> { type, leapTo[sq], leapFl[sq], rides[], hops[], bents[], overlap }
export function compileFairy(def, G) {
  const comps = parseBetza(def.betza), N2 = G.N * G.N;
  const T = { type: def.type, def, comps, leapTo: [], leapFl: [], rides: [], hops: [], bents: [], overlap: false };
  const leaps = [];
  for (const c of comps) {
    if (c.bent) { c.vecs.forEach((v, k) => T.bents.push({ a: G.id(v[0], v[1]), legs: c.bent[k].map(l => ({ vi: G.id(l.w[0], l.w[1]), range: l.range })), mode: c.mode })); continue; }
    for (const v of c.vecs) {
      const vi = G.id(v[0], v[1]);
      if (c.hop) T.hops.push({ vi, mode: c.mode });
      else if (c.range === 1) leaps.push({ vi, mode: c.mode });
      else T.rides.push({ vi, range: c.range || G.N, mode: c.mode });
    }
  }
  for (let sq = 0; sq < N2; sq++) {
    const to = [], fl = [];
    for (const l of leaps) { const t = G.STEP[l.vi][sq]; if (t < 0) continue; const j = to.indexOf(t); if (j >= 0) fl[j] |= l.mode; else { to.push(t); fl.push(l.mode); } }
    T.leapTo.push(Int16Array.from(to)); T.leapFl.push(Uint8Array.from(fl));
  }
  // overlap: two components reaching one square on an empty board (the most reach there is) -> dedupe in gen
  const b = new Int8Array(N2), tmp = [];
  for (let sq = 0; sq < N2 && !T.overlap; sq++) { genInto(T, G, b, sq, 0, tmp, false, null); const s = new Set(tmp.map(m => m >> MSH & 127)); if (s.size !== tmp.length) T.overlap = true; }
  return T;
}

// ---------------------------------------------------------------- kernels
// Moves are pushed in the engine format from | to << 6 | captured << 13 (N <= 8: 6-bit squares; see FAIRY-API.md
// for the 10x10 move layout). WALL squares: never a landing square; rides, hops and bent legs stop before them.
let MSH = 6, CAPSH = 13; // to-square / captured-piece shifts: 6 / 13 on 8x8 (engine format), 7 / 15 on 10x10
function setLayout(N) { MSH = N <= 8 ? 6 : 7; CAPSH = N <= 8 ? 13 : 15; }
function genInto(T, G, b, sq, side, out, capOnly, W) {
  out.length = 0; pushAll(T, G, b, sq, side, out, capOnly, W); return out;
}
function pushAll(T, G, b, sq, side, out, capOnly, W) {
  const start = out.length;
  const L = T.leapTo[sq], F = T.leapFl[sq];
  for (let i = 0; i < L.length; i++) {
    const to = L[i]; if (W && W[to]) continue;
    const q = b[to];
    if (q) { if (F[i] & 2 && (q >> CS) !== side) out.push(sq | to << MSH | q << CAPSH); }
    else if (!capOnly && F[i] & 1) out.push(sq | to << MSH);
  }
  for (const r of T.rides) rideWalk(G.RAY[r.vi][sq], r.range, r.mode, b, sq, side, out, capOnly, W);
  for (const h of T.hops) {
    const ray = G.RAY[h.vi][sq]; let k = 0;
    for (; k < ray.length; k++) { const to = ray[k]; if (W && W[to] || b[to]) break; }
    if (k >= ray.length || (W && W[ray[k]])) continue; // no screen (walls are never screens)
    for (k++; k < ray.length; k++) {
      const to = ray[k]; if (W && W[to]) break;
      const q = b[to];
      if (q) { if (h.mode & 2 && (q >> CS) !== side) out.push(sq | to << MSH | q << CAPSH); break; }
      if (!capOnly && h.mode & 1) out.push(sq | to << MSH);
    }
  }
  for (const bt of T.bents) {
    const f = G.STEP[bt.a][sq]; if (f < 0 || (W && W[f])) continue;
    const q = b[f];
    if (q) { if (bt.mode & 2 && (q >> CS) !== side) out.push(sq | f << MSH | q << CAPSH); continue; }
    if (!capOnly && bt.mode & 1) out.push(sq | f << MSH);
    for (const l of bt.legs) rideWalk(G.RAY[l.vi][f], l.range || G.N, bt.mode, b, sq, side, out, capOnly, W);
  }
  if (T.overlap && out.length - start > 1) {
    const seen = new Set(); let w = start;
    for (let i = start; i < out.length; i++) { const t = out[i] >> MSH & 127; if (!seen.has(t)) { seen.add(t); out[w++] = out[i]; } }
    out.length = w;
  }
}
function rideWalk(ray, range, mode, b, sq, side, out, capOnly, W) {
  const n = Math.min(range, ray.length);
  for (let k = 0; k < n; k++) {
    const to = ray[k]; if (W && W[to]) break;
    const q = b[to];
    if (q) { if (mode & 2 && (q >> CS) !== side) out.push(sq | to << MSH | q << CAPSH); break; }
    if (!capOnly && mode & 1) out.push(sq | to << MSH);
  }
}

// ---------------------------------------------------------------- active set + hooks
// ST holds the active board size, compiled types and the reverse-attack plan. bindFairyEngine() hands in the
// engine's own tables (mutated in place: VAL, TYPE_CH, CH_TYPE, UNITS; WALL is read live).
const ST = { N: 8, G: null, T: [], active: false, plan: null, WALL: new Uint8Array(64), eng: null, scratch: [] };
export function bindFairyEngine(tables) {
  ST.eng = tables || null;
  if (tables && tables.WALL) ST.WALL = tables.WALL;
  writeEngineTables();
}
export function setFairyWall(mask) { ST.WALL = mask; }
function writeEngineTables() {
  const e = ST.eng; if (!e) return;
  if (e.VAL) { if (e.VAL[7] == null) e.VAL[7] = 0; for (const d of FAIRY_ROSTER) e.VAL[d.type] = fairyValue(d.id, ST.N); }
  if (e.TYPE_CH) { if (e.TYPE_CH[7] == null) e.TYPE_CH[7] = ''; for (const d of FAIRY_ROSTER) e.TYPE_CH[d.type] = d.ch; }
  if (e.CH_TYPE) for (const d of FAIRY_ROSTER) e.CH_TYPE[d.ch] = d.type;
  if (e.UNITS) for (const d of FAIRY_ROSTER) e.UNITS[d.ch] = Math.round(d.value / 100);
  if (e.PIECE_NOUN) for (const d of FAIRY_ROSTER) e.PIECE_NOUN[d.ch] = d.name.toLowerCase();
}
// setFairyPieces(list, N): activate these pieces (ids, types, letters or def rows) for the next battle on an
// N x N board. [] or null switches every fairy hook off (standard chess costs nothing extra).
export function setFairyPieces(list, N = 8) {
  const defs = (list || []).map(defOf).filter(Boolean);
  if (N !== ST.N || !ST.G) { ST.N = N; ST.G = makeGeometry(N); if (ST.WALL.length !== N * N && !ST.eng) ST.WALL = new Uint8Array(N * N); }
  setLayout(N);
  ST.T = []; for (const d of defs) ST.T[d.type] = compileFairy(d, ST.G);
  ST.active = defs.length > 0;
  ST.plan = buildPlan();
  writeEngineTables();
  return defs.map(d => d.id);
}
export function activeFairy() { return ST.T.filter(Boolean).map(t => t.def.id); }
export function fairyTypesOn(b) { const s = new Set(); for (let i = 0; i < b.length; i++) { const t = b[i] & TM; if (t >= 8) s.add(t); } return [...s]; }

// reverse-attack plan: capture components only (divergent pieces are keyed on what they capture with)
function buildPlan() {
  const G = ST.G, leap = new Map(), ride = new Map(), hop = new Map(), bent = new Map();
  const neg = vi => G.id(-G.VEC[vi][0], -G.VEC[vi][1]);
  for (const T of ST.T) {
    if (!T) continue; const bit = 1 << T.type;
    for (const c of T.comps) {
      if (!(c.mode & 2)) continue;
      if (c.bent) {
        c.vecs.forEach((v, k) => { for (const l of c.bent[k]) {
          const key = v + '|' + l.w; const e = bent.get(key) || { na: G.id(-v[0], -v[1]), nw: G.id(-l.w[0], -l.w[1]), range: l.range || G.N, mask: 0 };
          e.mask |= bit; bent.set(key, e);
        } });
        continue;
      }
      for (const v of c.vecs) {
        const vi = G.id(v[0], v[1]), nv = neg(vi);
        if (c.hop) { const e = hop.get(nv) || { vi: nv, mask: 0 }; e.mask |= bit; hop.set(nv, e); }
        else if (c.range === 1) { const e = leap.get(nv) || { vi: nv, mask: 0 }; e.mask |= bit; leap.set(nv, e); }
        else { const e = ride.get(nv) || { vi: nv, rng: new Uint8Array(32), max: 0 }; const r = c.range || G.N; e.rng[T.type] = Math.max(e.rng[T.type], r); e.max = Math.max(e.max, r); ride.set(nv, e); }
      }
    }
  }
  return { leap: [...leap.values()], ride: [...ride.values()], hop: [...hop.values()], bent: [...bent.values()] };
}

// attacked(b, sq, by): does a FAIRY piece of side `by` attack sq? (the engine's own scan covers P N B R Q K).
// "Attack" = could capture an enemy piece standing on sq. Cannon: needs exactly one screen between it and sq.
export function attacked(b, sq, by) {
  if (!ST.active) return false;
  const P = ST.plan, G = ST.G, W = ST.WALL;
  for (const e of P.leap) { const s = G.STEP[e.vi][sq]; if (s >= 0) { const p = b[s]; if (p && (p >> CS) === by && (e.mask >> (p & TM) & 1)) return true; } }
  for (const e of P.ride) {
    const ray = G.RAY[e.vi][sq], n = Math.min(e.max, ray.length);
    for (let k = 0; k < n; k++) { const s = ray[k]; if (W[s]) break; const p = b[s]; if (p) { if ((p >> CS) === by && e.rng[p & TM] > k) return true; break; } }
  }
  for (const e of P.hop) {
    const ray = G.RAY[e.vi][sq]; let k = 0;
    for (; k < ray.length; k++) { const s = ray[k]; if (W[s] || b[s]) break; }
    if (k >= ray.length || W[ray[k]]) continue;
    for (k++; k < ray.length; k++) { const s = ray[k]; if (W[s]) break; const p = b[s]; if (p) { if ((p >> CS) === by && (e.mask >> (p & TM) & 1)) return true; break; } }
  }
  for (const e of P.bent) {
    // target = g + a + k*w (k >= 0); f = g + a and every square from f to sq - w must be empty and open
    let g = G.STEP[e.na][sq];
    if (g >= 0) { const p = b[g]; if (p && (p >> CS) === by && (e.mask >> (p & TM) & 1)) return true; }
    const ray = G.RAY[e.nw][sq], n = Math.min(e.range, ray.length);
    for (let k = 0; k < n; k++) {
      const f = ray[k]; if (W[f] || b[f]) break;
      g = G.STEP[e.na][f];
      if (g >= 0) { const p = b[g]; if (p && (p >> CS) === by && (e.mask >> (p & TM) & 1)) return true; }
    }
  }
  return false;
}
// the API name from the design brief: accepts a position or a bare board
export function attacks(pos, sq, by) { return attacked(pos && pos.b ? pos.b : pos, sq, by); }

// gen(b, sq, t, side, out, capturesOnly): append pseudo-legal moves of the fairy piece on sq (engine hook)
export function gen(b, sq, t, side, out, capOnly) { const T = ST.T[t]; if (T) pushAll(T, ST.G, b, sq, side, out, capOnly, ST.WALL); return out; }
// standalone probe (tests, UI): { moves: [to], captures: [to] }
export function fairyProbe(b, sq, t, side) {
  const T = ST.T[t] || compileFairy(defOf(t), ST.G || (ST.G = makeGeometry(ST.N))), out = [];
  pushAll(T, ST.G, b, sq, side, out, false, ST.WALL);
  const mv = [], cp = []; for (const m of out) ((m >> CAPSH & 63) ? cp : mv).push(m >> MSH & 127);
  return { moves: mv, captures: cp };
}

// ---------------------------------------------------------------- evaluation
// VAL[type] (written into the engine's VAL by bindFairyEngine) is the base value; evalPiece adds positional terms
// for one piece (the engine's own evaluate adds VAL); evalAdjust adds board-wide phase terms (white perspective).
export const FAIRY_TUNE = {
  wizardPair: 40,                    // both colours of wizard for one side
  cannonFull: 32, cannonEmpty: 8, cannonDrop: 100, // cannon value falls by cannonDrop as men on board go 32 -> 8
  amazonFree: 6, amazonPer: 12, amazonMax: 150,    // leveling: -12 cp per enemy "lesser point" above 6, cap 150
  leapCent: 4, leapMob: 2, rideMob: 1, cannonMob: 1, commonerEndCent: 5,
  board10: { leaper: 0.92, hopper: 1.0, rider: 1.0, bent: 1.02, compound: 1.0 }, // 10x10 re-band (Muller, Grand Chess)
};
export function fairyValue(id, N = 8) {
  const d = defOf(id); if (!d) return 0;
  return N >= 10 ? Math.round(d.value * (FAIRY_TUNE.board10[d.kind] || 1)) : d.value;
}
export function fairyValueTable(N = 8) { const o = {}; for (const d of FAIRY_ROSTER) o[d.id] = fairyValue(d.id, N); return o; }
export function evalPiece(b, sq, c, t, endgame) {
  const T = ST.T[t]; if (!T) return 0;
  const out = ST.scratch; out.length = 0; pushAll(T, ST.G, b, sq, c, out, false, ST.WALL);
  const mob = out.length, k = T.def.kind, cen = ST.G.CENT[sq], U = FAIRY_TUNE;
  if (k === 'leaper') return (T.def.id === 'commoner' && endgame ? cen * U.commonerEndCent : cen * U.leapCent - 10) + mob * U.leapMob;
  if (k === 'hopper') return mob * U.cannonMob;
  return mob * U.rideMob + (k === 'compound' && T.leapTo[sq].length ? cen * 2 : 0);
}
// board-wide terms: wizard pair, cannon emptiness decay, amazon leveling. White perspective, centipawns.
export function evalAdjust(b) {
  if (!ST.active) return 0;
  const U = FAIRY_TUNE, N = ST.N, wz = [[0, 0], [0, 0]], cann = [0, 0], amz = [0, 0], lesser = [0, 0];
  let men = 0;
  for (let sq = 0; sq < b.length; sq++) {
    const p = b[sq]; if (!p) continue; men++;
    const c = p >> CS, t = p & TM, d = FAIRY_BY_TYPE[t];
    if (t === 1) lesser[c] += 0.5; else if (t >= 2 && t <= 4) lesser[c] += 1; else if (d && d.value < 600) lesser[c] += 1;
    if (!d) continue;
    if (d.id === 'wizard') wz[c][(Math.floor(sq / N) + sq % N) & 1]++;
    else if (d.id === 'cannon') cann[c]++;
    else if (d.id === 'amazon') amz[c]++;
  }
  const s = [0, 0];
  const decay = Math.round(U.cannonDrop * Math.max(0, Math.min(1, (U.cannonFull - men) / (U.cannonFull - U.cannonEmpty))));
  for (let c = 0; c < 2; c++) {
    if (wz[c][0] && wz[c][1]) s[c] += U.wizardPair;
    s[c] -= cann[c] * decay;
    if (amz[c]) s[c] -= amz[c] * Math.min(U.amazonMax, U.amazonPer * Math.max(0, lesser[c ^ 1] - U.amazonFree));
  }
  return s[0] - s[1];
}
export function cannonValue(men) { const U = FAIRY_TUNE; return FAIRY_BY_ID.cannon.value - Math.round(U.cannonDrop * Math.max(0, Math.min(1, (U.cannonFull - men) / (U.cannonFull - U.cannonEmpty)))); }

// the hook object engine.mjs receives (setFairyHooks(fairyHooks))
export const fairyHooks = { gen, attacked, evalPiece, evalAdjust, bind: bindFairyEngine, setPieces: setFairyPieces, get active() { return ST.active; } };

// ---------------------------------------------------------------- UI: movement diagram + text
// moveDiagram(id, {N, sq}) -> reachable pattern on an EMPTY board from the centre (d4 on 8x8, e5 on 10x10).
// moves: squares it can move to; captures: squares it could capture on if an enemy stood there.
// For the cannon (captures need a screen) an `example` adds one screen two squares ahead and shows the hits.
export function moveDiagram(id, opt = {}) {
  const d = defOf(id); if (!d) return null;
  const N = opt.N || 8, sq = opt.sq != null ? opt.sq : (N / 2 - 1 | 0) * N + (N / 2 - 1 | 0);
  const saved = ST.N; setLayout(N);
  const G = makeGeometry(N), T = compileFairy(d, G);
  const capSet = (b) => {
    const res = [];
    for (let s = 0; s < N * N; s++) {
      if (s === sq || b[s]) continue; b[s] = 1 << CS | 1; const o = []; pushAll(T, G, b, sq, 0, o, true, null);
      if (o.some(m => (m >> MSH & 127) === s)) res.push(s); b[s] = 0;
    }
    return res;
  };
  const b = new Int8Array(N * N), o = []; pushAll(T, G, b, sq, 0, o, false, null);
  const r = { id: d.id, name: d.name, betza: d.betza, N, sq, moves: o.map(m => m >> MSH & 127).sort((x, y) => x - y), captures: capSet(b).sort((x, y) => x - y), plainWords: d.plainWords };
  if (T.hops.length) {
    const scr = sq + 2 * N; b[scr] = 1 << CS | 1;
    const cs = capSet(b); b[scr] = 0;
    r.example = { screen: scr, captures: cs, note: 'with a piece on the screen square, the cannon can capture on these squares' };
  }
  r.grid = diagramGrid(r);
  setLayout(saved);
  return r;
}
// rows top (last rank) to bottom: '@' piece, 'o' move+capture, 'm' move only, 'x' capture only, '#' screen, '.'
export function diagramGrid(r) {
  const mv = new Set(r.moves), cp = new Set(r.example ? r.example.captures : r.captures), rows = [];
  for (let rk = r.N - 1; rk >= 0; rk--) {
    let s = ''; for (let f = 0; f < r.N; f++) {
      const q = rk * r.N + f;
      s += q === r.sq ? '@' : r.example && q === r.example.screen ? '#' : mv.has(q) && cp.has(q) ? 'o' : mv.has(q) ? 'm' : cp.has(q) ? 'x' : '.';
    }
    rows.push(s);
  }
  return rows;
}
export function plainWords(id) { const d = defOf(id); return d ? d.plainWords : ''; }

// ---------------------------------------------------------------- economy: prices, caps, the enemy mirror
// base price ~ value^1.75 anchored on the queen (600 gold at 900 cp: fits the existing R/Q bases), copies x1.7^n
export const FAIRY_PRICE = { anchorVal: 900, anchorPrice: 600, exp: 1.75, growth: 1.7 };
export function fairyBasePrice(id) { const d = defOf(id); return d ? Math.round(FAIRY_PRICE.anchorPrice * Math.pow(d.value / FAIRY_PRICE.anchorVal, FAIRY_PRICE.exp)) : Infinity; }
export function fairyPrice(id, bought) { return Math.round(fairyBasePrice(id) * Math.pow(FAIRY_PRICE.growth, bought | 0)); }
// owned: number of copies currently in the formation/roster. Wizards come in pairs: a purchase is two copies.
export function fairyCanBuy(id, owned) { const d = defOf(id); if (!d) return false; const add = d.pair ? 2 : 1; return !d.cap || (owned | 0) + add <= d.cap; }
// pieces the enemy band may field in `region`. unlocks: {id: region the player unlocked it}. opt.band: elo band
// index (bands below opt.minBand stay frozen: no fairy pieces), opt.rival: the rival lord previews the player's
// next locked piece. enemyFirst pieces are fielded by bosses from their roster region regardless of unlocks.
export function enemyFairyPool(unlocks, region, opt = {}) {
  unlocks = unlocks || {}; const out = [];
  if ((opt.band | 0) < (opt.minBand | 0)) return out;
  for (const d of FAIRY_ROSTER) {
    const u = unlocks[d.id];
    if (u != null && region >= u + d.lag) out.push(d.id);
    else if (d.enemyFirst && opt.boss && region >= d.region) out.push(d.id);
  }
  if (opt.rival) { const next = FAIRY_ROSTER.find(d => unlocks[d.id] == null && !out.includes(d.id)); if (next) out.push(next.id); }
  return out;
}

// ---------------------------------------------------------------- gating (Seirawan-style delivery), pure helpers
// A gate = { color, sq (home square), t (fairy type) }. The bought piece waits off-board behind sq. When the piece
// standing on sq moves away, the mover may drop the gated piece onto sq in the same move (a gate move).
// If sq is vacated without gating, or its occupant is captured there first, the right lapses for that battle.
// Gate move = normal move | GATE_FLAG | t << GATE_SHIFT (bits 20-24). FAIRY-API.md has the engine patch.
export const GATE_FLAG = 1 << 19, GATE_SHIFT = 20;
export const gateType = m => (m >> GATE_SHIFT) & 31;
// moves of the side to move -> moves plus gate variants (append-only; pure)
export function expandGates(moves, gates, side) {
  const out = moves.slice();
  if (!gates || !gates.length) return out;
  for (const m of moves) { const from = m & 63; for (const g of gates) if (g.color === side && g.sq === from) out.push(m | GATE_FLAG | g.t << GATE_SHIFT); }
  return out;
}
// gates after move m by `side` (returns a new array): a gate move consumes its gate; a non-gate move off a home
// square lapses that gate; a capture landing on an enemy home square lapses the enemy's gate there.
export function gatesAfter(gates, m, side) {
  if (!gates || !gates.length) return gates || [];
  const from = m & 63, to = (m >> 6) & 63, cap = (m >> 13) & 63;
  return gates.filter(g => !((g.color === side && g.sq === from) || (cap && g.color !== side && g.sq === to)));
}
// apply / undo the drop on a board after makeMove / before unmakeMove (code = color << 5 | type)
export function gateDrop(b, m, side) { if (m & GATE_FLAG) b[m & 63] = side << CS | gateType(m); }
export function gateLift(b, m) { if (m & GATE_FLAG) b[m & 63] = 0; }

// ---------------------------------------------------------------- save migration (old 3-bit encoding)
export function migrateBoardCodes(arr) { return Array.from(arr, c => c ? ((c >> 3) << CS) | (c & 7) : 0); }
export function migrateMove(m) { const cap = (m >> 13) & 15; return (m & 0x1fff) | (cap ? (((cap >> 3) << CS) | (cap & 7)) << 13 : 0); }
