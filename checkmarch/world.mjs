// Checkmarch world layer: ties the region map (map.mjs, copied verbatim from checkmarch-map) to the
// game state (engine.mjs). Plain functions over `run.map`, testable headless (test-world.mjs).
//
// World time is in TICKS (see engine TUNE.tickSec): one chess move = 1 tick, a march costs ticks per road step,
// nothing else: no wall-clock time at all (v6). worldTick() applies n ticks to income, the raid clock and the rival.
// run.map = { seed: string, region: int, held: id[] (sorted), march: {id, need, done} (ticks) | null, shrine: id | null,
//             garrison: { [mineId]: pieceId[] }, raid: { t: ticks until the next raid, n: raids so far, pending: {id, n} | null },
//             rival: RivalState (rival.mjs, plain JSON), contact: bool (the rival's border has touched yours),
//             rlog: [{ t: text, n: count }] (rival chronicle, newest last) }
// What's saved is just that object; the Region itself is regenerated from (seed, region).
import { generateRegion, frontier, canCapture, capture, mapHashSeed, mapMulberry32, neighbors, fogView, mapAdjacency, mapBfs } from './map.mjs';
import { TUNE, accrueTicks, goldMult, mineMult, weekMod, SAVE_VERSION, enemyArmy, enemyBudget, armyUnits, createBattle, newState, DOCTRINE_KEYS, settleRoster, lootFor, levy, parseSq, cleanUpgrades, cleanOrders, pieceById, mineRate,
  ELO_TUNE, cleanElo, regionElo, eloCfg, cleanDwell, traitLevels, tierTraits, mateMemories,
  setTerrainProvider, setCaptureRules, blessActive, blessSum, blessProd, DWELL_MAX, DWELL_TYPES, SQUARE_ORDER, hash3, reserve, UNITS, PIECE_NOUN, squareCost, effPrice, dwellPrice, FAIRY_TRAITS, fairyTraitChance, TRAITS } from './engine.mjs';
import { RIVAL_TUNE, createRival, advanceRival, resolveBorder, nextMoveEta, rivalArmyFor, rivalOwners, rivalFrontier } from './rival.mjs';
import { RECIPES, loadForge, tickForge, smelt, upgradeSmeltCap, applyBar, losePiece, counterCheck, captureFallback, evalBonus, materialOf,
  smeltsLeft, smeltsPerDay, nextResetAt, smeltLevelPrice, stockCap, mineCounts, MAX_SMELT_LEVEL } from './forge.mjs';
import { generateTerrain, terrainGeometry } from './terrain.mjs';
import * as CONTENT from './content.mjs';
import * as SK from './skills.mjs';
import * as DSC from './discovery.mjs';
import * as FY from './fairy.mjs';
import { WHITE, BLACK, TYPE_CH, mFrom, mTo, mCap, mPromo, playMove, resetBattle, Q, setSkillsModule,
  setFairyHooks, battleGates, setRunHook, CH_TYPE, ELO_BANDS, matTier, garrisonedIds } from './engine.mjs';

export const WORLD = {
  marchBaseTicks: 5,   // march = 5 ticks + per road step from the keep: 12 in region 1, 10 in region 2, 8 from region 3
  marchStepTicks: 12,
  marchStepMinTicks: 8,
  marchStepDrop: 2,    // per region after the first
  marchMaxSteps: 10,
  marchTickMs: 330,    // the page plays a march out at ~3 ticks per second
  raidFirst: 360,      // first raid of a region: after 360 ticks holding a mine (~6 battles)
  raidEvery: 300,      // then every 300 +/- 90 ticks (deterministic per region)
  raidJitter: 90,
  rivalSecPerTick: 1,  // rival.mjs counts seconds: one world tick = one rival second (first move after ~90 ticks)
  raidBase: 0.45,         // raid budget = mine budget x (base + perMine x mines held, capped) x region factor
  raidPerMine: 0.06, raidMineCap: 8, raidRegion: 0.08,
  garrisonMax: 5,         // pieces per mine
  raidLootMult: 0.5,      // loot for repelling a raid, relative to a battle at the mine's tier
  borderLootMult: 0.6,    // loot for repelling the rival at your border
  rlogMax: 8,
  // rival.mjs tuning overrides (applied to RIVAL_TUNE at load; rival.mjs itself stays a verbatim copy).
  // bonusCap 9 -> 5: strength tops out at 6, so region 2+ rivals are not a full region ahead of their
  // garrisons (with ticks the old "8 h away" spike is gone: no offline catch-up at all since v6). keepAssaultMinHeld 5 -> 8,
  // multKeep 1.2 -> 1.0 and perNodeMs 40 -> 60 s: keep assaults ended ~1 in 3 bot runs, now ~1 in 10.
  rivalTune: { bonusCap: 5, keepAssaultMinHeld: 8, multKeep: 1.0, perNodeMs: 60e3 },
  keepMilitia: 2,         // pawns of the keep's own militia join a keep defence (not on the roster)
  rivalArmy: 0.85,        // rival army budget = engine enemyBudget(tier) x role multiplier x this
  // M5
  cacheLoot: 1.0,         // a supply cache pays this x a battle's loot at its tier (no battle)
  enemyMatRegion: 3,      // enemy garrisons carry iron from this region (tier-scaled count), one steel from region 5
  packChance: 3,          // 1 in packChance neutral nodes (v5 maps) field a content-pack formation for its tier
  // M6
  rewinds: 3,             // take-backs of the Tactician's own move per battle (never used by the balance bot)
  hintLoot: 0.1,          // a Hint costs this x the battle's loot (min hintMin gold); the Tactician's Lens makes the first ones free
  hintMin: 5,
  // P0-4 the week clock: every weekTicks world ticks a week turns (about 3 battles and their marches in region 1).
  // balance pass: 84 -> 168. Measured, a march + battle cycle is ~55 ticks (~88 in region 1 with raids and border
  // fights), so an 84-tick week turned every 1-1.5 battles; 168 gives the intended ~2 (region 1) to 3 battles a week
  weekTicks: 168,
  musterCap: 4,           // the keep musters 1 militia pawn per week (keep defence only), at most this many waiting
  minePulseTicks: 24,     // each held mine pays this many ticks of its income at the turn of the week (balance pass: 12 -> 24 with the longer week)
};
// M5 engine hooks: battle terrain tables come from terrain.mjs; forge.mjs decides counter captures and the
// material eval bonus (see engine.mjs useTerrain / counterInfo).
setTerrainProvider(t => terrainGeometry(t));
setCaptureRules({ counter: counterCheck, fallback: captureFallback, evalBonus });
setSkillsModule(SK); // M6: engine newState/endRun/rebuildRun grant the skills' start bonus
setFairyHooks(FY.fairyHooks); // v6: fairy pieces (fairy.mjs): engine VAL / TYPE_CH / CH_TYPE / UNITS / PIECE_NOUN gain the roster
setRunHook(s => cleanFairy(s)); // v6: every new run gets the account's fairy unlocks (run.fun) and empty gates
export function applyRivalTune() { Object.assign(RIVAL_TUNE, WORLD.rivalTune); return RIVAL_TUNE; }
applyRivalTune();

let worldCacheKey = '', worldCacheRegion = null;
export function worldRegion(run) {
  const k = run.map.seed + '#' + run.map.region;
  if (k !== worldCacheKey) { worldCacheKey = k; worldCacheRegion = generateRegion(run.map.seed, run.map.region); }
  return worldCacheRegion;
}
export function regionSeed(run, n) { return (run.seed >>> 0).toString(36) + '-r' + n; }
export function newWorldMap(run, regionNumber) {
  const n = Math.max(1, regionNumber | 0), seed = regionSeed(run, n);
  return { seed, region: n, held: [0], march: null, shrine: null, garrison: {}, raid: { t: WORLD.raidFirst, n: 0, pending: null },
    rival: newRivalFor(run, generateRegion(seed, n), seed, n), contact: false, rlog: [],
    // M5: the region's named lord (content pack), pack formations + caches (v5 maps only: migrated maps stay as
    // they were), nodes scouted by a shrine, the rival strength offset from shrine effects
    lord: CONTENT.lordForRegion(hash3(run.seed >>> 0, 0, 21), n).id, pack: true, scouted: [], rivalAdj: 0 };
}
// the rival lord of a region starts at the citadel, at the run's opposition elo for that region
export function newRivalFor(run, reg, seed, n) { return createRival(reg, { seed, regionNumber: n, eloBase: regionElo(run.elo, n) }); }
// make sure a run has a valid map (new runs, migrated saves); also refreshes derived flags
export function ensureMap(run, regionNumber = 1) {
  const m = run.map;
  if (!m || typeof m.seed !== 'string' || !(m.region >= 1) || !Array.isArray(m.held)) { run.map = newWorldMap(run, regionNumber); DSC.initDiscovery(run, worldRegion(run)); placeLandmarks(run); }
  else {
    const reg = worldRegion(run);
    m.held = m.held.filter(id => Number.isInteger(id) && id >= 0 && id < reg.nodes.length);
    if (!m.held.includes(reg.keepId)) m.held.unshift(reg.keepId);
    m.held.sort((a, b) => a - b);
    if (m.march && !canCapture(mapStateOf(run), m.march.id)) m.march = null;
    if (m.shrine != null && !(m.held.includes(m.shrine) && reg.nodes[m.shrine] && reg.nodes[m.shrine].type === 'shrine')) m.shrine = null;
    if (!m.raid || typeof m.raid !== 'object') m.raid = { t: WORLD.raidFirst, n: 0, pending: null };
    if (!(m.raid.t >= 0)) m.raid.t = WORLD.raidFirst;
    if (m.march && !(m.march.need > 0)) m.march = null;
    m.raid.n = m.raid.n | 0;
    if (m.raid.pending && !(heldMines(run).includes(m.raid.pending.id))) m.raid.pending = null;
    if (!m.rival || typeof m.rival !== 'object' || !Array.isArray(m.rival.held) || m.rival.nodeCount !== reg.nodes.length || m.rival.regionNumber !== m.region || m.rival.seat !== reg.citadelId) {
      m.rival = newRivalFor(run, reg, m.seed, m.region);
    }
    m.contact = !!m.contact || rivalContact(run);
    if (!Array.isArray(m.rlog)) m.rlog = [];
    if (!Array.isArray(m.scouted)) m.scouted = [];
    m.rivalAdj = Math.max(-RIVAL_TUNE.bonusCap, Math.min(RIVAL_TUNE.bonusCap, +m.rivalAdj || 0));
    if (m.lord != null && !lordById(m.lord)) m.lord = null;
    m.pack = !!m.pack;
    cleanGarrisons(run);
    DSC.cleanDiscovery(run, reg);
  }
  ensureForge(run);
  ensureWeek(run);
  worldRefresh(run);
  return run.map;
}
export function mapStateOf(run) { return { region: worldRegion(run), held: run.map.held }; }
export function worldFrontier(run) { return frontier(mapStateOf(run)); }
// standing town discount: any town held or adjacent (on the frontier)
export function townNearby(run) {
  const reg = worldRegion(run);
  return run.map.held.concat(worldFrontier(run)).some(id => reg.nodes[id].type === 'town');
}
// shop discount: the town market or a shrine discount, whichever is larger (they do not stack)
export function worldRefresh(run) {
  let d = townNearby(run) ? TUNE.mapTownDiscount : 0;
  for (const b of blessActive(run, 'shopDiscount')) d = Math.max(d, +b.v || 0);
  run.shopDisc = d;
}

// the enemy army defending a node (deterministic per region seed + node id)
export function nodeArmy(run, id) {
  const reg = worldRegion(run), n = reg.nodes[id];
  if (rivalOwns(run, id)) return rivalNodeArmy(run, id);
  const tier = Math.max(1, n.tier), key = mapHashSeed(run.map.seed + '|' + id) % 100003;
  if (isCache(run, id)) return { type: 'cache', cache: true, name: 'Supply cache', pieces: [], tier, mapId: id, region: run.map.region, place: n.name, units: 0, elo: 0, depth: 0, doctrine: 'balanced', traits: cleanDwell(null), terrain: null };
  const doctrine = nodeDoctrine(run, id), bm = blessProd(run, 'enemyBudgetMult');
  const a = enemyArmy(run.seed, tier, { type: n.type, key, formation: packFormation(run, id, tier, n.type, doctrine), budget: bm !== 1 ? enemyBudget(tier, n.type) * bm : undefined });
  a.tier = tier; a.mapId = id; a.region = run.map.region; a.place = n.name;
  if (n.type === 'citadel' && n.boss) a.boss = n.boss;
  a.elo = nodeElo(run, id); a.traits = cursedTraits(run, tierTraits(tier));
  a.units = armyUnits(a.pieces); a.depth = eloCfg(a.elo).maxDepth;
  a.doctrine = doctrine;
  fairyArmy(run, a, run.map.seed + '|' + id, { boss: n.type === 'citadel' });
  enemyMats(run, a); withTerrain(run, a, id, n.type);
  return a;
}
// opposition elo for a neutral node: the region's elo, +/- a deterministic spread, + the boss bonus at a citadel
export function nodeElo(run, id) {
  const n = worldRegion(run).nodes[id], sp = ELO_TUNE.spread;
  const j = sp ? (mapHashSeed(run.map.seed + '|elo|' + id) % (2 * sp + 1)) - sp : 0;
  return cleanElo(regionElo(run.elo, run.map.region) + j + (n.type === 'citadel' ? ELO_TUNE.boss : 0) + blessSum(run, 'enemyElo'));
}
// garrisons and citadels fight by one of three doctrines (deterministic per node); others are balanced
export function nodeDoctrine(run, id) {
  const n = worldRegion(run).nodes[id];
  if (n.type !== 'garrison' && n.type !== 'citadel') return 'balanced';
  return DOCTRINE_KEYS[mapHashSeed(run.map.seed + '|doctrine|' + id) % DOCTRINE_KEYS.length];
}
export function marchStepTicks(region) { return Math.max(WORLD.marchStepMinTicks, WORLD.marchStepTicks - WORLD.marchStepDrop * (Math.max(1, region) - 1)); }
export function marchTicks(run, id) {
  const n = worldRegion(run).nodes[id];
  const t = WORLD.marchBaseTicks + marchStepTicks(run.map.region) * Math.min(Math.max(1, n.dist), WORLD.marchMaxSteps);
  const mm = blessProd(run, 'marchMult');
  return mm === 1 ? t : Math.max(1, Math.round(t * mm));
}
// M6: Leadership (skills) shortens every march
// P0-4: the week's event may speed or slow marches (applied when a march starts)
export function marchNeed(run, id) { return Math.max(1, Math.round(marchTicks(run, id) * (1 - ((run.skillMods || {}).march || 0)) * weekMod(run, 'march', 1))); }
export function canMarch(run, id) {
  return !run.map.march && run.map.shrine == null && !DSC.discoveryBusy(run) && !(run.map.raid && run.map.raid.pending) && !rivalPending(run) && id != null && canCapture(mapStateOf(run), id);
}
export function startMarch(run, id) {
  if (!canMarch(run, id)) return false;
  run.map.march = { id, need: marchNeed(run, id), done: 0 };
  run.touched = true;
  return true;
}
export function cancelMarch(run) { const had = !!run.map.march; run.map.march = null; return had; }
// 0..1 while marching, null otherwise
export function marchProgress(run) {
  const m = run.map.march; if (!m) return null;
  return Math.max(0, Math.min(1, m.done / m.need));
}
// spend n march ticks (the caller also applies them to the world with worldTick); true once arrived
export function advanceMarch(run, n) {
  const m = run.map.march; if (!m) return false;
  m.done = Math.min(m.need, m.done + Math.max(0, n | 0));
  return m.done >= m.need;
}
// apply n world ticks: income, the raid clock (online only) and the rival. online=false (no raids; the rival may
// not assault the keep) was the old offline catch-up: the page no longer grants any (awayTicks = 0). Returns { gold, raid, events }.
// P0-4: the ticks are applied in segments that stop at each week boundary, so a turn of the week (muster, mine
// pulse, the new week's event) lands at the same tick whether time comes 1 tick at a time or in one catch-up.
// v6: world time comes only from play. Time away from the page grants nothing: zero ticks, so gold, raids, the
// rival, the forge and the week clock all wait exactly where they were.
export function awayTicks() { return 0; }
export function worldTick(state, n, online = true) {
  n = Math.max(0, Math.floor(n || 0));
  const run = state.run;
  if (!n) return { gold: 0, raid: null, events: [], dings: [], weeks: [] };
  ensureWeek(run);
  const out = { gold: 0, raid: null, events: [], dings: [], weeks: [] };
  while (n > 0) {
    const k = Math.min(n, weekLeft(run));
    const r = tickSegment(state, k, online);
    out.gold += r.gold; out.raid = out.raid || r.raid; out.events.push(...r.events); out.dings.push(...r.dings);
    n -= k;
    if ((run.ticks % WORLD.weekTicks) === 0) { const w = weekTurn(state); out.weeks.push(w); out.gold += w.pulse; }
  }
  return out;
}
function tickSegment(state, n, online) {
  const run = state.run;
  // the forge's clock is the world clock: synthetic now = run.ticks x forgeMsPerTick (see FORGE_MS_PER_TICK)
  run.ticks = (run.ticks || 0) + n;
  if (run.map) { ensureForge(run); run.forge = tickForge(run.forge, heldMineRes(run), forgeNow(run)); }
  const gold = accrueTicks(state, n);
  const dings = mineSkillXp(state, gold); // M6: mine income milestones pay skill XP (every tick of play)
  const raid = online ? raidTick(run, n) : null;
  const events = tickRival(run, n * weekMod(run, 'rival', 1), online);
  return { gold, raid, events, dings };
}
// march finished: returns the battle (from the player's current formation), clears the march.
// A supply cache has no battle: it is taken at once (run.map.lastCache holds the result) and arrive returns null.
export function arrive(run, state) {
  const m = run.map.march; if (!m) return null;
  run.map.march = null;
  if (!canCapture(mapStateOf(run), m.id)) return null;
  // M6 discovery: the pile on the road just walked is picked up at arrival (a halted march picks nothing up)
  const gains = DSC.collectOnMarch(run, DSC.marchFrom(run, m.id, worldRegion(run)), m.id);
  if (gains.length) { applyDiscGains(state || { run, memories: 0 }, gains); run.map.lastGains = gains; }
  if (isCache(run, m.id)) { takeCache(state || { run, memories: 0 }, m.id); return null; }
  return worldBattle(run, nodeArmy(run, m.id));
}
// every battle the world starts: shrine blessings for the player (Tactician elo, region traits), and the
// 'next'-scope blessings are consumed here (kept on battle.next for the loot at its end)
export function worldBattle(run, army, whites) {
  const b = createBattle(run, army, whites);
  b.tactElo = blessSum(run, 'tacticianElo') + weekMod(run, 'elo', 0);
  for (const bl of blessActive(run, 'trait')) if (bl.scope !== 'run' && DWELL_TYPES.includes(bl.piece)) b.traits[0][bl.piece] = Math.min(DWELL_MAX, (b.traits[0][bl.piece] | 0) + (bl.v | 0));
  if (weekMod(run, 'traitP', 0)) b.traits[0].P = Math.min(DWELL_MAX, (b.traits[0].P | 0) + weekMod(run, 'traitP', 0));
  if (Array.isArray(run.blessings)) { b.next = run.blessings.filter(x => x.scope === 'next'); run.blessings = run.blessings.filter(x => x.scope !== 'next'); }
  // M6: discovery traitWard (read live from held artifacts), the skills tally, and the rewind snapshot
  b.wardMax = DSC.artifactTotal(run, 'traitWard'); b.ward = 0; b.hints = 0; b.rw = 0; b.wkHint = weekMod(run, 'hint', 0); // Week of Rest: free first hint (fixed for the battle)
  b.sx = SK.newTally(battleTypes(run, b));
  // v6: bought fairy pieces waiting behind their home squares (formation battles and the keep defence)
  if (!whites || (army && army.kind === 'keep')) battleGates(b, gatesFor(run, b));
  b.start = battleSnapshot(b); b.moves = []; b.pk = { c: {}, f: {} };
  return b;
}
// loot multiplier for a battle that just ended: region/run blessings x the 'next' ones it consumed
export function lootMultFor(run, battle) {
  let m = blessProd(run, 'lootMult') * weekMod(run, 'loot', 1);
  for (const x of (battle && battle.next) || []) if (x.kind === 'lootMult') m *= +x.v || 1;
  return m;
}
function boostLoot(run, battle, sum) {
  const m = lootMultFor(run, battle);
  if (sum.loot > 0 && m !== 1) { const extra = Math.round(sum.loot * (m - 1)); run.gold += extra; sum.loot += extra; sum.blessedLoot = true; }
}
// after engine.finishBattle(): apply the territory change. Mutates state.run, extends sum.
export function applyMapResult(state, battle, sum) {
  const run = state.run, node = battle.node;
  settleForge(run, battle, sum);
  if (sum.result === 'win') boostLoot(run, battle, sum);
  if (run.map && node.mapId != null) sum.line = eventLine(run, sum.result === 'win' ? 'battleWin' : 'battleLoss', { place: node.place, gold: sum.loot, piece: linePiece(run, battle, sum.result === 'win') });
  if (sum.result !== 'win' || node.mapId == null || !run.map || node.region !== run.map.region) return sum;
  const st = mapStateOf(run);
  if (!canCapture(st, node.mapId)) return sum;
  run.map.held = capture(st, node.mapId).held;
  const type = st.region.nodes[node.mapId].type;
  sum.mapType = type; sum.place = node.place;
  if (type === 'shrine') { run.map.shrine = node.mapId; sum.shrine = true; fairyShrineFind(state, node.mapId, sum); }
  if (type === 'town') sum.town = true;
  if (node.rival) { sum.fromRival = true; if (type !== 'citadel') { ledgerNote(run, 'lost', node.place); rlogAdd(run, 'lost', `Lost ${node.place} to you`, rivalSays(run, 'lost', node.mapId)); } }
  else if (type === 'mine' && run.map.rival && run.map.rival.status === 'active') rlogAdd(run, 'mine', `Saw you take ${node.place}`, rivalSays(run, 'mine', node.mapId));
  if (type === 'citadel') {
    // the rival's seat: the region is won
    sum.nextRegion = run.map.region + 1; sum.seat = true;
    sum.line = eventLine(run, 'regionWin', { lord: rivalName(run), place: node.place, gold: sum.loot });
    run.map = newWorldMap(run, run.map.region + 1);
    DSC.initDiscovery(run, worldRegion(run)); placeLandmarks(run);
    run.blessings = (run.blessings || []).filter(b => b.scope !== 'region' || b.region >= run.map.region);
    state.bestRegion = Math.max(state.bestRegion || 1, run.map.region); state.seats = (state.seats || 0) + 1;
    fairySeatTaken(state, node.region || run.map.region - 1, sum);
    const lord = lordOf(run); if (lord) sum.lord = { name: lord.name, epithet: lord.epithet, taunt: lord.taunt };
  } else {
    // the rival leaves the node at its next advance; contact may begin here
    run.map.contact = run.map.contact || rivalContact(run);
    discoveryAfterCapture(state, node.mapId, sum);
  }
  worldRefresh(run);
  return sum;
}
// M6 discovery after a capture (battle or cache): piles on held roads, the Spyglass reveal, the site card at the node
function discoveryAfterCapture(state, id, sum) {
  const run = state.run, r = DSC.afterCapture(run, id, worldRegion(run));
  if (r.gains.length) { applyDiscGains(state, r.gains); if (sum) sum.gains = (sum.gains || []).concat(r.gains); }
  if (sum) { if (r.revealed.length) sum.revealed = r.revealed.length; if (r.site != null) sum.site = r.site; }
  return r;
}

// ---- shrine: a one-time choice when a shrine is taken ----
// legacy two-way choice (M2-M4; kept for old callers). M5 shrines draw from content.mjs SHRINE_CHOICES, see below.
export const LEGACY_SHRINE = {
  knight: { label: 'Knighthood', text: 'Knight one pawn for good: a permanent blessing (battle promotions last one battle)' },
  mines: { label: 'Rich veins', text: '+20% mine income for the rest of this region' },
};
// the pawn the shrine would knight: prefer one in the formation, front rank first
export function shrinePawn(run) {
  const placed = Object.entries(run.formation).map(([sq, id]) => [+sq, id]).sort((a, b) => b[0] - a[0]);
  for (const [, id] of placed) { const p = run.roster.find(r => r.id === id); if (p && p.t === 'P') return p; }
  return run.roster.find(r => r.t === 'P') || null;
}
// every pawn the shrine may knight (formation, reserve or garrison)
export function shrinePawns(run) { return run.roster.filter(r => r.t === 'P'); }
// pawnId (optional): the pawn the player tapped; default = shrinePawn()
export function chooseShrine(run, key, pawnId) {
  if (run.map.shrine == null || !LEGACY_SHRINE[key]) return false;
  if (key === 'knight') {
    const p = pawnId != null ? run.roster.find(r => r.id === pawnId) : shrinePawn(run);
    if (!p || p.t !== 'P') return false;
    p.t = 'N';
  }
  else addBlessing(run, { kind: 'mineIncomeMult', v: TUNE.shrineMineBoost, scope: 'region' });
  run.map.shrine = null;
  return true;
}

// ---- garrisons: pieces stationed at held mines of this region (not available to the formation) ----
export function heldMines(run) {
  const reg = worldRegion(run);
  return run.map.held.filter(id => reg.nodes[id] && reg.nodes[id].type === 'mine');
}
export function garrisonOf(run, id) { return (run.map.garrison && run.map.garrison[id]) || []; }
export function cleanGarrisons(run) {
  const m = run.map, g = m.garrison && typeof m.garrison === 'object' ? m.garrison : {}, out = {};
  const mines = new Set(heldMines(run)), seen = new Set(Object.values(run.formation));
  for (const k of Object.keys(g)) {
    const id = +k; if (!mines.has(id) || !Array.isArray(g[k])) continue;
    const list = [];
    for (const pid of g[k]) {
      const p = pieceById(run, pid);
      if (!p || p.t === 'K' || seen.has(pid) || list.length >= WORLD.garrisonMax) continue;
      seen.add(pid); list.push(pid);
    }
    if (list.length) out[id] = list;
  }
  m.garrison = out;
  return out;
}
// station a piece (from the formation or reserve) at a held mine
export function stationPiece(run, mineId, pieceId) {
  const p = pieceById(run, pieceId);
  if (!p || p.t === 'K' || !heldMines(run).includes(mineId)) return false;
  if ((run.map.raid && run.map.raid.pending) || rivalPending(run)) return false;
  for (const k of Object.keys(run.map.garrison)) if (run.map.garrison[k].includes(pieceId)) return false;
  const list = run.map.garrison[mineId] || (run.map.garrison[mineId] = []);
  if (list.length >= WORLD.garrisonMax) return false;
  for (const k of Object.keys(run.formation)) if (run.formation[k] === pieceId) delete run.formation[k];
  list.push(pieceId);
  return true;
}
// recall a garrisoned piece to the reserve (auto-placed on a free owned square when there is one)
export function recallPiece(run, mineId, pieceId) {
  const list = run.map.garrison[mineId]; if (!list || !list.includes(pieceId)) return false;
  if ((run.map.raid && run.map.raid.pending) || rivalPending(run)) return false;
  list.splice(list.indexOf(pieceId), 1);
  if (!list.length) delete run.map.garrison[mineId];
  const p = pieceById(run, pieceId);
  const free = run.owned.filter(sq => run.formation[sq] == null).sort((a, b) => p.t === 'P' ? (b >> 3) - (a >> 3) : (a >> 3) - (b >> 3));
  if (free.length) run.formation[free[0]] = pieceId;
  return true;
}
// lose a held mine (conceded or a failed defence): territory, income and the garrison (survivors go home)
export function loseMine(run, id) {
  const reg = worldRegion(run);
  if (!run.map.held.includes(id) || reg.nodes[id].type !== 'mine') return false;
  run.map.held = run.map.held.filter(x => x !== id);
  const tier = Math.max(1, reg.nodes[id].tier), i = run.mines.indexOf(tier);
  if (i >= 0) run.mines.splice(i, 1);
  delete run.map.garrison[id];
  if (run.map.march && !canCapture(mapStateOf(run), run.map.march.id)) run.map.march = null;
  worldRefresh(run);
  return true;
}
// lose any held node except the keep (a border battle lost or conceded)
export function loseNode(run, id) {
  const reg = worldRegion(run);
  if (!run.map.held.includes(id) || id === reg.keepId) return false;
  if (reg.nodes[id].type === 'mine') return loseMine(run, id);
  run.map.held = run.map.held.filter(x => x !== id);
  if (run.map.shrine === id) run.map.shrine = null;
  if (run.map.march && !canCapture(mapStateOf(run), run.map.march.id)) run.map.march = null;
  worldRefresh(run);
  return true;
}

// ---- raids: rivals hit one of your mines every few minutes of active map time ----
// the timer only runs while you hold a mine in this region and no battle, march, shrine choice or raid is pending
// the raid clock counts world ticks (battle moves and marches only); it pauses only while a choice waits
export function raidPaused(run) { const m = run.map; return !!(m.shrine != null || DSC.discoveryBusy(run) || (m.raid && m.raid.pending) || rivalPending(run)); }
// ambient raids only run until the rival's border first touches yours; after that the rival IS the raider
export function raidClockRuns(run) { return !raidPaused(run) && !run.map.contact && heldMines(run).length > 0; }
export function raidInterval(run, n) {
  const r = mapHashSeed(run.map.seed + '|raid|' + n) / 4294967296;
  return Math.round(WORLD.raidEvery + (r * 2 - 1) * WORLD.raidJitter);
}
// the mine the next raid will hit (shown on the map); deterministic per region + raid count
export function raidTarget(run) {
  const mines = heldMines(run); if (!mines.length) return null;
  const n = run.map.raid.n, reg = worldRegion(run);
  // richer mines draw raiders more often: weight = tier
  const w = mines.map(id => Math.max(1, reg.nodes[id].tier)), tot = w.reduce((a, b) => a + b, 0);
  let x = (mapHashSeed(run.map.seed + '|raidpick|' + n) % 1000) / 1000 * tot;
  for (let i = 0; i < mines.length; i++) { x -= w[i]; if (x < 0) return mines[i]; }
  return mines[mines.length - 1];
}
// advance the raid clock by dt ms (call only when no battle is running). Returns the raid when one starts.
export function raidTick(run, dt) {
  const r = run.map.raid;
  if (!raidClockRuns(run) || !(dt > 0)) return null;
  r.t -= dt;
  if (r.t > 0) return null;
  const id = raidTarget(run);
  r.pending = { id, n: r.n };
  r.n++; r.t = raidInterval(run, r.n);
  return r.pending;
}
export function raidBudget(run, id) {
  const reg = worldRegion(run), tier = Math.max(1, reg.nodes[id].tier);
  const k = WORLD.raidBase + WORLD.raidPerMine * Math.min(WORLD.raidMineCap, run.mines.length);
  return Math.max(1, enemyBudget(tier, 'mine') * k * (1 + WORLD.raidRegion * (run.map.region - 1)) * blessProd(run, 'enemyBudgetMult'));
}
// the raiding party for a pending raid
export function raidArmy(run) {
  const p = run.map.raid && run.map.raid.pending; if (!p) return null;
  const reg = worldRegion(run), n = reg.nodes[p.id], tier = Math.max(1, n.tier);
  const key = mapHashSeed(run.map.seed + '|raider|' + p.n) % 100003;
  const a = enemyArmy(run.seed, tier, { type: 'raid', key, budget: raidBudget(run, p.id) });
  a.type = 'raid'; a.raid = true; a.tier = tier; a.mapId = p.id; a.region = run.map.region; a.place = n.name;
  a.elo = cleanElo(regionElo(run.elo, run.map.region) + blessSum(run, 'enemyElo')); a.traits = cursedTraits(run, tierTraits(tier));
  a.units = armyUnits(a.pieces); a.depth = eloCfg(a.elo).maxDepth; a.doctrine = 'aggressive';
  enemyMats(run, a); withTerrain(run, a, 'raid' + p.id + '|' + p.n, 'raid');
  return a;
}
export function canDefend(run) { const p = run.map.raid && run.map.raid.pending; return !!p && garrisonOf(run, p.id).length > 0; }
export function concedeRaid(run) {
  const p = run.map.raid && run.map.raid.pending; if (!p) return false;
  run.map.raid.pending = null;
  return loseMine(run, p.id);
}
const DEF_SQ = { P: ['e2', 'd2', 'f2', 'c2', 'g2', 'b2'], X: ['d1', 'f1', 'c1', 'g1', 'b1', 'h1'] };
// a castellan king (id 0, not on the roster: losing it loses the mine, not the run) + the mine's garrison
export function garrisonWhites(run, mineId) {
  const list = garrisonOf(run, mineId).map(id => pieceById(run, id)).filter(Boolean);
  const whites = [{ sq: parseSq('e1'), id: 0, t: 'K' }], used = new Set([parseSq('e1')]);
  const take = arr => { for (const s of arr) { const q = parseSq(s); if (!used.has(q)) { used.add(q); return q; } } for (let q = 0; q < 16; q++) if (!used.has(q)) { used.add(q); return q; } return -1; };
  for (const p of list.slice().sort((x, y) => (x.t === 'P') - (y.t === 'P'))) whites.push({ sq: take(p.t === 'P' ? DEF_SQ.P.concat(DEF_SQ.X) : DEF_SQ.X.concat(DEF_SQ.P)), id: p.id, t: p.t });
  return whites;
}
// defence battle: castellan + garrison
export function defendRaid(run) {
  if (!canDefend(run)) return null;
  const a = raidArmy(run);
  return worldBattle(run, a, garrisonWhites(run, a.mapId));
}
// after a defence battle: win or draw keeps the mine (half loot on a win), anything else loses it
export function finishDefence(state, battle, result) {
  const run = state.run, id = battle.node.mapId;
  const promoted = settleRoster(run, battle);
  const sameRegion = run.map.region === battle.node.region;
  if (sameRegion) cleanGarrisons(run);
  const kept = result === 'win' || result === 'draw';
  const sum = { result: result === 'mate' ? 'loss' : result, raid: true, kept, tier: battle.tier, type: 'raid', lost: battle.lost.length, promoted: promoted.length, loot: 0, memories: 0, place: battle.node.place };
  settleForge(run, battle, sum);
  if (sameRegion && run.map.raid) run.map.raid.pending = null;
  if (kept) {
    if (result === 'win') { sum.loot = Math.round(lootFor(battle.tier, state.memories) * WORLD.raidLootMult); run.gold += sum.loot; run.wins++; boostLoot(run, battle, sum); }
  } else {
    if (sameRegion) loseMine(run, id);
    run.losses++;
  }
  sum.line = eventLine(run, kept ? 'raidRepelled' : 'raidLost', { place: battle.node.place, gold: sum.loot, lord: rivalName(run), piece: linePiece(run, battle, kept) });
  if (!run.roster.some(r => r.t !== 'K')) { levy(run, 2); sum.levy = 2; }
  return sum;
}

// ---- save migration ----
// v1 (linear road) -> v2 (world map): keeps memories, roster, formation, gold, upgrades and held mines;
// starts the map at the region matching the old road tier.
// v2 -> v3 (Memories shop, standing orders, raids/garrisons): each old Memory was worth +5% gold, a new
// unspent one only +1%, so old Memories become spendable 1:1 plus a one-time bonus of the same amount
// (capped at +50) to spend in the shop.
// settings.autoRetreat becomes the retreat order (on -> cautious, off -> off). Returns a v3 state, or null.
export function migrateMemories(m) { m = Math.max(0, m | 0); return m + Math.min(50, m); }
export function migrateState(s) {
  if (!s || !s.run || !Array.isArray(s.run.roster) || !s.run.formation || !s.settings) return null;
  if (s.v !== 1 && s.v !== 2 && s.v !== 3 && s.v !== 4 && s.v !== 5 && s.v !== SAVE_VERSION) return null;
  let out = s;
  const tickMap = s.v === 1; // a v1 save gets a brand-new map below, already in ticks
  if (s.v === 1) {
    const fresh = newState(Date.now(), s.run.seed >>> 0);
    out = Object.assign({}, s, { v: 2, migratedFrom: 1 });
    out.run = Object.assign({}, fresh.run, s.run);
    if (!Array.isArray(out.run.mines)) out.run.mines = [];
    out.run.map = null;
    ensureMap(out.run, Math.floor((Math.max(1, out.run.tier | 0) - 1) / 10) + 1);
  }
  if (out.v === 2) {
    out = Object.assign({}, out, { v: 3, migratedFrom: out.migratedFrom || 2 });
    out.memEarned = out.memories | 0;
    out.memories = migrateMemories(out.memories);
    out.memSpent = 0;
    out.run = Object.assign({}, out.run, { orders: cleanOrders({ retreat: out.settings.autoRetreat === false ? 'off' : 'cautious' }), touched: true });
    out.settings = Object.assign({}, out.settings); delete out.settings.autoRetreat;
  }
  if (out.v === 3) {
    // v3 -> v4 (living rival, dwellings, elo bands): the run keeps going at the default band (900) with no
    // dwellings; the rival lord of the current region starts fresh at its seat (ensureMap creates it).
    // The elo picker is not forced on a migrated player; it appears on the next run-over screen.
    out = Object.assign({}, out, { v: 4, migratedFrom: out.migratedFrom || 3, elo: ELO_TUNE.def, eloPicked: false, eloAsk: true });
    out.run = Object.assign({}, out.run, { elo: ELO_TUNE.def, dwell: cleanDwell(null) });
    // real time -> ticks: the raid countdown (ms) becomes ticks at 1 s per tick; a march in progress restarts
    // at the tick price of its target (its old start time means nothing in tick time)
    if (out.run.map && !tickMap) {
      const mp = out.run.map, raid = mp.raid ? Object.assign({}, mp.raid, { t: Math.max(1, Math.round((mp.raid.t || 0) / 1000 / TUNE.tickSec)) }) : mp.raid;
      out.run.map = Object.assign({}, mp, { rival: null, contact: false, rlog: [], raid, march: mp.march && mp.march.id != null ? { id: mp.march.id, need: 1, done: 0, fix: true } : null });
    } else if (out.run.map) out.run.map = Object.assign({}, out.run.map, { rival: null, contact: false, rlog: [] });
  }
  if (out.v === 4) {
    // v4 -> v5 (forge, terrain, content pack, cosmetics). The run keeps going with a fresh forge at tick 0; the
    // old shrine mine blessing becomes a region blessing; the current map keeps its formations and rival
    // (no lord, no pack formations, no caches: saved maps stay stable) until the next region.
    // Elo: a save that never chose a band explicitly (still the default 900, or migrated from before v4) is
    // asked once with the "Choose your foes" card on load; a band other than 900 counts as chosen.
    const asked = out.eloAsk || cleanElo(out.elo) === ELO_TUNE.def;
    out = Object.assign({}, out, { v: 5, migratedFrom: out.migratedFrom || 4, eloPicked: asked ? false : out.eloPicked !== false,
      bestRegion: Math.max(1, (out.run.map && out.run.map.region) | 0), seats: 0, cosmetics: { unlocked: ['classic'], set: 'classic', forged: [] } });
    delete out.eloAsk;
    const bl = out.run.mineBless != null ? [{ kind: 'mineIncomeMult', v: TUNE.shrineMineBoost, scope: 'region', region: out.run.mineBless }] : [];
    out.run = Object.assign({}, out.run, { ticks: 0, blessings: bl, memBonus: 0, forge: null });
    delete out.run.mineBless;
    if (out.run.map) out.run.map = Object.assign({}, out.run.map, { pack: !!out.run.map.pack, lord: out.run.map.lord ?? null, scouted: [], rivalAdj: 0 });
  }
  if (out.v === 5) {
    // v5 -> v6 (fairy pieces): the state itself holds no piece codes (the formation is roster ids); a saved battle is
    // migrated by migrateBattleSave(battle, the save's version) with fairy.mjs migrateBoardCodes / migrateMove.
    // Account unlocks start from the regions already reached (cleanFairy), with their ceremonies queued.
    out = Object.assign({}, out, { v: SAVE_VERSION, migratedFrom: out.migratedFrom || 5 });
  }
  out.elo = cleanElo(out.elo); out.eloPicked = out.eloPicked !== false;
  out.bestRegion = Math.max(1, out.bestRegion | 0); out.seats = Math.max(0, out.seats | 0);
  out.cosmetics = cleanCosmetics(out.cosmetics);
  if (!Array.isArray(out.run.blessings)) out.run.blessings = [];
  out.run.ticks = Math.max(0, +out.run.ticks || 0); out.run.memBonus = Math.max(0, out.run.memBonus | 0);
  out.run.elo = cleanElo(out.run.elo ?? out.elo); out.run.dwell = cleanDwell(out.run.dwell);
  out.upgrades = cleanUpgrades(out.upgrades);
  out.memories = Math.max(0, +out.memories || 0);
  out.run.orders = cleanOrders(out.run.orders);
  ensureMap(out.run);
  // M6: skills are additive (no version bump): repair them on every load; the price cache is always re-derived
  out.skills = SK.cleanSkills(out.skills); out.run.skillMods = SK.skillMods(out.skills);
  if (out.run.map.march && out.run.map.march.fix) out.run.map.march = { id: out.run.map.march.id, need: marchNeed(out.run, out.run.map.march.id), done: 0 };
  cleanP1(out);
  cleanFairy(out);
  return out;
}

// ---- settings + save export/import (Settings pass) ----
// state.settings: every field optional, so older saves load; vol is the master volume 0..1 (audio setVolume master).
export const SETTINGS_DEF = { theme: 'auto', sound: true, speed: 1, threat: true, vol: 0.8 };
export function cleanSettings(s) {
  const o = Object.assign({}, SETTINGS_DEF, s && typeof s === 'object' && !Array.isArray(s) ? s : null);
  if (!['auto', 'light', 'dark'].includes(o.theme)) o.theme = 'auto';
  o.sound = o.sound !== false; o.threat = o.threat !== false;
  if (![1, 2, 4].includes(o.speed)) o.speed = 1;
  o.vol = Number.isFinite(+o.vol) ? Math.round(Math.max(0, Math.min(1, +o.vol)) * 100) / 100 : SETTINGS_DEF.vol;
  return o;
}
// the exported string is the save exactly as the page stores it: JSON of { state, battle }
export function exportSaveText(snap) { return JSON.stringify(snap); }
// parse a pasted save. Returns { ok: true, data } (data is the raw { state, battle }, migrated later like a load)
// or { ok: false, err } with a plain reason. Never throws; never touches the caller's save.
export function parseSaveText(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, err: 'Paste a save string first.' };
  let data;
  try { data = JSON.parse(text.trim()); } catch (e) { return { ok: false, err: 'That text is not a Checkmarch save (it could not be read).' }; }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !data.state || typeof data.state !== 'object') return { ok: false, err: 'That text is not a Checkmarch save.' };
  const v = data.state.v;
  if (typeof v !== 'number' || !(v >= 1)) return { ok: false, err: 'That save has no version, so it cannot be loaded.' };
  if (v > SAVE_VERSION) return { ok: false, err: `That save is from a newer version (v${v}); this page reads up to v${SAVE_VERSION}.` };
  let st = null;
  try { st = migrateState(JSON.parse(JSON.stringify(data.state))); } catch (e) { st = null; }
  if (!st) return { ok: false, err: 'That save is damaged or incomplete, so it cannot be loaded.' };
  return { ok: true, data: { state: data.state, battle: data.battle ?? null } };
}

// ---- the living rival (rival.mjs): a lord at the citadel who takes nodes, grows and attacks your border ----
export function rivalOf(run) { return run.map && run.map.rival; }
export function rivalPending(run) { const r = rivalOf(run); return r && r.status === 'active' && r.pending ? r.pending : null; }
// the rival holds node id (and the player does not)
export function rivalOwns(run, id) { const r = rivalOf(run); return !!r && r.held.includes(id) && !run.map.held.includes(id); }
export function rivalOwnersOf(run) { return rivalOwners(run.map.rival, worldRegion(run), run.map.held); }
// the rival's border touches the player's: some player-held node is next to rival territory
export function rivalContact(run) {
  const r = rivalOf(run); if (!r || r.status !== 'active') return false;
  const held = new Set(run.map.held);
  return rivalFrontier(r, worldRegion(run)).some(id => held.has(id));
}
// the rival lord is the region's named boss (the citadel's lord in earlier versions)
export function rivalName(run) { const l = lordOf(run); if (l) return l.name; const reg = worldRegion(run); return reg.nodes[reg.citadelId].boss || 'the rival lord'; }
export const capFirst = t => t ? t[0].toUpperCase() + t.slice(1) : t;
export function rivalDoctrine(run) { const l = lordOf(run); if (l) return CONTENT.ENGINE_DOCTRINE[l.doctrine]; return DOCTRINE_KEYS[mapHashSeed(run.map.seed + '|rivaldoc') % DOCTRINE_KEYS.length]; }
export function rivalTraits(run) { const r = rivalView(run); return cursedTraits(run, traitLevels(r ? r.dwellings : 0)); }
// world ticks until the rival's next move (null while an attack waits or the rival is done)
export function rivalEta(run) { const r = rivalOf(run), e = r ? nextMoveEta(r) : null; return e == null ? null : Math.ceil(e / WORLD.rivalSecPerTick); }
// the rival as its armies see it: shrine rivalStrength effects (run.map.rivalAdj) shift its xp in a copy, so
// strength / dwellings / army tier move by that much. rival.mjs and its saved state stay untouched.
function rivalXpOf(s) { const T = RIVAL_TUNE; return s.ms / T.xpTimeMs + s.mineMs / T.xpMineMs + s.captures * T.xpCapture + s.sorties * T.xpSortie + s.borderWins * T.xpBorderWin; }
export function rivalView(run) {
  const r = rivalOf(run), adj = run.map && +run.map.rivalAdj || 0;
  if (!r || !adj) return r;
  const T = RIVAL_TUNE, base = r.strength, target = Math.max(1, Math.min(1 + T.bonusCap, base + adj));
  if (target === base) return r;
  const xpT = 3 * (Math.pow(2, (target - 1) / T.bonusScale) - 1), v = JSON.parse(JSON.stringify(r));
  v.captures += (xpT - rivalXpOf(r)) / T.xpCapture; // total xp is now exactly xpT
  v.strength = target;
  v.dwellings = Math.min(T.dwellingCap, Math.max(0, Math.floor(Math.log2(1 + Math.max(0, xpT)))));
  return v;
}
// rival.mjs army spec -> engine army (enemyArmy shape + world fields). rivalArmyFor() supplies the tier, role
// and elo; the pieces are filled by engine enemyArmy() on the engine budget curve (with its early-tier ramp)
// times the role multiplier (border 1.0, garrison 0.95, keep 1.2) and WORLD.rivalArmy. With the module's own
// flat curve, region-1 border hosts were ~25% bigger than the garrisons around them and the bot lost its keep
// in 11 of 20 runs.
function rivalArmyOut(run, ra, id, extra) {
  const reg = worldRegion(run), n = reg.nodes[id], tier = Math.max(1, Math.round(ra.tier)), T = RIVAL_TUNE;
  const keep = ra.role === 'keepAssault', mult = keep ? T.multKeep : ra.role === 'garrison' ? T.multGarrison : T.multBorder;
  const key = mapHashSeed(run.map.seed + '|rival|' + id + '|' + ra.role + '|' + tier) % 100003;
  const e = enemyArmy(run.seed, tier, { type: keep ? 'citadel' : 'garrison', key, formation: keep ? null : lordFormation(run, id, tier, ra.role), budget: enemyBudget(tier, 'garrison') * mult * WORLD.rivalArmy * blessProd(run, 'enemyBudgetMult') });
  const a = Object.assign({ type: n.type, name: keep ? ra.name : e.name, boss: rivalName(run), pieces: e.pieces,
    tier, mapId: id, region: run.map.region, place: n.name, rival: true, role: ra.role,
    elo: cleanElo(ra.elo + blessSum(run, 'enemyElo')), traits: rivalTraits(run), doctrine: rivalDoctrine(run), mineTier: Math.max(1, n.tier) }, extra || {});
  fairyArmy(run, a, run.map.seed + '|rival|' + id + '|' + ra.role, { rival: true, boss: keep || !!(extra && extra.seat) });
  a.units = armyUnits(a.pieces); a.depth = eloCfg(a.elo).maxDepth;
  enemyMats(run, a); withTerrain(run, a, id + '|' + ra.role, keep ? 'keep' : ra.role === 'garrison' ? n.type : 'raid');
  return a;
}
// the rival's garrison on a node it holds (the player attacks it). The seat is the old citadel:
// citadel formation and budget multiplier, the boss elo bonus, the rival's name as the boss.
export function rivalNodeArmy(run, id) {
  const rv = rivalView(run), reg = worldRegion(run), ra = rivalArmyFor(rv, id, reg);
  if (id !== reg.citadelId) return rivalArmyOut(run, ra, id);
  const tier = Math.max(1, Math.round(ra.tier));
  const e = enemyArmy(run.seed, Math.max(10, tier), { type: 'citadel', budget: enemyBudget(tier, 'citadel') * WORLD.rivalArmy * blessProd(run, 'enemyBudgetMult') });
  const a = rivalArmyOut(run, ra, id, { type: 'citadel', name: e.name, pieces: e.pieces, seat: true, elo: cleanElo(ra.elo + ELO_TUNE.boss + blessSum(run, 'enemyElo')) });
  a.units = armyUnits(a.pieces); enemyMats(run, a); withTerrain(run, a, id + '|seat', 'citadel');
  return a;
}
// the army of a pending border battle / keep assault
export function borderArmy(run) {
  const p = rivalPending(run); if (!p) return null;
  const ra = rivalArmyFor(rivalView(run), p.nodeId, worldRegion(run));
  const keep = p.type === 'keepAssault';
  return rivalArmyOut(run, ra, p.nodeId, { type: 'rival', border: true, kind: keep ? 'keep' : 'border', noRetreat: keep, doctrine: keep ? rivalDoctrine(run) : 'aggressive' });
}
// how a pending border battle is fought: 'keep' (formation, the run is at stake), 'garrison' (castellan + the
// mine's garrison), or 'formation' (your army marches out; your King fights, so mate ends the run)
export function borderMode(run) {
  const p = rivalPending(run); if (!p) return null;
  if (p.type === 'keepAssault') return 'keep';
  const n = worldRegion(run).nodes[p.nodeId];
  return n.type === 'mine' && garrisonOf(run, p.nodeId).length ? 'garrison' : 'formation';
}
export function defendBorder(run) {
  const a = borderArmy(run); if (!a) return null;
  const mode = borderMode(run);
  if (mode === 'garrison') { a.castellan = true; return worldBattle(run, a, garrisonWhites(run, a.mapId)); }
  if (mode === 'keep') return worldBattle(run, a, keepWhites(run));
  return worldBattle(run, a);
}
// the formation plus the keep's militia pawns (ids from 1e6: never on the roster, so they cost nothing)
export function keepWhites(run) {
  const whites = Object.entries(run.formation).map(([sq, id]) => ({ sq: +sq, id, t: pieceById(run, id).t }));
  const used = new Set(whites.map(w => w.sq));
  const free = []; for (let sq = 15; sq >= 8; sq--) if (!used.has(sq)) free.push(sq);
  free.sort((a, b) => Math.abs((a & 7) - 3.5) - Math.abs((b & 7) - 3.5));
  // P0-4: the weekly muster's pawns stand with the keep's own militia (rank 2 first, then rank 1)
  for (let sq = 7; sq >= 0; sq--) if (!used.has(sq)) free.push(sq);
  const n = WORLD.keepMilitia + militiaOf(run);
  for (let i = 0; i < n && i < free.length; i++) whites.push({ sq: free[i], id: 1e6 + i, t: 'P' });
  return whites;
}
// concede: the rival takes the node. Conceding the keep ends the run (returns { runOver: true }).
export function concedeBorder(state) {
  const run = state.run, p = rivalPending(run); if (!p) return null;
  const name = worldRegion(run).nodes[p.nodeId].name;
  run.map.rival = resolveBorder(run.map.rival, p.nodeId, false);
  if (p.type === 'keepAssault') { rlogAdd(run, 'keep', `${rivalName(run)} took your keep`); return { runOver: true, memories: mateMemories(run.sumTiers) }; }
  loseNode(run, p.nodeId);
  rlogAdd(run, 'took', `Took ${name} (conceded)`); ledgerNote(run, 'took', name);
  return { runOver: false, nodeId: p.nodeId };
}
// after a border battle: a win or draw repels the rival (half loot-ish on a win); a loss hands the node over.
// A lost keep assault, or your King mated while defending with the formation, ends the run (25% Memories).
export function finishBorder(state, battle, result) {
  const run = state.run, node = battle.node, id = node.mapId, castellan = !!node.castellan, keep = node.kind === 'keep';
  const promoted = settleRoster(run, battle);
  const same = run.map.region === node.region;
  if (same) cleanGarrisons(run);
  const kept = result === 'win' || result === 'draw';
  const sum = { result: result === 'mate' && castellan ? 'loss' : result, border: true, keep, castellan, kept, tier: battle.tier, type: 'rival', lost: battle.lost.length, promoted: promoted.length, loot: 0, memories: 0, place: node.place, boss: node.boss };
  settleForge(run, battle, sum);
  const p = same ? rivalPending(run) : null;
  if (p && p.nodeId === id) run.map.rival = resolveBorder(run.map.rival, id, kept);
  if (kept) {
    if (result === 'win') { sum.loot = Math.round(lootFor(battle.tier, state.memories) * WORLD.borderLootMult); run.gold += sum.loot; run.wins++; boostLoot(run, battle, sum); }
    if (same) rlogAdd(run, 'repelled', `Repelled at ${node.place}`);
  } else {
    run.losses++;
    if (keep || (result === 'mate' && !castellan)) { sum.runOver = true; sum.memories = mateMemories(run.sumTiers); }
    else if (same) { loseNode(run, id); rlogAdd(run, 'took', `Took ${node.place} from you`); ledgerNote(run, 'took', node.place); }
  }
  if (!sum.runOver && !run.roster.some(r => r.t !== 'K')) { levy(run, 2); sum.levy = 2; }
  sum.line = eventLine(run, sum.runOver ? 'regionLose' : kept ? 'battleWin' : 'battleLoss', { lord: node.boss, place: node.place, gold: sum.loot, piece: linePiece(run, battle, kept) });
  return sum;
}
// content variety 5: the rival lord's voice in the chronicle, by the lord's doctrine (pure text, picked by a hash)
export const RIVAL_SAYS = {
  aggressive: {
    capture: ['Another flag for my wall.', 'Too slow. It is mine now.', 'I take, you watch. Keep watching.'],
    mine: ['Dig fast. I am coming for that seam.', 'Enjoy the ore while you can carry it.', 'A mine? I will burn it out from under you.'],
    lost: ['Lucky. Do it twice and I will notice.', 'You will pay that back with interest.', 'Good. Now I have a reason.'],
    keep: ['Open the gates, or I open them for you.', 'I can smell your hearth from here.', 'Today your walls learn my name.'] },
  solid: {
    capture: ['Patience takes everything in the end.', 'One more stone in my wall.', 'Quietly done, as it should be.'],
    mine: ['Take it. Holding it is the hard part.', 'A mine is a long promise. Can you keep it?', 'I have outlasted richer lords than you.'],
    lost: ['A step back is not a fall.', 'I will wait. You will tire.', 'Keep it warm for me.'],
    keep: ['I have waited long enough at your door.', 'The siege is slow. So am I. Neither of us stops.', 'Your keep stands. For now.'] },
  material: {
    capture: ['Entered in the ledger: one more for me.', 'Bought cheap, held dear.', 'Profit, plain and simple.'],
    mine: ['Your mine, my future income.', 'I have already priced that ore.', 'Every seam you open, I will tax.'],
    lost: ['A write-off. I will collect later.', 'Noted. Your bill grows.', 'Expensive for you, I suspect.'],
    keep: ['I have come to collect.', 'Your keep is the last item on my list.', 'Everything you own, itemised and claimed.'] },
};
export function rivalSays(run, k, id) {
  const l = lordOf(run), T = RIVAL_SAYS[l && RIVAL_SAYS[l.doctrine] ? l.doctrine : 'solid'][k];
  if (!T) return '';
  const recent = (run.map.rlog || []).map(e => e.q).filter(Boolean).slice(-2);
  let i = mapHashSeed(run.map.seed + '|says|' + k + '|' + id) % T.length;
  for (let n = 0; n < T.length - 1 && recent.includes(T[i]); n++) i = (i + 1) % T.length;
  return T[i];
}
// rival chronicle: newest last; repeated sorties fold into one line
export function rlogAdd(run, k, t, q) {
  const L = run.map.rlog || (run.map.rlog = []), last = L[L.length - 1];
  if (last && last.k === k && k === 'sortie') { last.n++; return; }
  L.push(q ? { k, t, n: 1, q } : { k, t, n: 1 });
  if (L.length > WORLD.rlogMax) L.splice(0, L.length - WORLD.rlogMax);
}
function rlogEvent(run, ev) {
  const n = worldRegion(run).nodes[ev.nodeId], nm = n ? n.name : '?';
  if (ev.type === 'capture') { rlogAdd(run, 'capture', `Took ${nm}`, rivalSays(run, 'capture', ev.nodeId)); ledgerNote(run, 'took', nm); }
  else if (ev.type === 'sortie') { rlogAdd(run, 'sortie', 'Drilled its troops'); ledgerNote(run, 'drill'); }
  else if (ev.type === 'borderBattle') rlogAdd(run, 'border', `Attacked ${nm}`);
  else if (ev.type === 'keepAssault') rlogAdd(run, 'keep', 'Assaulted your keep', rivalSays(run, 'keep', ev.nodeId));
}
// advance the rival by n world ticks (online: moves and marches; false: the quiet mode of the old catch-up).
// Never runs while an ambient raid waits for orders (only one threat is pending at a time).
// Returns the rival's events, plus { type: 'contact' } when its border first touches yours.
export function tickRival(run, ticks, online) {
  const m = run.map, rv = m.rival;
  if (!rv || rv.status !== 'active' || !(ticks > 0) || (m.raid && m.raid.pending)) return [];
  const r = advanceRival(rv, worldRegion(run), m.held, ticks * WORLD.rivalSecPerTick, { online: !!online });
  m.rival = r.state;
  for (const ev of r.events) rlogEvent(run, ev);
  const ev = r.events.slice();
  if (!m.contact && rivalContact(run)) { m.contact = true; ev.push({ type: 'contact' }); }
  return ev;
}
// one line for an offline catch-up: "took 5 nodes, drilled 3 times, attacks Oakford"
export function rivalSummary(run, events) {
  const reg = worldRegion(run), c = events.filter(e => e.type === 'capture').length, so = events.filter(e => e.type === 'sortie').length;
  const p = events.find(e => e.type === 'borderBattle');
  const bits = [];
  if (c) bits.push(`took ${c} node${c === 1 ? '' : 's'}`);
  if (so) bits.push(`drilled its troops${so > 1 ? ' ' + so + ' times' : ''}`);
  if (p) bits.push(`now attacks ${reg.nodes[p.nodeId].name}`);
  return bits.length ? `${capFirst(rivalName(run))} ${bits.join(', ')}.` : '';
}

// =====================================================================
// M5: forge and frontier
// =====================================================================

// ---- forge (forge.mjs) on the world clock ----
// forge.mjs counts real milliseconds. Here it runs on WORLD TICKS: its "now" is run.ticks x FORGE_MS_PER_TICK
// (3000 ms = TUNE.tickSec, the same conversion the gold economy uses). So the trickle is RATES per 1200 ticks
// (an "hour" = 3.6e6 ms / 3000), a stockpile holds 24 such hours, and the smelt cap resets every 28,800 ticks
// (a forge "day" = 86.4e6 ms / 3000). The forge's own 8 h gap cap (9600 ticks) never bites: worldTick feeds it
// every tick, and away time grants no ticks at all.
export const FORGE_MS_PER_TICK = TUNE.tickSec * 1000;
export const FORGE_TICKS_PER_HOUR = 3600000 / FORGE_MS_PER_TICK, FORGE_TICKS_PER_DAY = 86400000 / FORGE_MS_PER_TICK;
export function forgeNow(run) { return Math.floor((run.ticks || 0) * FORGE_MS_PER_TICK); }
export function ensureForge(run) {
  if (!run.forge || run.forge.v !== 1 || !run.forge.stock || !run.forge.mats) run.forge = loadForge(run.forge, forgeNow(run));
  return run.forge;
}
// mine resources: region 1 tin + coal, iron ore from region 2, obsidian shards from region 3. Mines take the
// pool in turn (by node id, from a seeded offset), so every region offers each of its resources.
const RES_POOL = r => r >= 3 ? ['tin', 'coal', 'iron', 'shards'] : r >= 2 ? ['tin', 'coal', 'iron'] : ['tin', 'coal'];
let resCacheKey = '', resCache = null;
export function mineResources(run) {
  const k = run.map.seed + '#' + run.map.region;
  if (k !== resCacheKey) {
    const reg = worldRegion(run), pool = RES_POOL(run.map.region), off = mapHashSeed(run.map.seed + '|res') % pool.length;
    resCache = {}; reg.nodes.filter(n => n.type === 'mine').forEach((n, i) => { resCache[n.id] = pool[(i + off) % pool.length]; });
    resCacheKey = k;
  }
  return resCache;
}
export function mineResource(run, id) { return mineResources(run)[id] || null; }
export function heldMineRes(run) { return heldMines(run).map(id => ({ id, resource: mineResource(run, id) })); }
export const RES_SHORT = { tin: 'tin', coal: 'coal', iron: 'iron ore', shards: 'obsidian shards' };
export function forgeStatus(run) {
  const f = ensureForge(run), now = forgeNow(run), c = mineCounts(heldMineRes(run));
  return { now, left: smeltsLeft(f, now), perDay: smeltsPerDay(f), resetIn: Math.ceil((nextResetAt(now) - now) / FORGE_MS_PER_TICK), counts: c,
    caps: { tin: stockCap('tin', c.tin), coal: stockCap('coal', c.coal), iron: stockCap('iron', c.iron), shards: stockCap('shards', c.shards) },
    level: f.smelt.level, upgradePrice: f.smelt.level >= MAX_SMELT_LEVEL ? null : smeltLevelPrice(f.smelt.level) };
}
// P0-4 Week of the Forge: a smelt needs only half the ore (rounded up). forge.mjs is untouched: the waived part is
// lent to the stockpile for the smelt (and taken back if it fails), so the module's own checks still run.
export function smeltCost(run, recipe) {
  const rc = RECIPES[recipe]; if (!rc) return null;
  const f = weekMod(run, 'smelt', 1), o = {};
  for (const k of Object.keys(rc.in)) o[k] = f === 1 ? rc.in[k] : Math.max(1, Math.ceil(rc.in[k] * f));
  return o;
}
export function forgeSmelt(state, recipe) {
  const run = state.run, f0 = ensureForge(run), cost = smeltCost(run, recipe);
  let base = f0;
  if (cost && RECIPES[recipe] && weekMod(run, 'smelt', 1) !== 1) {
    base = JSON.parse(JSON.stringify(f0));
    for (const k of Object.keys(cost)) if (base.stock[k] >= cost[k]) base.stock[k] += RECIPES[recipe].in[k] - cost[k];
  }
  const r = smelt(base, recipe, forgeNow(run));
  if (!r.ok) return r;
  run.forge = r.state; run.touched = true;
  const c = state.cosmetics = cleanCosmetics(state.cosmetics);
  if (!c.forged.includes(recipe)) c.forged.push(recipe);
  return r;
}
// the forge's smelt-cap upgrade costs gold (forge.mjs smeltLevelPrice; no shop discount)
export function forgeUpgrade(run) {
  const st = forgeStatus(run); if (st.upgradePrice == null || run.gold < st.upgradePrice) return false;
  const r = upgradeSmeltCap(run.forge); if (!r.ok) return false;
  run.gold -= st.upgradePrice; run.forge = r.state; run.touched = true; return true;
}
export function pieceMaterial(run, id) { return run.forge ? materialOf(run.forge, id) : 'wood'; }
export function forgeApplyBar(run, pieceId) {
  const p = pieceById(run, pieceId); if (!p || p.t === 'K') return { ok: false, reason: 'no-piece' };
  const r = applyBar(ensureForge(run), pieceId);
  if (r.ok) { run.forge = r.state; run.touched = true; }
  return r;
}
// perma-death: every roster piece captured in a battle loses its bars (forge.mjs losePiece). Idempotent per battle.
export function settleForge(run, battle, sum) {
  if (battle.forgeDone || !run.forge) return 0;
  battle.forgeDone = true; let n = 0;
  for (const id of battle.lost) if (id > 0 && id < 1e6 && run.forge.mats[id]) { const r = losePiece(run.forge, id); run.forge = r.state; n += r.lostBars.length; }
  if (sum && n) sum.lostBars = n;
  return n;
}
// enemy materials: from WORLD.enemyMatRegion (3) garrisons carry iron, 1 piece + 1 per 6 tiers past tier 20
// (max 4), on their most valuable pieces; from region 5 the best of them is steel. Wood before region 3.
export function enemyMats(run, a) {
  const reg = run.map.region; a.mats = 0;
  if (reg < WORLD.enemyMatRegion || !a.pieces) return a;
  const n = Math.max(1, Math.min(4, 1 + Math.floor((a.tier - 20) / 6)));
  const order = a.pieces.map((p, i) => i).filter(i => a.pieces[i].t !== 'K').sort((x, y) => UNITS[a.pieces[y].t] - UNITS[a.pieces[x].t] || x - y);
  order.slice(0, n).forEach((i, k) => { a.pieces[i].m = reg >= 5 && k === 0 ? 2 : 1; a.mats++; });
  return a;
}

// ---- terrain (terrain.mjs): one biome per node, rocks and water from tier 3 ----
export const BIOME_WEIGHTS = [[0.6, 0.25, 0.15], [0.3, 0.45, 0.25], [0.25, 0.25, 0.5]]; // plains, highland, marsh by region (cycles)
export function biomeFor(run, id) {
  const w = BIOME_WEIGHTS[(Math.max(1, run.map.region) - 1) % 3], h = (mapHashSeed(run.map.seed + '|biome|' + id) % 1000) / 1000;
  return h < w[0] ? 'plains' : h < w[0] + w[1] ? 'highland' : 'marsh';
}
// CRITICAL: the enemy formation's squares are passed as `avoid` (several presets use ranks 5-6, outside
// terrain.mjs's guaranteed-clear zone). The player's squares (ranks 1-2) are always clear.
export function withTerrain(run, a, key, type) {
  const id = typeof key === 'number' ? key : parseInt(key, 10) || 0;
  a.terrain = generateTerrain(run.map.seed, String(key), 8, biomeFor(run, id), { tier: a.tier, type, avoid: a.pieces.map(p => p.sq) });
  if (!a.terrain.blocked.length) a.terrain = null;
  return a;
}
// "rocky ground" / "wet ground" / "rocky, wet ground" / "open ground" for node cards
export function terrainSummary(t) {
  if (!t || !t.blocked.length) return { label: 'open ground', rock: 0, water: 0 };
  let rock = 0, water = 0; for (const sq of t.blocked) if (t.kind[sq] === 'water') water++; else rock++;
  return { label: rock && water ? 'rocky, wet ground' : rock ? 'rocky ground' : 'wet ground', rock, water, biome: t.biome };
}

// ---- content pack (content.mjs): lords, formations, event lines ----
export function lordById(id) { return CONTENT.RIVAL_LORDS.find(l => l.id === id) || null; }
export function lordOf(run) { return run.map && run.map.lord ? lordById(run.map.lord) : null; }
export function lordTitle(run) { const l = lordOf(run); return l ? `${l.name}, ${l.epithet}` : capFirst(rivalName(run)); }
const CONTENT_DOC = { aggressive: 'aggressive', solid: 'solid', greedy: 'material' };
// banded merge (CONTENT-API.md 3): 1 in WORLD.packChance neutral nodes of a v5 map field a pack formation of its tier
export function packFormation(run, id, tier, type, doctrine) {
  if (!run.map.pack || type === 'citadel') return null;
  const seed = run.seed >>> 0, key = mapHashSeed(run.map.seed + '|' + id);
  if (hash3(seed, key, 11) % WORLD.packChance !== 0) return null;
  const pool = CONTENT.formationsForTier(tier, { citadel: false, doctrine: CONTENT_DOC[doctrine] });
  return pool.length ? CONTENT.toEngineFormation(pool[hash3(seed, key, 13) % pool.length]) : null;
}
// the rival lord's own formations (same doctrine + a favored piece), when one covers the tier
export function lordFormation(run, id, tier, role) {
  const l = lordOf(run); if (!l || !run.map.pack) return null;
  const pool = CONTENT.formationsForLord(l).filter(f => !f.citadel && tier >= f.tiers[0] && tier <= f.tiers[1]);
  return pool.length ? CONTENT.toEngineFormation(pool[mapHashSeed(run.map.seed + '|lordf|' + id + '|' + role + '|' + tier) % pool.length]) : null;
}
export function eventLine(run, kind, vars) {
  const v = Object.assign({}, vars || {});
  v.gold = v.gold ? Math.round(v.gold).toLocaleString('en-US') : null;
  if (!v.lord) v.lord = run.map ? rivalName(run) : null;
  const L = (CONTENT.EVENT_LINES[kind] || []).filter(l => [...l.matchAll(/\{(\w+)\}/g)].every(m => v[m[1]] != null && v[m[1]] !== ''));
  if (!L.length) return '';
  return CONTENT.fillLine(L[hash3(run.seed >>> 0, (run.battles | 0) + (run.ticks | 0), 17) % L.length], v);
}
function linePiece(run, battle, won) {
  if (!won && battle.lost.length) { const p = pieceById(run, battle.lost[0]); if (p) return PIECE_NOUN[p.t]; }
  for (let sq = 63; sq >= 0; sq--) { const id = battle.ids[sq], pc = battle.pos.b[sq]; if (id >= 0 && pc && (pc & 31) !== 6 && (pc >> 5) === 0) return PIECE_NOUN[TYPE_CH[pc & 31]]; }
  return null;
}

// ---- supply caches: 1-2 per region, overlaid on low-tier garrison nodes of v5 maps (map.mjs is unchanged) ----
let cacheKey = '', cacheList = [];
export function cacheIds(run) {
  if (!run.map || !run.map.pack) return [];
  const k = run.map.seed + '#' + run.map.region;
  if (k !== cacheKey) {
    const reg = worldRegion(run), h = id => mapHashSeed(run.map.seed + '|cache|' + id);
    let g = reg.nodes.filter(n => n.type === 'garrison' && n.col >= 1);
    if (!g.length) g = reg.nodes.filter(n => n.type === 'garrison');
    g.sort((a, b) => a.tier - b.tier || h(a.id) - h(b.id));
    cacheList = g.slice(0, 1 + mapHashSeed(run.map.seed + '|caches') % 2).map(n => n.id).sort((a, b) => a - b);
    cacheKey = k;
  }
  return cacheList;
}
export function isCache(run, id) { return cacheIds(run).includes(id) && !run.map.held.includes(id) && !rivalOwns(run, id); }
export function cacheLoot(run, id, mem) { return Math.round(lootFor(Math.max(1, worldRegion(run).nodes[id].tier), mem || 0) * WORLD.cacheLoot); }
export function takeCache(state, id) {
  const run = state.run, st = mapStateOf(run), n = st.region.nodes[id];
  if (!isCache(run, id) || !canCapture(st, id)) return null;
  run.map.held = capture(st, id).held;
  const gold = cacheLoot(run, id, state.memories);
  run.gold += gold; run.touched = true;
  run.map.contact = run.map.contact || rivalContact(run);
  worldRefresh(run);
  const res = { cache: true, id, place: n.name, gold, line: eventLine(run, 'cache', { place: n.name, gold, piece: 'scout' }) };
  discoveryAfterCapture(state, id, res);
  run.map.lastCache = res;
  diaryCount(state, run.map.region, 'cache'); diaryUpdate(state); // P1-5 diary
  return res;
}

// ---- shrine blessings: content.mjs SHRINE_CHOICES and the effect vocabulary (EFFECT_KINDS) ----
export function addBlessing(run, e) {
  if (!Array.isArray(run.blessings)) run.blessings = [];
  const b = { kind: e.kind, v: e.v, scope: e.scope || 'run', region: run.map ? run.map.region : 1 };
  if (e.piece) b.piece = e.piece;
  run.blessings.push(b); return b;
}
// enemy traits plus 'enemyTrait' curses of this region
export function cursedTraits(run, base) {
  const o = cleanDwell(base);
  for (const b of blessActive(run, 'enemyTrait')) if (o[b.piece] != null) o[b.piece] = Math.min(DWELL_MAX, o[b.piece] + (b.v | 0));
  return o;
}
// the shrine a node offers: deterministic per region seed + node, from the pool open in this region
export function shrineChoiceFor(run, id) {
  const pool = CONTENT.shrineChoicesFor(run.map.region);
  return pool.length ? pool[mapHashSeed(run.map.seed + '|shrine|' + id) % pool.length] : null;
}
export function pendingShrine(run) { return run.map.shrine != null ? shrineChoiceFor(run, run.map.shrine) : null; }
const piecesOf = (run, t) => run.roster.filter(p => p.t === t);
// can this effect part be taken now (CONTENT-API.md preconditions, plus "meaningful": no free square left,
// a dwelling already at max, no rival to delay)? -> '' or the reason it is greyed out
export function effectBlocker(run, p) {
  switch (p.kind) {
    case 'gold': return p.v < 0 && run.gold < -p.v ? `needs ${-p.v} gold` : '';
    case 'losePiece': return piecesOf(run, p.piece).length < p.v ? `needs ${p.v} ${PIECE_NOUN[p.piece]}${p.v > 1 ? 's' : ''}` : '';
    case 'promotePawn': return piecesOf(run, 'P').length ? '' : 'no pawn';
    case 'squares': return SQUARE_ORDER.map(parseSq).some(sq => !run.owned.includes(sq)) ? '' : 'every square owned';
    case 'trait': return p.scope === 'run' && cleanDwell(run.dwell)[p.piece] >= DWELL_MAX ? 'dwelling at max' : '';
    case 'rivalClock': case 'rivalStrength': return rivalOf(run) && rivalOf(run).status === 'active' ? '' : 'no rival';
    default: return '';
  }
}
export function sideBlocker(run, side) {
  const c = pendingShrine(run); if (!c || !c[side]) return 'no shrine';
  for (const p of CONTENT.effectParts(c[side].effect)) { const b = effectBlocker(run, p); if (b) return b; }
  return '';
}
// does this side need the player to pick a pawn (promotePawn)?
export function sideNeedsPawn(run, side) { const c = pendingShrine(run); return !!c && CONTENT.effectParts(c[side].effect).some(p => p.kind === 'promotePawn'); }
function removePieces(run, t, v) {
  const out = [];
  for (let i = 0; i < v; i++) {
    const res = reserve(run).filter(p => p.t === t);
    let id = res.length ? res[res.length - 1].id : null;
    if (id == null) for (const k of Object.keys(run.map.garrison)) { const g = run.map.garrison[k], j = g.findIndex(x => pieceById(run, x).t === t); if (j >= 0) { id = g[j]; g.splice(j, 1); if (!g.length) delete run.map.garrison[k]; break; } }
    if (id == null) { const f = Object.entries(run.formation).filter(([, x]) => pieceById(run, x).t === t).sort((a, b) => b[0] - a[0]); if (f.length) { id = f[0][1]; delete run.formation[f[0][0]]; } }
    if (id == null) break;
    run.roster = run.roster.filter(p => p.id !== id);
    if (run.forge && run.forge.mats[id]) run.forge = losePiece(run.forge, id).state;
    out.push(id);
  }
  return out;
}
// lift the fog on every node within v roads of the shrine
export function revealAround(run, from, v) {
  const reg = worldRegion(run), d = mapBfs(mapAdjacency(reg.nodes.length, reg.roads), from), s = new Set(run.map.scouted || []);
  reg.nodes.forEach(n => { if (d[n.id] >= 0 && d[n.id] <= v) s.add(n.id); });
  run.map.scouted = [...s].sort((a, b) => a - b);
  return run.map.scouted;
}
export function applyEffect(state, p, pick) {
  const run = state.run, m = run.map;
  switch (p.kind) {
    case 'gold': run.gold += p.v; break;
    case 'incomeFlat': case 'mineIncomeMult': case 'lootMult': case 'shopDiscount': case 'tacticianElo': case 'enemyElo':
    case 'enemyBudgetMult': case 'marchMult': case 'enemyTrait': addBlessing(run, p); break;
    case 'trait':
      if (p.scope === 'run') { run.dwell = cleanDwell(run.dwell); run.dwell[p.piece] = Math.min(DWELL_MAX, run.dwell[p.piece] + p.v); }
      else addBlessing(run, p);
      break;
    case 'squares': {
      for (let i = 0; i < p.v; i++) {
        const sq = SQUARE_ORDER.map(parseSq).find(q => !run.owned.includes(q)); if (sq == null) break;
        run.owned.push(sq); const res = reserve(run); if (res.length) run.formation[sq] = res[0].id;
      }
      break;
    }
    case 'addPiece': for (let i = 0; i < p.v; i++) run.roster.push({ id: run.nextId++, t: p.piece }); break;
    case 'losePiece': removePieces(run, p.piece, p.v); break;
    case 'promotePawn': {
      const pw = (pick != null && pieceById(run, pick) && pieceById(run, pick).t === 'P') ? pieceById(run, pick) : shrinePawn(run);
      if (pw) pw.t = p.to;
      break;
    }
    case 'raidClock': if (m.raid) m.raid.t = Math.max(30, m.raid.t + p.v); break;
    case 'rivalClock': { const r = rivalOf(run); if (r && r.status === 'active' && r.nextMoveAt != null) r.nextMoveAt += p.v * WORLD.rivalSecPerTick * 1000; break; }
    case 'rivalStrength': m.rivalAdj = Math.max(-RIVAL_TUNE.bonusCap, Math.min(RIVAL_TUNE.bonusCap, (+m.rivalAdj || 0) + p.v)); break;
    case 'reveal': DSC.revealAround(run, m.shrine != null ? m.shrine : worldRegion(run).keepId, p.v, worldRegion(run)); break;
    case 'bar': ensureForge(run); run.forge.bars[p.material] += p.v; break;
    case 'resource': { const f = ensureForge(run), c = mineCounts(heldMineRes(run))[p.res]; f.stock[p.res] = Math.min(Math.max(f.stock[p.res], stockCap(p.res, c)), f.stock[p.res] + p.v); break; }
    case 'memoriesOnEnd': run.memBonus = (run.memBonus | 0) + p.v; break;
    case 'skillXp': if (SK.SKILL_TYPES.includes(p.piece) && p.v > 0) skillGains(state, { [p.piece]: p.v | 0 }); break; // content variety: landmarks
  }
}
// take one side ('a' | 'b') of the pending shrine; pick = the pawn id for a promotePawn part
export function chooseShrineSide(state, side, pick) {
  const run = state.run, c = pendingShrine(run);
  if (!c || (side !== 'a' && side !== 'b') || sideBlocker(run, side)) return null;
  for (const p of CONTENT.effectParts(c[side].effect)) applyEffect(state, p, pick);
  run.map.shrine = null; run.touched = true;
  worldRefresh(run); cleanGarrisons(run);
  diaryCount(state, run.map.region, 'shrine'); diaryUpdate(state); // P1-5 diary
  return { id: c.id, name: c.name, side, label: c[side].label };
}
// scouted (revealed) nodes show their details on the map card even in the fog
export function worldFog(run) {
  const v = fogView(mapStateOf(run)), sc = new Set(run.map.scouted || []), reg = worldRegion(run);
  return v.map(n => n.vis === 'fog' && sc.has(n.id) ? Object.assign({}, reg.nodes[n.id], { vis: 'scouted' }) : n);
}

// ---- opposition elo: change the band mid-run (new opponents from the next battle; the Tactician stays equal) ----
export function setRunElo(state, e) {
  state.elo = cleanElo(e); state.eloPicked = true;
  const run = state.run; run.elo = state.elo;
  const r = rivalOf(run); if (r) r.eloBase = regionElo(run.elo, run.map.region);
  return state.elo;
}

// ---- cosmetic piece sets (content.mjs PIECE_SETS): unlocked by lifetime Memories, regions, seats, the forge ----
export function cleanCosmetics(c) {
  c = c && typeof c === 'object' ? c : {};
  const ids = CONTENT.PIECE_SETS.map(s => s.id);
  const unlocked = Array.isArray(c.unlocked) ? c.unlocked.filter(x => ids.includes(x)) : [];
  if (!unlocked.includes('classic')) unlocked.unshift('classic');
  return { unlocked, set: unlocked.includes(c.set) ? c.set : 'classic', forged: Array.isArray(c.forged) ? c.forged.filter(x => ['iron', 'steel', 'obsidian'].includes(x)) : [] };
}
export function setUnlocked(state, set) {
  const u = set.unlockedBy, c = cleanCosmetics(state.cosmetics);
  switch (u.kind) {
    case 'default': return true;
    case 'memories': return (state.memEarned || 0) >= u.v;
    case 'region': return Math.max(state.bestRegion || 1, state.run && state.run.map ? state.run.map.region : 1) >= u.v;
    case 'citadels': return (state.seats || 0) >= u.v;
    case 'forge': return c.forged.includes(u.material);
  }
  return false;
}
// refresh the unlocked list; returns the sets unlocked just now
export function refreshCosmetics(state) {
  const c = state.cosmetics = cleanCosmetics(state.cosmetics), fresh = [];
  for (const s of CONTENT.PIECE_SETS) if (!c.unlocked.includes(s.id) && setUnlocked(state, s)) { c.unlocked.push(s.id); fresh.push(s); }
  return fresh;
}
export function choosePieceSet(state, id) {
  refreshCosmetics(state);
  if (!state.cosmetics.unlocked.includes(id)) return false;
  state.cosmetics.set = id; return true;
}
export function unlockText(u) {
  return u.kind === 'default' ? 'always' : u.kind === 'memories' ? `earn ${u.v} Memories` : u.kind === 'region' ? `reach region ${u.v}` : u.kind === 'citadels' ? `win ${u.v} rival seats` : `smelt a ${u.material} bar`;
}

// =====================================================================
// M6: feel pass (skills, discovery, rewind)
// =====================================================================

// ---- skills (skills.mjs, SKILLS-API.md section 7) ----
// the roster type of a battle piece (a promoted pawn is still a pawn: Pawncraft); castellan/militia fall back to the board
export function typeOfPiece(run, id, pc) { const p = id >= 0 ? pieceById(run, id) : null; return (p && p.t) || TYPE_CH[pc & 31]; }
// v6: skills.mjs knows P N B R Q K only, so fairy pieces earn their XP into Leadership (FAIRY_WORLD.skill); a fairy
// victim counts as the classic piece of its weight (pawn-units: 3 knight, up to 6 rook, above queen)
export const skillType = t => SK.SKILL_TYPES.includes(t) ? t : (UNITS[t] != null ? FAIRY_WORLD.skill : t);
export const skillVictim = t => SK.SKILL_TYPES.includes(t) || UNITS[t] == null ? t : UNITS[t] <= 3 ? 'N' : UNITS[t] <= 6 ? 'R' : 'Q';
export function battleTypes(run, b) {
  const out = [];
  for (let sq = 0; sq < 64; sq++) { const pc = b.pos.b[sq]; if (pc && (pc >> 5) === WHITE) out.push(skillType(typeOfPiece(run, b.ids[sq], pc))); }
  return out;
}
// play one move and keep the skills tally (battle.sx). Every move of a world battle goes through here (the page's
// commitMove and the rewind replay), so a replay rebuilds the tally exactly and no XP is counted twice.
// A capture undone by an enemy trait (Bulwark hold, a victim that slipped away) or a glanced counter does not count.
export function battleMove(run, battle, m) {
  const side = battle.pos.side, from = mFrom(m), to = mTo(m), cap = mCap(m), aId = battle.ids[from], vId = battle.ids[to], aPc = battle.pos.b[from];
  const vMat = battle.pos.m ? battle.pos.m[to] | 0 : 0, vType = cap && vId > 0 ? typeOfPiece(run, vId, cap) : null;
  playMove(battle, m);
  const lt = battle.lastTrait, lc = battle.lastCounter, stood = !(lt && lt.ok && !lt.blocked) && !(lc && lc.fails);
  const sx = battle.sx || (battle.sx = SK.newTally([]));
  if (side === WHITE && cap && stood) SK.noteCapture(sx, skillType(typeOfPiece(run, aId, aPc)), skillVictim(TYPE_CH[cap & 31]));
  if (side === BLACK && cap && stood && vId >= 0) SK.noteLoss(sx, skillType(typeOfPiece(run, vId, cap)));
  // P1-8: who captured what, and what a fallen piece was (the Hall of the Fallen reads battle.pk at the end)
  const pk = battle.pk || (battle.pk = { c: {}, f: {} });
  if (side === WHITE && cap && stood && aId > 0 && aId < 1e6) pk.c[aId] = (pk.c[aId] | 0) + 1;
  if (side === BLACK && cap && vId > 0 && vId < 1e6 && (battle.lost || []).includes(vId) && !pk.f[vId]) pk.f[vId] = { t: vType, mat: vMat };
  if (side === WHITE && mPromo(m) && battle.ids[to] === aId && (battle.pos.b[to] & 31) === Q) SK.notePromotion(sx);
  if (battle.over && battle.over.result === 'win' && battle.over.reason === 'Checkmate') SK.noteMate(sx, skillType(typeOfPiece(run, aId, aPc)));
  return battle.over;
}
function skillGains(state, gains) {
  state.skills = SK.cleanSkills(state.skills);
  const r = SK.applyGains(state.skills, gains);
  if (state.run) state.run.skillMods = SK.skillMods(state.skills);
  markSkillGlow(state, r.dings);
  return { gained: r.gained, dings: r.dings, text: SK.gainText(r.gained) };
}
// the battle's XP (raw engine result: a castellan 'mate' pays no survival XP, as intended)
export function awardBattleXp(state, battle, result) { return skillGains(state, SK.battleXp(battle.sx, result, battle.tier)); }
export function awardMarchXp(state, tier) { return skillGains(state, SK.marchXp(tier)); }
// mine income milestones (worldTick): XP to each type garrisoned at a mine (P if none); nothing without a held mine
export function mineSkillXp(state, gold) {
  const run = state.run;
  if (!(gold > 0) || !state.skills || !run.map || !heldMines(run).length) return [];
  const types = Object.values(run.map.garrison || {}).flat().map(id => skillType((pieceById(run, id) || {}).t));
  const g = SK.mineXp(state.skills, gold, types);
  return Object.keys(g).length ? skillGains(state, g).dings : [];
}

// ---- discovery (discovery.mjs, DISCOVERY-API.md INTEGRATION) ----
// apply effect parts from a pile, a site or an artifact with the game's own applyEffect. Blessings created for an
// artifact are tagged with its id (the Run tab lists artifacts separately).
export function applyParts(state, parts, art) {
  const run = state.run;
  for (const p of parts || []) {
    const n = (run.blessings || []).length;
    applyEffect(state, p);
    if (art) for (const b of (run.blessings || []).slice(n)) b.art = art.id;
  }
  worldRefresh(run); cleanGarrisons(run);
}
export function applyDiscGains(state, gains) { for (const g of gains) applyParts(state, g.apply, g.art); state.run.touched = true; }
// "+21 gold · +5 tin" for a batch of pickups
export function gainsText(gains) { return gains.map(g => g.short).filter(Boolean).join(' · '); }
export function siteCardOf(run) { return run.map.site != null ? DSC.siteCard(run, run.map.site, worldRegion(run)) : null; }
export function openSiteCard(run, i) { return DSC.openSite(run, i); }
export function skipSite(run) { DSC.dismissSite(run); }
// take side 'a' | 'b' of the open site: resolveSite applies artifacts, reveals and ambushes itself; the rest is applied here
export function chooseSite(state, side) {
  const run = state.run, i = run.map.site, res = DSC.resolveSite(run, side, worldRegion(run));
  if (!res) return null;
  applyParts(state, res.apply, res.art);
  run.touched = true; res.site = i;
  diaryUpdate(state); // P1-5 diary: a named place visited
  return res;
}
// ---- content variety 4: one flavour line per battle, by node type and ground [open, rocky, wet] (pure text) ----
export const BATTLE_INTRO = {
  garrison: ['Open fields and a garrison in neat ranks. Nowhere to hide, for either side.', 'The garrison waits among the boulders. Mind the lanes the rocks leave open.', 'Reeds and standing water round the garrison. Every dry square matters.'],
  mine: ['Spoil heaps and pit-head wheels. The guards mean to keep their seam.', "The mine's guards hold the cut rock above the shafts.", "Flooded workings and sodden carts: the mine's guards fight knee-deep."],
  town: ['The market stalls are packed away; the town watch lines the square.', 'Stone lanes and walled yards: the town fights street by street.', 'Canals cut the town in pieces, and its watch holds the bridges.'],
  shrine: ["Pilgrims scatter as the shrine's wardens take the field.", "The shrine's wardens stand among old carved stones.", 'Holy springs ring the shrine, and its wardens will not give them up.'],
  citadel: ["The rival lord's banners fill the plain. Everything rides on this.", "The citadel crowns the crags, and the lord's best hold every pass.", 'A moat and a marsh guard the citadel. The rival lord waits behind both.'],
  raid: ['Raiders on the open road, making for your mine.', 'Raiders slip down through the rocks toward your mine.', 'Raiders wade in through the mire to strike your mine.'],
  border: ["The rival lord's host crosses open ground to take what you hold.", "The rival lord's host comes over the rocks at your border.", "The rival lord's host splashes through the marsh at your border."],
  keep: ['The rival lord is at your gates. If the keep falls, the run ends.', "Ladders clatter against your keep's rock. Hold, or the run ends.", 'They come across the moat for your keep. Hold, or the run ends.'],
  ambush: ['Figures rise from the long grass: an ambush!', 'Shapes break from behind the rocks: an ambush!', 'Out of the reeds they come: an ambush!'],
};
export function battleIntro(node, terrain) {
  if (!node) return '';
  const k = node.type === 'rival' ? (node.kind === 'keep' ? 'keep' : 'border') : node.ambush ? 'ambush' : node.type, L = BATTLE_INTRO[k];
  if (!L) return '';
  const g = terrainSummary(terrain);
  return L[g.water > g.rock ? 2 : g.rock ? 1 : 0];
}
// ---- content variety 3: dwelling titles and lore, by level 0..DWELL_MAX (pure text) ----
export const DWELL_LORE = {
  P: [['Empty Field', 'Nobody farms here yet.'], ['Hamlet', 'A few huts; the pawns dig in where they stand.'], ['Village', 'A palisade and a drill green: pawns learn to give ground and live.'], ['Garrison Town', 'Walls, a muster bell and a hundred stubborn neighbours.']],
  N: [['Open Pasture', 'Wild horses, no riders.'], ['Stables', 'A dozen horses and a stable boy who rides like the wind.'], ['Horse Fair', 'Riders come from three valleys to trade tricks and mounts.'], ['Cavalry Keep', 'Knights who can leave any square before the blow lands.']],
  B: [['Wayside Cross', 'A cross by the road and a bowl for alms.'], ['Chapel', 'Candles, a bell, and bishops who trust the long diagonal.'], ['Abbey', 'Cloisters full of quiet bishops and quieter escapes.'], ['Cathedral', 'Its spire is seen from every corner of the board.']],
  R: [['Quarry', 'Stone, waiting to be stacked.'], ['Watchtower', 'One tower, one rook, and a very good view.'], ['Bastion', 'Thick walls that send attackers bouncing off.'], ['Fortress of Rooks', 'Towers on towers; nothing gets in uninvited.']],
  Q: [['Bower', 'A garden with a single chair.'], ['Hall', 'A long table, and a queen who sits at its head.'], ['Court', 'Courtiers, spies and a queen who is never where you strike.'], ['Throne Room', 'Every road in the kingdom runs to this room.']],
};
export function dwellLore(t, l) { const L = DWELL_LORE[t]; if (!L) return null; const [title, text] = L[Math.max(0, Math.min(L.length - 1, l | 0))]; return { title, text }; }
// ---- content variety 1: named landmarks (Heroes 3 style one-off visits) ----
// 1-2 per region, seeded from the region seed, placed right after initDiscovery as extra run.map.sites entries (the
// site card, map mark, "Not now", diary and save all reuse discovery.mjs as they are). discovery.mjs stays verbatim:
// the archetypes are registered into DSC.LOCATION_BY_ID only (never DSC.LOCATIONS, so placeSites never draws them).
// Budget-neutral: each landmark removes one gold road pile of this region worth at least its gold option (no
// landmark if no such pile is left over the treasure minimum). Option b trades that same slot for a skill XP nudge,
// a one-battle buff, a raid delay or forge stock, never extra income.
export const LANDMARK = { gold: 20, xp: 40, max: 2, eras: 8 };
export const landmarkXp = r => Math.round(LANDMARK.xp * SK.tierMult(10 * (Math.max(1, r) - 1) + 5) / 5) * 5;
const lmO = (label, effect) => ({ label, effect });
const lmG = l => lmO(l + ': +{gold} gold', { kind: 'gold', v: LANDMARK.gold });
const lmX = (l, t) => r => lmO(`${l}: +${landmarkXp(r)} ${SK.SKILL_NAMES[t]} XP`, { kind: 'skillXp', piece: t, v: landmarkXp(r) });
const lmV = (x, r) => typeof x === 'function' ? x(r) : x;
const lmD = (id, name, glyph, blurb, a, b) => ({ id, name, glyph, blurb, minRegion: 99, landmark: true,
  variants: Array.from({ length: LANDMARK.eras }, (_, k) => ({ minRegion: 1, a: lmV(a, k + 1), b: lmV(b, k + 1) })) });
export const LANDMARKS = [
  lmD('hermits-mill', "The Hermit's Mill", '✻', 'A mill that grinds for nobody. The hermit trades his flour, or teaches the patient.',
    lmG('Buy his flour and sell it on'), lmX('Turn the stones with him a day', 'P')),
  lmD('sunken-crypt', 'Sunken Crypt', '✚', 'Water to the knees, and old kings asleep in stone boxes.',
    lmG('Lift the grave goods'), lmO('Say the old words and leave them be: enemies -40 elo next battle', { kind: 'enemyElo', v: -40, scope: 'next' })),
  lmD('wandering-tutor', 'Wandering Tutor', '✧', 'A scholar with one boot and a chessboard. One lesson, then he moves on.',
    lmX("Study the knight's tour", 'N'), lmX('Study the long diagonals', 'B')),
  lmD('toll-bridge', 'The Old Toll Bridge', '⚑', 'Nobody has kept this bridge for years, but the toll box is still half full.',
    lmG('Empty the toll box'), lmO('Bar the bridge: the next raid comes 120 ticks later', { kind: 'raidClock', v: 120 })),
  lmD('drowned-chapel', 'Drowned Chapel', '☗', 'A chapel half under the lake. Its bell still rings at night.',
    lmG('Pry the silver off the altar'), lmO('Ring the bell: +60 elo next battle', { kind: 'tacticianElo', v: 60, scope: 'next' })),
  lmD('old-battlefield', 'The Old Battlefield', '✠', 'Rusted blades in the grass, and the old battle lines still plain to read.',
    lmG('Gather what is worth selling'), lmX('Walk the lines and learn', 'R')),
  lmD('hunters-lodge', "Hunter's Lodge", '❖', 'Antlers on every wall and a larder the hunters will share.',
    lmG('Sell their furs in town'), lmX('Ride out with the hunt', 'K')),
  lmD('charcoal-burners', 'Charcoal Burners', '☼', 'Smoke all day from the earth mounds. They pay in coin or in charcoal.',
    lmG('Sell a stack for them'), lmO('Carry wood for a day: +5 coal', { kind: 'resource', res: 'coal', v: 5 })),
  lmD('ferrymans-landing', "Ferryman's Landing", '⚓', 'The ferryman knows every road the armies take, and sells what he hears.',
    lmG('Take his fare money'), lmO('Pay him in promises: next battle loot +40%', { kind: 'lootMult', v: 1.4, scope: 'next' })),
];
export const LANDMARK_IDS = new Set(LANDMARKS.map(l => l.id));
for (const l of LANDMARKS) DSC.LOCATION_BY_ID[l.id] = l;
export const isLandmark = s => !!s && LANDMARK_IDS.has(s.arch);
// the gold a landmark's gold option pays in region r (the site card's own scaling)
export const landmarkGold = r => Math.round(LANDMARK.gold * DSC.regionScale(r) / 5) * 5;
function lmOffset(reg, n, taken) {
  let best = null;
  for (let k = 0; k < 8; k++) {
    const an = k * Math.PI / 4 + 0.39, x = Math.max(8, Math.min(992, n.x + Math.cos(an) * 30)), y = Math.max(8, Math.min(592, n.y + Math.sin(an) * 30));
    let sc = Infinity;
    for (const o of reg.nodes) if (o.id !== n.id) sc = Math.min(sc, Math.hypot(o.x - x, o.y - y));
    for (const [a, b] of reg.roads) { const A = reg.nodes[a], B = reg.nodes[b], dx = B.x - A.x, dy = B.y - A.y, u = Math.max(0, Math.min(1, ((x - A.x) * dx + (y - A.y) * dy) / (dx * dx + dy * dy || 1))); sc = Math.min(sc, 1.5 * Math.hypot(A.x + u * dx - x, A.y + u * dy - y)); }
    for (const p of taken) sc = Math.min(sc, Math.hypot(p.x - x, p.y - y));
    if (!best || sc > best.sc) best = { sc, dx: Math.round(x - n.x), dy: Math.round(y - n.y) };
  }
  return best;
}
// placeLandmarks(run): once per region map (a v6 map already carrying landmarks, or an old map, is left alone)
export function placeLandmarks(run, reg = worldRegion(run)) {
  const m = run.map; if (m.disc !== DSC.DISC_VERSION || !Array.isArray(m.sites) || !Array.isArray(m.treasure) || m.sites.some(isLandmark)) return [];
  const r = m.region, rng = mapMulberry32(mapHashSeed(m.seed + '|landmarks')), mix = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const want = Math.min(LANDMARK.max, 1 + (rng() < 0.5 ? 1 : 0)), used = new Set(m.sites.map(s => s.at)), g = landmarkGold(r);
  const anchors = mix(reg.nodes.filter(x => x.dist >= 2 && !used.has(x.id) && !['keep', 'citadel', 'shrine'].includes(x.type)));
  const kinds = mix(LANDMARKS.slice()), out = [], taken = m.sites.map(s => ({ x: reg.nodes[s.at].x + s.dx, y: reg.nodes[s.at].y + s.dy }));
  for (const at of anchors) {
    if (out.length >= want || m.treasure.length <= DSC.DISC.treasureMin) break;
    if (out.some(o => reg.nodes[o.at].col === at.col)) continue;
    // fund it: the smallest gold pile still worth at least the landmark's gold option
    const piles = m.treasure.filter(t => t.k === 'gold' && !t.got && t.e.v >= g).sort((a, b) => a.e.v - b.e.v);
    if (!piles.length) break;
    m.treasure.splice(m.treasure.indexOf(piles[0]), 1);
    const off = lmOffset(reg, at, taken), s = { at: at.id, arch: kinds[out.length].id, v: Math.min(r, LANDMARK.eras) - 1, dx: off.dx, dy: off.dy, focus: null, prize: null, done: 0, later: false, fund: piles[0].e.v };
    taken.push({ x: at.x + s.dx, y: at.y + s.dy }); out.push(s);
  }
  m.sites.push(...out);
  return out;
}
// the site battle: an ambush party of the anchor node's budget x v; the formation fights, retreat is allowed,
// and the run is never at stake (a mate counts as a loss)
export function ambushArmy(run) {
  const reg = worldRegion(run), spec = DSC.ambushSpec(run, reg); if (!spec) return null;
  const n = reg.nodes[spec.mapId], tier = spec.tier;
  const a = enemyArmy(run.seed, tier, { type: 'raid', key: spec.key, budget: enemyBudget(tier, 'garrison') * spec.budgetMult * blessProd(run, 'enemyBudgetMult') });
  a.type = 'ambush'; a.ambush = true; a.tier = tier; a.mapId = spec.mapId; a.region = run.map.region; a.place = spec.place; a.at = n.name; a.prize = spec.prize;
  a.elo = cleanElo(regionElo(run.elo, run.map.region) + blessSum(run, 'enemyElo')); a.traits = cursedTraits(run, tierTraits(tier));
  a.units = armyUnits(a.pieces); a.depth = eloCfg(a.elo).maxDepth; a.doctrine = 'aggressive';
  enemyMats(run, a); withTerrain(run, a, 'ambush|' + spec.mapId + '|' + spec.key, 'raid');
  return a;
}
export function startAmbush(run) { const a = ambushArmy(run); return a ? worldBattle(run, a) : null; }
// slip away from a waiting ambush without a fight: the site stays done, no prize
export function withdrawAmbush(run) { return DSC.finishAmbush(run, false); }
export function finishAmbushBattle(state, battle, result) {
  const run = state.run, promoted = settleRoster(run, battle), same = run.map.region === battle.node.region, won = result === 'win';
  if (same) cleanGarrisons(run);
  const sum = { result: result === 'mate' ? 'loss' : result, ambush: true, tier: battle.tier, type: 'ambush', lost: battle.lost.length, promoted: promoted.length, loot: 0, memories: 0, place: battle.node.place, at: battle.node.at };
  settleForge(run, battle, sum);
  const fa = same ? DSC.finishAmbush(run, won) : null;
  if (won) { sum.loot = Math.round(lootFor(battle.tier, state.memories) * WORLD.raidLootMult); run.gold += sum.loot; run.wins++; boostLoot(run, battle, sum); }
  else run.losses++;
  if (fa && fa.art) { applyParts(state, fa.apply, fa.art); sum.art = { name: fa.art.name, text: fa.art.text }; }
  sum.line = eventLine(run, won ? 'battleWin' : 'battleLoss', { place: battle.node.at, gold: sum.loot, piece: linePiece(run, battle, won) });
  if (!run.roster.some(r => r.t !== 'K')) { levy(run, 2); sum.levy = 2; }
  return sum;
}
// Hints: free while the Tactician's Lens (hints artifacts) has some left this battle, else a small gold price
export function hintPrice(battle) { return Math.max(WORLD.hintMin, Math.round(lootFor(battle.tier, 0) * WORLD.hintLoot)); }
export function freeHints(run, battle) { return Math.max(0, DSC.artifactTotal(run, 'hints') + (battle.wkHint | 0) - (battle.hints | 0)); }
export function payHint(run, battle) {
  if (freeHints(run, battle) > 0) { battle.hints = (battle.hints | 0) + 1; return { ok: true, free: true, cost: 0 }; }
  const c = hintPrice(battle); if (run.gold < c) return { ok: false, free: false, cost: c };
  run.gold -= c; battle.hints = (battle.hints | 0) + 1; return { ok: true, free: false, cost: c };
}

// ---- rewind: take back the Tactician's last own move (and the reply), up to WORLD.rewinds times per battle ----
// Battles are deterministic from (start snapshot, seed, move list): trait and counter rolls are seeded by seed + ply,
// so a replay restores captured pieces, the tally and the rolls exactly (the same rolls recur at the same ply).
export function battleSnapshot(b) {
  return { b: Array.from(b.pos.b), side: b.pos.side, k: b.pos.k.slice(), ids: Array.from(b.ids), m: b.pos.m ? Array.from(b.pos.m) : null, sx: JSON.parse(JSON.stringify(b.sx || SK.newTally([]))),
    g: b.pos.g ? b.pos.g.map(x => Object.assign({}, x)) : null };
}
export function rewindsLeft(b) { return b && b.start && Array.isArray(b.moves) ? Math.max(0, WORLD.rewinds - (b.rw | 0)) : 0; }
// index in b.moves of the player's (WHITE's) last move, or -1. Every ply flips the side, so ply i is (start side ^ i).
export function lastOwnPly(b) {
  if (!b || !b.start || !Array.isArray(b.moves)) return -1;
  for (let i = b.moves.length - 1; i >= 0; i--) if (((b.start.side ^ i) & 1) === WHITE) return i;
  return -1;
}
export function canRewind(b) { return !!b && !b.over && rewindsLeft(b) > 0 && lastOwnPly(b) >= 0; }
// truncate to just before that move (2 plies, or 1 if the enemy has not replied) and replay from the start
export function rewindBattle(run, b) {
  if (!canRewind(b)) return false;
  const keep = b.moves.slice(0, lastOwnPly(b));
  resetBattle(b, b.start);
  b.sx = JSON.parse(JSON.stringify(b.start.sx || SK.newTally([])));
  b.pk = { c: {}, f: {} };
  for (const m of keep) battleMove(run, b, m);
  b.rw = (b.rw | 0) + 1;
  return true;
}

// =====================================================================
// P0-4: the week clock. Every WORLD.weekTicks ticks a week turns: the keep musters a militia pawn (keep defence only,
// up to WORLD.musterCap), each held mine pays a small pulse, and the new week's event takes hold. The event of week
// w is drawn from (run seed, w), so it is known (and shown) a whole week ahead. Week 1 is always quiet.
// run.week = { n: current week (1-based), ev: event id | null, mods: {...} } (re-derived from run.ticks on load)
// =====================================================================
export const WEEK_EVENTS = [
  { id: 'forge', name: 'Week of the Forge', text: 'smelts need half the ore', tone: 'good', mods: { smelt: 0.5 } },
  { id: 'roads', name: 'Week of the Roads', text: 'marches are 20% faster', tone: 'good', mods: { march: 0.8 } },
  { id: 'wolf', name: 'Week of the Wolf', text: 'the rival lord moves 10% faster', tone: 'bad', mods: { rival: 1.1 } },
  { id: 'plenty', name: 'Week of Plenty', text: 'mines pay 25% more gold', tone: 'good', mods: { mine: 1.25 } },
  { id: 'spoils', name: 'Week of Spoils', text: 'battle loot is 15% higher', tone: 'good', mods: { loot: 1.15 } },
  { id: 'owl', name: 'Week of the Owl', text: 'your Tactician plays 40 elo stronger', tone: 'good', mods: { elo: 40 } },
  { id: 'mud', name: 'Week of Mud', text: 'marches are 10% slower', tone: 'bad', mods: { march: 1.1 } },
  { id: 'levy', name: 'Week of the Levy', text: 'the keep musters 2 militia pawns instead of 1', tone: 'good', mods: { muster: 2 } },
  { id: 'hearth', name: 'Week of the Hearth', text: 'your keep pays +10 gold per 100 moves', tone: 'good', mods: { inc: 2 } },
  { id: 'shield', name: 'Week of the Shield', text: 'Stubborn +1 for your pawns (+20% chance a captured pawn falls back)', tone: 'good', mods: { traitP: 1 } },
  { id: 'rest', name: 'Week of Rest', text: 'a quiet week: the first hint in each battle is free', tone: 'neutral', mods: { hint: 1 } },
  { id: 'tithe', name: 'Week of the Tithe', text: 'mines pay 15% less gold', tone: 'bad', mods: { mine: 0.85 } },
  // content variety 2: three mirrored pairs on existing mechanisms (each pair sums to no change, so a random week's
  // long-run value is unchanged by them; they only dilute the pool)
  { id: 'bounty', name: 'Week of Bounties', text: 'battle loot is 10% higher', tone: 'good', mods: { loot: 1.1 } },
  { id: 'lean', name: 'Lean Week', text: 'battle loot is 10% lower', tone: 'bad', mods: { loot: 0.9 } },
  { id: 'clear', name: 'Week of Clear Skies', text: 'your Tactician plays 30 elo stronger', tone: 'good', mods: { elo: 30 } },
  { id: 'raven', name: 'Week of the Raven', text: 'your Tactician plays 30 elo weaker (ill omens)', tone: 'bad', mods: { elo: -30 } },
  { id: 'truce', name: 'Week of the Truce', text: 'the rival lord moves 10% slower', tone: 'good', mods: { rival: 0.9 } },
  { id: 'drums', name: 'Week of War Drums', text: 'war drums hurry the rival lord: he moves 10% faster', tone: 'bad', mods: { rival: 1.1 } },
];
export const WEEK_BY_ID = Object.fromEntries(WEEK_EVENTS.map(e => [e.id, e]));
export function weekOfTicks(ticks) { return Math.floor(Math.max(0, +ticks || 0) / WORLD.weekTicks) + 1; }
export function weekNo(run) { return weekOfTicks(run.ticks); }
// ticks until the next turn of the week (1..weekTicks)
export function weekLeft(run) { return WORLD.weekTicks - (Math.max(0, Math.floor(+run.ticks || 0)) % WORLD.weekTicks); }
const weekPick = (run, w) => hash3(run.seed >>> 0, w, 8484) % WEEK_EVENTS.length;
// the event of week w (null for week 1); never the same event two weeks running
export function weekEvent(run, w) {
  w = Math.floor(+w); if (!(w >= 2)) return null;
  let i = weekPick(run, w);
  if (w >= 3 && i === weekPick(run, w - 1)) i = (i + 1) % WEEK_EVENTS.length;
  return WEEK_EVENTS[i];
}
export function weekLine(e) { return e ? `${e.name}: ${e.text}` : ''; }
// "Next week: the Week of the Forge (smelts need half the ore)"
export function weekNext(run) { const e = weekEvent(run, weekNo(run) + 1); return e ? `Next week: the ${e.name} (${e.text})` : ''; }
export function militiaOf(run) { return Math.max(0, Math.min(WORLD.musterCap, run.militia | 0)); }
function setWeek(run, n) { const e = weekEvent(run, n); run.week = { n, ev: e ? e.id : null, mods: e ? Object.assign({}, e.mods) : {} }; }
// repair/derive run.week from run.ticks (old saves, hand edits): no boundary effects are paid here
export function ensureWeek(run) {
  const n = weekNo(run), w = run.week;
  if (!w || typeof w !== 'object' || w.n !== n || (w.ev != null && !WEEK_BY_ID[w.ev]) || !w.mods) setWeek(run, n);
  run.militia = militiaOf(run);
  return run.week;
}
// the gold one turn of the week pays from held mines (WORLD.minePulseTicks of their income each)
export function minePulse(run, mem) {
  let m = 0; for (const t of run.mines || []) m += mineRate(t);
  return m * mineMult(run) * goldMult(mem) * TUNE.tickSec / 60 * WORLD.minePulseTicks;
}
// a week turns (run.ticks is now a multiple of weekTicks): the pulse is paid at the old week's rates, then the new
// week begins. Returns { n, ev, pulse, muster, next } for the page's toast.
export function weekTurn(state) {
  const run = state.run, pulse = minePulse(run, state.memories);
  run.gold += pulse;
  if (run.map && run.map.rival) ledgerClose(run); // P1-6: the rival ledger's line for the week that just ended
  setWeek(run, weekNo(run));
  const before = militiaOf(run);
  run.militia = Math.min(WORLD.musterCap, before + weekMod(run, 'muster', 1));
  const e = weekEvent(run, run.week.n);
  return { n: run.week.n, ev: e ? e.id : null, pulse, muster: run.militia - before, next: weekEvent(run, run.week.n + 1) };
}

// =====================================================================
// P0-3: who yields the field (the battle's event line)
// =====================================================================
export function yieldLine(node, claimed) {
  const who = !node ? 'The enemy'
    : node.boss && (node.type === 'citadel' || node.type === 'rival') ? capFirst(node.boss)
    : node.raid || node.type === 'raid' ? 'The raiders'
    : node.ambush || node.type === 'ambush' ? 'The ambushers'
    : node.place ? `The garrison of ${node.place}` : node.name ? `The garrison of ${node.name}` : 'The garrison';
  const boss = !!(node && node.boss && (node.type === 'citadel' || node.type === 'rival'));
  if (claimed) return `${who} cannot recover: you claim the field`;
  return boss ? `${who} lowers the banner and yields the field` : `${who} yields the field`;
}

// =====================================================================
// P0-2: level ceremony. A level-up sets state.skillGlow[type] (the Army tab row glows) until the Skill Guide for
// that skill is opened (viewSkill). skillGuide(type, level) writes out what the level gave, the next unlocks,
// the title ladder and the halfway landmark.
// =====================================================================
export function markSkillGlow(state, dings) {
  if (!dings || !dings.length) return;
  const g = state.skillGlow && typeof state.skillGlow === 'object' && !Array.isArray(state.skillGlow) ? state.skillGlow : (state.skillGlow = {});
  for (const d of dings) if (d && SK.SKILL_TYPES.includes(d.type)) g[d.type] = Math.max(g[d.type] | 0, d.level | 0);
}
export function skillGlows(state, t) { return !!(state.skillGlow && state.skillGlow[t]); }
export function viewSkill(state, t) { if (state.skillGlow && state.skillGlow[t]) { delete state.skillGlow[t]; return true; } return false; }
// the first level whose total xp is at least half of level 99's (the "92 is half of 99" landmark of this curve)
export function skillHalfLevel() {
  const half = SK.xpForLevel(SK.MAX_LEVEL) / 2;
  let L = 1; while (L < SK.MAX_LEVEL && SK.xpForLevel(L) < half) L++;
  return L;
}
const pctS = f => String(+(f * 100).toFixed(2)) + '%';
const NOUNS = { P: ['pawn', 'pawns'], N: ['knight', 'knights'], B: ['bishop', 'bishops'], R: ['rook', 'rooks'], Q: ['queen', 'queens'], K: ['square', 'squares'] };
// the concrete perk changes from level a to level b of one skill (never empty for b = a + 1)
export function perkDelta(t, a, b) {
  const p = SK.perksFor(t, a), q = SK.perksFor(t, b), out = [], [one, many] = NOUNS[t];
  if (q.discount !== p.discount) out.push(`${t === 'K' ? 'formation squares' : many} ${pctS(q.discount - p.discount)} cheaper (now ${pctS(q.discount)} off${q.discount >= SK.PERK_TABLE.discCap ? ', the maximum' : ''})`);
  if (q.marchCut !== p.marchCut) out.push(`marches ${pctS(q.marchCut - p.marchCut)} shorter (now ${pctS(q.marchCut)})`);
  if (q.start !== p.start) out.push(`every new run starts with ${q.start} free ${q.start === 1 ? one : many} (was ${p.start})`);
  if (q.title !== p.title) out.push(`new title: ${q.title}`);
  if (b === skillHalfLevel() && a < b) out.push('the halfway mark to 99');
  if (!out.length) out.push(`total level +${b - a}`);
  return out;
}
export function skillGuide(t, level) {
  if (!SK.SKILL_TYPES.includes(t)) return null;
  const L = Math.max(1, Math.min(SK.MAX_LEVEL, Math.floor(+level) || 1)), pk = SK.perksFor(t, L), half = skillHalfLevel();
  const gave = L > 1 ? perkDelta(t, L - 1, L) : [`${t === 'K' ? 'formation squares' : NOUNS[t][1]} ${pctS(pk.discount)} cheaper from the start`];
  // the next level always, then the next milestones (a title, a free piece, the halfway mark, 99), up to 4 rows
  const next = [];
  if (L < SK.MAX_LEVEL) next.push({ level: L + 1, text: perkDelta(t, L, L + 1).join('; ') });
  for (let x = L + 2; x <= SK.MAX_LEVEL && next.length < 4; x++) {
    const a = SK.perksFor(t, x - 1), b = SK.perksFor(t, x);
    if (a.title !== b.title || a.start !== b.start || x === half || x === SK.MAX_LEVEL) next.push({ level: x, text: perkDelta(t, x - 1, x).filter(s => !/cheaper|shorter/.test(s) || x === SK.MAX_LEVEL).join('; ') });
  }
  const ladder = SK.TITLE_LEVELS.map((lv, i) => ({ level: lv, title: SK.TITLES[t][i], got: L >= lv }));
  const hx = SK.xpForLevel(half), mx = SK.xpForLevel(SK.MAX_LEVEL);
  return { type: t, skill: pk.skill, level: L, title: pk.title, perks: pk, gave, next, ladder, half,
    landmark: `${half} is half of 99: level ${half} (${hx.toLocaleString('en-US')} xp) is past the halfway point of the ${mx.toLocaleString('en-US')} xp that 99 needs, and level ${half - 1} falls ${(Math.ceil(mx / 2) - SK.xpForLevel(half - 1)).toLocaleString('en-US')} xp short of it.` };
}

// =====================================================================
// P1 engagement: the trophy ladder (banners, total level, regional diaries), the rival ledger, the Hall of the
// Fallen, and the "next goal" picker. Everything account-side lives on `state` (never deducted); run-side
// counters live on the run or its map and go with them.
//   state.banners = { [type]: 1 }          claimed skill banners (a 99 + 99 gold)
//   state.tlMile = highest total-level milestone already announced
//   state.diary = { [region]: { done: {checkId: 1}, n: {counter: k}, tiers: {tierId: 1} } }, state.diaryNews = [...]
//   state.hall = [entry, ...] (newest last, capped), state.hallN (all-time count), state.bequest = { bank, paid }
//   run.pstat = { [pieceId]: { b: battles survived, c: captures } }
//   run.map.rledger = [{ w, ds, s, took: [], lost: [], drills }], run.map.rweek = { w, s0, took, lost, drills }
// =====================================================================
export const P1 = {
  bannerGold: 99,                                 // the claim ritual's symbolic price (run gold)
  milestones: [100, 200, 300, 400, 500, 594],     // total level toasts (594 = six 99s)
  bequestPer: 15,                                 // 1 Memory per 15 pawn-units of value (type + tempering); balance pass: 3 -> 15 with the payout scale (memScale 5)
  bequestMinBattles: 2,                           // only a piece that survived 2+ battles leaves a bequest
  hallMax: 80,                                    // entries kept (the count is kept forever)
  ledgerMax: 10,
  band: { patrol: 0.6, company: 1.15 },           // guard bands: army points / your formation's points
};
// repair the P1 fields on every load (additive; a save from before this pass gets them fresh). A save that has no
// tutorial record predates the tutorial: its player is no newcomer, so the tips start switched off ("Replay tips" on
// the Run tab turns them back on). Total-level milestones already passed are not announced again.
export function cleanP1(s) {
  s.banners = s.banners && typeof s.banners === 'object' && !Array.isArray(s.banners) ? Object.fromEntries(SK.SKILL_TYPES.filter(t => s.banners[t]).map(t => [t, 1])) : {};
  if (!(s.tlMile >= 0)) s.tlMile = milestoneFloor(SK.totalLevel(s.skills));
  cleanDiary(s); cleanHall(s);
  s.diaryMem = Math.max(0, s.diaryMem | 0);
  if (s.tutorial === undefined) s.tutorial = { seen: {}, counts: {}, off: true };
  if (s.run) { if (!s.run.pstat || typeof s.run.pstat !== 'object') s.run.pstat = {}; if (s.run.map) cleanLedger(s.run); }
  return s;
}
// ---- P1-5 banners + total level ----
export function maxedSkills(state) { return SK.SKILL_TYPES.filter(t => SK.skillLevel(state.skills, t) >= SK.MAX_LEVEL); }
export function bannerTrim(state) { return maxedSkills(state).length >= 2; }
export function hasBanner(state, t) { return !!(state.banners && state.banners[t]); }
export function bannerClaimable(state, t) { return SK.SKILL_TYPES.includes(t) && SK.skillLevel(state.skills, t) >= SK.MAX_LEVEL && !hasBanner(state, t); }
export function claimBanner(state, t) {
  if (!bannerClaimable(state, t)) return { ok: false, reason: hasBanner(state, t) ? 'claimed' : 'level' };
  const run = state.run; if (!(run.gold >= P1.bannerGold)) return { ok: false, reason: 'gold' };
  run.gold -= P1.bannerGold;
  if (!state.banners || typeof state.banners !== 'object') state.banners = {};
  state.banners[t] = 1;
  return { ok: true, trim: bannerTrim(state) };
}
// the milestones crossed going from total level `prev` (exclusive) to `now` (inclusive)
export function totalLevelMilestones(prev, now) { return P1.milestones.filter(m => m > prev && m <= now); }
export function milestoneFloor(total) { let f = 0; for (const m of P1.milestones) if (total >= m) f = m; return f; }
// announce each milestone once: returns the newly reached ones and remembers the highest
export function noteTotalLevel(state) {
  const tl = SK.totalLevel(state.skills), prev = +state.tlMile || 0, got = totalLevelMilestones(prev, tl);
  if (got.length) state.tlMile = got[got.length - 1];
  return { total: tl, reached: got, next: P1.milestones.find(m => m > tl) || null };
}

// ---- P1-5 regional diaries: four tiers per region number, kept for the account (a check, once done, stays done) ----
export const DIARY_TIERS = [
  { id: 'easy', name: 'Easy', mem: 1, title: 'Wayfarer' },
  { id: 'medium', name: 'Medium', mem: 2, title: 'Pathfinder' },
  { id: 'hard', name: 'Hard', mem: 3, title: 'Warden' },
  { id: 'elite', name: 'Elite', mem: 5, title: 'Lord-Surveyor' },
];
const resList = n => RES_POOL(n).map(r => RES_SHORT[r]);
const andList = a => a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
// each check: a plain sentence (text(region)) and a test over the region's facts (f) and its counters (c)
export const DIARY_CHECKS = [
  { id: 'mine', tier: 'easy', text: () => 'Hold a mine', test: f => f.mines >= 1 },
  { id: 'town', tier: 'easy', text: () => 'Hold a market town', test: f => f.towns >= 1 },
  { id: 'site', tier: 'easy', text: () => 'Visit a named place', test: f => f.sitesDone >= 1 },
  { id: 'clean', ev: 1, tier: 'easy', text: () => 'Win a battle without losing a piece', test: (f, c) => (c.flawless | 0) >= 1 },
  { id: 'types', tier: 'medium', text: n => `Hold every kind of mine at once (${andList(resList(n))})`, test: f => f.resKinds >= f.resPool },
  { id: 'shrine', ev: 1, tier: 'medium', text: () => 'Take a shrine\'s blessing', test: (f, c) => (c.shrine | 0) >= 1 },
  { id: 'cache', ev: 1, tier: 'medium', text: () => 'Take a supply cache', test: (f, c) => (c.cache | 0) >= 1 },
  { id: 'hold', ev: 1, tier: 'medium', text: () => 'Keep a place you hold: beat a raid or a rival attack', test: (f, c) => (c.repelled | 0) >= 1 },
  { id: 'sites', tier: 'hard', text: () => 'Find every named place (all out of the fog)', test: f => f.sites > 0 && f.sitesSeen >= f.sites },
  { id: 'fog', tier: 'hard', text: () => 'Lift the fog from every place in the region', test: f => f.nodes > 0 && f.fog === 0 },
  { id: 'back', ev: 1, tier: 'hard', text: () => 'Win back a place the rival holds', test: (f, c) => (c.wonBack | 0) >= 1 },
  { id: 'clean3', ev: 1, tier: 'hard', text: () => 'Win 3 battles here without losing a piece', test: (f, c) => (c.flawless | 0) >= 3 },
  { id: 'seat', ev: 1, tier: 'elite', text: () => 'Take the rival lord\'s seat', test: (f, c) => (c.seat | 0) >= 1 },
  { id: 'allmines', tier: 'elite', text: () => 'Hold every mine in the region at once', test: f => f.mineNodes > 0 && f.mines >= f.mineNodes },
  { id: 'visit', tier: 'elite', text: () => 'Visit every named place', test: f => f.sites > 0 && f.sitesDone >= f.sites },
];
export function diaryOf(state, n) {
  if (!state.diary || typeof state.diary !== 'object' || Array.isArray(state.diary)) state.diary = {};
  const k = String(Math.max(1, n | 0)), d = state.diary[k] && typeof state.diary[k] === 'object' ? state.diary[k] : (state.diary[k] = {});
  for (const f of ['done', 'n', 'tiers']) if (!d[f] || typeof d[f] !== 'object' || Array.isArray(d[f])) d[f] = {};
  return d;
}
export function cleanDiary(state) {
  const src = state.diary && typeof state.diary === 'object' && !Array.isArray(state.diary) ? state.diary : {};
  state.diary = {};
  for (const k of Object.keys(src)) if (/^\d+$/.test(k) && +k >= 1) {
    const d = diaryOf(state, +k), s = src[k] || {};
    for (const c of DIARY_CHECKS) if (s.done && s.done[c.id]) d.done[c.id] = 1;
    if (s.n && typeof s.n === 'object') for (const x of Object.keys(s.n)) d.n[x] = Math.max(0, s.n[x] | 0);
    for (const t of DIARY_TIERS) if (s.tiers && s.tiers[t.id]) d.tiers[t.id] = 1;
  }
  if (!Array.isArray(state.diaryNews)) state.diaryNews = [];
  return state.diary;
}
// a counter event for a region's diary ('flawless', 'shrine', 'cache', 'repelled', 'wonBack', 'seat')
export function diaryCount(state, n, key, by = 1) { const d = diaryOf(state, n); d.n[key] = (d.n[key] | 0) + by; return d.n[key]; }
// what the map shows now (current region only)
export function diaryFacts(run) {
  const reg = worldRegion(run), held = new Set(run.map.held), n = run.map.region;
  const mineNodes = reg.nodes.filter(x => x.type === 'mine'), heldMine = mineNodes.filter(x => held.has(x.id));
  const kinds = new Set(heldMine.map(x => mineResource(run, x.id)).filter(Boolean));
  const sites = run.map.sites || [], seen = DSC.visibleSites(run, reg);
  return { region: n, nodes: reg.nodes.length, mines: heldMine.length, mineNodes: mineNodes.length, resKinds: kinds.size, resPool: RES_POOL(n).length,
    towns: reg.nodes.filter(x => x.type === 'town' && held.has(x.id)).length,
    sites: sites.length, sitesSeen: seen.length, sitesDone: sites.filter(s => s.done).length,
    fog: worldFog(run).filter(v => v.vis === 'fog').length };
}
// mark every check that holds now for the current region; completes tiers (Memories + title, once). Returns the news.
export function diaryUpdate(state) {
  const run = state.run; if (!run || !run.map) return [];
  const n = run.map.region, d = diaryOf(state, n), f = diaryFacts(run), news = [];
  for (const c of DIARY_CHECKS) if (!d.done[c.id]) { let ok = false; try { ok = !!c.test(f, d.n); } catch (e) { ok = false; } if (ok) { d.done[c.id] = 1; news.push({ kind: 'check', region: n, id: c.id, text: c.text(n) }); } }
  news.push(...diaryTiers(state, n));
  if (news.length) { if (!Array.isArray(state.diaryNews)) state.diaryNews = []; state.diaryNews.push(...news); if (state.diaryNews.length > 20) state.diaryNews.splice(0, state.diaryNews.length - 20); }
  return news;
}
// pay out tiers whose checks are all done (counter checks for an old region are marked by diaryEventMark)
function diaryTiers(state, n) {
  const d = diaryOf(state, n), out = [];
  for (const t of DIARY_TIERS) {
    if (d.tiers[t.id]) continue;
    if (DIARY_CHECKS.filter(c => c.tier === t.id).every(c => d.done[c.id])) {
      d.tiers[t.id] = 1; state.memories = (state.memories || 0) + t.mem; state.memEarned = (state.memEarned || 0) + t.mem;
      state.diaryMem = (state.diaryMem | 0) + t.mem;
      out.push({ kind: 'tier', region: n, id: t.id, name: t.name, mem: t.mem, title: diaryTitle(t, n) });
    }
  }
  return out;
}
// counter checks can complete for a region that is no longer on the map (the seat battle opens the next region)
function diaryEventMark(state, n) {
  const d = diaryOf(state, n), news = [];
  for (const c of DIARY_CHECKS) if (!d.done[c.id] && c.ev) { let ok = false; try { ok = !!c.test({}, d.n); } catch (e) { ok = false; } if (ok) { d.done[c.id] = 1; news.push({ kind: 'check', region: n, id: c.id, text: c.text(n) }); } }
  news.push(...diaryTiers(state, n));
  if (news.length) { if (!Array.isArray(state.diaryNews)) state.diaryNews = []; state.diaryNews.push(...news); }
  return news;
}
export function diaryTitle(t, n) { return `${t.title} of Region ${n}`; }
export function diaryTitles(state) {
  const out = [];
  for (const k of Object.keys(state.diary || {}).sort((a, b) => a - b)) for (const t of DIARY_TIERS) if (state.diary[k].tiers && state.diary[k].tiers[t.id]) out.push(diaryTitle(t, +k));
  return out;
}
// plain progress for the Run tab: per tier, done/total and each check
export function diaryProgress(state, n) {
  const d = diaryOf(state, n);
  return DIARY_TIERS.map(t => {
    const cs = DIARY_CHECKS.filter(c => c.tier === t.id).map(c => ({ id: c.id, text: c.text(n), done: !!d.done[c.id] }));
    return { id: t.id, name: t.name, mem: t.mem, title: diaryTitle(t, n), done: !!d.tiers[t.id], got: cs.filter(c => c.done).length, total: cs.length, checks: cs };
  });
}

// ---- P1-8 the Hall of the Fallen ----
// a fallen piece's name: a given name from the content pack's lords and a family name from another lord (stable per run + id)
const LORD_GIVEN = CONTENT.RIVAL_LORDS.map(l => l.name.split(' ').filter(w => !/^(Abbess|of|the)$/i.test(w))[0]).filter(Boolean);
const LORD_FAMILY = CONTENT.RIVAL_LORDS.map(l => l.name.split(' ').pop()).filter(w => /^[A-Z][a-z]+$/.test(w) && !/^Ford$/.test(w));
export function pieceName(run, id) {
  const g = LORD_GIVEN[hash3(run.seed >>> 0, id | 0, 77) % LORD_GIVEN.length];
  let f = LORD_FAMILY[hash3(run.seed >>> 0, id | 0, 78) % LORD_FAMILY.length];
  if (CONTENT.RIVAL_LORDS.some(l => l.name === g + ' ' + f)) f = LORD_FAMILY[(LORD_FAMILY.indexOf(f) + 1) % LORD_FAMILY.length];
  return g + ' ' + f;
}
export function pieceValue(t, mat) { return (UNITS[t] || 0) + Math.max(0, Math.min(3, mat | 0)); }
// the one-time bequest of a fallen piece (Memories, fractional; banked whole): 0 unless it survived 2+ battles
export function bequestFor(t, mat, battles) { return (battles | 0) >= P1.bequestMinBattles ? pieceValue(t, mat) / P1.bequestPer : 0; }
export function pstatOf(run, id) { if (!run.pstat || typeof run.pstat !== 'object') run.pstat = {}; return run.pstat[id] || (run.pstat[id] = { b: 0, c: 0 }); }
// bank a bequest: the fraction accumulates, whole Memories are paid at once and never taken back
export function bankBequest(state, mem) {
  const q = state.bequest && typeof state.bequest === 'object' ? state.bequest : (state.bequest = { bank: 0, paid: 0 });
  q.bank = Math.max(0, +q.bank || 0) + Math.max(0, +mem || 0);
  const whole = Math.floor(q.bank + 1e-9) - (q.paid | 0);
  if (whole > 0) { q.paid = (q.paid | 0) + whole; state.memories = (state.memories || 0) + whole; state.memEarned = (state.memEarned || 0) + whole; }
  return Math.max(0, whole);
}
export function cleanHall(state) {
  state.hall = (Array.isArray(state.hall) ? state.hall : []).filter(e => e && typeof e.name === 'string' && UNITS[e.t] != null).slice(-P1.hallMax);
  state.hallN = Math.max(state.hall.length, state.hallN | 0);
  const q = state.bequest; state.bequest = { bank: Math.max(0, +(q && q.bank) || 0), paid: Math.max(0, (q && q.paid) | 0) };
  return state.hall;
}
export function hallOfRun(state, runNo) { return (state.hall || []).filter(e => e.run === runNo); }

// ---- after every world battle (page endBattle, balance bot): per-piece stats, the Hall, diary counters ----
// battle.pk = { c: { [id]: captures }, f: { [id]: { t, mat } } } is kept by battleMove (rebuilt on rewind).
export function afterBattle(state, battle, sum) {
  const run = state.run, node = battle.node || {}, pk = battle.pk || { c: {}, f: {} };
  if (battle.p1Done) return { fallen: [], bequest: 0 };
  battle.p1Done = true;
  const lost = new Set(battle.lost || []), ids = new Set();
  for (const id of (battle.start ? battle.start.ids : battle.ids)) if (id > 0 && id < 1e6) ids.add(id);
  for (const id of battle.gated || []) if (id > 0 && id < 1e6) ids.add(id); // v6: fairy pieces that entered through a gate
  for (const id of lost) if (id > 0 && id < 1e6) ids.add(id);
  const fallen = []; let bq = 0;
  for (const id of ids) {
    const ps = pstatOf(run, id), caps = pk.c[id] | 0;
    if (lost.has(id)) {
      const f = pk.f[id]; if (!f || UNITS[f.t] == null) { delete run.pstat[id]; continue; }
      const mem = bequestFor(f.t, f.mat, ps.b);
      const e = { name: pieceName(run, id), t: f.t, mat: MAT_NAMES[f.mat | 0] || 'wood', battles: ps.b, caps: ps.c + caps, run: (state.totalRuns | 0) + 1,
        region: node.region || (run.map ? run.map.region : 1), place: node.place || node.name || '', tier: battle.tier | 0, mem: Math.round(mem * 100) / 100 };
      fallen.push(e); bq += mem;
      delete run.pstat[id];
    } else if (pieceById(run, id)) { ps.b++; ps.c += caps; }
  }
  if (fallen.length) {
    if (!Array.isArray(state.hall)) state.hall = [];
    state.hall.push(...fallen); if (state.hall.length > P1.hallMax) state.hall.splice(0, state.hall.length - P1.hallMax);
    state.hallN = (state.hallN | 0) + fallen.length;
  }
  const paid = bq > 0 ? bankBequest(state, bq) : 0;
  // diary counters for the battle's region (the seat battle has already opened the next region)
  const n = node.region || (run.map ? run.map.region : 1);
  const won = sum && (sum.result === 'win');
  if (won && !(battle.lost || []).length) diaryCount(state, n, 'flawless');
  if (sum && (sum.raid || sum.border) && sum.kept && sum.result === 'win') diaryCount(state, n, 'repelled');
  if (sum && sum.fromRival) diaryCount(state, n, 'wonBack');
  if (sum && sum.seat) diaryCount(state, n, 'seat');
  if (run.map && run.map.region === n) diaryUpdate(state); else diaryEventMark(state, n);
  if (sum) { sum.fallen = fallen; sum.bequest = bq; sum.bequestPaid = paid; }
  cleanGates(run);
  return { fallen, bequest: bq, paid };
}
const MAT_NAMES = ['wood', 'iron', 'steel', 'obsidian'];

// ---- P1-6 the rival ledger: what the rival gained each week, its strength math, guard bands ----
function rweekOf(run) {
  const m = run.map, rv = m.rival, w = weekNo(run);
  if (!m.rweek || typeof m.rweek !== 'object' || !Array.isArray(m.rweek.took)) m.rweek = { w, s0: rv ? rv.strength : 1, took: [], lost: [], drills: 0 };
  if (!Array.isArray(m.rweek.lost)) m.rweek.lost = [];
  return m.rweek;
}
export function cleanLedger(run) {
  const m = run.map; if (!m) return;
  m.rledger = (Array.isArray(m.rledger) ? m.rledger : []).filter(e => e && Number.isFinite(+e.w)).slice(-P1.ledgerMax);
  rweekOf(run);
}
export function ledgerNote(run, kind, name) {
  if (!run.map || !run.map.rival) return;
  const k = rweekOf(run);
  if (kind === 'took') k.took.push(name); else if (kind === 'lost') k.lost.push(name); else if (kind === 'drill') k.drills++;
}
// close the week's ledger line (called at each turn of the week, before the new week begins)
export function ledgerClose(run) {
  const m = run.map, rv = m && m.rival; if (!rv) return null;
  const k = rweekOf(run), e = { w: k.w, ds: Math.round((rv.strength - k.s0) * 100) / 100, s: Math.round(rv.strength * 100) / 100, took: k.took.slice(), lost: k.lost.slice(), drills: k.drills, held: rv.held.length };
  if (!Array.isArray(m.rledger)) m.rledger = [];
  m.rledger.push(e); if (m.rledger.length > P1.ledgerMax) m.rledger.splice(0, m.rledger.length - P1.ledgerMax);
  m.rweek = { w: weekNo(run), s0: rv.strength, took: [], lost: [], drills: 0 };
  return e;
}
const signed = x => (x >= 0 ? '+' : '') + (Math.round(x * 10) / 10).toFixed(1);
// "Week 3: +0.4 strength, took Milltown and Oakford, drilled twice"
export function ledgerLine(e, open) {
  const bits = [`${signed(e.ds)} strength`];
  if (e.took && e.took.length) bits.push('took ' + andList(e.took)); else bits.push('took no new places');
  if (e.lost && e.lost.length) bits.push('lost ' + andList(e.lost) + ' to you');
  if (e.drills) bits.push(e.drills === 1 ? 'drilled once' : `drilled ${e.drills} times`);
  return `Week ${e.w}${open ? ' so far' : ''}: ${bits.join(', ')}`;
}
export function ledgerLines(run) {
  const m = run.map; if (!m || !m.rival) return [];
  const k = rweekOf(run), rv = m.rival, cur = { w: k.w, ds: rv.strength - k.s0, took: k.took, lost: k.lost, drills: k.drills };
  return [ledgerLine(cur, true)].concat((m.rledger || []).slice().reverse().map(e => ledgerLine(e)));
}
// the rival's strength in plain words: where its xp comes from, the formula, what strength does
export function rivalMath(run) {
  const r = rivalOf(run); if (!r) return null;
  const T = RIVAL_TUNE, tpm = 1000 * WORLD.rivalSecPerTick; // rival ms per world tick
  const parts = [
    { k: 'time', xp: r.ms / T.xpTimeMs, how: `1 per ${Math.round(T.xpTimeMs / tpm)} moves of its clock` },
    { k: 'mines', xp: r.mineMs / T.xpMineMs, how: `1 per mine held per ${Math.round(T.xpMineMs / tpm)} moves` },
    { k: 'places taken', xp: r.captures * T.xpCapture, how: `${T.xpCapture} for each (${r.captures} so far)` },
    { k: 'drills', xp: r.sorties * T.xpSortie, how: `${T.xpSortie} for each (${r.sorties} so far)` },
    { k: 'border wins', xp: r.borderWins * T.xpBorderWin, how: `${T.xpBorderWin} for each (${r.borderWins} so far)` },
  ];
  const xp = parts.reduce((a, p) => a + p.xp, 0), vw = rivalView(run), adj = +run.map.rivalAdj || 0;
  const tier = (r.regionNumber - 1) * T.tiersPerRegion + vw.strength, elo = Math.round(r.eloBase + T.eloPerStrength * (vw.strength - 1));
  return {
    xp, strength: r.strength, shown: vw.strength, max: 1 + T.bonusCap, adj, dwellings: vw.dwellings, tier, elo, parts,
    lines: [
      `Strength ${vw.strength.toFixed(1)} of ${1 + T.bonusCap} at most. It only grows, never shrinks.`,
      `It comes from experience: ${xp.toFixed(1)} xp in all. ` + parts.map(p => `${capFirst(p.k)} ${p.xp.toFixed(1)} (${p.how})`).join('; ') + '.',
      `Strength = 1 + ${T.bonusScale} x log2(1 + xp / 3), capped at ${1 + T.bonusCap}: ${r.strength.toFixed(2)}` + (adj ? `, then ${signed(adj)} from shrine effects` : '') + '.',
      `Its armies fight at tier ${tier.toFixed(1)} (the region's base tier + strength) and elo ${elo} (+${T.eloPerStrength} per strength point above 1).`,
      `Trait dwellings ${vw.dwellings}: one level per doubling of xp, so its captured pieces may survive like yours.`,
    ],
  };
}
// a guard band for an army against your formation's points (H3-style: no exact count needed to judge a fight)
export function guardBand(units, yours) {
  const y = Math.max(1, yours | 0), r = (units || 0) / y;
  const k = r <= P1.band.patrol ? 'patrol' : r <= P1.band.company ? 'company' : 'host';
  const text = k === 'patrol' ? 'a patrol (well under your formation)' : k === 'company' ? 'a company (about your formation\'s match)' : 'a host (stronger than your formation)';
  return { k, ratio: r, text, word: k === 'patrol' ? 'a patrol' : k === 'company' ? 'a company' : 'a host' };
}
export function formationUnits(run) { return armyUnits(Object.values(run.formation).map(id => pieceById(run, id)).filter(Boolean)); }

// ---- P2-10 next goal: the nearest actionable thing, in plain words (the page rotates the first few) ----
export function nextGoals(state) {
  const run = state.run, out = [];
  if (!run || !run.map) return out;
  for (const t of SK.SKILL_TYPES) if (bannerClaimable(state, t)) out.push({ k: 'banner', t, text: `Claim your ${SK.SKILL_NAMES[t]} banner on the Army tab (${P1.bannerGold} gold).` });
  const sq = effPrice(run, squareCost(run)), res = reserveCount(run);
  if (run.owned.length < 16 && run.gold >= sq && res > 0) out.push({ k: 'square', text: `Buy a formation square for ${Math.ceil(sq)} gold: tap a + square on the board. ${res === 1 ? 'A reserve piece is' : res + ' reserve pieces are'} waiting.` });
  const dw = cleanDwell(run.dwell);
  const dws = DWELL_TYPES.filter(t => dw[t] < DWELL_MAX && run.roster.some(p => p.t === t)).map(t => ({ t, p: effPrice(run, dwellPrice(t, dw[t])) })).filter(x => run.gold >= x.p).sort((a, b) => a.p - b.p);
  if (dws.length) out.push({ k: 'dwell', t: dws[0].t, text: `Build a ${PIECE_NOUN[dws[0].t] || dws[0].t} dwelling for ${Math.ceil(dws[0].p)} gold on the Army tab: their captured pieces may survive.` });
  const pr = diaryProgress(state, run.map.region).find(t => !t.done && t.total - t.got === 1);
  if (pr) { const c = pr.checks.find(x => !x.done); out.push({ k: 'diary', text: `One task left in the Region ${run.map.region} ${pr.name} diary: ${c.text.charAt(0).toLowerCase() + c.text.slice(1)}.` }); }
  const near = SK.SKILL_TYPES.map(t => { const lp = SK.levelProgress(SK.skillXp(state.skills, t)); return { t, lp }; }).filter(x => x.lp.next != null && x.lp.frac >= 0.75).sort((a, b) => b.lp.frac - a.lp.frac)[0];
  if (near) out.push({ k: 'skill', t: near.t, text: `${SK.SKILL_NAMES[near.t]} ${near.lp.level + 1} is ${Math.ceil(near.lp.need)} xp away.` });
  const w = run.week && run.week.ev ? WEEK_BY_ID[run.week.ev] : null;
  out.push(w ? { k: 'week', text: `${w.name}: ${w.text}, ${weekLeft(run)} moves left this week.` } : { k: 'week', text: `Week ${weekNo(run)} is quiet. ${weekNext(run) || 'Next week'}, in ${weekLeft(run)} moves.` });
  return out;
}
const reserveCount = run => reserve(run).filter(p => p.t !== 'K').length;

// =====================================================================
// v6 fairy pieces (fairy.mjs, a verbatim copy of ../checkmarch-fairy; FAIRY-API.md). This milestone ships the 8x8
// roster: commoner, champion, wizard (pairs), cannon, nightrider, then archbishop and chancellor late. The gryphon,
// the amazon and the lion wait for the 10x10 milestone (their rows stay in the module, unwired).
// Account (state.fairy, never reset by endRun): un = { id: region it was unlocked in }, seen = { id: 1 } (ceremony
// shown), q = ids whose unlock ceremony is still to show, wiz = failed wizard rolls (each failure raises the odds).
// Run: run.fun = a synced copy of un (army builders only see the run), run.fbought = { letter: copies bought, minus
// copies lost }, run.gates = [{ id, sq }]: a bought piece that found no free square waits off the board behind its
// home square sq (Seirawan gating: it enters when that square's piece moves away in battle; engine pos.g).
// =====================================================================
export const FAIRY_SHIP = ['commoner', 'champion', 'wizard', 'cannon', 'nightrider', 'archbishop', 'chancellor'];
// absolute region numbers. how: 'region' (reaching the region opens the dwelling), 'shrine' (an announced roll when
// a shrine is taken), 'boss' (the region's seat: the lord's reward is the first copy, then the dwelling sells more)
export const FAIRY_UNLOCK = {
  commoner: { region: 2, how: 'region', place: 'Hamlet', text: 'Reach region 2: the Hamlet dwelling opens.' },
  champion: { region: 3, how: 'region', place: 'Hamlet, upgraded', text: 'Reach region 3: the Hamlet grows and trains champions.' },
  wizard: { region: 3, how: 'shrine', place: "Wizard's tower", text: 'Take a shrine in region 3 or later: an announced roll may find the wizards (the odds rise after each miss).' },
  cannon: { region: 4, how: 'region', place: 'Foundry', text: 'Reach region 4: the Foundry casts cannons.' },
  nightrider: { region: 5, how: 'boss', place: 'Night stable', text: 'Take the seat of region 5: the first nightrider is the lord\'s reward, then the Night stable sells more.' },
  archbishop: { region: 6, how: 'region', place: 'Cathedral', text: 'Reach region 6: the Cathedral consecrates an archbishop.' },
  chancellor: { region: 7, how: 'region', place: 'Chancery', text: 'Reach region 7: the Chancery appoints a chancellor.' },
};
// skill: fairy XP goes to Leadership (skills.mjs has no seventh type). Prices use the module's anchor (600 gold at
// 900 cp) and growth (x1.7 per copy) with the roster exponents: value^2 for the compounds, value^1.5 for the rest.
// mirrorLag: the enemy band fields a type this many regions after the player unlocked it; rivalLead: the rival lord
// fields it one region sooner (a visible threat). Below minRegion, and in elo bands below minBand, enemies never do.
export const FAIRY_WORLD = { skill: 'K', expCompound: 2, expOther: 1.5, mirrorLag: 2, rivalLead: 1, minRegion: 3, minBand: 1,
  wizardChance: 0.5, wizardPity: 0.25, perArmy: 1, bossExtra: 1, lateRegion: 6,
  // balance pass: x eraGrowth per unlock region after 2 (the copy growth, as if each region were one more copy). Without it
  // every exotic cost 1-3% of its unlock region's gold and was bought the moment it opened (the archbishop at 454-504
  // gold when region 6 earned 20-50k); now the archbishop is ~a fifth of region 6, the commoner still ~3% of region 2
  eraGrowth: 1.7 };
export const fairyDef = x => FY.FAIRY_BY_ID[x] || FY.FAIRY_BY_CH[x] || null;
export const isFairyType = t => !!FY.FAIRY_BY_CH[t];
export function fairyBase(id) {
  const d = FY.FAIRY_BY_ID[id]; if (!d) return Infinity;
  const P = FY.FAIRY_PRICE, e = d.kind === 'compound' ? FAIRY_WORLD.expCompound : FAIRY_WORLD.expOther;
  return Math.round(P.anchorPrice * Math.pow(d.value / P.anchorVal, e) * Math.pow(FAIRY_WORLD.eraGrowth, Math.max(0, ((FAIRY_UNLOCK[id] && FAIRY_UNLOCK[id].region) || 2) - 2)));
}
export function fairyPriceTable() { const o = {}; for (const id of FAIRY_SHIP) o[id] = fairyBase(id); return o; }
const cleanFBought = o => { const r = {}; for (const id of FAIRY_SHIP) { const c = FY.FAIRY_BY_ID[id].ch; r[c] = Math.max(0, (o && o[c]) | 0); } return r; };
// price of the next purchase (a wizard purchase is a pair: twice the base, growth counted in pairs)
export function fairyCost(run, id) {
  const d = FY.FAIRY_BY_ID[id]; if (!d) return Infinity;
  const n = ((run.fbought && run.fbought[d.ch]) | 0), steps = d.pair ? Math.floor(n / 2) : n;
  return Math.round(fairyBase(id) * (d.pair ? 2 : 1) * Math.pow(FY.FAIRY_PRICE.growth, steps));
}
export const fairyOwned = (run, id) => run.roster.filter(p => p.t === FY.FAIRY_BY_ID[id].ch).length;
// the copy cap (0 = none); the nightrider is capped at 1 until enemies of this region field it, then 2
export function fairyCap(run, id) {
  const d = FY.FAIRY_BY_ID[id]; if (!d) return 0;
  if (id === 'nightrider') return fairyPool(run, run.map ? run.map.region : 1).includes('nightrider') ? 2 : 1;
  return d.cap | 0;
}
export function fairyBlocker(run, id) {
  const d = FY.FAIRY_BY_ID[id]; if (!d || !FAIRY_SHIP.includes(id)) return 'unknown piece';
  if (!run.fun || run.fun[id] == null) return 'not unlocked';
  const cap = fairyCap(run, id), add = d.pair ? 2 : 1;
  if (cap && fairyOwned(run, id) + add > cap) return `at most ${cap} in your army`;
  return '';
}
// ---- account unlocks ----
export function unlockFairy(state, id, region) {
  if (!state.fairy || !FAIRY_SHIP.includes(id) || state.fairy.un[id] != null) return false;
  state.fairy.un[id] = Math.max(1, region | 0);
  if (!state.fairy.seen[id] && !state.fairy.q.includes(id)) state.fairy.q.push(id);
  if (state.run) state.run.fun = Object.assign({}, state.fairy.un);
  return true;
}
export function cleanFairy(state) {
  const f = state.fairy && typeof state.fairy === 'object' ? state.fairy : {}, un = {}, seen = {};
  for (const id of FAIRY_SHIP) { const r = f.un && f.un[id]; if (Number.isInteger(r) && r >= 1) un[id] = r; if (f.seen && f.seen[id]) seen[id] = 1; }
  state.fairy = { un, seen, q: (Array.isArray(f.q) ? f.q : []).filter((id, i, a) => un[id] != null && !seen[id] && a.indexOf(id) === i), wiz: Math.max(0, f.wiz | 0) };
  // a region already reached keeps its dwelling (saves from before v6, or an unlock missed): account-permanent
  for (const id of FAIRY_SHIP) { const u = FAIRY_UNLOCK[id]; if (u.how === 'region' && (state.bestRegion | 0) >= u.region) unlockFairy(state, id, u.region); }
  const run = state.run;
  if (run) { run.fun = Object.assign({}, state.fairy.un); run.fbought = cleanFBought(run.fbought); cleanGates(run); }
  return state.fairy;
}
// a shrine taken in region 3+ while the wizards are still unknown: an announced roll (seeded by run, region, node)
export function fairyShrineFind(state, id, sum) {
  const run = state.run, reg = run.map ? run.map.region : 1;
  if (!state.fairy) cleanFairy(state);
  if (state.fairy.un.wizard != null || reg < FAIRY_UNLOCK.wizard.region) return null;
  const chance = Math.min(1, FAIRY_WORLD.wizardChance + FAIRY_WORLD.wizardPity * state.fairy.wiz);
  const roll = hash3(run.seed >>> 0, reg * 1000 + (id | 0), 3131) / 4294967296, found = roll < chance;
  if (found) unlockFairy(state, 'wizard', reg); else state.fairy.wiz++;
  const r = { id: 'wizard', chance, roll, found,
    text: `A wizard's tower stands beside the shrine: ${Math.round(chance * 100)}% to find its wizards... roll ${roll.toFixed(2)} ${found ? '<' : '≥'} ${chance.toFixed(2)}: ` +
      (found ? 'found! Wizards can now be recruited in pairs in the Shop.' : 'no wizards this time. The next shrine has better odds.') };
  if (sum) sum.fairyRoll = r;
  return r;
}
// a region's seat falls (applyMapResult): dwellings of the next region open; region 5's lord gives the first nightrider
export function fairySeatTaken(state, regionWon, sum) {
  if (!state.fairy) cleanFairy(state);
  const got = [];
  for (const id of FAIRY_SHIP) { const u = FAIRY_UNLOCK[id]; if (u.how === 'region' && regionWon + 1 >= u.region && unlockFairy(state, id, u.region)) got.push(id); }
  if (regionWon >= FAIRY_UNLOCK.nightrider.region && unlockFairy(state, 'nightrider', regionWon)) {
    const run = state.run, nid = run.nextId++; run.roster.push({ id: nid, t: FY.FAIRY_BY_ID.nightrider.ch }); placeOrGate(run, nid);
    got.push('nightrider'); if (sum) sum.fairyGift = { id: 'nightrider', pid: nid };
  }
  if (sum && got.length) sum.fairyUnlocks = got;
  return got;
}
// ---- the unlock ceremony and the Pieces list ----
export function fairyCeremonyNext(state) { const f = state.fairy; return f && f.q.length ? f.q[0] : null; }
export function fairyCeremonySeen(state, id) {
  if (!state.fairy) cleanFairy(state);
  state.fairy.seen[id] = 1; state.fairy.q = state.fairy.q.filter(x => x !== id);
  return fairyCeremonyNext(state);
}
const firstSentence = t => { const i = t.indexOf('. '); return i < 0 ? t : t.slice(0, i + 1); };
export function fairyCard(run, id) {
  const d = FY.FAIRY_BY_ID[id], u = FAIRY_UNLOCK[id]; if (!d || !u) return null;
  const cap = run ? fairyCap(run, id) : d.cap | 0;
  return { id, ch: d.ch, name: d.name, betza: d.betza, plainWords: d.plainWords, short: firstSentence(d.plainWords), diagram: FY.moveDiagram(id), place: u.place, region: u.region, how: u.how, unlockText: u.text,
    units: UNITS[d.ch], pair: !!d.pair, cap, capText: d.pair ? `sold as an opposite-colour pair, at most ${cap} in your army` : cap ? `at most ${cap} in your army${id === 'nightrider' ? ' (2 once enemies field it)' : ''}` : 'no limit on copies',
    price: run ? fairyCost(run, id) : fairyBase(id) * (d.pair ? 2 : 1), trait: fairyTrait(run, d.ch) };
}
// polish: an exotic piece's capture trait, carried by its family's dwelling (engine FAIRY_TRAITS)
export function fairyTrait(run, ch) {
  const f = FAIRY_TRAITS[ch]; if (!f) return null;
  const lvl = run ? cleanDwell(run.dwell)[f.fam] : 0;
  return { label: f.label, text: f.text, fam: f.fam, famName: TRAITS[f.fam].noun, per: f.per, lvl, chance: fairyTraitChance(ch, lvl), max: fairyTraitChance(ch, DWELL_MAX) };
}
export function fairyPieces(state) {
  const un = (state.fairy && state.fairy.un) || {};
  return FAIRY_SHIP.map(id => { const d = FY.FAIRY_BY_ID[id], u = FAIRY_UNLOCK[id]; return { id, ch: d.ch, name: d.name, known: un[id] != null, region: u.region, place: u.place, unlockText: u.text, short: firstSentence(d.plainWords), betza: d.betza }; });
}
// ---- buying, placement, gating ----
const sqColor = sq => ((sq >> 3) + (sq & 7)) & 1;
const homeOrder = (a, b) => (a >> 3) - (b >> 3) || Math.abs((a & 7) - 3.5) - Math.abs((b & 7) - 3.5);
export function freeSquares(run) { return run.owned.filter(sq => run.formation[sq] == null).sort(homeOrder); }
// squares a waiting piece may stand behind: owned, occupied in the formation, no other gate there
export function gateHomes(run) { const used = new Set((run.gates || []).map(g => g.sq)); return run.owned.filter(sq => run.formation[sq] != null && !used.has(sq)).sort(homeOrder); }
export function cleanGates(run) {
  const placed = new Set(Object.values(run.formation || {})), gar = garrisonedIds(run), used = new Set(), out = [];
  for (const g of Array.isArray(run.gates) ? run.gates : []) {
    const id = g && g.id, sq = g && g.sq, p = pieceById(run, id);
    if (!p || !isFairyType(p.t) || placed.has(id) || gar.has(id) || !run.owned.includes(sq) || used.has(sq) || out.some(x => x.id === id)) continue;
    if (run.formation[sq] == null) { run.formation[sq] = id; placed.add(id); continue; } // its home is free: it simply stands there
    used.add(sq); out.push({ id, sq });
  }
  run.gates = out; return out;
}
export const gateOfPiece = (run, id) => (run.gates || []).find(g => g.id === id) || null;
// a new piece: a free owned square if there is one, else it waits behind homeSq (or the best free home)
export function placeOrGate(run, id, homeSq, avoidColor) {
  let free = freeSquares(run);
  if (avoidColor != null && free.some(q => sqColor(q) !== avoidColor)) free = free.filter(q => sqColor(q) !== avoidColor);
  if (free.length) { run.formation[free[0]] = id; return { sq: free[0], gate: false }; }
  const homes = gateHomes(run), sq = homes.includes(homeSq) ? homeSq : homes[0];
  if (sq == null) return { sq: null, gate: false }; // no home left: it waits in the reserve
  if (!Array.isArray(run.gates)) run.gates = [];
  run.gates.push({ id, sq }); return { sq, gate: true };
}
export function setGateHome(run, id, sq) {
  const g = gateOfPiece(run, id), p = pieceById(run, id);
  if (!p || !isFairyType(p.t)) return false;
  if (run.formation[sq] == null || !run.owned.includes(sq) || (run.gates || []).some(x => x.sq === sq && x.id !== id)) return false;
  if (g) g.sq = sq; else { if (Object.values(run.formation).includes(id) || garrisonedIds(run).has(id)) return false; run.gates.push({ id, sq }); }
  return true;
}
export function buyFairy(run, id, homeSq) {
  if (fairyBlocker(run, id)) return null;
  const d = FY.FAIRY_BY_ID[id], c = effPrice(run, fairyCost(run, id));
  if (run.gold < c) return null;
  run.touched = true; run.gold -= c; if (run.discounts > 0) run.discounts--;
  run.fbought = cleanFBought(run.fbought);
  const out = { ids: [], placed: [], gated: [] }; let firstCol = null;
  for (let i = 0; i < (d.pair ? 2 : 1); i++) {
    run.fbought[d.ch]++;
    const nid = run.nextId++; run.roster.push({ id: nid, t: d.ch }); out.ids.push(nid);
    const r = placeOrGate(run, nid, i === 0 ? homeSq : null, d.pair && i === 1 ? firstCol : null);
    if (r.sq != null) { (r.gate ? out.gated : out.placed).push({ id: nid, sq: r.sq }); if (i === 0) firstCol = sqColor(r.sq); }
  }
  return out;
}
// engine gates for a battle just created from the formation: each waiting piece whose home holds a piece of yours
export function gatesFor(run, b) {
  cleanGates(run);
  const out = [], mats = run.forge && run.forge.mats;
  for (const g of run.gates) {
    const p = pieceById(run, g.id), pc = b.pos.b[g.sq];
    if (!p || !pc || (pc >> 5) !== WHITE || b.ids[g.sq] < 0) continue;
    out.push({ color: WHITE, sq: g.sq, t: CH_TYPE[p.t], mt: mats ? matTier(mats[g.id]) : 0, id: g.id });
  }
  return out;
}
export function fairyShopRows(run) {
  return FAIRY_SHIP.filter(id => run.fun && run.fun[id] != null).map(id => {
    const d = FY.FAIRY_BY_ID[id];
    return { id, ch: d.ch, name: d.name, short: firstSentence(d.plainWords), cost: fairyCost(run, id), pair: !!d.pair, owned: fairyOwned(run, id), cap: fairyCap(run, id), units: UNITS[d.ch], blocker: fairyBlocker(run, id), place: FAIRY_UNLOCK[id].place };
  });
}
// ---- the enemy lagged mirror ----
export function eloBand(elo) { let i = 0; while (i < ELO_BANDS.length - 1 && ELO_BANDS[i + 1] <= cleanElo(elo)) i++; return i; }
// the region from which the enemy band (or the rival lord, one region sooner) fields a type the player unlocked
export function fairyMirrorRegion(run, id, rival) { const u = run.fun && run.fun[id]; return u == null ? null : Math.max(FAIRY_WORLD.minRegion, u + FAIRY_WORLD.mirrorLag - (rival ? FAIRY_WORLD.rivalLead : 0)); }
// fairy.mjs enemyFairyPool keeps the band freeze; its per-piece lag is shifted so every type follows mirrorLag
export function fairyPool(run, region, opt = {}) {
  if ((region | 0) < FAIRY_WORLD.minRegion) return [];
  const un = run.fun || {}, sh = {};
  for (const id of FAIRY_SHIP) if (un[id] != null) sh[id] = un[id] + FAIRY_WORLD.mirrorLag - (opt.rival ? FAIRY_WORLD.rivalLead : 0) - FY.FAIRY_BY_ID[id].lag;
  return FY.enemyFairyPool(sh, region | 0, { band: eloBand(run.elo), minBand: FAIRY_WORLD.minBand }).filter(id => FAIRY_SHIP.includes(id));
}
// types the rival fields in this region ahead of the ordinary garrisons (shown on the rival chip as a threat)
export function rivalFairyThreat(run) { const reg = run.map ? run.map.region : 1, g = fairyPool(run, reg); return fairyPool(run, reg, { rival: true }).filter(id => !g.includes(id)); }
// swap pieces of an enemy army for fairy pieces of the pool: each takes the place of the piece closest in weight
// (never the king or a pawn), so budgets and shapes hold. 1 per army (+1 for a boss, +1 from lateRegion).
export function fairyArmy(run, a, key, opt = {}) {
  const reg = a.region || (run.map ? run.map.region : 1), pool = fairyPool(run, reg, opt);
  if (!pool.length || !Array.isArray(a.pieces)) return a;
  const n = Math.min(pool.length, FAIRY_WORLD.perArmy + (opt.boss ? FAIRY_WORLD.bossExtra : 0) + (reg >= FAIRY_WORLD.lateRegion ? 1 : 0));
  const h = mapHashSeed(key + '|fairy'), order = pool.map((x, i) => pool[(i + h) % pool.length]);
  // the rival's preview piece goes first, so the threat he shows is on the board
  if (opt.rival) { const g = fairyPool(run, reg); order.sort((x, y) => (g.includes(x) ? 1 : 0) - (g.includes(y) ? 1 : 0)); }
  a.fairy = [];
  for (const id of order) {
    if (a.fairy.length >= n) break;
    const d = FY.FAIRY_BY_ID[id], u = UNITS[d.ch]; let best = -1, bd = 1e9;
    a.pieces.forEach((p, i) => { if (p.t === 'K' || p.t === 'P' || isFairyType(p.t) || UNITS[p.t] == null) return; const dd = Math.abs(UNITS[p.t] - u); if (dd < bd) { bd = dd; best = i; } });
    if (best < 0 || bd > 3) continue;
    a.pieces[best] = Object.assign({}, a.pieces[best], { t: d.ch }); a.fairy.push(id);
  }
  if (a.fairy.length) a.units = armyUnits(a.pieces);
  return a;
}
// ---- saves: v5 battles carry color << 3 codes (and moves with a 4-bit captured field); keyed on the save's version
export function migrateBattleSave(o, v) {
  if (!o || typeof o !== 'object' || (v | 0) >= 6) return o;
  const mb = a => Array.isArray(a) ? FY.migrateBoardCodes(a) : a, mm = m => Number.isInteger(m) ? FY.migrateMove(m) : m;
  const out = Object.assign({}, o, { b: mb(o.b), last: mm(o.last | 0) });
  if (Array.isArray(o.moves)) out.moves = o.moves.map(mm);
  if (o.start && Array.isArray(o.start.b)) out.start = Object.assign({}, o.start, { b: mb(o.start.b) });
  if (Array.isArray(o.hist)) out.hist = o.hist.map(e => Array.isArray(e) && typeof e[0] === 'string' && e[0].length >= 65
    ? [String.fromCharCode(...FY.migrateBoardCodes([...e[0].slice(0, 64)].map(c => c.charCodeAt(0)))) + e[0].slice(64), e[1]] : e);
  return out;
}
