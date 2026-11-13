// Checkmarch discovery: road treasure, run artifacts, named one-off locations and scouting.
// Pure ES module, no DOM, no Math.random, no Date. Effects use the content pack's vocabulary
// (content.mjs EFFECT_KINDS); the few new kinds are registered into it at load (DISCOVERY_EFFECT_KINDS).
// State lives on run.map (see DISCOVERY-API.md "Save"):
//   disc: 1 | 0 (0 = an old save: no discovery content until the next region)
//   treasure: [{a, b, t, k: 'gold'|'res'|'memory'|'art', e: effect, art?: id, got: 0|1}]  (a < b: a road)
//   sites: [{at, arch, v, dx, dy, focus: id|null, prize: artId|null, done: 0|'a'|'b', later: bool}]
//   scouted: id[] (sorted; fog lifted without holding)
// Held artifacts live on run.arts: [{id, r}] (run-scoped, so they survive newWorldMap; a new run drops them).
//   site: index | null (a location card is open), ambush: {site, v} | null (a site battle waits)
import { mapHashSeed, mapMulberry32, generateRegion, visibility, mapAdjacency } from './map.mjs';
import { EFFECT_KINDS, EVENT_LINES, effectParts, effectMinRegion, validateEffect, fillLine } from './content.mjs';

export const DISC_VERSION = 1;
export const DISC = {
  edgesPerTreasure: 4.5, treasureMin: 2,
  kindW: [['gold', 0.62], ['res', 0.30], ['memory', 0.04], ['art', 0.04]],
  goldLo: 15, goldHi: 30, richMult: 1.25, growth: 1.6,      // gold pile = U(lo,hi) x 1.6^(region-1) (x1.25 rich band)
  resW: [['tin', 0.35], ['coal', 0.35], ['iron', 0.22], ['shards', 0.08]],
  resLo: 3, resHi: 7, resPerRegion: 0.25,                     // units = U(lo,hi) x (1 + 0.25 (region-1)), shards half
  memoryMinRegion: 3,                                         // memoriesOnEnd is gated to region 3 by the content pack
  artFallback: 2,                                             // an owned artifact in treasure pays gold x this instead
  sitesBase: 3, sitesMax: 5, siteMinDist: 2, siteOffset: 30,
  rarityW: { common: 3, rare: 1 },
};

// ---------- artifacts (run-scoped; lost when the run ends) ----------
const dArt = (id, name, rarity, minRegion, effect, text) => ({ id, name, rarity, minRegion, effect, text });
export const ARTIFACTS = [
  dArt('vanguard-banner', 'Banner of the Vanguard', 'common', 1, { kind: 'squares', v: 1 }, '+1 starting square'),
  dArt('tacticians-lens', "Tactician's Lens", 'common', 1, { kind: 'hints', v: 1, scope: 'run' }, '1 free hint every battle'),
  dArt('obsidian-chip', 'Obsidian Chip', 'rare', 2, { kind: 'traitWard', v: 1, scope: 'run' }, 'Your first capture each battle cannot fail its counter roll'),
  dArt('toll-ledger', "Toll-Keeper's Ledger", 'common', 1, { kind: 'incomeFlat', v: 2, scope: 'run' }, '+2 gold/min'),
  dArt('lodestone', "Prospector's Lodestone", 'common', 1, { kind: 'mineIncomeMult', v: 1.15, scope: 'run' }, 'Mine income +15%'),
  dArt('scout-spyglass', "Scout's Spyglass", 'common', 1, { kind: 'sight', v: 1, scope: 'run' }, 'Taking a node scouts 2 roads around it'),
  dArt('gilded-purse', 'Gilded Purse', 'common', 1, { kind: 'lootMult', v: 1.1, scope: 'run' }, 'Battle loot +10%'),
  dArt('war-drum', 'War Drum', 'rare', 2, { kind: 'tacticianElo', v: 50, scope: 'run' }, 'Tactician elo +50'),
  dArt('quartermaster-seal', "Quartermaster's Seal", 'rare', 2, { kind: 'shopDiscount', v: 0.1, scope: 'run' }, 'Shop prices -10% (a town coupon does not stack)'),
  dArt('drill-whistle', "Drillmaster's Whistle", 'rare', 2, { kind: 'trait', piece: 'P', v: 1, scope: 'run' }, 'Stubborn pawns +1 level'),
  dArt('dread-standard', 'Standard of Dread', 'rare', 3, { kind: 'enemyElo', v: -40, scope: 'run' }, 'Enemy elo -40'),
  dArt('pilgrim-reliquary', 'Pilgrim Reliquary', 'rare', 3, { kind: 'memoriesOnEnd', v: 2 }, '+2 Memories when this run ends'),
];
export const ARTIFACT_BY_ID = Object.fromEntries(ARTIFACTS.map(a => [a.id, a]));

// ---------- new effect kinds (same schema as content.mjs EFFECT_KINDS) ----------
// hints / traitWard / sight are read live from held artifacts (artifactTotal); the game never "applies" them.
// artifact / reveal / ambush inside a site card are applied by resolveSite itself.
export const DISCOVERY_EFFECT_KINDS = {
  hints: { params: { v: ['int', 1, 3] }, scopes: ['run'], text: 'The first v Hints each battle are free.' },
  traitWard: { params: { v: ['int', 1, 2] }, scopes: ['run'], text: "The player's first v captures each battle ignore the victim's trait roll." },
  sight: { params: { v: ['int', 1, 2] }, scopes: ['run'], text: 'Taking a node also scouts every node within 1+v roads of it.' },
  artifact: { params: { id: ['enum', ARTIFACTS.map(a => a.id)] }, text: 'Award this run artifact (discovery.mjs).' },
  ambush: { params: { v: ['num', 0.4, 1.2] }, text: "A battle at the site against an army of the node's budget x v; a win pays the site prize." },
};
export const PASSIVE_KINDS = ['hints', 'traitWard', 'sight'];
export function registerDiscoveryKinds() {
  for (const [k, d] of Object.entries(DISCOVERY_EFFECT_KINDS)) if (!EFFECT_KINDS[k]) EFFECT_KINDS[k] = d;
  return EFFECT_KINDS;
}
registerDiscoveryKinds();
export function discMinRegion(e) {
  if (e.kind === 'artifact') return (ARTIFACT_BY_ID[e.id] || { minRegion: 1 }).minRegion;
  if (e.kind === 'combo') return Math.max(...e.parts.map(discMinRegion));
  return effectMinRegion(e);
}

// ---------- named one-off locations (shrine-card pattern: a and optional b, {label, effect}) ----------
// {gold} in a label is filled with the option's scaled gold amount. An artifact id of null is the site's prize.
const dCombo = (...parts) => ({ kind: 'combo', parts });
const dOpt = (label, effect) => ({ label, effect });
const dVar = (minRegion, a, b) => (b ? { minRegion, a, b } : { minRegion, a });
const dGold = v => ({ kind: 'gold', v });
const dLoc = (id, name, glyph, minRegion, blurb, variants, extra) => Object.assign({ id, name, glyph, minRegion, blurb, variants }, extra);
export const LOCATIONS = [
  dLoc('witch-hut', 'Witch Hut', '⌂', 1, 'A crooked hut. The witch teaches one craft to each traveller.', [
    dVar(1, dOpt('Learn her craft: Stubborn pawns +1 this region', { kind: 'trait', piece: 'P', v: 1, scope: 'region' })),
    dVar(2, dOpt('Learn her craft: Sidestep knights +1 for the run', { kind: 'trait', piece: 'N', v: 1, scope: 'run' })),
    dVar(2, dOpt('Learn her craft: Faith bishops +1 for the run', { kind: 'trait', piece: 'B', v: 1, scope: 'run' })),
    dVar(3, dOpt('Learn her craft: Bulwark rooks +1 for the run', { kind: 'trait', piece: 'R', v: 1, scope: 'run' })),
  ]),
  dLoc('obelisk', 'Obelisk', '▲', 1, 'Runes on the stone describe a place you have not been.', [
    dVar(1, dOpt('Read the runes: the fog lifts over a far place', { kind: 'reveal', v: 1 }), dOpt('Chip off the capstone: +5 shards', { kind: 'resource', res: 'shards', v: 5 })),
  ], { focus: true }),
  dLoc('abandoned-camp', 'Abandoned Camp', '✦', 1, 'Cold fires, torn tents, boots still by the bedrolls.', [
    dVar(1, dOpt('Search the camp (even odds: 2 pawns or an ambush)', { kind: 'addPiece', piece: 'P', v: 2 })),
    dVar(1, dOpt('Search the camp (even odds: 2 pawns or an ambush)', { kind: 'ambush', v: 0.6 })),
  ]),
  dLoc('cartographer', "Cartographer's Tent", '✎', 1, 'A mapmaker with ink-black fingers and prices to match.', [
    dVar(1, dOpt('Buy a sketch ({gold} gold): fog lifts 3 roads around', dCombo(dGold(-40), { kind: 'reveal', v: 3 })),
      dOpt('Buy the survey ({gold} gold): fog lifts 4 roads around', dCombo(dGold(-80), { kind: 'reveal', v: 4 }))),
  ]),
  dLoc('sunken-vault', 'Sunken Vault', '◆', 2, 'A drowned strongroom. Something glints behind the bars.', [
    dVar(2, dOpt('Pay a diver {gold} gold to bring it up', dCombo(dGold(-120), { kind: 'artifact', id: null })), dOpt('Force the door (a guarded fight)', { kind: 'ambush', v: 0.9 })),
  ], { prize: true }),
  dLoc('mercenary-camp', 'Mercenary Camp', '⚔', 1, 'Sellswords between wars, dicing for their next master.', [
    dVar(1, dOpt('Hire two pawns for {gold} gold', dCombo(dGold(-35), { kind: 'addPiece', piece: 'P', v: 2 })), dOpt('Stand them a round: +60 elo next battle', { kind: 'tacticianElo', v: 60, scope: 'next' })),
    dVar(3, dOpt('Hire a knight for {gold} gold', dCombo(dGold(-70), { kind: 'addPiece', piece: 'N', v: 1 })), dOpt('Hire two pawns for {gold} gold', dCombo(dGold(-35), { kind: 'addPiece', piece: 'P', v: 2 }))),
  ]),
  dLoc('windmill', 'Windmill', '✢', 1, 'The miller pays in kind, or in coin.', [
    dVar(1, dOpt('Take the sacks: +10 coal', { kind: 'resource', res: 'coal', v: 10 }), dOpt('Take the coin: +{gold} gold', dGold(45))),
    dVar(1, dOpt('Take the crates: +10 tin', { kind: 'resource', res: 'tin', v: 10 }), dOpt('Take the coin: +{gold} gold', dGold(45))),
    dVar(2, dOpt('Take the ore: +7 iron', { kind: 'resource', res: 'iron', v: 7 }), dOpt('Take the coin: +{gold} gold', dGold(55))),
  ]),
  dLoc('watchtower', 'Watchtower', '⌖', 1, 'A tall tower with a long view and a short ladder.', [
    dVar(1, dOpt('Climb it: fog lifts 2 roads around', { kind: 'reveal', v: 2 }), dOpt('Post a lookout: next raid 150 ticks later', { kind: 'raidClock', v: 150 })),
  ]),
  dLoc('standing-stones', 'Standing Stones', '◎', 1, 'A ring of stones that hum before a battle.', [
    dVar(1, dOpt('Touch the east stone: +40 elo this region', { kind: 'tacticianElo', v: 40, scope: 'region' }), dOpt('Touch the west stone: enemies -30 elo this region', { kind: 'enemyElo', v: -30, scope: 'region' })),
    dVar(3, dOpt('Offer {gold} gold: +1 Memory when the run ends', dCombo(dGold(-150), { kind: 'memoriesOnEnd', v: 1 })), dOpt('Touch the east stone: +40 elo this region', { kind: 'tacticianElo', v: 40, scope: 'region' })),
  ]),
  dLoc('smugglers-den', "Smugglers' Den", '☾', 2, 'Low voices, a back door, goods with no questions.', [
    dVar(2, dOpt('Buy the passwords ({gold} gold): shop -15% this region', dCombo(dGold(-80), { kind: 'shopDiscount', v: 0.15, scope: 'region' })), dOpt('Sell them your route: the rival stalls 300 ticks', { kind: 'rivalClock', v: 300 })),
  ]),
];
export const LOCATION_BY_ID = Object.fromEntries(LOCATIONS.map(l => [l.id, l]));

// ---------- small helpers ----------
const rngOf = (...k) => mapMulberry32(mapHashSeed(k.join('|')));
const pickW = (rng, table) => { let r = rng() * table.reduce((s, x) => s + x[1], 0); for (const [k, w] of table) if ((r -= w) < 0) return k; return table[table.length - 1][0]; };
const shuffle = (rng, a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const ekey = (a, b) => Math.min(a, b) * 1000 + Math.max(a, b);
export const regionScale = r => Math.pow(DISC.growth, Math.max(1, r | 0) - 1);
const clampGold = v => Math.max(-2000, Math.min(5000, v));
let cacheK = '', cacheR = null;
export function regionOf(run) {
  const k = run.map.seed + '#' + run.map.region;
  if (k !== cacheK) { cacheK = k; cacheR = generateRegion(run.map.seed, run.map.region); }
  return cacheR;
}
// node ids within v roads of center (center included)
export function nodesWithin(region, center, v) {
  const adj = mapAdjacency(region.nodes.length, region.roads), d = new Map([[center, 0]]), q = [center];
  for (let h = 0; h < q.length; h++) { const u = q[h]; if (d.get(u) >= v) continue; for (const w of adj[u]) if (!d.has(w)) { d.set(w, d.get(u) + 1); q.push(w); } }
  return [...d.keys()].sort((a, b) => a - b);
}

// ---------- artifact rolls / awards ----------
// rollArtifact(seed, regionNumber, exclude ids) -> id | null (weighted common 3 : rare 1, minRegion respected)
export function rollArtifact(seed, regionNumber, exclude = []) {
  const ex = new Set(exclude), pool = ARTIFACTS.filter(a => a.minRegion <= regionNumber && !ex.has(a.id));
  if (!pool.length) return null;
  return pickW(rngOf(seed, 'art', regionNumber), pool.map(a => [a.id, DISC.rarityW[a.rarity]]));
}
export const ownsArtifact = (run, id) => !!(run.arts || []).some(x => x.id === id);
// awardArtifact -> { def, apply: effect parts the game applies now via its applyEffect } | null (unknown or owned)
export function awardArtifact(run, id) {
  const def = ARTIFACT_BY_ID[id]; if (!def || ownsArtifact(run, id)) return null;
  (run.arts || (run.arts = [])).push({ id, r: run.map.region });
  return { def, apply: effectParts(def.effect).filter(p => !PASSIVE_KINDS.includes(p.kind)) };
}
export const heldArtifacts = run => (run.arts || []).map(x => ARTIFACT_BY_ID[x.id]).filter(Boolean);
// sum of v over held artifacts' parts of one kind (hints, traitWard, sight, ...)
export function artifactTotal(run, kind) {
  let s = 0; for (const a of heldArtifacts(run)) for (const p of effectParts(a.effect)) if (p.kind === kind) s += p.v;
  return s;
}

// ---------- road treasure ----------
function treasureEffect(rng, region, a, b, k) {
  const r = region.regionNumber, rich = region.nodes[a].band === 'rich' || region.nodes[b].band === 'rich';
  if (k === 'res') {
    const res = pickW(rng, DISC.resW);
    const v = Math.round((DISC.resLo + rng() * (DISC.resHi - DISC.resLo)) * (1 + DISC.resPerRegion * (r - 1)) * (res === 'shards' ? 0.5 : 1));
    return { kind: 'resource', res, v: Math.max(1, Math.min(40, v)) };
  }
  if (k === 'memory') return { kind: 'memoriesOnEnd', v: 1 };
  const v = (DISC.goldLo + rng() * (DISC.goldHi - DISC.goldLo)) * regionScale(r) * (rich ? DISC.richMult : 1) * (k === 'art' ? DISC.artFallback : 1);
  return { kind: 'gold', v: clampGold(Math.max(1, Math.round(v))) };
}
// placeTreasure(seed, region, exclude art ids) -> treasure[] (deterministic; ~1 per 4.5 roads, at most 1 per road)
export function placeTreasure(seed, region, exclude = []) {
  const r = region.regionNumber, rng = rngOf(seed, 'treasure', r), roads = region.roads;
  const n = Math.min(roads.length, Math.max(DISC.treasureMin, Math.round(roads.length / DISC.edgesPerTreasure + rng() - 0.5)));
  const ex = exclude.slice(), out = [];
  for (const [a, b] of shuffle(rng, roads.map(x => x.slice())).slice(0, n)) {
    let k = pickW(rng, DISC.kindW);
    if (k === 'memory' && r < DISC.memoryMinRegion) k = 'gold';
    let art = null;
    if (k === 'art') { art = rollArtifact(seed + '|t' + out.length, r, ex); if (art) ex.push(art); else k = 'gold'; }
    const t = { a, b, t: Math.round((0.35 + rng() * 0.3) * 100) / 100, k, e: treasureEffect(rng, region, a, b, k), got: 0 };
    if (art) t.art = art;
    out.push(t);
  }
  return out.sort((x, y) => x.a - y.a || x.b - y.b);
}
const CACHE_LINES = EVENT_LINES.cache.filter(l => !l.includes('{piece}'));
function gainOf(run, t, i) {
  const out = { id: i, k: t.k, apply: [], art: null, text: '', short: '' };
  if (t.k === 'art') {
    const w = awardArtifact(run, t.art);
    if (w) { out.art = w.def; out.apply = w.apply; out.text = `Found an artifact: ${w.def.name}.`; out.short = w.def.text; return out; }
  }
  const e = t.e; out.apply = [e];
  if (e.kind === 'gold') {
    out.text = fillLine(CACHE_LINES[mapHashSeed(run.map.seed + '|line|' + i) % CACHE_LINES.length], { gold: e.v.toLocaleString('en-US') });
    out.short = `+${e.v} gold`;
  } else if (e.kind === 'resource') { out.text = `By the roadside: ${e.v} ${e.res}.`; out.short = `+${e.v} ${e.res}`; }
  else { out.text = 'A keepsake in the mud. You will remember this road.'; out.short = '+1 Memory at run end'; }
  return out;
}
// the held node a march to toId sets out from (lowest dist, then lowest id); null if none
export function marchFrom(run, toId, region = regionOf(run)) {
  const held = new Set(run.map.held), c = region.roads.filter(([a, b]) => a === toId || b === toId).map(([a, b]) => a === toId ? b : a).filter(x => held.has(x));
  c.sort((x, y) => region.nodes[x].dist - region.nodes[y].dist || x - y);
  return c.length ? c[0] : null;
}
// collectOnMarch(run, fromId, toId) -> gains[] (idempotent: a picked-up pile is marked got and never pays again)
export function collectOnMarch(run, fromId, toId) {
  const L = run.map.treasure; if (!Array.isArray(L) || fromId == null || toId == null) return [];
  const k = ekey(fromId, toId), out = [];
  L.forEach((t, i) => { if (!t.got && ekey(t.a, t.b) === k) { t.got = 1; out.push(gainOf(run, t, i)); } });
  return out;
}
// roads inside your territory are yours: collect every pile on a road with both ends held
export function sweepHeld(run) {
  const held = new Set(run.map.held), out = [];
  (run.map.treasure || []).forEach((t, i) => { if (!t.got && held.has(t.a) && held.has(t.b)) { t.got = 1; out.push(gainOf(run, t, i)); } });
  return out;
}

// ---------- fog / scouting ----------
// visibility with scouting: 'held' | 'frontier' | 'scouted' (fog lifted, not attackable) | 'fog'
export function discVisibility(region, held, scouted) {
  const vis = visibility({ region, held });
  for (const id of scouted || []) if (vis[id] === 'fog') vis[id] = 'scouted';
  return vis;
}
// fogView with scouting: scouted nodes show full info (vis 'scouted'); fog stays a silhouette
export function discFogView(region, held, scouted) {
  const vis = discVisibility(region, held, scouted);
  return region.nodes.map(n => vis[n.id] === 'fog' ? { id: n.id, x: n.x, y: n.y, vis: 'fog', silhouette: true, big: n.type === 'citadel' } : { ...n, vis: vis[n.id] });
}
// lift fog on every node within v roads of center; returns the ids that newly became visible
export function revealAround(run, center, v, region = regionOf(run)) {
  const m = run.map, vis = discVisibility(region, m.held, m.scouted), s = new Set(m.scouted || []), fresh = [];
  for (const id of nodesWithin(region, center, Math.max(0, v | 0))) { if (vis[id] === 'fog') fresh.push(id); s.add(id); }
  m.scouted = [...s].filter(id => !m.held.includes(id)).sort((a, b) => a - b);
  return fresh;
}
export const sightRadius = run => artifactTotal(run, 'sight');
export function revealOnCapture(run, nodeId, region = regionOf(run)) {
  const s = sightRadius(run); return s > 0 ? revealAround(run, nodeId, 1 + s, region) : [];
}

// ---------- location placement ----------
function siteOffset(rng, region, n) {
  let best = null;
  const dirs = shuffle(rng, [0, 1, 2, 3, 4, 5, 6, 7]);
  for (const k of dirs) {
    const an = k * Math.PI / 4, x = Math.max(8, Math.min(992, n.x + Math.cos(an) * DISC.siteOffset)), y = Math.max(8, Math.min(592, n.y + Math.sin(an) * DISC.siteOffset));
    let sc = Infinity;
    for (const o of region.nodes) if (o.id !== n.id) sc = Math.min(sc, Math.hypot(o.x - x, o.y - y));
    for (const [a, b] of region.roads) sc = Math.min(sc, 1.5 * segDist(x, y, region.nodes[a], region.nodes[b]));
    if (!best || sc > best.sc) best = { sc, dx: Math.round(x - n.x), dy: Math.round(y - n.y) };
  }
  return best;
}
function segDist(px, py, A, B) {
  const dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy || 1, u = Math.max(0, Math.min(1, ((px - A.x) * dx + (py - A.y) * dy) / L2));
  return Math.hypot(A.x + u * dx - px, A.y + u * dy - py);
}
// placeSites(seed, region, exclude art ids) -> sites[]: 3-5 one-off locations beside nodes that start in fog
export function placeSites(seed, region, exclude = []) {
  const r = region.regionNumber, rng = rngOf(seed, 'sites', r);
  const n = Math.min(DISC.sitesMax, DISC.sitesBase + (r >= 3 ? 1 : 0) + (rng() < 0.5 ? 1 : 0));
  const pool = shuffle(rng, region.nodes.filter(x => x.type !== 'keep' && x.type !== 'citadel' && x.dist >= DISC.siteMinDist));
  // spread out: one site per column first, then the rest
  const cols = new Set(), anchors = [];
  for (const x of pool) if (!cols.has(x.col)) { cols.add(x.col); anchors.push(x); }
  for (const x of pool) if (!anchors.includes(x)) anchors.push(x);
  const archs = shuffle(rng, LOCATIONS.filter(l => l.minRegion <= r)), ex = exclude.slice(), out = [];
  for (const arch of archs) {
    if (out.length >= n || out.length >= anchors.length) break;
    const vs = arch.variants.map((v, i) => i).filter(i => arch.variants[i].minRegion <= r);
    const vi = vs[Math.floor(rng() * vs.length)], at = anchors[out.length];
    let prize = null, focus = null;
    if (arch.prize) { prize = rollArtifact(seed + '|site|' + arch.id, r, ex); if (!prize) continue; ex.push(prize); }
    if (arch.focus) {
      const far = region.nodes.filter(x => x.dist >= at.dist + 2 && x.id !== region.citadelId);
      focus = far.length ? far[Math.floor(rng() * far.length)].id : region.citadelId;
    }
    const off = siteOffset(rng, region, at);
    out.push({ at: at.id, arch: arch.id, v: vi, dx: off.dx, dy: off.dy, focus, prize, done: 0, later: false });
  }
  return out;
}

// ---------- region hook / save ----------
// known ids only, first copy of each id kept
function cleanArts(list) {
  const arts = (Array.isArray(list) ? list : []).filter(x => x && ARTIFACT_BY_ID[x.id]);
  return arts.filter((x, i) => arts.findIndex(y => y.id === x.id) === i).map(x => ({ id: x.id, r: x.r | 0 }));
}
// initDiscovery(run): call right after newWorldMap() (new run or next region). Artifacts on run.arts are untouched.
export function initDiscovery(run, region = regionOf(run)) {
  const m = run.map;
  run.arts = cleanArts([...(run.arts || []), ...(m.arts || [])]); delete m.arts;
  const own = run.arts.map(x => x.id);
  m.treasure = placeTreasure(m.seed, region, own);
  m.sites = placeSites(m.seed, region, own.concat(m.treasure.filter(t => t.art).map(t => t.art)));
  m.scouted = []; m.site = null; m.ambush = null; m.disc = DISC_VERSION;
  return m;
}
// cleanDiscovery(run): tolerant load / migration. Absent or broken fields become empty (disc 0 = nothing
// placed this region). Valid entries are kept as they are. Artifacts (run.arts, or the old run.map.arts) survive if their ids are known.
export function cleanDiscovery(run, region = regionOf(run)) {
  const m = run.map, N = region.nodes.length, roads = new Set(region.roads.map(([a, b]) => ekey(a, b)));
  const isId = x => Number.isInteger(x) && x >= 0 && x < N, arr = x => Array.isArray(x) ? x : [];
  const has = m.disc === DISC_VERSION;
  m.treasure = has ? arr(m.treasure).filter(t => t && isId(t.a) && isId(t.b) && t.a < t.b && roads.has(ekey(t.a, t.b))
    && ['gold', 'res', 'memory', 'art'].includes(t.k) && !validateEffect(t.e).length && (t.k !== 'art' || ARTIFACT_BY_ID[t.art]))
    .map(t => Object.assign({}, t, { t: +t.t >= 0 && +t.t <= 1 ? +t.t : 0.5, got: t.got ? 1 : 0 })) : [];
  m.sites = has ? arr(m.sites).filter(s => s && isId(s.at) && LOCATION_BY_ID[s.arch] && LOCATION_BY_ID[s.arch].variants[s.v]
    && (!LOCATION_BY_ID[s.arch].prize || ARTIFACT_BY_ID[s.prize]))
    .map(s => Object.assign({}, s, { dx: +s.dx || 0, dy: +s.dy || 0, focus: isId(s.focus) ? s.focus : null, prize: ARTIFACT_BY_ID[s.prize] ? s.prize : null,
      done: s.done === 'a' || s.done === 'b' ? s.done : 0, later: !!s.later })) : [];
  m.scouted = [...new Set(arr(m.scouted).filter(isId))].sort((a, b) => a - b);
  run.arts = cleanArts([...arr(run.arts), ...arr(m.arts)]); delete m.arts;   // older builds kept them on run.map.arts
  const site = m.sites[m.site];
  if (!(Number.isInteger(m.site) && site && !site.done && m.held.includes(site.at))) m.site = null;
  const ab = m.ambush;
  m.ambush = ab && m.sites[ab.site] && m.sites[ab.site].done && +ab.v >= 0.4 && +ab.v <= 1.2 ? { site: ab.site, v: +ab.v } : null;
  m.disc = has ? DISC_VERSION : 0;
  return m;
}
export const migrateDiscovery = cleanDiscovery;
// a card or a site battle is waiting: the game should block marches (like a pending shrine)
export const discoveryBusy = run => !!(run.map.site != null || run.map.ambush);

// ---------- sites: cards and resolution ----------
function scaleEffect(e, r, prize) {
  if (e.kind === 'combo') return { kind: 'combo', parts: e.parts.map(p => scaleEffect(p, r, prize)) };
  if (e.kind === 'gold') { const v = Math.round(Math.abs(e.v) * regionScale(r) / 5) * 5 || 5; return { kind: 'gold', v: clampGold(Math.sign(e.v) * v) }; }
  if (e.kind === 'artifact') return { kind: 'artifact', id: prize };
  return e;
}
export function canChoose(run, effect) {
  return effectParts(effect).every(p => p.kind === 'gold' ? p.v >= 0 || run.gold >= -p.v : p.kind === 'artifact' ? !ownsArtifact(run, p.id) : true);
}
// siteCard(run, i) -> { i, id, name, glyph, blurb, place, a: {label, effect, ok}, b? } (b absent: one choice + "Leave")
export function siteCard(run, i, region = regionOf(run)) {
  const s = run.map.sites && run.map.sites[i]; if (!s) return null;
  const arch = LOCATION_BY_ID[s.arch], vr = arch.variants[s.v], r = run.map.region;
  const card = { i, id: arch.id, name: arch.name, glyph: arch.glyph, blurb: arch.blurb, place: region.nodes[s.at].name, done: s.done };
  for (const side of ['a', 'b']) {
    if (!vr[side]) continue;
    const effect = scaleEffect(vr[side].effect, r, s.prize), gp = effectParts(effect).find(p => p.kind === 'gold');
    let label = fillLine(vr[side].label, { gold: gp ? Math.abs(gp.v) : '' });
    if (s.prize && effectParts(effect).some(p => p.kind === 'artifact')) label += `: ${ARTIFACT_BY_ID[s.prize].name}`;
    card[side] = { label, effect, ok: !s.done && canChoose(run, effect) };
  }
  return card;
}
// sites the player can see (anchor not in fog), for the renderer
export function visibleSites(run, region = regionOf(run)) {
  const vis = discVisibility(region, run.map.held, run.map.scouted);
  return (run.map.sites || []).map((s, i) => ({ s, i })).filter(({ s }) => vis[s.at] !== 'fog').map(({ s, i }) => {
    const arch = LOCATION_BY_ID[s.arch], n = region.nodes[s.at];
    return { i, at: s.at, x: n.x + s.dx, y: n.y + s.dy, glyph: arch.glyph, name: arch.name, done: !!s.done, ready: !s.done && run.map.held.includes(s.at) };
  });
}
// treasure the player can see: not picked up, neither road end in fog
export function visibleTreasure(run, region = regionOf(run)) {
  const vis = discVisibility(region, run.map.held, run.map.scouted);
  return (run.map.treasure || []).map((t, i) => ({ i, a: t.a, b: t.b, t: t.t, k: t.k === 'art' ? 'art' : t.k, got: t.got }))
    .filter(t => !t.got && vis[t.a] !== 'fog' && vis[t.b] !== 'fog');
}
// point on a road drawn as a quadratic curve A -> ctrl -> B (pass map-render's mapRoadCurve(A, B) as ctrl)
export function roadPoint(A, B, ctrl, t) {
  const u = 1 - t; return { x: u * u * A.x + 2 * u * t * ctrl.cx + t * t * B.x, y: u * u * A.y + 2 * u * t * ctrl.cy + t * t * B.y };
}
// open a site's card (tap, or automatically from afterCapture). Its anchor must be held and it must be unvisited.
export function openSite(run, i) {
  const s = run.map.sites && run.map.sites[i];
  if (!s || s.done || !run.map.held.includes(s.at) || run.map.ambush) return false;
  run.map.site = i; return true;
}
// "Not now": close the card, the site stays (tap it to come back); it no longer pops up by itself
export function dismissSite(run) { const s = run.map.sites[run.map.site]; if (s) s.later = true; run.map.site = null; }
// resolveSite(run, 'a'|'b') -> { apply: parts for the game's applyEffect, art, revealed, ambush, label } | null
export function resolveSite(run, side, region = regionOf(run)) {
  const m = run.map, i = m.site, card = siteCard(run, i, region); if (!card || !card[side] || !card[side].ok) return null;
  const s = m.sites[i], out = { apply: [], art: null, revealed: [], ambush: null, label: card[side].label };
  for (const p of effectParts(card[side].effect)) {
    if (p.kind === 'artifact') { const w = awardArtifact(run, p.id); if (w) { out.art = w.def; out.apply.push(...w.apply); } }
    else if (p.kind === 'reveal') out.revealed.push(...revealAround(run, s.focus != null ? s.focus : s.at, p.v, region));
    else if (p.kind === 'ambush') { m.ambush = { site: i, v: p.v }; out.ambush = m.ambush; }
    else out.apply.push(p);
  }
  s.done = side; m.site = null;
  return out;
}
// the pending site battle, for the game to build with engine enemyArmy (budget x budgetMult)
export function ambushSpec(run, region = regionOf(run)) {
  const ab = run.map.ambush; if (!ab) return null;
  const s = run.map.sites[ab.site], n = region.nodes[s.at];
  return { mapId: s.at, tier: Math.max(1, n.tier), budgetMult: ab.v, place: LOCATION_BY_ID[s.arch].name, key: mapHashSeed(run.map.seed + '|ambush|' + ab.site) % 100003, prize: s.prize };
}
// after the site battle: a win pays the prize artifact (if the site has one). Returns { art, apply }.
export function finishAmbush(run, won) {
  const ab = run.map.ambush; if (!ab) return null;
  run.map.ambush = null;
  const s = run.map.sites[ab.site], w = won && s.prize ? awardArtifact(run, s.prize) : null;
  return { won: !!won, art: w ? w.def : null, apply: w ? w.apply : [] };
}
// after applyMapResult captured nodeId (same region): sweep held roads, sight reveal, open the site there
export function afterCapture(run, nodeId, region = regionOf(run)) {
  const gains = sweepHeld(run), revealed = revealOnCapture(run, nodeId, region);
  trimScouted(run);
  const i = (run.map.sites || []).findIndex(s => s.at === nodeId && !s.done && !s.later);
  const site = i >= 0 && run.map.site == null && openSite(run, i) ? i : null;
  return { gains, revealed, site };
}
function trimScouted(run) { const h = new Set(run.map.held); run.map.scouted = (run.map.scouted || []).filter(id => !h.has(id)); }
