// Checkmarch MATERIALS + FORGE — pure, deterministic ES module (no DOM, no Math.random, no Date.now).
// Every function that needs the time takes `now` (ms since epoch) and every function that needs
// randomness takes an injected `rng()` returning [0,1). State is plain JSON; functions never mutate
// their input state, they return a fresh copy.
//
// Time model
//  - Trickle: exact integer arithmetic. Each resource keeps a fractional remainder `frac` measured in
//    1/3_600_000ths of a unit, so ticking once over 2h or 7200 times over 1s gives the same stockpile.
//  - Any single gap between ticks is capped at OFFLINE_CAP_MS (8h). A clock that moves backwards
//    accrues nothing until it passes the last seen timestamp again (lastTs never decreases).
//  - Daily smelt cap: UTC calendar days (dayIndex = floor(now / 86_400_000)). Resets at 00:00 UTC.
//    UTC has no DST, so a day is always exactly 24h and local DST shifts cannot double or skip a reset.

export const FORGE_VERSION = 1;
export const HOUR_MS = 3600000;
export const DAY_MS = 86400000;
export const OFFLINE_CAP_MS = 8 * HOUR_MS;
export const STOCK_CAP_HOURS = 24;        // stockpile cap = 24h of current output for that resource

// ---- materials ----
export const MATERIALS = ['wood', 'iron', 'steel', 'obsidian'];
export const MATERIAL_LABEL = { wood: 'Wood', iron: 'Iron', steel: 'Steel', obsidian: 'Obsidian' };
export const tierOf = m => { const i = MATERIALS.indexOf(m); return i < 0 ? 0 : i; };
export const nextMaterial = m => MATERIALS[tierOf(m) + 1] || null;

// ---- resources and mines ----
export const RESOURCES = ['tin', 'coal', 'iron', 'shards'];
export const RESOURCE_LABEL = { tin: 'Tin ore', coal: 'Coal', iron: 'Iron ore', shards: 'Obsidian shards' };
// units per hour per held mine of that resource
export const RATES = { tin: 8, coal: 8, iron: 7, shards: 6 };

// ---- recipes: bar name = the material it upgrades a piece TO ----
export const RECIPES = {
  iron:     { in: { tin: 3, coal: 2 },  label: 'Iron bar' },
  steel:    { in: { iron: 3, coal: 3 }, label: 'Steel bar' },
  obsidian: { in: { shards: 4 },        label: 'Obsidian bar' },
};
export const BASE_SMELTS_PER_DAY = 1;
export const MAX_SMELT_LEVEL = 3;          // up to 4 smelts/day
export function smeltLevelPrice(level) { return Math.round(500 * Math.pow(3, level)); } // gold, suggestion only

// ---- counter rule ----
export const COUNTER_CHANCE = 0.25;
// ---- engine eval: centipawns per material tier (wood 0, iron 15, steel 30, obsidian 45) ----
export const EVAL_CP_PER_TIER = 15;

const clone = s => JSON.parse(JSON.stringify(s));
const dayIndex = now => Math.floor(now / DAY_MS);
const zeroRes = () => ({ tin: 0, coal: 0, iron: 0, shards: 0 });

export function createForge(now) {
  return {
    v: FORGE_VERSION,
    lastTs: Math.floor(now),
    stock: zeroRes(),             // whole units
    frac: zeroRes(),              // remainder in 1/3_600_000 unit
    bars: { iron: 0, steel: 0, obsidian: 0 },
    smelt: { day: dayIndex(now), used: 0, level: 0 },
    mats: {},                     // pieceId -> material (absent = wood)
    lost: { iron: 0, steel: 0, obsidian: 0 }, // lifetime bars destroyed by perma-death (stats)
  };
}

// Normalize a possibly old / hand-edited save. Unknown fields are dropped.
export function loadForge(raw, now) {
  const f = createForge(now);
  if (!raw || typeof raw !== 'object') return f;
  const n = (x, lo = 0) => (Number.isFinite(+x) ? Math.max(lo, Math.floor(+x)) : lo);
  if (Number.isFinite(+raw.lastTs)) f.lastTs = Math.floor(+raw.lastTs);
  for (const r of RESOURCES) { f.stock[r] = n(raw.stock && raw.stock[r]); f.frac[r] = Math.min(HOUR_MS - 1, n(raw.frac && raw.frac[r])); }
  for (const b of Object.keys(f.bars)) { f.bars[b] = n(raw.bars && raw.bars[b]); f.lost[b] = n(raw.lost && raw.lost[b]); }
  if (raw.smelt) { f.smelt.day = n(raw.smelt.day); f.smelt.used = n(raw.smelt.used); f.smelt.level = Math.min(MAX_SMELT_LEVEL, n(raw.smelt.level)); }
  if (raw.mats) for (const k of Object.keys(raw.mats)) { const m = raw.mats[k]; if (tierOf(m) > 0) f.mats[k] = m; }
  return f;
}

// count held mines per resource (dedup by id; unknown resources ignored)
export function mineCounts(heldMines) {
  const c = zeroRes(), seen = new Set();
  for (const m of heldMines || []) {
    if (!m || seen.has(m.id) || !(m.resource in c)) continue;
    seen.add(m.id); c[m.resource]++;
  }
  return c;
}
export function stockCap(resource, count) { return RATES[resource] * STOCK_CAP_HOURS * Math.max(1, count); }
export function ratePerHour(heldMines) { const c = mineCounts(heldMines), o = {}; for (const r of RESOURCES) o[r] = RATES[r] * c[r]; return o; }

export function tickForge(state, heldMines, now) {
  const s = clone(state);
  now = Math.floor(now);
  if (!(now > s.lastTs)) return s;                  // clock went back or no time: nothing, keep lastTs
  const dt = Math.min(OFFLINE_CAP_MS, now - s.lastTs);
  s.lastTs = now;
  const c = mineCounts(heldMines);
  for (const r of RESOURCES) {
    const cap = stockCap(r, c[r]);
    if (!c[r]) continue;                            // no mine: no accrual (frac kept for when one returns)
    if (s.stock[r] >= cap) { s.frac[r] = 0; continue; }
    const num = s.frac[r] + dt * RATES[r] * c[r];   // in 1/3.6e6 units; < 2^53 for any sane mine count
    const whole = Math.floor(num / HOUR_MS);
    s.stock[r] += whole; s.frac[r] = num - whole * HOUR_MS;
    if (s.stock[r] >= cap) { s.stock[r] = cap; s.frac[r] = 0; }
  }
  return s;
}

// fractional view for progress bars (0..1 to the next unit)
export function stockFraction(state, resource) { return state.frac[resource] / HOUR_MS; }

function rollDay(s, now) { const d = dayIndex(now); if (d > s.smelt.day) { s.smelt.day = d; s.smelt.used = 0; } }
export function smeltsPerDay(state) { return BASE_SMELTS_PER_DAY + (state.smelt.level | 0); }
export function smeltsLeft(state, now) { const s = clone(state); rollDay(s, now); return Math.max(0, smeltsPerDay(s) - s.smelt.used); }
export function nextResetAt(now) { return (dayIndex(now) + 1) * DAY_MS; }
export function canSmelt(state, recipe, now) {
  const rc = RECIPES[recipe];
  if (!rc) return { ok: false, reason: 'unknown-recipe' };
  if (smeltsLeft(state, now) <= 0) return { ok: false, reason: 'daily-cap' };
  for (const r of Object.keys(rc.in)) if (state.stock[r] < rc.in[r]) return { ok: false, reason: 'missing-' + r };
  return { ok: true };
}

export function smelt(state, recipe, now) {
  const chk = canSmelt(state, recipe, now);
  const s = clone(state); rollDay(s, now);
  if (!chk.ok) return { state: s, ok: false, reason: chk.reason };
  const rc = RECIPES[recipe];
  for (const r of Object.keys(rc.in)) s.stock[r] -= rc.in[r];
  s.bars[recipe]++; s.smelt.used++;
  return { state: s, ok: true };
}

export function upgradeSmeltCap(state) {
  const s = clone(state);
  if (s.smelt.level >= MAX_SMELT_LEVEL) return { state: s, ok: false, reason: 'max-level' };
  s.smelt.level++;
  return { state: s, ok: true };
}

export function materialOf(state, pieceId) { return state.mats[pieceId] || 'wood'; }

// Upgrades a piece exactly one tier, consuming the bar named after the new material.
// currentMaterial is what the caller believes; if the forge has a record for the piece it must agree.
export function applyBar(state, pieceId, currentMaterial) {
  const s = clone(state);
  const cur = currentMaterial || materialOf(s, pieceId);
  if (s.mats[pieceId] && s.mats[pieceId] !== cur) return { ok: false, reason: 'material-mismatch', newMaterial: materialOf(s, pieceId), state: s };
  const nxt = nextMaterial(cur);
  if (!nxt) return { ok: false, reason: 'max-tier', newMaterial: cur, state: s };
  if (s.bars[nxt] <= 0) return { ok: false, reason: 'no-' + nxt + '-bar', newMaterial: cur, state: s };
  s.bars[nxt]--; s.mats[pieceId] = nxt;
  return { ok: true, newMaterial: nxt, state: s };
}

// Perma-death: the piece and every bar invested in it are gone.
export function barsInvested(material) { return MATERIALS.slice(1, tierOf(material) + 1); }
export function losePiece(state, pieceId) {
  const s = clone(state);
  const lost = barsInvested(materialOf(s, pieceId));
  for (const b of lost) s.lost[b]++;
  delete s.mats[pieceId];
  return { state: s, lostBars: lost };
}

// Counter rule: attacker vs target exactly one tier above -> 25% the capture fails.
// rng is consumed ONLY when the rule applies, so replays stay aligned. `roll` is returned for display.
export function counterCheck(attackerMaterial, targetMaterial, rng) {
  const applies = tierOf(targetMaterial) === tierOf(attackerMaterial) + 1;
  if (!applies) return { fails: false, chance: 0, roll: null };
  const roll = rng();
  return { fails: roll < COUNTER_CHANCE, chance: COUNTER_CHANCE, roll };
}

// Where the attacker ends up when a capture fails.
// move: { from, to, piece } — from/to are square indices (sq = rank*boardN + file, the engine's layout)
//   or [file, rank] pairs (the result uses the same form); piece: 'P','N','B','R','Q','K' or engine 1..6.
// Sliders (B, R, Q) stop on the last free square before the target along their path (adjacent capture =
// origin). blockedFn(sq) may report extra blocked squares; the slider then stops before the first one.
// Pawn, knight, king: origin.
const TYPE_NUM = { P: 1, N: 2, B: 3, R: 4, Q: 5, K: 6 };
export function captureFallback(move, boardN = 8, blockedFn = () => false) {
  const arr = Array.isArray(move.from);
  const toFR = v => (Array.isArray(v) ? [v[0], v[1]] : [v % boardN, Math.floor(v / boardN)]);
  const out = (f, r) => (arr ? [f, r] : r * boardN + f);
  const [ff, fr] = toFR(move.from), [tf, tr] = toFR(move.to);
  const t = typeof move.piece === 'number' ? move.piece : TYPE_NUM[String(move.piece || '').toUpperCase()];
  const origin = out(ff, fr);
  if (t !== 3 && t !== 4 && t !== 5) return origin;
  const df = tf - ff, dr = tr - fr, n = Math.max(Math.abs(df), Math.abs(dr));
  const straight = df === 0 || dr === 0, diag = Math.abs(df) === Math.abs(dr);
  if (!n || !(straight || diag) || (t === 3 && !diag) || (t === 4 && !straight)) return origin; // not a slide
  const sf = Math.sign(df), sr = Math.sign(dr);
  let f = ff, r = fr;
  for (let i = 1; i < n; i++) {
    const nf = ff + sf * i, nr = fr + sr * i;
    if (blockedFn(out(nf, nr))) break;
    f = nf; r = nr;
  }
  return out(f, r);
}

export function evalBonus(material) { return tierOf(material) * EVAL_CP_PER_TIER; }

// seeded rng for announced rolls (same algorithm as engine.mjs mulberry)
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
