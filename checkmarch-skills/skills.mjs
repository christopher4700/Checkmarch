// Checkmarch skills: RuneScape-style PERMANENT levels per piece type (P N B R Q K), 1..99.
// Pure logic, no DOM, no imports, no randomness: every function is deterministic over plain JSON.
//
// Save shape (lives on `state`, NOT on `run`, so it survives endRun):
//   state.skills = { P: { xp }, N: { xp }, B: { xp }, R: { xp }, Q: { xp }, K: { xp }, mg: number }
//   xp: integer >= 0 (capped at XP_CAP); mg: mine gold banked toward the next mine milestone (0..XP_TABLE.mineEvery)
// Battle tally (lives on the live battle, serialize it with the battle):
//   tally = { f: {type: fielded}, l: {type: lost}, c: {type: victim pawn-units captured}, p: promotions, m: mating type | null }
// Flow: XP sources -> gains {type: xp} -> applyGains(skills, gains) -> { gained, dings } (dings = toasts + sounds).

export const SKILL_TYPES = ['P', 'N', 'B', 'R', 'Q', 'K'];
export const SKILL_NAMES = { P: 'Pawncraft', N: 'Knightcraft', B: 'Bishopcraft', R: 'Rookcraft', Q: 'Queencraft', K: 'Leadership' };
const NOUN = { P: ['pawn', 'pawns'], N: ['knight', 'knights'], B: ['bishop', 'bishops'], R: ['rook', 'rooks'], Q: ['queen', 'queens'], K: ['king', 'kings'] };
const isType = t => typeof t === 'string' && SKILL_TYPES.includes(t);

// ---- XP award table: the ONE place balance tunes where XP comes from ----
// Every battle award is multiplied by tierMult(tier) = min(tierMultMax, 1 + tierStep x (tier - 1)).
export const XP_TABLE = {
  victim: { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 }, // pawn-units of a captured enemy piece
  capture: 10,     // per victim pawn-unit, to the capturing piece's type (pawn 10, knight/bishop 30, rook 50, queen 90)
  survive: 4,      // per fielded piece still standing at the end (any result except your own King mated)
  win: 8,          // per fielded piece, on a win
  lead: 2,         // on a win, to K (Leadership): per non-King piece fielded
  mate: 150,       // checkmate delivered: to the type that gave mate (big)
  promote: 30,     // a pawn reached the last rank (any result): to P
  march: 6,        // a march arrived: to K (tiny)
  mineEvery: 250,  // every 250 gold of mine income ...
  mine: 4,         // ... +4 XP to each type garrisoned at mines (P if none); not tier-scaled (gold already is)
  mineMaxPerCall: 40, // milestones paid by one mineXp() call at most (guards huge offline/garbage amounts)
  tierStep: 0.04, tierMultMax: 4,
};
export function tierMult(tier) {
  const t = Math.max(1, Math.floor(+tier) || 1);
  return Math.min(XP_TABLE.tierMultMax, 1 + XP_TABLE.tierStep * (t - 1));
}

// ---- level curve: the RuneScape formula with a gentler doubling (div 9 instead of 7) ----
// xp(L) = floor( sum_{l=1}^{L-1} floor(l + base x 2^(l/div)) / 4 ):  L2 81, L10 1022, L30 8535, L50 43347, L99 1918756.
export const CURVE = { base: 300, div: 9, maxLevel: 99 };
export const MAX_LEVEL = CURVE.maxLevel;
export const XP_CAP = 50000000;
const XPT = [0, 0]; // XPT[L] = total xp needed for level L
{
  let s = 0;
  for (let L = 2; L <= MAX_LEVEL; L++) { s += Math.floor(L - 1 + CURVE.base * Math.pow(2, (L - 1) / CURVE.div)); XPT[L] = Math.floor(s / 4); }
}
export function xpForLevel(l) {
  l = Math.floor(+l);
  if (!(l >= 1)) return 0;
  return XPT[Math.min(MAX_LEVEL, l)];
}
const cleanXp = xp => { xp = Math.floor(+xp); return Number.isFinite(xp) && xp > 0 ? Math.min(XP_CAP, xp) : 0; };
export function levelForXp(xp) {
  xp = cleanXp(xp);
  let lo = 1, hi = MAX_LEVEL; // largest L with XPT[L] <= xp
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (XPT[mid] <= xp) lo = mid; else hi = mid - 1; }
  return lo;
}
// for UI bars: { level, frac 0..1 toward the next level (1 at 99), into, need, next: xp total for next level | null }
export function levelProgress(xp) {
  xp = cleanXp(xp);
  const level = levelForXp(xp);
  if (level >= MAX_LEVEL) return { level, frac: 1, into: xp - XPT[MAX_LEVEL], need: 0, next: null };
  const a = XPT[level], b = XPT[level + 1];
  return { level, frac: (xp - a) / (b - a), into: xp - a, need: b - xp, next: b };
}
export function progressFrac(xp) { return levelProgress(xp).frac; }

// ---- perks: tiny per level, permanent, and on axes the run systems don't touch ----
// Dwellings give per-run trait chances; Memories give starting pawns/squares/gold/Tactician; materials give tiers.
// Skills give: a shop discount per type (K: formation squares), free starting pieces at milestones, K march speed, titles.
export const PERK_TABLE = {
  discPerLevel: 0.0025, discCap: 0.25, // -0.25% per level on that type's shop price (K: squares): every level pays;
  discFullAt: 99,                      // 98 x 0.25% = 24.5%, and level 99 snaps to the full 25% cap (99 x 0.25% would be 24.75%)
  start: { P: { every: 10 }, N: { at: [30, 60, 90] }, B: { at: [30, 60, 90] }, R: { at: [45, 90] }, Q: { at: [99] }, K: null },
  marchPerLevel: 0.0015, marchCap: 0.15, // K only: march ticks -0.15% per level (99: -14.9%)
};
export const TITLE_LEVELS = [1, 10, 20, 30, 40, 50, 60, 70, 80, 90, 99];
export const TITLES = {
  P: ['Recruit', 'Militiaman', 'Yeoman', 'Footman', 'Sergeant', 'Veteran', 'Pikemaster', 'Warden', 'Old Guard', 'Iron Line', 'Pawn Eternal'],
  N: ['Groom', 'Rider', 'Squire', 'Outrider', 'Knight', 'Banneret', 'Paladin', 'Lancer Captain', 'Marshal', 'Champion', 'Grandmaster of Horse'],
  B: ['Acolyte', 'Deacon', 'Priest', 'Chaplain', 'Vicar', 'Canon', 'Abbot', 'Prelate', 'Archdeacon', 'Cardinal', 'Pontiff'],
  R: ['Mason', 'Gatekeeper', 'Watchman', 'Wallwarden', 'Towerguard', 'Bastion', 'Siegebreaker', 'Keepmaster', 'Rampart Lord', 'Iron Tower', 'Unbreached'],
  Q: ['Page', 'Courtier', 'Countess', 'Duchess', 'Archduchess', 'Regent', 'Sovereign', 'Empress', 'Warqueen', 'High Queen', 'Queen Eternal'],
  K: ['Chieftain', 'Thane', 'Baron', 'Viscount', 'Earl', 'Marquis', 'Duke', 'Prince', 'King', 'High King', 'Emperor'],
};
const clampLevel = l => { l = Math.floor(+l); return l >= 1 ? Math.min(MAX_LEVEL, l) : 1; };
const r4 = x => Math.round(x * 1e4) / 1e4; // perk fractions without float drift (12 x 0.0025 = 0.03 exactly)
function titleIdx(level) { let i = 0; while (i + 1 < TITLE_LEVELS.length && TITLE_LEVELS[i + 1] <= level) i++; return i; }
export function startCount(type, level) {
  const s = PERK_TABLE.start[type]; if (!s) return 0;
  level = clampLevel(level);
  return s.every ? Math.floor(level / s.every) : s.at.filter(a => level >= a).length;
}
// perksFor(type, level) -> what the game applies for one skill. Unknown type -> null.
export function perksFor(type, level) {
  if (!isType(type)) return null;
  const L = clampLevel(level), T = PERK_TABLE, ti = titleIdx(L), nx = ti + 1 < TITLE_LEVELS.length ? ti + 1 : -1;
  return {
    type, level: L, skill: SKILL_NAMES[type],
    title: TITLES[type][ti],
    nextTitle: nx < 0 ? null : { level: TITLE_LEVELS[nx], title: TITLES[type][nx] },
    discount: L >= T.discFullAt ? T.discCap : r4(Math.min(T.discCap, L * T.discPerLevel)), // fraction off the price
    discountOn: type === 'K' ? 'square' : 'piece',           // piece: buyPiece(type); square: buySquare
    start: startCount(type, L),                              // free pieces of this type at run start (reserve)
    marchCut: type === 'K' ? r4(Math.min(T.marchCap, L * T.marchPerLevel)) : 0, // fraction off march ticks
  };
}

// ---- save sub-schema ----
export function newSkills() { const o = {}; for (const t of SKILL_TYPES) o[t] = { xp: 0 }; o.mg = 0; return o; }
// tolerant of anything: missing, null, strings, arrays, NaN, negative, {P: 123} (bare numbers), extra keys (dropped)
export function cleanSkills(s) {
  const o = newSkills();
  if (!s || typeof s !== 'object' || Array.isArray(s)) return o;
  for (const t of SKILL_TYPES) {
    const v = s[t];
    o[t].xp = cleanXp(v && typeof v === 'object' ? v.xp : v);
  }
  const mg = +s.mg;
  o.mg = Number.isFinite(mg) && mg > 0 ? Math.min(XP_TABLE.mineEvery, Math.round(mg * 100) / 100) : 0;
  return o;
}
export function skillXp(skills, type) { const v = skills && skills[type]; return cleanXp(v && v.xp); }
export function skillLevel(skills, type) { return levelForXp(skillXp(skills, type)); }
export function allPerks(skills) { const o = {}; for (const t of SKILL_TYPES) o[t] = perksFor(t, skillLevel(skills, t)); return o; }
export function totalLevel(skills) { let n = 0; for (const t of SKILL_TYPES) n += skillLevel(skills, t); return n; }

// ---- applying perks (integrator helpers; plain numbers in, plain numbers out) ----
// price after the skill discount; compose BEFORE engine effPrice (town/coupon): effPrice(run, skillPrice(skills, t, base))
export function skillPrice(skills, type, price) {
  const p = perksFor(type, skillLevel(skills, type));
  return p ? Math.round(price * (1 - p.discount)) : price;
}
export function squarePriceSkill(skills, price) { return skillPrice(skills, 'K', price); }
export function marchTicksSkill(skills, ticks) {
  const cut = perksFor('K', skillLevel(skills, 'K')).marchCut;
  return Math.max(1, Math.round(ticks * (1 - cut)));
}
// flat derived modifiers for engine code that only sees `run`: cache as run.skillMods = skillMods(state.skills)
// on load, at run start and after every applyGains. { P, N, B, R, Q: price fraction off, sq: square fraction off, march: tick fraction off }
export function skillMods(skills) {
  const o = {};
  for (const t of SKILL_TYPES) if (t !== 'K') o[t] = perksFor(t, skillLevel(skills, t)).discount;
  const k = perksFor('K', skillLevel(skills, 'K'));
  o.sq = k.discount; o.march = k.marchCut;
  return o;
}
// { P, N, B, R, Q }: free pieces a new run starts with in its reserve
export function startBonus(skills) { const o = {}; for (const t of SKILL_TYPES) if (t !== 'K') o[t] = startCount(t, skillLevel(skills, t)); return o; }
// mutates a fresh engine run (newRun/rebuildRun result): pushes the bonus pieces into the RESERVE (roster, not placed),
// without touching run.bought (free pieces do not raise shop prices). Idempotent per run via run.skillStart.
export function grantStart(run, skills) {
  if (!run || !Array.isArray(run.roster) || run.skillStart) return null;
  const b = startBonus(skills);
  for (const t of ['Q', 'R', 'B', 'N', 'P']) for (let i = 0; i < b[t]; i++) run.roster.push({ id: run.nextId++, t });
  run.skillStart = b;
  return b;
}

// ---- level-up "dings" ----
const pct = f => String(+(f * 100).toFixed(2));
function dingParts(type, a, b) {
  const parts = [], [one, many] = NOUN[type];
  if (b.discount !== a.discount) {
    const what = type === 'K' ? 'squares' : many, cap = b.discount >= PERK_TABLE.discCap ? ' (max)' : '';
    parts.push(`${what} now ${pct(b.discount)}% cheaper${cap}`);
  }
  if (b.marchCut !== a.marchCut) parts.push(`marches ${pct(b.marchCut)}% faster`);
  if (b.start !== a.start) parts.push(`runs start with ${b.start} extra ${b.start === 1 ? one : many}`);
  if (b.title !== a.title) parts.push(`title: ${b.title}`);
  return parts;
}
// levelUps(oldXp, newXp, type) -> one entry per level crossed, lowest first:
//   { type, skill, level, text: "Knightcraft 12 — knights now 3% cheaper", title: string | null (new title),
//     start: +n free pieces gained at this level, big: true on a title, a start bonus, every 10th level and 99 }
// Without a (valid) type the entries are generic ("Level 12"). newXp <= oldXp -> [].
export function levelUps(oldXp, newXp, type) {
  const lo = levelForXp(oldXp), hi = levelForXp(newXp), out = [];
  for (let L = lo + 1; L <= hi; L++) {
    if (!isType(type)) { out.push({ type: null, skill: null, level: L, text: `Level ${L}`, title: null, start: 0, big: L % 10 === 0 || L === MAX_LEVEL }); continue; }
    const a = perksFor(type, L - 1), b = perksFor(type, L), parts = dingParts(type, a, b);
    out.push({ type, skill: b.skill, level: L, text: `${b.skill} ${L} — ${parts.length ? parts.join(', ') : 'mastery deepens'}`,
      title: b.title !== a.title ? b.title : null, start: b.start - a.start,
      big: b.title !== a.title || b.start !== a.start || L % 10 === 0 || L === MAX_LEVEL });
  }
  return out;
}

// ---- XP sources -> gains ----
export function newTally(types) {
  const t = { f: {}, l: {}, c: {}, p: 0, m: null };
  if (Array.isArray(types)) for (const x of types) if (isType(x)) t.f[x] = (t.f[x] || 0) + 1;
  return t;
}
export function cleanTally(t) {
  const o = newTally(), cnt = (src, k) => { const v = Math.floor(+(src && src[k])); return v > 0 ? Math.min(1000, v) : 0; };
  if (!t || typeof t !== 'object') return o;
  for (const x of SKILL_TYPES) {
    const f = cnt(t.f, x), l = cnt(t.l, x), c = cnt(t.c, x);
    if (f) o.f[x] = f; if (l) o.l[x] = l; if (c) o.c[x] = c;
  }
  o.p = cnt(t, 'p'); o.m = isType(t.m) ? t.m : null;
  return o;
}
// a player capture that STOOD (not undone by an enemy trait): by = capturing type, victim = captured type
export function noteCapture(tally, by, victim) {
  if (!tally || !isType(by) || !isType(victim)) return tally;
  const v = XP_TABLE.victim[victim] | 0; if (v) tally.c[by] = (tally.c[by] || 0) + v;
  return tally;
}
export function noteLoss(tally, type) { if (tally && isType(type)) tally.l[type] = (tally.l[type] || 0) + 1; return tally; }
export function notePromotion(tally) { if (tally) tally.p = (tally.p | 0) + 1; return tally; }
export function noteMate(tally, type) { if (tally && isType(type)) tally.m = type; return tally; }

const addG = (g, t, n) => { if (n > 0) g[t] = (g[t] || 0) + n; };
function scaled(g, mult) { const o = {}; for (const t of SKILL_TYPES) { const n = Math.round((g[t] || 0) * mult); if (n > 0) o[t] = n; } return o; }
// one capture on its own (e.g. for a floating "+30" over the board); battleXp already counts captures from the tally
export function captureXp(by, victim, tier) {
  if (!isType(by) || !isType(victim)) return {};
  return scaled({ [by]: XP_TABLE.victim[victim] * XP_TABLE.capture }, tierMult(tier));
}
// result: 'win' | 'draw' | 'loss' | 'mate' (the player's King mated). Returns gains {type: xp}.
export function battleXp(tally, result, tier) {
  const t = cleanTally(tally), X = XP_TABLE, g = {};
  for (const x of SKILL_TYPES) addG(g, x, (t.c[x] || 0) * X.capture);
  if (result !== 'mate') for (const x of SKILL_TYPES) addG(g, x, Math.max(0, (t.f[x] || 0) - (t.l[x] || 0)) * X.survive);
  if (result === 'win') {
    let army = 0;
    for (const x of SKILL_TYPES) { addG(g, x, (t.f[x] || 0) * X.win); if (x !== 'K') army += t.f[x] || 0; }
    if (t.f.K) addG(g, 'K', army * X.lead);
    if (t.m) addG(g, t.m, X.mate);
  }
  addG(g, 'P', t.p * X.promote);
  return scaled(g, tierMult(tier));
}
export function marchXp(tier) { return scaled({ K: XP_TABLE.march }, tierMult(tier)); }
// bank mine income (mutates skills.mg); every mineEvery gold pays `mine` XP to each garrisoned type (P if none)
export function mineXp(skills, gold, types) {
  if (!skills || typeof skills !== 'object') return {};
  const X = XP_TABLE, gd = +gold;
  let acc = (+skills.mg || 0) + (Number.isFinite(gd) && gd > 0 ? gd : 0);
  let n = Math.floor(acc / X.mineEvery);
  acc -= n * X.mineEvery;
  if (n > X.mineMaxPerCall) n = X.mineMaxPerCall;
  skills.mg = Math.round(Math.min(X.mineEvery, Math.max(0, acc)) * 100) / 100;
  if (!n) return {};
  let ts = Array.isArray(types) ? [...new Set(types.filter(x => isType(x) && x !== 'K'))] : [];
  if (!ts.length) ts = ['P'];
  const g = {}; for (const x of ts) g[x] = n * X.mine;
  return g;
}
export function mergeGains(...gs) { const o = {}; for (const g of gs) if (g) for (const t of SKILL_TYPES) addG(o, t, Math.floor(+g[t]) || 0); return o; }

// apply gains (mutates skills; repairs it first if needed). Returns { gained: {type: xp actually added}, dings: [...] }
export function applyGains(skills, gains) {
  const out = { gained: {}, dings: [] };
  if (!skills || typeof skills !== 'object' || !gains) return out;
  for (const t of SKILL_TYPES) {
    const add = Math.floor(+gains[t]);
    if (!(add > 0)) continue;
    if (!skills[t] || typeof skills[t] !== 'object') skills[t] = { xp: 0 };
    const old = cleanXp(skills[t].xp), nw = Math.min(XP_CAP, old + add);
    skills[t].xp = nw;
    if (nw > old) { out.gained[t] = nw - old; out.dings.push(...levelUps(old, nw, t)); }
  }
  return out;
}
// "+56 Pawncraft · +18 Leadership" for a battle-result line
export function gainText(gained) {
  return SKILL_TYPES.filter(t => gained && gained[t] > 0).map(t => `+${gained[t]} ${SKILL_NAMES[t]}`).join(' · ');
}
// one toast per skill: a multi-level jump (9 -> 12) folds into "Pawncraft 12 — ... title: Militiaman" with the deltas
// over the whole jump; big if any crossed level was big. Big toasts first.
export function dingToasts(dings) {
  const by = {};
  for (const d of dings || []) {
    if (!d || !isType(d.type)) continue;
    const b = by[d.type] || (by[d.type] = { lo: d.level, hi: d.level, big: false });
    b.lo = Math.min(b.lo, d.level); b.hi = Math.max(b.hi, d.level); b.big = b.big || !!d.big;
  }
  const out = [];
  for (const t of SKILL_TYPES) {
    const b = by[t]; if (!b) continue;
    const a = perksFor(t, b.lo - 1), z = perksFor(t, b.hi), parts = dingParts(t, a, z);
    out.push({ type: t, skill: z.skill, level: b.hi, from: b.lo - 1, text: `${z.skill} ${b.hi} — ${parts.length ? parts.join(', ') : 'mastery deepens'}`,
      title: z.title !== a.title ? z.title : null, start: z.start - a.start, big: b.big });
  }
  return out.sort((x, y) => (y.big - x.big) || (y.level - x.level));
}
