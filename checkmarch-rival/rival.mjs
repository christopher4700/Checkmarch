// Checkmarch living rival: a rival lord who starts at the region's east keep (the citadel node)
// and plays the player's game back at them: clears neutral nodes, takes mines, grows an army,
// pushes west. Where the two frontiers meet, border battles decide who keeps the node.
//
// Pure ES module. No DOM, no imports, no Math.random, no Date. Deterministic from its inputs.
// The state is plain JSON (no Sets or Maps). The region object comes from map.mjs generateRegion.
// Inline-friendly: every top-level name starts with `rival` / `RIVAL` or is a public API name.
//
// Time model: the rival keeps its own clock in integer milliseconds (state.ms). Every scheduled
// action happens at an exact integer ms, and all growth is computed in closed form from integer
// counters, so one advance of N seconds gives exactly the same state as N advances of 1 second
// (with the same playerHeld and the same online flag).

export const RIVAL_TUNE = {
  firstMoveMs: 90e3,        // first action ~90 s after the region opens (+/- jitter)
  baseIntervalMs: 90e3,     // gap between actions: base + perNode x (nodes held - 1), capped
  perNodeMs: 40e3,
  maxIntervalMs: 12 * 60e3,
  jitter: 0.08,             // +/- 8 % per gap, deterministic per move number
  retreatMult: 1.5,         // gap after losing a border battle is 1.5x longer
  nodeCooldownMs: 5 * 60e3, // a node where the rival lost a border battle is safe for 5 min
  keepCooldownMs: 10 * 60e3,// after a repelled keep assault, the keep is safe for 10 min
  keepAssaultMinHeld: 5,    // the rival needs at least 5 nodes before it assaults the player keep
  offlineMinDist: 2,        // offline the rival never takes a node closer than 2 roads to the keep
  onlineMaxDt: 30,          // default online flag: dt <= 30 s counts as a live tick
  // target preference (higher wins); the rival never captures a player node without a battle
  score: { mine: 300, town: 200, shrine: 100, garrison: 0, keep: 140, neutralBonus: 50, perDist: 10, jitter: 10 },
  // growth: xp from time, mine-time, captures, sorties and border wins; strength = 1 + bonus
  xpTimeMs: 10 * 60e3,      // +1 xp per 10 min of rival clock
  xpMineMs: 15 * 60e3,      // +1 xp per mine per 15 min held
  xpCapture: 0.5, xpSortie: 0.25, xpBorderWin: 1,
  bonusScale: 1.5, bonusCap: 9, dwellingCap: 12,
  // armies: budget = budgetBase x growth^tier x mult (same shape as engine.mjs enemyBudget)
  budgetBase: 8, budgetGrowth: 1.045,
  multBorder: 1.0, multGarrison: 0.95, multKeep: 1.2,
  eloBase: 800, eloPerStrength: 50,
  tiersPerRegion: 10,
};

const RIVAL_UNITS = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 };

// Rival formations (black side, ranks 8/7/6): king square + ordered slots, filled until the budget
// runs out. The last one is reserved for keep assaults.
export const RIVAL_FORMATIONS = [
  { name: 'Vanguard', k: 'e8', s: 'Pe7 Pd7 Nc6 Nf6 Pc7 Pf7 Bc8 Bf8 Pb7 Pg7 Ra8 Rh8 Qd8 Pa7 Ph7' },
  { name: 'Outriders', k: 'e8', s: 'Nb6 Ng6 Pd7 Pe7 Nc8 Nf8 Pc7 Pf7 Bd8 Pb7 Pg7 Ra8 Rh8 Qg8 Pa7 Ph7' },
  { name: 'Rook Columns', k: 'g8', s: 'Re8 Rd8 Pf7 Pg7 Ph7 Pe6 Pd6 Pc7 Nc6 Bb7 Pb6 Pa7 Nf6 Be7 Qa8' },
  { name: 'Iron Wall', k: 'e8', s: 'Pc6 Pd6 Pe6 Pf6 Pb7 Pg7 Bd7 Be7 Pa7 Ph7 Nc7 Nf7 Rd8 Rf8 Qc8' },
  { name: 'Twin Spires', k: 'e8', s: 'Bb7 Bg7 Pd7 Pe7 Pc6 Pf6 Nd8 Pa7 Ph7 Pb6 Pg6 Ra8 Rh8 Qf8 Nc8' },
  { name: "Lord's Court", k: 'e8', keep: true, s: 'Qd8 Rc8 Rf8 Pd7 Pe7 Pf7 Pc7 Nd6 Ne6 Bb7 Bg7 Pb6 Pg6 Pa7 Ph7' },
];

// ---------- helpers ----------
function rivalHash(str) {
  const s = String(str);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return h >>> 0;
}
function rivalRoll(...parts) { return rivalHash(parts.join('|')) / 4294967296; }
function rivalSet(x) { return x instanceof Set ? x : new Set(x || []); }
function rivalClone(s) {
  return { ...s, held: s.held.slice(), cooldown: { ...s.cooldown }, pending: s.pending ? { ...s.pending } : null };
}
function rivalAdj(region) {
  const adj = Array.from({ length: region.nodes.length }, () => []);
  for (const [a, b] of region.roads) { adj[a].push(b); adj[b].push(a); }
  for (const l of adj) l.sort((p, q) => p - q);
  return adj;
}
function rivalCheck(s, region) {
  if (!region || !region.nodes) throw new Error('rival: region required');
  if (s.nodeCount !== region.nodes.length || s.seat !== region.citadelId || s.regionNumber !== region.regionNumber) {
    throw new Error('rival: state belongs to a different region');
  }
}
function rivalSq(name) { return (name.charCodeAt(0) - 97) + (parseInt(name.slice(1), 10) - 1) * 8; }
function rivalInsert(arr, id) { if (!arr.includes(id)) { arr.push(id); arr.sort((p, q) => p - q); } }

// ---------- growth ----------
function rivalXp(s) {
  const T = RIVAL_TUNE;
  return s.ms / T.xpTimeMs + s.mineMs / T.xpMineMs + s.captures * T.xpCapture + s.sorties * T.xpSortie + s.borderWins * T.xpBorderWin;
}
/** Army strength value: 1 at the start, rising (never falling) to 1 + bonusCap. */
export function rivalStrength(s) {
  const T = RIVAL_TUNE;
  return 1 + Math.min(T.bonusCap, T.bonusScale * Math.log2(1 + rivalXp(s) / 3));
}
/** Dwelling level: 0 at the start, +1 for each doubling of xp, capped. */
export function rivalDwellings(s) {
  return Math.min(RIVAL_TUNE.dwellingCap, Math.floor(Math.log2(1 + rivalXp(s))));
}
function rivalDerive(s) {
  s.strength = rivalStrength(s);
  s.dwellings = rivalDwellings(s);
  return s;
}

function rivalIntervalMs(s) {
  const T = RIVAL_TUNE;
  const base = Math.min(T.maxIntervalMs, T.baseIntervalMs + T.perNodeMs * Math.max(0, s.held.length - 1));
  const r = rivalRoll(s.seed, 'gap', s.regionNumber, s.moves);
  return Math.round(base * (1 + T.jitter * (2 * r - 1)));
}

function rivalMinesHeld(s, region) {
  let m = 0;
  for (const id of s.held) if (region.nodes[id] && region.nodes[id].type === 'mine') m++;
  return m;
}
function rivalClockTo(s, region, t) {
  if (t <= s.ms) return;
  s.mineMs += rivalMinesHeld(s, region) * (t - s.ms);
  s.ms = t;
}

// ---------- public API ----------

/**
 * createRival(region, { regionNumber, eloBase, seed }) -> RivalState
 * The rival starts holding only the citadel (the east keep).
 */
export function createRival(region, opts = {}) {
  if (!region || !region.nodes) throw new Error('rival: region required');
  const regionNumber = Math.max(1, Math.floor(Number(opts.regionNumber ?? region.regionNumber) || 1));
  const seed = String(opts.seed ?? region.seed);
  const s = {
    v: 1, seed, regionNumber,
    eloBase: Number.isFinite(opts.eloBase) ? opts.eloBase : RIVAL_TUNE.eloBase,
    nodeCount: region.nodes.length, seat: region.citadelId, playerKeep: region.keepId,
    status: 'active',           // 'active' | 'won' (took the player keep) | 'defeated' (lost its seat)
    held: [region.citadelId],
    ms: 0, frac: 0, mineMs: 0,
    moves: 0, captures: 0, sorties: 0, borderWins: 0, borderLosses: 0, lost: 0,
    nextMoveAt: 0, pending: null, cooldown: {}, handover: null,
    strength: 1, dwellings: 0,
  };
  s.nextMoveAt = Math.round(RIVAL_TUNE.firstMoveMs * (1 + RIVAL_TUNE.jitter * (2 * rivalRoll(seed, 'first', regionNumber) - 1)));
  return rivalDerive(s);
}

/**
 * advanceRival(state, region, playerHeld, dtSeconds, now?, opts?) -> { state, events }
 * - playerHeld: Set or array of node ids the player holds (the game is authoritative).
 * - now: optional wall-clock ms at the END of this advance; events then carry `wall`.
 *   May also be an options object ({ now, online }).
 * - opts.online: true for live ticks, false for offline catch-up. Default: dtSeconds <= 30.
 *   Offline: no keepAssault, no capture closer to the player keep than the player's own deepest
 *   held node (and never closer than 2 roads), at most one pending border battle (then it pauses).
 */
export function advanceRival(state, region, playerHeld, dtSeconds, now, opts) {
  if (now && typeof now === 'object') { opts = now; now = opts.now; }
  opts = opts || {};
  const dt = Number.isFinite(dtSeconds) && dtSeconds > 0 ? dtSeconds : 0;
  const online = opts.online != null ? !!opts.online : dt <= RIVAL_TUNE.onlineMaxDt;
  const s = rivalClone(state);
  rivalCheck(s, region);
  const P = rivalSet(playerHeld);
  const events = [];

  // 1. sync with the game: nodes the player took from the rival leave its territory
  if (s.handover != null && !P.has(s.handover)) s.handover = null;
  if (s.status === 'active') {
    if (P.has(s.seat)) {
      s.status = 'defeated'; s.pending = null; s.nextMoveAt = null;
    }
    const before = s.held.length;
    s.held = s.held.filter(id => !P.has(id) || id === s.handover);
    s.lost += before - s.held.length;
    if (s.pending && s.pending.type === 'borderBattle' && !P.has(s.pending.nodeId)) {
      // the contested node changed hands some other way: call the battle off
      s.pending = null; s.nextMoveAt = s.ms + rivalIntervalMs(s);
    }
  }

  // 2. advance the clock, acting at each scheduled move time
  const total = s.ms + s.frac + dt * 1000;
  const end = Math.max(s.ms, Math.floor(total + 1e-6));
  const adj = rivalAdj(region);
  while (s.status === 'active' && !s.pending && s.nextMoveAt != null && s.nextMoveAt <= end) {
    rivalClockTo(s, region, s.nextMoveAt);
    const ev = rivalMove(s, region, adj, P, online);
    if (now != null && Number.isFinite(now)) ev.wall = now - (end - ev.ms);
    events.push(ev);
  }
  rivalClockTo(s, region, end);
  s.frac = Math.max(0, total - end);
  rivalDerive(s);
  return { state: s, events };
}

// one action at time s.ms; mutates s; returns the event
function rivalMove(s, region, adj, P, online) {
  const T = RIVAL_TUNE, S = T.score, t = s.ms;
  for (const k of Object.keys(s.cooldown)) if (s.cooldown[k] <= t) delete s.cooldown[k];
  const mine = new Set(s.held);
  let edge = -Infinity;
  if (!online) {
    edge = T.offlineMinDist;
    for (const id of P) { const n = region.nodes[id]; if (n && n.dist > edge) edge = n.dist; }
  }
  const cand = new Set();
  for (const h of s.held) for (const v of adj[h]) if (!mine.has(v)) cand.add(v);
  let best = null, bestScore = -Infinity, bestKind = null;
  for (const id of [...cand].sort((p, q) => p - q)) {
    const n = region.nodes[id];
    let kind, score;
    if (id === s.playerKeep) {
      if (!online || s.held.length < T.keepAssaultMinHeld || s.cooldown[id] != null || !P.has(id)) continue;
      kind = 'keepAssault'; score = S.keep;
    } else if (P.has(id)) {
      if (s.cooldown[id] != null) continue;
      kind = 'borderBattle'; score = S[n.type] ?? 0;
    } else {
      if (n.dist < edge) continue;
      kind = 'capture'; score = (S[n.type] ?? 0) + S.neutralBonus;
    }
    score += -S.perDist * n.dist + Math.floor(rivalRoll(s.seed, 'pick', s.regionNumber, s.moves, id) * S.jitter);
    if (score > bestScore) { bestScore = score; best = id; bestKind = kind; }
  }
  s.moves++;
  let ev;
  if (best == null) {
    // nothing it may attack: it drills at its westernmost border node (small xp gain)
    let at = s.held[0], d = Infinity;
    for (const id of s.held) if (region.nodes[id].dist < d) { d = region.nodes[id].dist; at = id; }
    s.sorties++;
    ev = { type: 'sortie', nodeId: at };
  } else if (bestKind === 'capture') {
    rivalInsert(s.held, best);
    s.captures++;
    ev = { type: 'capture', nodeId: best };
  } else {
    s.pending = { type: bestKind, nodeId: best, at: t };
    ev = { type: bestKind, nodeId: best };
  }
  s.nextMoveAt = s.pending ? null : t + rivalIntervalMs(s);
  ev.at = t / 1000; ev.ms = t; ev.rivalStrength = rivalStrength(s);
  return ev;
}

/**
 * resolveBorder(state, nodeId, playerWon) -> state
 * Report the outcome of the pending borderBattle / keepAssault on nodeId.
 * playerWon: the rival retreats, the node is safe for a cooldown, its next move is delayed.
 * rival won: it takes the node (state.handover = nodeId: the game must remove it from the
 * player's held list), or for a keepAssault, state.status becomes 'won'.
 * A nodeId that does not match the pending battle returns an unchanged copy.
 */
export function resolveBorder(state, nodeId, playerWon) {
  const s = rivalClone(state);
  if (!s.pending || s.pending.nodeId !== nodeId) return s;
  const kind = s.pending.type;
  s.pending = null;
  if (playerWon) {
    s.borderLosses++;
    s.cooldown[nodeId] = s.ms + (kind === 'keepAssault' ? RIVAL_TUNE.keepCooldownMs : RIVAL_TUNE.nodeCooldownMs);
    s.nextMoveAt = s.ms + Math.round(rivalIntervalMs(s) * RIVAL_TUNE.retreatMult);
  } else {
    s.borderWins++;
    if (kind === 'keepAssault') {
      s.status = 'won'; s.nextMoveAt = null;
      rivalInsert(s.held, nodeId);
    } else {
      rivalInsert(s.held, nodeId);
      s.captures++;
      s.handover = nodeId;
      s.nextMoveAt = s.ms + rivalIntervalMs(s);
    }
  }
  return rivalDerive(s);
}

/** Seconds until the rival's next action, or null while a battle is pending or the rival is done. */
export function nextMoveEta(state) {
  if (state.status !== 'active' || state.pending || state.nextMoveAt == null) return null;
  return Math.max(0, (state.nextMoveAt - state.ms - (state.frac || 0)) / 1000);
}

/** True when the rival holds node id. */
export function rivalHolds(state, id) { return state.held.includes(id); }

/** Unheld nodes on the rival's border (neighbours of rival territory), sorted. */
export function rivalFrontier(state, region) {
  const adj = rivalAdj(region), mine = new Set(state.held), out = new Set();
  for (const h of state.held) for (const v of adj[h]) if (!mine.has(v)) out.add(v);
  return [...out].sort((p, q) => p - q);
}

/** owners(state, region, playerHeld) -> array by node id: 'player' | 'rival' | null. */
export function rivalOwners(state, region, playerHeld) {
  const P = rivalSet(playerHeld), R = new Set(state.held);
  return region.nodes.map(n => (R.has(n.id) && (!P.has(n.id) || n.id === state.handover) ? 'rival' : P.has(n.id) ? 'player' : null));
}

/** The rival's effective tier for armies: region base tier + strength (a float). */
export function rivalTier(state) {
  return (state.regionNumber - 1) * RIVAL_TUNE.tiersPerRegion + rivalStrength(state);
}

/**
 * rivalArmyFor(state, nodeId, region?) -> army spec
 *   { name, role, tier, budget, units, depth, elo, pieces: [{ type, square, sq }] }
 * role: 'keepAssault' (nodeId is the player keep), 'garrison' (a rival-held node the player
 * attacks) or 'border' (the rival attacks a player node). With region, the army is never weaker
 * than the node's own tier (garrison) or the node's tier - 1 (border). Pieces are on the black side
 * (ranks 8/7/6), type is an uppercase letter (K Q R B N P), sq is 0..63 with a1 = 0.
 * Deterministic: depends on the seed, node, role and floor(tier).
 */
export function rivalArmyFor(state, nodeId, region) {
  const T = RIVAL_TUNE;
  const role = nodeId === state.playerKeep ? 'keepAssault' : state.held.includes(nodeId) ? 'garrison' : 'border';
  let tier = rivalTier(state);
  const node = region && region.nodes && region.nodes[nodeId];
  if (node) tier = Math.max(tier, role === 'garrison' ? node.tier : node.tier - 1);
  if (role === 'keepAssault') tier += 1;
  const mult = role === 'keepAssault' ? T.multKeep : role === 'garrison' ? T.multGarrison : T.multBorder;
  const budget0 = T.budgetBase * Math.pow(T.budgetGrowth, tier) * mult;
  const forms = RIVAL_FORMATIONS.filter(f => !f.keep);
  const fm = role === 'keepAssault' ? RIVAL_FORMATIONS.find(f => f.keep)
    : forms[rivalHash([state.seed, 'army', state.regionNumber, nodeId, role, Math.floor(tier)].join('|')) % forms.length];
  const out = rivalFill(fm, budget0);
  const depth = Math.min(4, 1 + Math.floor(tier / 8)) + (role === 'keepAssault' ? 1 : 0);
  const elo = Math.round(state.eloBase + T.eloPerStrength * (rivalStrength(state) - 1));
  const units = out.reduce((a, p) => a + RIVAL_UNITS[p.t], 0);
  return {
    name: fm.name, role, tier, budget: budget0, units, depth, elo,
    pieces: out.map(p => ({ type: p.t, square: p.name, sq: rivalSq(p.name) })),
  };
}

// same fill rule as engine.mjs enemyArmy: slots in order while affordable, expensive slots fall
// back to a knight or a pawn, then an upgrade pass spends what is left
function rivalFill(fm, budget) {
  const slots = fm.s.split(' ').map(x => ({ t: x[0], name: x.slice(1) }));
  const out = [{ t: 'K', name: fm.k }];
  const unused = [];
  for (const sl of slots) {
    const v = RIVAL_UNITS[sl.t];
    if (v <= budget + 0.5) { out.push({ t: sl.t, name: sl.name }); budget -= v; }
    else if (budget >= 2.5 && (sl.t === 'R' || sl.t === 'Q')) { out.push({ t: 'N', name: sl.name }); budget -= 3; }
    else unused.push(sl);
  }
  for (const sl of unused) if (budget >= 0.5) { out.push({ t: 'P', name: sl.name }); budget -= 1; }
  const up = { P: ['N', 2], N: ['R', 2], B: ['R', 2], R: ['Q', 4] };
  let changed = true;
  while (budget >= 2 && changed) {
    changed = false;
    for (const pc of out) {
      if (pc.t === 'P' && (pc.name[1] === '1' || pc.name[1] === '8')) continue;
      const u = up[pc.t]; if (!u || budget < u[1] - 0.25) continue;
      pc.t = u[0]; budget -= u[1]; changed = true; if (budget < 2) break;
    }
  }
  return out;
}
