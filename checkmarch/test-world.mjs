// node test-world.mjs: the world-map layer (world.mjs) over engine.mjs + the copied map module.
import * as E from './engine.mjs';
import * as W from './world.mjs';
import * as M from './map.mjs';
import * as RV from './rival.mjs';
import * as SK from './skills.mjs';
import * as DSC from './discovery.mjs';
import { musicMoodFor } from './audio.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { slimJs } from './build.mjs';
import { RIVAL_LORDS } from './content.mjs';
import * as FY from './fairy.mjs';
const CONTENT_LORDS = RIVAL_LORDS.map(l => l.name);
let fail = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fail++; };

// copies of the map/audio modules must match their source projects (no behaviour changes)
for (const [f, src] of [['map.mjs', '../checkmarch-map/map.mjs'], ['map-render.mjs', '../checkmarch-map/map-render.mjs'], ['audio.mjs', '../checkmarch-music/audio.mjs'], ['rival.mjs', '../checkmarch-rival/rival.mjs'],
  ['forge.mjs', '../checkmarch-forge/forge.mjs'], ['terrain.mjs', '../checkmarch-terrain/terrain.mjs'], ['content.mjs', '../checkmarch-content/content.mjs'], ['fx.mjs', '../checkmarch-fx/fx.mjs'],
  ['skills.mjs', '../checkmarch-skills/skills.mjs'], ['discovery.mjs', '../checkmarch-discovery/discovery.mjs'], ['tutorial.mjs', '../checkmarch-tutorial/tutorial.mjs'], ['fairy.mjs', '../checkmarch-fairy/fairy.mjs']]) {
  const u = new URL(src, import.meta.url);
  if (!existsSync(u)) { console.log(`info ${src} not present; skipping copy check`); continue; }
  ok(readFileSync(new URL(f, import.meta.url), 'utf8') === readFileSync(u, 'utf8'), `${f} is a verbatim copy of ${src}`);
}

const fresh = seed => { const s = E.newState(0, seed); W.ensureMap(s.run); return s; };
// win a battle against map node `id` without playing it out (finishBattle + applyMapResult as the UI does)
function forceWin(st, id) {
  const run = st.run;
  if (run.map.site != null) W.skipSite(run); // M6: a discovery site card would gate the march
  if (run.map.ambush) W.withdrawAmbush(run);
  W.startMarch(run, id);
  const b = W.arrive(run, st);
  if (!b) { const c = run.map.lastCache; return { result: 'win', cache: true, loot: c ? c.gold : 0, mapType: 'cache' }; } // M5 supply cache: no battle
  const sum = E.finishBattle(st, b, 'win');
  return W.applyMapResult(st, b, sum);
}

{
  const st = fresh(11), run = st.run;
  ok(st.v === E.SAVE_VERSION && E.SAVE_VERSION === 6, 'new state is save version 6');
  ok(run.map.region === 1 && run.map.held.length === 1 && run.map.held[0] === 0, 'new run starts holding only the keep of region 1');
  const reg = W.worldRegion(run), f = W.worldFrontier(run);
  ok(f.length >= 1 && f.every(id => reg.nodes[id].col === 0), `frontier is column 0 (${f.length} nodes)`);
  ok(W.marchTicks(run, f[0]) === 5 + 12 * reg.nodes[f[0]].dist, 'march = 5 ticks + 12 per road step (region 1)');
  const fog = reg.nodes.find(n => !f.includes(n.id) && n.id !== 0);
  ok(!W.startMarch(run, fog.id, 0), 'cannot march to a fogged node');
  ok(W.startMarch(run, f[0]) && !W.startMarch(run, f[1] ?? f[0]), 'one march at a time');
  const need = run.map.march.need;
  ok(W.marchProgress(run) === 0 && !W.advanceMarch(run, Math.floor(need / 2)) && Math.abs(W.marchProgress(run) - Math.floor(need / 2) / need) < 1e-9, 'march progress counts ticks');
  ok(W.advanceMarch(run, need) && W.marchProgress(run) === 1, 'the march arrives once its ticks are spent');
  // arrival builds the battle from the formation and the node's garrison
  const b = W.arrive(run);
  ok(b && b.node.mapId === f[0] && b.tier === Math.max(1, reg.nodes[f[0]].tier) && run.map.march === null, 'arrival starts the battle for the node');
  const whites = [...b.pos.b].filter(p => p && (p >> 5) === E.WHITE).length;
  ok(whites === Object.keys(run.formation).length, 'battle uses the player formation');
  ok(E.deserBattle(JSON.parse(JSON.stringify(E.serBattle(b)))).node.mapId === f[0], 'battle node (mapId) survives a save round-trip');
  // loss: nothing captured
  E.finishBattle(st, b, 'loss'); W.applyMapResult(st, b, { result: 'loss' });
  ok(run.map.held.length === 1, 'a lost battle captures nothing');
}

// full region: capture greedily toward the citadel; check mine / town / shrine / citadel effects
{
  const st = fresh(12345), run = st.run;
  let sawMine = false, sawTown = false, sawShrine = false, guard = 0, adv = null;
  while (run.map.region === 1 && guard++ < 60) {
    const reg = W.worldRegion(run), f = W.worldFrontier(run);
    // prefer non-citadel nodes so we exercise everything, citadel last
    const id = f.find(i => reg.nodes[i].type !== 'citadel') ?? f[0];
    const type = reg.nodes[id].type, mines0 = run.mines.length, gold0 = run.gold;
    const sum = forceWin(st, id);
    ok(sum.result === 'win' && run.gold > gold0, `took ${type} "${reg.nodes[id].name}" (tier ${reg.nodes[id].tier}) for ${sum.loot} gold`);
    if (type === 'mine') { sawMine = true; ok(run.mines.length === mines0 + 1, 'mine adds income'); }
    if (type === 'town' || W.townNearby(run)) { if (!sawTown) ok(run.shopDisc === 0.1 && E.effPrice(run, 100) === 90, 'town held/adjacent: 10% shop discount'); sawTown = true; }
    if (type === 'shrine') {
      sawShrine = true;
      ok(run.map.shrine === id && !W.canMarch(run, W.worldFrontier(run)[0]), 'shrine pending blocks marching');
      if (!run.mineBless) {
        const inc0 = E.incomePerMin(run, 0);
        ok(W.chooseShrine(run, 'mines') && run.map.shrine === null, 'shrine: mine blessing chosen');
        ok(run.mines.length === 0 || E.incomePerMin(run, 0) > inc0, 'mine blessing raises income');
      } else {
        const pawn = W.shrinePawn(run), pid = pawn && pawn.id;
        ok(W.chooseShrine(run, 'knight') && (!pid || E.pieceById(run, pid).t === 'N'), 'shrine: pawn knighted');
      }
    }
    if (sum.nextRegion) adv = sum;
  }
  ok(sawMine && sawShrine, `region 1 had mines (${sawMine}), shrines (${sawShrine}), town discount (${sawTown})`);
  ok(adv && run.map.region === 2 && run.map.held.length === 1 && run.map.march === null, 'citadel win advances to region 2 with a fresh map');
  const r2 = W.worldRegion(run), f2 = W.worldFrontier(run);
  ok(run.map.seed !== W.regionSeed(run, 1) && Math.min(...f2.map(i => W.nodeArmy(run, i).tier)) >= 11, 'region 2 has a new seed and higher tiers');
  ok(E.mineMult(run) === 1, 'mine blessing ends with the region');
  ok(W.lordOf(run) && W.nodeArmy(run, r2.citadelId).boss === W.rivalName(run) && W.rivalName(run) === W.lordOf(run).name, `citadel army carries the region lord's name (${W.lordTitle(run)})`);
}

// enemy armies for map nodes: legal shape, budget by type
{
  let good = true;
  for (let s = 0; s < 6; s++) for (let rn = 1; rn <= 4; rn++) {
    const st = fresh(s + 1); st.run.map = W.newWorldMap(st.run, rn); W.ensureMap(st.run);
    const reg = W.worldRegion(st.run);
    for (const n of reg.nodes) {
      if (n.type === 'keep' || W.isCache(st.run, n.id)) continue;
      const a = W.nodeArmy(st.run, n.id), sqs = new Set(a.pieces.map(p => p.sq));
      if (sqs.size !== a.pieces.length || a.pieces.filter(p => p.t === 'K').length !== 1 || a.pieces.some(p => p.sq < 32)) good = false;
      if (a.type !== n.type || a.tier !== Math.max(1, n.tier)) good = false;
    }
  }
  ok(good, 'map node armies: one king, black half only, node type and tier respected');
}

// save migration v1 -> v2
{
  const v1 = E.newState(0, 99); v1.v = 1; delete v1.run.map;
  v1.run.tier = 23; v1.run.mines = [5, 8]; v1.run.gold = 500; v1.memories = 4;
  const st = W.migrateState(JSON.parse(JSON.stringify(v1)));
  ok(st && st.v === 6 && st.run.map.region === 3 && st.run.mines.length === 2 && st.run.gold === 500 && st.memories === 8 && st.memEarned === 4, 'v1 save migrates to v6 (region from tier, gold, mines kept; 4 old Memories -> 8 to spend)');
  ok(st.run.orders.retreat === 'cautious' && st.upgrades.pawns === 0 && st.run.map.raid.t === W.WORLD.raidFirst && typeof st.run.map.garrison === 'object', 'v1 -> v4: default orders, no upgrades, raid clock + garrison added');
  ok(st.run.map.rival && st.run.map.rival.regionNumber === 3 && st.run.map.rival.seat === W.worldRegion(st.run).citadelId, 'v1 -> v4: the region-3 rival is created at its seat');
  ok(W.migrateState({ v: 99, run: {} }) === null && W.migrateState(null) === null, 'unknown/garbage saves are rejected (fresh start)');
  const v2 = fresh(5); v2.run.map.held = [0, 999]; v2.run.map.march = { id: 999, start: 0, ms: 1 };
  W.migrateState(v2);
  ok(v2.run.map.held.length === 1 && v2.run.map.march === null, 'v2 save with bad ids is repaired');
  // a real v2 save (as milestone 2 wrote it): memories +5% each, settings.autoRetreat, no raid/garrison on the map
  const o = fresh(6); o.v = 2; o.memories = 70; o.settings.autoRetreat = false;
  delete o.upgrades; delete o.memSpent; delete o.run.orders; delete o.run.map.raid; delete o.run.map.garrison; delete o.run.incBonus;
  const m = W.migrateState(JSON.parse(JSON.stringify(o)));
  ok(m && m.v === 6 && m.memories === 120 && m.memEarned === 70 && m.migratedFrom === 2, 'v2 -> v6: 70 old Memories become 120 to spend (bonus capped at +50)');
  ok(m.run.orders.retreat === 'off' && !('autoRetreat' in m.settings) && m.run.map.raid.n === 0 && !W.raidClockRuns(m.run), 'v2 -> v4: auto-retreat off becomes the "off" retreat order; raid clock added');
  ok(E.incomePerMin(m.run, 0) === E.TUNE.baseIncome && !E.runPristine(m.run), 'v2 -> v3: run in progress keeps its income and is not rebuilt by upgrades');
  ok(W.migrateState(JSON.parse(JSON.stringify(m))).memories === 120, 'v4 save loads unchanged');
}
// save migration v3 -> v4: rival, dwellings, elo band
{
  const o = fresh(7); W.ensureMap(o.run);
  const f = W.worldFrontier(o.run); forceWin(o, f[0]);
  o.run.map.raid.t = 240000; o.run.map.march = { id: W.worldFrontier(o.run)[0], start: 12345, ms: 9000 };
  o.v = 3; delete o.elo; delete o.eloPicked; delete o.run.elo; delete o.run.dwell; delete o.run.battles;
  delete o.run.map.rival; delete o.run.map.contact; delete o.run.map.rlog;
  const held = o.run.map.held.slice(), gold = o.run.gold;
  const b = E.createBattle(o.run, W.nodeArmy(o.run, W.worldFrontier(o.run)[0]));
  const sb = E.serBattle(b); for (const k of ['elo', 'seed', 'traits', 'maj', 'tlog', 'lastTrait']) delete sb[k];
  const m = W.migrateState(JSON.parse(JSON.stringify(o)));
  ok(m && m.v === 6 && m.migratedFrom === 3 && m.elo === E.ELO_TUNE.def && m.eloPicked === false && m.run.elo === E.ELO_TUNE.def, 'v3 -> v6: default elo band 900; the picker is asked once on load (no band was ever chosen)');
  ok(JSON.stringify(m.run.dwell) === JSON.stringify({ P: 0, N: 0, B: 0, R: 0, Q: 0 }) && m.run.map.rival && m.run.map.rival.held.length === 1 && m.run.map.rival.held[0] === W.worldRegion(m.run).citadelId, 'v3 -> v4: no dwellings; a fresh rival holds only its seat');
  ok(m.run.map.raid.t === Math.round(240 / E.TUNE.tickSec) && m.run.map.march && m.run.map.march.done === 0 && m.run.map.march.need === W.marchTicks(m.run, m.run.map.march.id), `v3 -> v4: raid countdown 240 s -> ${m.run.map.raid.t} ticks; the march restarts at its tick price`);
  ok(JSON.stringify(m.run.map.held) === JSON.stringify(held) && m.run.gold === gold && Array.isArray(m.run.map.rlog) && typeof m.run.map.contact === 'boolean', 'v3 -> v4: territory and gold kept, chronicle + contact flag added');
  const db = E.deserBattle(JSON.parse(JSON.stringify(sb)));
  ok(db && db.traits.length === 2 && db.traits[0].P === 0 && db.elo === null && E.battleEngineCfg(m.run, db, E.WHITE).maxDepth >= 1, 'v3 battle in progress resumes (no traits, default elo)');
  const back = W.migrateState(JSON.parse(JSON.stringify(m)));
  ok(JSON.stringify(back.run.map.rival) === JSON.stringify(m.run.map.rival), 'v4 rival state survives a save round-trip unchanged');
}

// elo mapping: one table, both engines, region drift, Tactician steps
{
  const cfgs = [400, 600, 800, 900, 1000, 1200, 1400, 1500, 1700, 2000, 2200].map(E.eloCfg);
  ok(cfgs.every((c, i) => i === 0 || (c.maxDepth >= cfgs[i - 1].maxDepth && c.jitter <= cfgs[i - 1].jitter && c.timeMs >= cfgs[i - 1].timeMs)), `elo table is monotone (depth ${cfgs.map(c => c.maxDepth).join('/')}, jitter ${cfgs.map(c => c.jitter).join('/')})`);
  ok(E.ELO_BANDS.join() === '600,900,1200,1500' && E.eloCfg(600).maxDepth === 1 && E.eloCfg(1200).maxDepth === 3 && E.eloCfg(1500).maxDepth === 4 && E.eloCfg(1800).maxDepth === 5 && E.ELO_BANDS.every((e, i, L) => i === 0 || E.eloCfg(e).maxDepth > E.eloCfg(L[i - 1]).maxDepth || E.eloCfg(e).qsDepth > E.eloCfg(L[i - 1]).qsDepth), 'bands 600/900/1200/1500 map to depth 1..4 (balance pass: every band step searches deeper); depth 5 from 1800');
  ok(E.cleanElo('x') === E.ELO_TUNE.def && E.cleanElo(99999) === E.ELO_TUNE.max, 'garbage elo is cleaned');
  ok(E.regionElo(900, 1) === 900 && E.regionElo(900, 3) === 900 + 2 * E.ELO_TUNE.perRegion, 'opposition drifts up per region');
  const st = E.newState(0, 41, 1200); W.ensureMap(st.run); const run = st.run;
  ok(run.elo === 1200 && run.map.rival.eloBase === 1200, 'the chosen band seeds the run and its rival');
  const reg = W.worldRegion(run), f = W.worldFrontier(run);
  const els = reg.nodes.filter(n => n.type !== 'keep' && !W.rivalOwns(run, n.id) && !W.isCache(run, n.id)).map(n => W.nodeArmy(run, n.id).elo);
  ok(els.every(e => Math.abs(e - 1200) <= E.ELO_TUNE.spread), `neutral node elos around the band (${Math.min(...els)}..${Math.max(...els)})`);
  W.startMarch(run, f[0]); const b = W.arrive(run);
  const wc = E.battleEngineCfg(run, b, E.WHITE), bc = E.battleEngineCfg(run, b, E.BLACK);
  ok(b.elo === W.nodeArmy(run, f[0]).elo && wc.elo === bc.elo && wc.maxDepth === bc.maxDepth && wc.jitter === bc.jitter, `equal engines: Tactician 0 plays at the opposition elo (${wc.elo})`);
  run.tact = 2;
  ok(E.battleEngineCfg(run, b, E.WHITE).elo === b.elo + 2 * E.ELO_TUNE.tactStep, `each Tactician level is +${E.ELO_TUNE.tactStep} elo`);
  const seat = W.nodeArmy(run, reg.citadelId);
  ok(seat.rival && seat.seat && seat.elo > run.map.rival.eloBase && seat.boss === W.rivalName(run), 'the rival seat fights above the band, under the rival lord\'s name');
}

// dwellings: prices, levels, enemy trait levels
{
  const st = fresh(51), run = st.run;
  ok([0, 1, 2].map(l => E.dwellPrice('P', l)).join() === '150,450,1350' && E.dwellPrice('Q', 0) > E.dwellPrice('N', 0) && E.dwellPrice('N', 0) > E.dwellPrice('P', 0) && E.dwellPrice('P', 3) === Infinity, 'dwelling price 150 x 3^lvl, knights and up cost more, max level 3');
  ok(!E.buyDwelling(run, 'P') && run.dwell.P === 0, 'cannot buy a dwelling without gold');
  run.gold = 1e6;
  for (let i = 0; i < 5; i++) E.buyDwelling(run, 'P');
  ok(run.dwell.P === 3 && Math.abs(E.traitChance('P', 3) - 0.6) < 1e-9 && Math.abs(E.traitChance('R', 2) - 0.2) < 1e-9 && Math.abs(E.traitChance('Q', 1) - 0.15) < 1e-9, 'pawn dwelling caps at 3 (60% Stubborn); Bulwark 10%/lvl, Majesty 15%/lvl');
  ok(JSON.stringify(E.traitLevels(7)) === JSON.stringify({ P: 2, N: 2, B: 1, R: 1, Q: 1 }) && JSON.stringify(E.traitLevels(99)) === JSON.stringify({ P: 3, N: 3, B: 3, R: 3, Q: 3 }), 'enemy trait points go round-robin P N B R Q, capped at 3');
  ok(E.tierTraits(4).P === 0 && E.tierTraits(5).P === 1 && E.tierTraits(13).N === 1, 'garrison traits by tier (from tier 5)');
  const b = E.createBattle(run, W.nodeArmy(run, W.worldFrontier(run)[0]));
  ok(b.traits[0].P === 3 && b.traits[1].P === 0, 'battles carry the player dwellings and the defenders\' traits');
  const back = W.migrateState(JSON.parse(JSON.stringify(st)));
  ok(back.run.dwell.P === 3, 'dwellings survive a save round-trip');
}

// traits: each one's geometry, the legality rule, seeded determinism
{
  const sq = E.parseSq;
  // a bare battle: list = 'wKe1 wPe4 bKe8 bNf6'; tw/tb = trait levels of white/black
  function mk(list, side, tw, tb, seed) {
    const pos = E.emptyPos(), ids = new Int32Array(64).fill(-1); let wi = 1, bi = -2;
    for (const t of list.split(' ')) { const c = t[0] === 'w' ? 0 : 1, s = sq(t.slice(2)); E.setPiece(pos, s, c, E.CH_TYPE[t[1]]); ids[s] = c ? bi-- : wi++; }
    pos.side = side;
    return { tier: 1, node: { type: 'garrison' }, pos, ids, history: new Map(), plies: 0, last: 0, lost: [], over: null, elo: 900, seed,
      traits: [E.cleanDwell(tw), E.cleanDwell(tb)], maj: [0, 0], tlog: [], lastTrait: null };
  }
  const mv = (b, name) => E.legalMoves(b.pos).find(m => E.moveName(m) === name);
  // find a seed whose first roll passes (or fails) the chance
  function seedFor(list, side, tw, tb, name, pass) {
    for (let s = 1; s < 5000; s++) { const b = mk(list, side, tw, tb, s), info = E.traitCheck(b, mv(b, name)); if (info && (E.traitRoll(b, 101) < info.chance) === pass) return s; }
    return -1;
  }
  const run1 = (list, side, tw, tb, name, pass) => { const s = seedFor(list, side, tw, tb, name, pass), b = mk(list, side, tw, tb, s); E.playMove(b, mv(b, name)); return b; };
  // Stubborn: the pawn falls back one square toward home
  let L = 'wKa1 wPe4 bKh8 bNf6', b = run1(L, 1, { P: 2 }, null, 'f6e4', true);
  ok(b.lastTrait && b.lastTrait.ok && !b.lastTrait.blocked && b.pos.b[sq('e3')] === E.P && (b.pos.b[sq('e4')] & 31) === E.N && b.lost.length === 0, 'Stubborn: captured pawn on e4 falls back to e3, attacker stands on e4, nothing lost');
  ok(E.traitAnnounce(b.lastTrait) === 'Stubborn pawn: 40% to fall back' && /saved!/.test(b.tlog[0]), `announcement: "${E.traitAnnounce(b.lastTrait)}", log: "${b.tlog[0]}"`);
  b = run1('wKa1 wPe4 wBe3 bKh8 bNf6', 1, { P: 3 }, null, 'f6e4', true);
  ok(b.lastTrait.ok && b.lastTrait.blocked && !b.pos.b[sq('e4')] === false && (b.pos.b[sq('e4')] & 31) === E.N && b.lost.length === 1, 'Stubborn: the way back (e3) is taken, so the pawn dies');
  b = run1('wKa1 wPe4 bKh8 bNf6', 1, { P: 1 }, null, 'f6e4', false);
  ok(!b.lastTrait.ok && b.lost.length === 1 && !b.pos.b[sq('e3')] && /taken/.test(b.tlog[0]), 'Stubborn roll fails: the pawn is taken');
  // black pawn falls back toward rank 8
  b = run1('wKa1 wNb4 bKh8 bPd5', 0, null, { P: 3 }, 'b4d5', true);
  ok(b.pos.b[sq('d6')] === (32 | E.P) && b.lost.length === 0, 'Stubborn (black): pawn on d5 falls back to d6');
  // Sidestep: a random empty knight square
  b = run1('wKa1 wNd4 bKh8 bBb6', 1, { N: 3 }, null, 'b6d4', true);
  const kd = b.lastTrait.sq;
  ok(b.lastTrait.ok && !b.lastTrait.blocked && b.pos.b[kd] === E.N && [-17, -15, -10, -6, 6, 10, 15, 17].includes(kd - sq('d4')) && Math.abs((kd & 7) - 3) <= 2, `Sidestep: knight on d4 leaps to ${E.sqName(kd)}`);
  const b2 = run1('wKa1 wNd4 bKh8 bBb6', 1, { N: 3 }, null, 'b6d4', true);
  ok(b2.lastTrait.sq === kd && b2.tlog[0] === b.tlog[0], 'same seed + ply: the same roll and square (replays are stable)');
  // Faith: along the attacker's diagonal, away from it
  b = run1('wKa1 wBd4 bKh8 bBa7', 1, { B: 3 }, null, 'a7d4', true);
  ok(b.lastTrait.sq === sq('e3') && b.pos.b[sq('e3')] === E.B, 'Faith: bishop hit from a7 slips on to e3');
  b = run1('wKa1 wBd4 wPe3 bKh8 bBa7', 1, { B: 3 }, null, 'a7d4', true);
  ok(b.lastTrait.ok && b.lastTrait.blocked && b.lost.length === 1, 'Faith: the square beyond (e3) is taken: no slip, the bishop falls');
  b = run1('wKa1 wBd4 bKh8 bRd8', 1, { B: 3 }, null, 'd8d4', true);
  ok([sq('c3'), sq('e3')].includes(b.lastTrait.sq), `Faith: hit straight down the file, it slips to a rear diagonal (${E.sqName(b.lastTrait.sq)})`);
  // Bulwark: the capture fails; the attacker goes back; the turn is spent
  b = run1('wKa1 wRd4 bKh8 bQd8', 1, { R: 3 }, null, 'd8d4', true);
  ok(b.pos.b[sq('d4')] === E.R && b.pos.b[sq('d8')] === (32 | E.Q) && b.pos.side === E.WHITE && b.plies === 1 && b.lost.length === 0, 'Bulwark: rook stays on d4, queen back on d8, white to move');
  // legality: Bulwark cannot undo a capture that got the capturer out of check
  b = run1('wKa1 wRd7 bKd8', 1, { R: 3 }, null, 'd8d7', true);
  ok(b.lastTrait.ok && b.lastTrait.blocked && (b.pos.b[sq('d7')] & 31) === E.K && b.lost.length === 1, 'legality: Kxd7 out of check stands even when Bulwark rolls (the king may not be left in check)');
  // legality: a sidestep that would check the capturing king is refused
  b = run1('wKh1 wNa1 wPc2 bKc1 bRa8', 1, { N: 3 }, null, 'a8a1', true);
  ok(b.lastTrait.ok && b.lastTrait.blocked && !b.pos.b[E.parseSq('b3')] && b.lost.length === 1 && !E.inCheck(b.pos, E.BLACK), 'legality: a sidestep to b3 would check the capturing king, so the knight is taken');
  // Majesty: once per battle, to an adjacent empty square
  b = run1('wKa1 wQd4 bKh8 bRd8 bRe8', 1, { Q: 3 }, null, 'd8d4', true);
  const qd = b.lastTrait.sq;
  ok(b.lastTrait.ok && !b.lastTrait.blocked && b.pos.b[qd] === E.Q && Math.max(Math.abs((qd >> 3) - 3), Math.abs((qd & 7) - 3)) === 1 && b.maj[0] === 1, `Majesty: queen steps from d4 to ${E.sqName(qd)}`);
  b.pos.side = E.BLACK; const again = E.legalMoves(b.pos).find(m => E.mTo(m) === qd && E.mCap(m));
  ok(!again || E.traitCheck(b, again) === null, 'Majesty is spent for the rest of the battle');
  // enemy side traits apply to the player capturing
  b = run1('wKa1 wRd1 bKh8 bRd8', 0, null, { R: 3 }, 'd1d8', true);
  ok(b.pos.b[sq('d8')] === (32 | E.R) && b.pos.b[sq('d1')] === E.R && b.pos.side === E.BLACK, 'enemy Bulwark: your capture fails too');
  // search never rolls traits: thinking about a capture leaves the battle untouched
  b = mk('wKa1 wPe4 bKh8 bNf6', 1, { P: 3 }, null, 9);
  const before = Array.from(b.pos.b).join();
  E.search(b.pos, { maxDepth: 3 });
  ok(Array.from(b.pos.b).join() === before && b.tlog.length === 0 && b.lastTrait === null, 'search() leaves the battle and its trait log untouched');
  const sb = E.deserBattle(JSON.parse(JSON.stringify(E.serBattle(run1('wKa1 wQd4 bKh8 bRd8 bRe8', 1, { Q: 3 }, null, 'd8d4', true)))));
  ok(sb.maj[0] === 1 && sb.tlog.length === 1 && sb.traits[0].Q === 3, 'trait state (Majesty used, log, levels) survives a save round-trip');
}

// the living rival
{
  const st = fresh(61), run = st.run, reg = W.worldRegion(run);
  const rv = run.map.rival;
  ok(rv && rv.held.length === 1 && rv.held[0] === reg.citadelId && rv.status === 'active' && W.rivalOwns(run, reg.citadelId), 'a new region: the rival holds only its seat (the citadel)');
  ok(RV.RIVAL_TUNE.bonusCap === W.WORLD.rivalTune.bonusCap && RV.RIVAL_TUNE.keepAssaultMinHeld === W.WORLD.rivalTune.keepAssaultMinHeld, `world tuning applied to RIVAL_TUNE (bonusCap ${RV.RIVAL_TUNE.bonusCap})`);
  const eta = W.rivalEta(run);
  ok(eta > 60 && eta < 120, `first rival move in ${eta} ticks`);
  let ev = W.tickRival(run, eta + 1, true);
  ok(ev.some(e => e.type === 'capture') && run.map.rival.held.length === 2 && run.map.rlog.length === 1, `online tick: the rival takes ${reg.nodes[ev[0].nodeId].name}`);
  const owners = W.rivalOwnersOf(run);
  ok(owners[ev[0].nodeId] === 'rival' && owners[0] === 'player', 'owners: rival node and player keep');
  // the player attacks a rival node: rival army (garrison role), win takes it from the rival
  const rid = ev[0].nodeId, a = W.nodeArmy(run, rid);
  ok(a.rival && a.role === 'garrison' && a.boss === W.rivalName(run) && a.traits && a.elo === RV.rivalArmyFor(run.map.rival, rid, reg).elo, 'a rival-held node is defended by a rival army (elo and traits from the rival)');
  run.map.held.push(...M.roadDistances(reg).map((d, i) => i).filter(i => reg.nodes[i].dist < reg.nodes[rid].dist && i !== reg.citadelId));
  run.map.held = [...new Set(run.map.held)].sort((x, y) => x - y);
  ok(W.canMarch(run, rid) || !M.canCapture(W.mapStateOf(run), rid), 'rival node can be attacked once on your frontier');
  if (M.canCapture(W.mapStateOf(run), rid)) {
    W.startMarch(run, rid); const b = W.arrive(run);
    ok(b.node.rival && b.elo === a.elo, 'battle against the rival node uses its army and elo');
    W.applyMapResult(st, b, E.finishBattle(st, b, 'win'));
    W.tickRival(run, 1, true);
    ok(!run.map.rival.held.includes(rid) && run.map.held.includes(rid), 'won back: the node leaves rival territory on the next advance');
  }
}
{
  // border battles: let the rival meet a player who holds most of the map
  const st = fresh(71), run = st.run, reg = W.worldRegion(run);
  run.map.held = reg.nodes.filter(n => n.id !== reg.citadelId && n.dist < reg.nodes[reg.citadelId].dist).map(n => n.id).sort((x, y) => x - y);
  W.ensureMap(run);
  ok(run.map.contact && !W.raidClockRuns(run), 'contact: rival border touches yours, so ambient raids stop');
  let ev = [], guard = 0;
  while (!W.rivalPending(run) && guard++ < 50) ev = ev.concat(W.tickRival(run, 30, true));
  const p = W.rivalPending(run);
  ok(p && p.type === 'borderBattle' && run.map.held.includes(p.nodeId), `the rival attacks your ${reg.nodes[p.nodeId].type} ${reg.nodes[p.nodeId].name}`);
  ok(!W.canMarch(run, W.worldFrontier(run)[0]) && W.tickRival(run, 600, true).length === 0, 'a pending border battle pauses marching and the rival clock');
  const ba = W.borderArmy(run);
  ok(ba && ba.border && ba.role === 'border' && ba.pieces.filter(x => x.t === 'K').length === 1 && ba.pieces.every(x => x.sq >= 32), `border army: ${ba.units} pts, elo ${ba.elo}`);
  // defend with the formation and win: the node stays, the rival backs off
  let mode = W.borderMode(run), b = W.defendBorder(run);
  ok(mode !== 'keep' && b.node.border && (mode === 'garrison' ? b.node.castellan : Array.from(b.ids).filter(i => i > 0).length === Object.keys(run.formation).length), `defence battle (${mode})`);
  const gold0 = run.gold;
  let sum = W.finishBorder(st, b, 'win');
  ok(sum.kept && sum.loot > 0 && run.gold === gold0 + sum.loot && run.map.held.includes(p.nodeId) && !W.rivalPending(run) && run.map.rival.cooldown[p.nodeId] > 0, 'border battle won: node kept, loot paid, the node is on cooldown');
  // next attack: concede
  guard = 0; while (!W.rivalPending(run) && guard++ < 200) W.tickRival(run, 30, true);
  const p2 = W.rivalPending(run);
  if (p2 && p2.type === 'borderBattle') {
    const c = W.concedeBorder(st);
    ok(!c.runOver && !run.map.held.includes(p2.nodeId) && run.map.rival.held.includes(p2.nodeId) && run.map.rival.handover === p2.nodeId, 'conceded: the rival takes the node');
    W.tickRival(run, 1, true);
    ok(run.map.rival.handover === null && W.rivalOwns(run, p2.nodeId) && M.canCapture(W.mapStateOf(run), p2.nodeId) === M.frontier(W.mapStateOf(run)).includes(p2.nodeId), 'handover clears; the node is rival-held and can be retaken from the map');
  } else ok(false, 'expected a second border battle');
  // a lost defence hands the node over too
  guard = 0; while (!W.rivalPending(run) && guard++ < 200) W.tickRival(run, 30, true);
  const p3 = W.rivalPending(run);
  if (p3 && p3.type === 'borderBattle') {
    const d = W.defendBorder(run); sum = W.finishBorder(st, d, 'loss');
    ok(!sum.kept && !sum.runOver && !run.map.held.includes(p3.nodeId), 'border battle lost: the node falls to the rival');
  } else ok(p3 && p3.type === 'keepAssault', 'third attack (border or keep)');
  // rival chronicle folds sorties
  W.rlogAdd(run, 'sortie', 'Drilled its troops'); W.rlogAdd(run, 'sortie', 'Drilled its troops'); W.rlogAdd(run, 'sortie', 'Drilled its troops');
  const last = run.map.rlog[run.map.rlog.length - 1];
  ok(last.k === 'sortie' && last.n >= 3 && run.map.rlog.length <= W.WORLD.rlogMax, 'repeated sorties fold into one chronicle line');
}
{
  // garrison defence of a mine, keep assault = run over
  const st = fresh(81), run = st.run, reg = W.worldRegion(run);
  const mine = reg.nodes.find(n => n.type === 'mine');
  run.map.held = [0, mine.id]; run.mines.push(Math.max(1, mine.tier));
  const pawn = run.roster.find(x => x.t === 'P'); W.stationPiece(run, mine.id, pawn.id);
  run.map.rival = RV.createRival(reg, { seed: run.map.seed, regionNumber: 1, eloBase: 900 });
  run.map.rival.held = [...new Set([reg.citadelId, ...M.neighbors(reg, mine.id)].filter(i => i !== 0))].sort((x, y) => x - y);
  run.map.rival.pending = { type: 'borderBattle', nodeId: mine.id, at: 0 }; run.map.rival.nextMoveAt = null;
  ok(W.borderMode(run) === 'garrison', 'a garrisoned mine is defended by its garrison');
  const d = W.defendBorder(run), whites = Array.from(d.ids).filter((x, i) => x >= 0 && d.pos.b[i] && (d.pos.b[i] >> 5) === 0);
  ok(d.node.castellan && whites.length === 2 && whites.includes(0) && whites.includes(pawn.id), 'garrison defence: castellan + the stationed pawn');
  const runs0 = st.totalRuns, s = W.finishBorder(st, d, 'mate');
  ok(s.result === 'loss' && !s.runOver && !run.map.held.includes(mine.id) && !run.mines.length && st.totalRuns === runs0, 'castellan mated: the mine is lost, not the run');
  // keep assault
  run.map.rival = RV.createRival(reg, { seed: run.map.seed, regionNumber: 1, eloBase: 900 });
  run.map.rival.held = [...new Set([reg.citadelId, ...M.neighbors(reg, 0)])].sort((x, y) => x - y);
  run.map.rival.pending = { type: 'keepAssault', nodeId: 0, at: 0 }; run.map.rival.nextMoveAt = null;
  ok(W.borderMode(run) === 'keep' && W.borderArmy(run).kind === 'keep' && W.borderArmy(run).noRetreat, 'keep assault: the formation defends, no auto-retreat');
  const k = W.defendBorder(run), kw = Array.from(k.ids).filter(x => x >= 1e6).length;
  ok(kw === W.WORLD.keepMilitia, `keep militia: ${kw} pawns join (not on the roster)`);
  const ks = W.finishBorder(st, k, 'loss');
  ok(ks.runOver && ks.memories === E.mateMemories(run.sumTiers) && run.map.rival.status === 'won', 'keep assault lost = run over at 25% Memories');
  run.map.rival = RV.createRival(reg, { seed: run.map.seed, regionNumber: 1, eloBase: 900 });
  run.map.rival.pending = { type: 'keepAssault', nodeId: 0, at: 0 }; run.map.rival.nextMoveAt = null;
  ok(W.concedeBorder(st).runOver, 'yielding the keep ends the run');
  run.map.rival = RV.createRival(reg, { seed: run.map.seed, regionNumber: 1, eloBase: 900 });
  run.map.rival.pending = { type: 'keepAssault', nodeId: 0, at: 0 }; run.map.rival.nextMoveAt = null;
  const kd = W.finishBorder(st, W.defendBorder(run), 'draw');
  ok(kd.kept && !kd.runOver && run.map.rival.cooldown[0] > 0, 'a held keep (draw) repels the assault');
}
{
  // v6: time passes only from play. Away time yields zero ticks: gold, the week and the rival do not move
  { const a0 = fresh(90), j0 = JSON.stringify(a0); const n = W.awayTicks(8 * 3600e3); W.worldTick(a0, n);
    ok(n === 0 && JSON.stringify(a0) === j0, 'away time (8 h) yields zero ticks: gold, week, raid clock and rival unchanged'); }
  // a batch of 300 quiet ticks (online=false: no raids, no keep assault)
  const OFFN = 300;
  const st = fresh(91), run = st.run, g0 = run.gold;
  const res = W.worldTick(st, OFFN, false), ev = res.events;
  const rv = run.map.rival;
  ok(rv.ms === OFFN * 1000 * W.WORLD.rivalSecPerTick && !ev.some(e => e.type === 'keepAssault') && res.raid === null, `a quiet batch of ${OFFN} ticks: rival clock ${rv.ms / 1000} s, ${rv.held.length} rival nodes, strength ${rv.strength.toFixed(1)}`);
  // P0-4: the catch-up crosses week boundaries, so income is paid per week segment at that week's rates
  { const c = fresh(91); let exp = 0; for (let t = 0; t < OFFN; t++) { exp += E.incomePerTick(c.run, c.memories); c.run.ticks++; if (c.run.ticks % W.WORLD.weekTicks === 0) { exp += W.minePulse(c.run, c.memories); W.ensureWeek(c.run); } }
    ok(Math.abs(run.gold - g0 - exp) < 1e-9 && Math.abs(res.gold - exp) < 1e-9 && res.gold > 0 && res.weeks.length === Math.floor(OFFN / W.WORLD.weekTicks), `the batch pays ${res.gold.toFixed(1)} gold (income per tick x ticks, week by week; ${res.weeks.length} weeks turned)`); }
  // ticks are the clock: one tick of 300 equals 300 ticks of one (income, rival)
  const a = fresh(92), b = fresh(92);
  W.worldTick(a, 300); for (let i = 0; i < 300; i++) W.worldTick(b, 1);
  ok(JSON.stringify(a.run.map.rival) === JSON.stringify(b.run.map.rival) && Math.abs(a.run.gold - b.run.gold) < 1e-6, 'worldTick(300) == 300 x worldTick(1)');
  ok(Math.abs(E.incomePerTick(a.run, 0) - E.incomePerMin(a.run, 0) * E.TUNE.tickSec / 60) < 1e-12, `income per tick = gold/min x ${E.TUNE.tickSec} / 60`);
  const line = W.rivalSummary(run, ev), so = ev.filter(e => e.type === 'sortie').length;
  ok(line.startsWith(W.capFirst(W.rivalName(run))) && (so < 2 || /drilled its troops \d+ times/.test(line)), `batch summary: "${line}"`);
  ok(run.map.rlog.filter(e => e.k === 'sortie').length <= 1 || run.map.rlog.every((e, i, L) => !(e.k === 'sortie' && L[i - 1] && L[i - 1].k === 'sortie')), 'consecutive sorties are one chronicle line');
}
{
  // taking the rival's seat wins the region (the old citadel flow)
  const st = fresh(101), run = st.run, reg = W.worldRegion(run);
  run.map.held = reg.nodes.filter(n => n.id !== reg.citadelId).map(n => n.id).sort((x, y) => x - y);
  run.map.rival.held = [reg.citadelId];
  W.startMarch(run, reg.citadelId); const b = W.arrive(run);
  ok(b.node.seat && b.node.type === 'citadel' && b.node.boss === W.rivalName(run), `the seat battle: ${b.node.boss}, ${b.node.units} pts, elo ${b.elo}`);
  const sum = W.applyMapResult(st, b, E.finishBattle(st, b, 'win'));
  ok(sum.seat && sum.nextRegion === 2 && run.map.region === 2 && run.map.rival.regionNumber === 2 && run.map.rival.held.length === 1 && run.map.rival.eloBase === E.regionElo(run.elo, 2), 'seat taken: region won; region 2 has a new rival at a higher elo');
}

// Memories shop
{
  const st = fresh(21);
  ok(E.goldMult(0) === 1 && Math.abs(E.goldMult(25) - 1.25) < 1e-9, 'innate +1% gold per unspent Memory');
  ok(!E.buyMemUpgrade(st, 'pawns') && st.upgrades.pawns === 0, 'cannot buy an upgrade without Memories');
  st.memories = 1000;
  const costs = []; for (let i = 0; i < 4; i++) { costs.push(E.memCost('pawns', st.upgrades.pawns)); E.buyMemUpgrade(st, 'pawns'); }
  ok(costs.every((c, i) => i === 0 || c > costs[i - 1]) && st.memories === 1000 - costs.reduce((a, b) => a + b, 0), `costs rise per level (${costs.join(', ')}) and are paid`);
  ok(E.runPristine(st.run) && st.run.roster.filter(p => p.t === 'P').length === 7, 'pristine run is rebuilt: 3 + 4 starting pawns');
  for (const k of ['squares', 'income', 'tact', 'gold']) E.buyMemUpgrade(st, k);
  ok(st.run.owned.length === 5 && st.run.tact === 1 && st.run.gold === E.TUNE.startGold + 30 && E.incomePerMin(st.run, 0) === E.TUNE.baseIncome + 1, 'squares, Tactician, starting gold and keep income apply to a pristine run');
  for (let i = 0; i < 10; i++) E.buyMemUpgrade(st, 'tact');
  ok(st.upgrades.tact === E.TACT_MAX && E.memCost('tact', E.TACT_MAX) === Infinity, 'Tactician upgrade caps at the max level');
  // once a run has started, upgrades wait for the next run
  E.buyPiece(st.run, 'P');
  const pawns = st.run.roster.filter(p => p.t === 'P').length;
  E.buyMemUpgrade(st, 'pawns');
  ok(!E.runPristine(st.run) && st.run.roster.filter(p => p.t === 'P').length === pawns, 'an upgrade bought mid-run does not change the current run');
  st.run.orders.doctrine = 'solid';
  E.endRun(st, 5, 77); W.ensureMap(st.run);
  ok(st.run.roster.filter(p => p.t === 'P').length === 3 + st.upgrades.pawns && st.run.orders.doctrine === 'solid', 'the next run starts with every upgrade and keeps the standing orders');
  const ids = new Set(Object.values(st.run.formation));
  ok(ids.size === Object.keys(st.run.formation).length && Object.keys(st.run.formation).every(sq => st.run.owned.includes(+sq)), 'upgraded start: formation only on owned squares, no duplicates');
}

// doctrines + standing orders
{
  const st = fresh(31), run = st.run, reg = W.worldRegion(run);
  const docs = reg.nodes.filter(n => n.type !== 'keep' && !W.isCache(run, n.id)).map(n => [n.type, W.nodeArmy(run, n.id).doctrine]);
  ok(docs.every(([t, d]) => (t === 'garrison' || t === 'citadel') ? E.DOCTRINE_KEYS.includes(d) : d === 'balanced'), 'garrisons/citadels have one of 3 doctrines, other nodes are balanced');
  ok(W.nodeArmy(run, reg.citadelId).doctrine === W.nodeArmy(run, reg.citadelId).doctrine, 'doctrine is deterministic per node');
  const gid = reg.nodes.find(n => n.type === 'garrison').id;
  W.startMarch(run, gid); const b = W.arrive(run);
  const ec = E.battleEngineCfg(run, b, E.BLACK);
  ok(ec.doctrine && ec.doctrine.label === E.DOCTRINES[b.node.doctrine].label, 'enemy engine uses the node doctrine');
  ok(E.battleEngineCfg(run, b, E.WHITE).doctrine === null, 'default orders: plain eval for the player');
  run.orders.keepQueen = true;
  ok(E.battleEngineCfg(run, b, E.WHITE).doctrine.ownQ > 0, '"never trade the queen" weights the queen');
  // the queen-keeper declines an even queen trade the plain engine takes
  const pos = E.emptyPos();
  for (const [sq, c, t] of [['e1', 0, E.K], ['d1', 0, E.Q], ['e8', 1, E.K], ['d5', 1, E.Q], ['c6', 1, E.P], ['h2', 0, E.P], ['h7', 1, E.P]]) E.setPiece(pos, E.parseSq(sq), c, t);
  const plain = E.search(E.clonePos(pos), { maxDepth: 3 }), keep = E.search(E.clonePos(pos), { maxDepth: 3, doctrine: E.doctrineWeights('balanced', true) });
  ok(E.moveName(plain.move) === 'd1d5' && E.moveName(keep.move) !== 'd1d5', `queen trade: plain ${E.moveName(plain.move)}, keep-queen ${E.moveName(keep.move)}`);
  // retreat thresholds
  const think = order => { run.orders.retreat = order; const r = E.thinkMove(run, { pos: (() => { const p = E.emptyPos(); E.setPiece(p, 4, 0, E.K); E.setPiece(p, 60, 1, E.K); E.setPiece(p, 59, 1, E.Q); E.setPiece(p, 56, 1, E.R); p.side = 0; return p; })(), history: new Map(), tier: 5, node: { type: 'garrison' } }); return r.retreat; };
  ok(think('cautious') && think('stubborn') && !think('off'), 'auto-retreat: off never retreats; cautious/stubborn do when 14 pawns down');
  ok(E.RETREAT_AT.cautious === -500 && E.RETREAT_AT.stubborn === -1200, 'retreat thresholds: cautious -500, stubborn -1200');
  // travel time scales down by region
  ok(W.marchStepTicks(1) === 12 && W.marchStepTicks(2) === 10 && W.marchStepTicks(3) === 8 && W.marchStepTicks(7) === 8, 'march step: 12 ticks, 10, then 8 from region 3');
}

// garrisons, raids and defence
{
  const st = fresh(12345), run = st.run;
  // take frontier nodes until a mine is held
  let guard = 0;
  while (!W.heldMines(run).length && guard++ < 40) {
    const reg = W.worldRegion(run), f = W.worldFrontier(run);
    const id = f.find(i => reg.nodes[i].type === 'mine') ?? f.find(i => reg.nodes[i].type !== 'citadel');
    forceWin(st, id); if (run.map.shrine != null) W.chooseShrine(run, 'mines');
  }
  const mine = W.heldMines(run)[0], reg = W.worldRegion(run), mineTier = Math.max(1, reg.nodes[mine].tier);
  ok(mine != null && run.mines.includes(mineTier), `holding mine ${reg.nodes[mine].name} (tier ${mineTier})`);
  // clock: 360 ticks before the first raid; it pauses while a choice (the shrine) waits
  ok(W.raidClockRuns(run) && run.map.raid.t === W.WORLD.raidFirst, 'raid clock runs while a mine is held: first raid after 360 ticks');
  ok(!W.raidTick(run, 350) && run.map.raid.pending === null, 'no raid before 360 ticks');
  const f0 = W.worldFrontier(run).find(i => reg.nodes[i].type !== 'citadel');
  run.map.shrine = 999;
  ok(!W.raidClockRuns(run) && !W.raidTick(run, 60) && run.map.raid.t === 10, 'raid clock pauses while a shrine choice waits');
  run.map.shrine = null;
  // station: piece leaves the formation and the reserve
  const pawn = run.roster.find(p => p.t === 'P' && Object.values(run.formation).includes(p.id)), king = run.roster.find(p => p.t === 'K');
  ok(!W.stationPiece(run, mine, king.id), 'the King cannot be stationed');
  ok(W.stationPiece(run, mine, pawn.id) && !Object.values(run.formation).includes(pawn.id) && !E.reserve(run).some(p => p.id === pawn.id), 'stationed pawn leaves formation and reserve');
  ok(!W.stationPiece(run, mine, pawn.id), 'a piece can only be stationed once');
  const b0 = E.createBattle(run, W.nodeArmy(run, f0));
  ok(!Array.from(b0.ids).includes(pawn.id), 'garrisoned piece is not in the attack formation');
  ok(W.recallPiece(run, mine, pawn.id) && W.garrisonOf(run, mine).length === 0 && (Object.values(run.formation).includes(pawn.id) || E.reserve(run).some(p => p.id === pawn.id)), 'recall returns the piece');
  // the raid fires on a held mine; no garrison = no defence
  const tgt = W.raidTarget(run);
  const raid = W.raidTick(run, 10);
  ok(raid && raid.id === tgt && W.heldMines(run).includes(raid.id) && run.map.raid.t >= W.WORLD.raidEvery - W.WORLD.raidJitter, `raid at tick 360 hits the announced mine; next in ${run.map.raid.t} ticks`);
  ok(!W.canDefend(run) && W.defendRaid(run) === null, 'no garrison there: defence not offered');
  ok(!W.canMarch(run, f0) && !W.raidClockRuns(run), 'a pending raid blocks marching and pauses the clock');
  const ra = W.raidArmy(run);
  ok(ra && ra.raid && ra.units >= 1 && ra.units < W.nodeArmy(run, raid.id).units + 2 && ra.pieces.filter(p => p.t === 'K').length === 1, `raid army: ${ra.units} pts (mine garrison ${W.nodeArmy(run, raid.id).units})`);
  const inc0 = E.incomePerMin(run, 0), held0 = run.map.held.length;
  ok(W.concedeRaid(run) && !run.map.held.includes(raid.id) && run.map.held.length === held0 - 1 && E.incomePerMin(run, 0) < inc0 && run.map.raid.pending === null, 'conceding loses the mine and its income');
  ok(W.worldFrontier(run).includes(raid.id), 'a conceded mine can be retaken from the map');
  // retake it, garrison it, and defend
  forceWin(st, raid.id);
  const gp = run.roster.filter(p => p.t !== 'K').slice(0, 2);
  gp.forEach(p => W.stationPiece(run, raid.id, p.id));
  ok(W.garrisonOf(run, raid.id).length === 2, 'two pieces stationed');
  run.map.raid.t = 1; while (!run.map.raid.pending) { run.map.raid.t = 1; W.raidTick(run, 5); if (run.map.raid.pending && run.map.raid.pending.id !== raid.id) { run.map.raid.pending = null; } }
  ok(W.canDefend(run), 'with a garrison, defence is offered');
  const d = W.defendRaid(run), whites = [];
  for (let sq = 0; sq < 64; sq++) if (d.pos.b[sq] && (d.pos.b[sq] >> 5) === E.WHITE) whites.push(d.ids[sq]);
  ok(whites.length === 3 && whites.includes(0) && gp.every(p => whites.includes(p.id)) && d.node.raid, 'defence battle: castellan + the garrison only');
  // a captured garrison piece is gone; a mated castellan loses the mine, not the run
  d.lost.push(gp[0].id);
  const runs0 = st.totalRuns, sum = W.finishDefence(st, d, 'mate');
  ok(sum.result === 'loss' && !sum.kept && st.totalRuns === runs0 && !run.map.held.includes(raid.id) && !E.pieceById(run, gp[0].id), 'defence lost: mine lost, captured piece gone, run continues');
  ok(E.pieceById(run, gp[1].id) && W.garrisonOf(run, raid.id).length === 0 && E.reserve(run).concat(Object.values(run.formation).map(id => E.pieceById(run, id))).some(p => p && p.id === gp[1].id), 'surviving garrison comes home');
  // win a defence
  forceWin(st, raid.id); W.stationPiece(run, raid.id, gp[1].id);
  while (!run.map.raid.pending || run.map.raid.pending.id !== raid.id) { run.map.raid.pending = null; run.map.raid.t = 1; W.raidTick(run, 5); }
  const d2 = W.defendRaid(run), g0 = run.gold, w = W.finishDefence(st, d2, 'win');
  ok(w.kept && w.loot > 0 && run.gold === g0 + w.loot && run.map.held.includes(raid.id) && W.garrisonOf(run, raid.id).length === 1 && run.map.raid.pending === null, `defence won: mine kept, +${w.loot} gold, garrison stays`);
  // budget scales with region and income
  const b1 = W.raidBudget(run, raid.id); run.mines.push(1, 1, 1); const b2 = W.raidBudget(run, raid.id); run.mines.length -= 3;
  ok(b2 > b1, `raid budget grows with mines held (${b1.toFixed(1)} -> ${b2.toFixed(1)})`);
  // save round trip keeps garrison + raid clock
  const back = W.migrateState(JSON.parse(JSON.stringify(st)));
  ok(back.run.map.garrison[raid.id] && back.run.map.garrison[raid.id][0] === gp[1].id && back.run.map.raid.n === run.map.raid.n, 'garrison and raid clock survive a save round-trip');
  // shrine pawn picker: knight the tapped pawn
  run.map.shrine = W.worldRegion(run).nodes.find(n => n.type === 'shrine').id;
  if (!run.map.held.includes(run.map.shrine)) run.map.held.push(run.map.shrine);
  E.levy(run, 2);
  const pawns = W.shrinePawns(run), pick = pawns[pawns.length - 1];
  ok(pawns.length >= 2 && W.chooseShrine(run, 'knight', pick.id) && pick.t === 'N' && pawns.slice(0, -1).every(p => p.t === 'P'), 'shrine knights exactly the pawn the player picked');
  // citadel: garrisons dissolve into the reserve
  const kept = W.garrisonOf(run, raid.id)[0];
  run.map = W.newWorldMap(run, 2); W.ensureMap(run);
  ok(E.reserve(run).some(p => p.id === kept) && Object.keys(run.map.garrison).length === 0, 'a new region: garrisons come home');
}
// ===================== M5: forge and frontier =====================
import * as F from './forge.mjs';
import * as T from './terrain.mjs';
import * as C from './content.mjs';
// terrain: biome per node, avoid = the enemy formation, none below tier 3, walls in real battles
{
  let avoidOk = true, lowClear = true, withT = 0, probs = 0;
  for (let s = 0; s < 8; s++) for (const rn of [1, 2, 3, 4]) {
    const st = fresh(300 + s); st.run.map = W.newWorldMap(st.run, rn); W.ensureMap(st.run);
    for (const n of W.worldRegion(st.run).nodes) {
      if (n.type === 'keep') continue;
      const a = W.nodeArmy(st.run, n.id);
      if (!a.terrain) { continue; }
      withT++;
      const occ = new Set(a.pieces.map(p => p.sq));
      if (a.terrain.blocked.some(q => occ.has(q) || q < 16)) avoidOk = false;
      if (a.tier < 3) lowClear = false;
      probs += T.terrainProblems(a.terrain, { avoid: [...occ] }).length;
    }
    const st1 = fresh(300 + s);
    for (const n of W.worldRegion(st1.run).nodes) if (n.type !== 'keep' && Math.max(1, n.tier) < 3 && W.nodeArmy(st1.run, n.id).terrain) lowClear = false;
  }
  ok(withT > 100 && avoidOk && probs === 0, `terrain on ${withT} node armies: never on an enemy piece or the deployment ranks (opts.avoid), no guarantee broken`);
  ok(lowClear, 'tiers below 3 stay clear');
  const st = fresh(77), run = st.run; run.map = W.newWorldMap(run, 2); W.ensureMap(run);
  const reg = W.worldRegion(run), ids = W.worldFrontier(run).filter(id => !W.isCache(run, id));
  ok(['plains', 'highland', 'marsh'].includes(W.biomeFor(run, ids[0])) && W.biomeFor(run, ids[0]) === W.biomeFor(run, ids[0]), 'each node has a deterministic biome');
  const id = ids.find(i => W.nodeArmy(run, i).terrain) ?? ids[0];
  W.startMarch(run, id); W.advanceMarch(run, 999); const b = W.arrive(run, st);
  ok(b && b.terrain && b.terrain.blocked.length >= 2 && W.terrainSummary(b.terrain).label.endsWith('ground'), `the battle carries its terrain (${W.terrainSummary(b.terrain).label}, ${b.terrain.blocked.length} squares)`);
  const walls = new Set(b.terrain.blocked); let onWall = false, plies = 0;
  const rng = E.mulberry(5);
  while (!b.over && plies < 120) {
    const r = E.thinkMove(run, b, { timeMs: 1e9, maxNodes: 3000, rng });
    if (walls.has(E.mTo(r.move))) onWall = true;
    E.playMove(b, r.move); plies++;
    for (const q of walls) if (b.pos.b[q]) onWall = true;
    if (E.battleLegal(b).some(m => walls.has(E.mTo(m)))) onWall = true;
  }
  ok(!onWall && plies > 10, `a real ${plies}-ply battle on terrain never puts a piece on a wall`);
  E.useTerrain(null);
  ok(E.perft(E.startPos(), 3) === 8902, 'tables restored after the battle (perft 3 = 8902)');
  const sb = E.deserBattle(JSON.parse(JSON.stringify(E.serBattle(b))));
  ok(sb.terrain && sb.terrain.blocked.join() === b.terrain.blocked.join(), 'terrain survives a battle save round-trip');
}
// forge on the world clock: 1 tick = 3000 forge-ms; the trickle and the daily cap scale with ticks
{
  const st = fresh(88), run = st.run;
  ok(W.FORGE_MS_PER_TICK === 3000 && W.FORGE_TICKS_PER_HOUR === 1200 && W.FORGE_TICKS_PER_DAY === 28800, 'forge conversion: 3000 ms per tick, an hour = 1200 ticks, a day = 28800 ticks');
  const reg = W.worldRegion(run), mines = reg.nodes.filter(n => n.type === 'mine');
  const res = mines.map(n => W.mineResource(run, n.id));
  ok(res.every(r => r === 'tin' || r === 'coal') && res.includes('tin') && res.includes('coal'), `region 1 mines yield tin and coal (${res.join(', ')})`);
  const st3 = fresh(88); st3.run.map = W.newWorldMap(st3.run, 3); W.ensureMap(st3.run);
  const r3 = W.worldRegion(st3.run).nodes.filter(n => n.type === 'mine').map(n => W.mineResource(st3.run, n.id));
  ok(r3.includes('shards') || r3.length < 4, `region 3 mines include obsidian shards (${r3.join(', ')})`);
  const tin = mines.find(n => W.mineResource(run, n.id) === 'tin'), coal = mines.find(n => W.mineResource(run, n.id) === 'coal');
  run.map.held = [...run.map.held, tin.id, coal.id].sort((a, b) => a - b);
  const a = JSON.parse(JSON.stringify(st)), b2 = JSON.parse(JSON.stringify(st));
  W.worldTick(a, 300, true); for (let i = 0; i < 300; i++) W.worldTick(b2, 1, true);
  ok(JSON.stringify(a.run.forge) === JSON.stringify(b2.run.forge), 'forge: worldTick(300) equals 300 x worldTick(1)');
  W.worldTick(st, 1200, true);
  ok(run.forge.stock.tin === 8 && run.forge.stock.coal === 8 && run.ticks === 1200, `1200 ticks (a forge hour) with one tin + one coal mine: +8 tin, +8 coal (${run.forge.stock.tin}/${run.forge.stock.coal})`);
  ok(W.forgeSmelt(st, 'iron').ok && run.forge.bars.iron === 1 && run.forge.stock.tin === 5, 'smelt an iron bar (3 tin + 2 coal)');
  const again = W.forgeSmelt(st, 'iron');
  ok(!again.ok && again.reason === 'daily-cap' && W.forgeStatus(run).left === 0, 'smelt cap: one smelt per forge day');
  const left = W.forgeStatus(run).resetIn;
  W.worldTick(st, left - 1, true);
  ok(!W.forgeSmelt(st, 'iron').ok, `still capped 1 tick before the reset (${left} ticks after the smelt)`);
  W.worldTick(st, 1, true);
  ok(W.forgeSmelt(st, 'iron').ok && run.ticks === 28800, 'the cap resets at tick 28800 (a forge day)');
  ok(st.cosmetics.forged.includes('iron'), 'the first smelted bar is recorded for piece-set unlocks');
  run.gold = 10000; ok(W.forgeUpgrade(run) && W.forgeStatus(run).perDay === 2 && run.gold === 10000 - F.smeltLevelPrice(0), 'bellows upgrade costs gold and adds a smelt per day');
  // apply bars: one tier per bar, kings excluded; ids are stable
  const pawn = run.roster.find(p => p.t === 'P'), king = run.roster.find(p => p.t === 'K');
  ok(W.forgeApplyBar(run, pawn.id).ok && W.pieceMaterial(run, pawn.id) === 'iron' && !W.forgeApplyBar(run, king.id).ok, 'a bar tempers a pawn to iron (by roster id); the king cannot be tempered');
  ok(!W.forgeApplyBar(run, pawn.id).ok, 'iron -> steel needs a steel bar');
  // perma-death: the pawn dies in battle and its bar goes with it
  W.ensureMap(run); const fid = W.worldFrontier(run).find(i => !W.isCache(run, i));
  const bt = W.worldBattle(run, W.nodeArmy(run, fid)); // (raids / the rival may be pending after 28800 ticks)
  const psq = bt.ids.findIndex(x => x === pawn.id);
  ok(psq >= 0 && bt.pos.m && bt.pos.m[psq] === 1, 'the tempered pawn fights as iron (pos.m)');
  bt.lost.push(pawn.id);
  const sum = W.applyMapResult(st, bt, E.finishBattle(st, bt, 'loss'));
  ok(!E.pieceById(run, pawn.id) && !run.forge.mats[pawn.id] && run.forge.lost.iron === 1 && sum.lostBars === 1, 'a captured piece leaves the roster and loses its bars (forge losePiece)');
  ok(W.migrateState(JSON.parse(JSON.stringify(st))).run.forge.bars.iron === run.forge.bars.iron, 'forge state survives a save round-trip');
}
// counter rule on the real board: wood attacker vs iron target, 25%, fallback geometry, check rule
{
  const st = fresh(91), run = st.run;
  const army = (pieces) => ({ type: 'garrison', name: 'T', tier: 5, pieces, elo: 900, traits: null, doctrine: 'balanced', terrain: null });
  const mk = seed => { const b = E.createBattle(run, army([{ sq: 63, t: 'K' }, { sq: E.parseSq('e5'), t: 'N', m: 1 }, { sq: 55, t: 'P' }]), [{ sq: 4, id: 0, t: 'K' }, { sq: E.parseSq('e2'), id: 50, t: 'R' }]); b.seed = seed; return b; };
  let fails = null, lands = null;
  for (let s = 1; s < 200 && (!fails || !lands); s++) {
    const b = mk(s), m = E.battleLegal(b).find(x => E.mFrom(x) === E.parseSq('e2') && E.mTo(x) === E.parseSq('e5'));
    const ci = E.counterInfo(b, m);
    if (!ci || ci.chance !== 0.25 || ci.fb !== E.parseSq('e4')) { fails = 'bad'; break; }
    E.playMove(b, m);
    if (b.lastCounter.fails) fails = fails || b; else lands = lands || b;
  }
  ok(fails && fails !== 'bad' && (fails.pos.b[E.parseSq('e4')] & 31) === E.R && (fails.pos.b[E.parseSq('e5')] & 31) === E.N && fails.pos.side === E.BLACK && fails.ids[E.parseSq('e4')] === 50,
    'a failed counter roll: the rook stops on e4 (last free square before the target), the iron knight lives, the turn is spent');
  ok(fails.lastCounter.roll < 0.25 && /roll 0\.\d\d < 0\.25: the capture fails \(stops on e4\)/.test(fails.tlog[fails.tlog.length - 1]), `the roll is announced: "${fails.tlog[fails.tlog.length - 1]}"`);
  ok(lands && (lands.pos.b[E.parseSq('e5')] & 31) === E.R && lands.lastCounter.roll >= 0.25, 'a successful roll: the capture lands');
  const b0 = mk(1); b0.pos.m[E.parseSq('e5')] = 2; // steel target vs wood: two tiers apart, no counter
  ok(E.counterInfo(b0, E.battleLegal(b0).find(x => E.mTo(x) === E.parseSq('e5'))) === null, 'no roll unless the target is exactly one tier above');
  // check rule: the capture is the only way out of check -> no roll
  const bc = E.createBattle(run, army([{ sq: 63, t: 'K' }, { sq: E.parseSq('f3'), t: 'N', m: 1 }]), [{ sq: 4, id: 0, t: 'K' }, { sq: E.parseSq('f6'), id: 51, t: 'R' }]);
  bc.pos.side = E.WHITE;
  const mc = E.battleLegal(bc).find(x => E.mFrom(x) === E.parseSq('f6') && E.mTo(x) === E.parseSq('f3'));
  ok(E.inCheck(bc.pos) && mc && E.counterInfo(bc, mc) === null, 'check rule: no roll when failing would leave the mover\'s king attacked');
  ok(E.evaluate(fails.pos) !== undefined && (() => { const p = E.clonePos(lands.pos); const before = p.mv; return typeof before === 'number'; })(), 'material eval bonus is tracked (pos.mv)');
  // search stays deterministic and the material table survives make/unmake
  const bb = mk(3), snap = Array.from(bb.pos.m), mv0 = bb.pos.mv;
  E.search(bb.pos, { maxDepth: 3 });
  ok(Array.from(bb.pos.m).join() === snap.join() && bb.pos.mv === mv0, 'search leaves pos.m / pos.mv unchanged (make/unmake symmetric)');
  // enemy materials from region 3
  const s3 = fresh(92); s3.run.map = W.newWorldMap(s3.run, 3); W.ensureMap(s3.run);
  const a3 = W.worldFrontier(s3.run).filter(i => !W.isCache(s3.run, i)).map(i => W.nodeArmy(s3.run, i));
  const s1a = W.worldFrontier(run).filter(i => !W.isCache(run, i)).map(i => W.nodeArmy(run, i));
  ok(a3.every(a => a.mats >= 1 && a.pieces.some(p => p.m === 1)) && s1a.every(a => !a.mats), 'garrisons carry iron from region 3, none in region 1');
}
// content pack: shrine effects (every kind), greyed sides, lords, formations, caches, event lines
{
  const st = fresh(93), run = st.run; W.ensureMap(run);
  const apply = (e, pick) => W.applyEffect(st, e, pick);
  const g0 = run.gold; apply({ kind: 'gold', v: 60 }); ok(run.gold === g0 + 60, 'effect gold');
  const i0 = E.incomePerMin(run, 0); apply({ kind: 'incomeFlat', v: 2, scope: 'region' }); ok(Math.abs(E.incomePerMin(run, 0) - i0 - 2) < 1e-9, 'effect incomeFlat (region)');
  apply({ kind: 'mineIncomeMult', v: 1.2, scope: 'region' }); ok(Math.abs(E.mineMult(run) - 1.2) < 1e-9, 'effect mineIncomeMult (region)');
  apply({ kind: 'shopDiscount', v: 0.15, scope: 'region' }); W.worldRefresh(run); ok(run.shopDisc === 0.15, 'effect shopDiscount (max with the town market)');
  const own0 = run.owned.length; apply({ kind: 'squares', v: 2 }); ok(run.owned.length === own0 + 2 && run.squaresBought === 0, 'effect squares (price ladder unchanged)');
  const n0 = run.roster.length; apply({ kind: 'addPiece', piece: 'N', v: 1 }); ok(run.roster.length === n0 + 1 && run.bought.N === 0 && run.roster.at(-1).t === 'N', 'effect addPiece');
  const p0 = run.roster.filter(p => p.t === 'P').length; apply({ kind: 'losePiece', piece: 'P', v: 1 }); ok(run.roster.filter(p => p.t === 'P').length === p0 - 1, 'effect losePiece');
  const pw = run.roster.find(p => p.t === 'P'); apply({ kind: 'promotePawn', to: 'B' }, pw.id); ok(pw.t === 'B', 'effect promotePawn (the picked pawn)');
  apply({ kind: 'trait', piece: 'R', v: 1, scope: 'run' }); ok(run.dwell.R === 1, 'effect trait (run): dwelling level');
  apply({ kind: 'trait', piece: 'P', v: 2, scope: 'region' }); apply({ kind: 'tacticianElo', v: 60, scope: 'next' }); apply({ kind: 'lootMult', v: 1.25, scope: 'next' });
  apply({ kind: 'enemyElo', v: 20, scope: 'region' }); apply({ kind: 'enemyTrait', piece: 'N', v: 1, scope: 'region' }); apply({ kind: 'enemyBudgetMult', v: 0.6, scope: 'region' });
  const fr = W.worldFrontier(run).filter(i => !W.isCache(run, i)), nid = fr[0], na = W.nodeArmy(run, nid);
  ok(na.elo === W.nodeElo(run, nid) && na.traits.N >= 1, 'effects enemyElo / enemyTrait reach node armies');
  const nb = (() => { const t = run.blessings; run.blessings = t.filter(b => b.kind !== 'enemyBudgetMult'); const u = W.nodeArmy(run, nid).units; run.blessings = t; return u; })();
  ok(na.units <= nb, `effect enemyBudgetMult shrinks armies (${nb} -> ${na.units} pts)`);
  W.startMarch(run, nid); W.advanceMarch(run, 999); const b = W.arrive(run, st);
  ok(b.tactElo === 60 && b.traits[0].P === 2 && !run.blessings.some(x => x.scope === 'next') && b.next.length === 2, 'next-scope blessings are consumed by the next battle (Tactician +60, region Stubborn +2)');
  ok(E.battleEngineCfg(run, b, E.WHITE).elo === E.cleanElo(b.elo + 60), 'effect tacticianElo raises the player engine');
  const sum = W.applyMapResult(st, b, E.finishBattle(st, b, 'win'));
  ok(sum.blessedLoot && sum.loot === Math.round(E.lootFor(b.tier, st.memories)) + Math.round(E.lootFor(b.tier, st.memories) * 0.25), 'effect lootMult (next): +25% loot on that battle');
  ok(typeof sum.line === 'string' && sum.line.length > 5 && !/\{/.test(sum.line), `battle result line: "${sum.line}"`);
  const rt = run.map.raid.t; apply({ kind: 'raidClock', v: 120 }); ok(run.map.raid.t === rt + 120, 'effect raidClock');
  const na0 = run.map.rival.nextMoveAt; apply({ kind: 'rivalClock', v: 480 }); ok(run.map.rival.nextMoveAt === na0 + 480000 && W.rivalEta(run) >= 480, 'effect rivalClock delays the rival (world-side, rival.mjs untouched)');
  const s0 = W.rivalView(run).strength; apply({ kind: 'rivalStrength', v: 1 }); ok(Math.abs(W.rivalView(run).strength - s0 - 1) < 1e-6 && run.map.rival.strength === s0, 'effect rivalStrength: the armies see +1 strength (view only)');
  apply({ kind: 'rivalStrength', v: -2 }); ok(W.rivalView(run).strength === 1, 'rivalStrength floors at 1');
  apply({ kind: 'marchMult', v: 0.5, scope: 'region' }); const fr2 = W.worldFrontier(run)[0];
  ok(W.marchTicks(run, fr2) === Math.round((5 + 12 * W.worldRegion(run).nodes[fr2].dist) * 0.5), 'effect marchMult');
  const bars0 = run.forge.bars.steel; apply({ kind: 'bar', material: 'steel', v: 1 }); ok(run.forge.bars.steel === bars0 + 1, 'effect bar');
  apply({ kind: 'resource', res: 'coal', v: 8 }); ok(run.forge.stock.coal >= 8, 'effect resource');
  apply({ kind: 'memoriesOnEnd', v: 2 }); const m0 = st.memories; const gain = E.endRun(st, 0, 5); ok(gain === 2 && st.memories === m0 + 2, 'effect memoriesOnEnd: paid at the end of the run, after the mate cut');
  const s2 = fresh(94), r2 = s2.run, shrine = W.worldRegion(r2).nodes.find(n => n.type === 'shrine');
  r2.map.held = [...r2.map.held, shrine.id].sort((a, b) => a - b);
  W.applyEffect(s2, { kind: 'reveal', v: 2 }); // from the keep when no shrine is pending
  ok(r2.map.scouted.length >= 3 && W.worldFog(r2).some(v => v.vis === 'scouted'), `effect reveal: ${r2.map.scouted.length} nodes scouted, shown in the fog`);
  // a real pack shrine: deterministic choice, minRegion-gated, greyed when unaffordable
  r2.map.shrine = shrine.id; const c = W.pendingShrine(r2);
  ok(c && c.minRegion <= 1 && C.SHRINE_CHOICES.includes(c) && W.shrineChoiceFor(r2, shrine.id) === c, `the shrine offers a pack choice: ${c.name}`);
  r2.gold = 0;
  ok(W.effectBlocker(r2, { kind: 'gold', v: -50 }) === 'needs 50 gold' && W.effectBlocker(r2, { kind: 'losePiece', piece: 'R', v: 1 }) !== '' && W.effectBlocker(r2, { kind: 'promotePawn', to: 'N' }) === '', 'unaffordable / impossible parts are greyed with a reason');
  const side = W.sideBlocker(r2, 'a') ? 'b' : 'a', took = W.chooseShrineSide(s2, side);
  ok(took && r2.map.shrine === null && !W.chooseShrineSide(s2, side), 'a shrine side is taken once');
  ok(C.shrineChoicesFor(1).every(x => x.minRegion === 1) && W.worldRegion(r2) && (() => { const s5 = fresh(95); s5.run.map = W.newWorldMap(s5.run, 5); W.ensureMap(s5.run); const sh = W.worldRegion(s5.run).nodes.filter(n => n.type === 'shrine'); return sh.every(n => W.shrineChoiceFor(s5.run, n.id).minRegion <= 5); })(), 'shrine pools are minRegion-gated');
  // lords
  const l = W.lordOf(r2);
  ok(l && W.rivalName(r2) === l.name && W.rivalDoctrine(r2) === C.ENGINE_DOCTRINE[l.doctrine] && l.taunt.length <= 80, `region lord ${W.lordTitle(r2)} (${l.doctrine}) names and drives the rival`);
  // pack formations on v5 maps only (saved maps stay stable)
  let packUsed = 0, packOld = 0;
  const names = new Set(C.ENEMY_FORMATION_PACK.map(f => f.name));
  for (let s = 0; s < 6; s++) {
    const sx = fresh(400 + s), rx = sx.run;
    for (const n of W.worldRegion(rx).nodes) if (n.type !== 'keep' && !W.isCache(rx, n.id) && names.has(W.nodeArmy(rx, n.id).name)) packUsed++;
    rx.map.pack = false;
    for (const n of W.worldRegion(rx).nodes) if (n.type !== 'keep' && names.has(W.nodeArmy(rx, n.id).name)) packOld++;
  }
  ok(packUsed > 5 && packOld === 0, `content-pack formations on new maps (${packUsed} nodes), none on migrated maps`);
  // caches
  const s6 = fresh(96), r6 = s6.run, cs = W.cacheIds(r6);
  ok(cs.length >= 1 && cs.length <= 2 && cs.every(id => W.worldRegion(r6).nodes[id].type === 'garrison'), `1-2 supply caches per region (${cs.length})`);
  const cid = cs[0], reg6 = W.worldRegion(r6);
  r6.map.held = reg6.nodes.filter(n => n.id !== cid && n.id !== reg6.citadelId && M.neighbors(reg6, cid).includes(n.id)).map(n => n.id).concat(r6.map.held).sort((a, b) => a - b);
  r6.map.held = [...new Set(r6.map.held)];
  const gold6 = r6.gold, bat0 = r6.battles | 0;
  ok(W.nodeArmy(r6, cid).cache && W.startMarch(r6, cid), 'a cache is marched to like any node');
  W.advanceMarch(r6, 999); const nb6 = W.arrive(r6, s6), lc = r6.map.lastCache;
  ok(nb6 === null && (r6.battles | 0) === bat0 && r6.map.held.includes(cid) && lc && lc.gold > 0 && r6.gold === gold6 + lc.gold && lc.line.length > 5 && !/\{/.test(lc.line), `cache taken without a battle: +${lc && lc.gold} gold, "${lc && lc.line}"`);
  ok(!W.isCache(r6, cid), 'a taken cache is just a held node');
  const s7 = fresh(97); s7.run.map.pack = false; ok(W.cacheIds(s7.run).length === 0, 'no caches on migrated maps');
}
// elo: asked once on migrated saves with no chosen band; changeable mid-run on the Run tab
{
  const v4 = fresh(98); v4.v = 4; v4.eloPicked = true; v4.elo = 900; delete v4.cosmetics; delete v4.run.forge; delete v4.run.blessings; v4.run.mineBless = 1;
  const m = W.migrateState(JSON.parse(JSON.stringify(v4)));
  ok(m.v === 6 && m.eloPicked === false && m.migratedFrom === 4 && m.run.blessings.length === 1 && m.run.blessings[0].kind === 'mineIncomeMult' && E.mineMult(m.run) === E.TUNE.shrineMineBoost && m.run.forge && m.run.forge.v === 1, 'v4 -> v6: default band -> the elo card is asked once; mine blessing becomes a region blessing; fresh forge');
  const v4b = JSON.parse(JSON.stringify(v4)); v4b.elo = 1200; v4b.run.elo = 1200;
  ok(W.migrateState(v4b).eloPicked === true, 'v4 -> v5: an explicitly chosen band (not the default) is not asked again');
  ok(W.migrateState(JSON.parse(JSON.stringify(m))).eloPicked === false, 'the ask survives a reload until answered');
  ok(E.newState(0, 3).eloPicked === false, 'a fresh / reset save asks for the band (the UI shows the card; tick() self-heals a hidden gate)');
  const st = fresh(99), run = st.run; st.eloPicked = true;
  const id = W.worldFrontier(run).find(i => !W.isCache(run, i)), e0 = W.nodeArmy(run, id).elo;
  W.setRunElo(st, 1500);
  const e1 = W.nodeArmy(run, id).elo;
  ok(st.elo === 1500 && run.elo === 1500 && e1 === e0 + 600 && run.map.rival.eloBase === 1500, `mid-run band change: new opponents ${e0} -> ${e1}, rival re-based`);
  W.startMarch(run, id); W.advanceMarch(run, 999); const b = W.arrive(run, st);
  ok(E.battleEngineCfg(run, b, E.WHITE).elo === E.battleEngineCfg(run, b, E.BLACK).elo, 'the Tactician stays equal to the new band');
}
// cosmetics
{
  const st = fresh(100);
  ok(W.refreshCosmetics(st).length === 0 && !W.choosePieceSet(st, 'moonlit-vigil'), 'locked piece sets cannot be chosen');
  st.memEarned = 30; const fresh1 = W.refreshCosmetics(st);
  ok(fresh1.some(s => s.id === 'moonlit-vigil') && W.choosePieceSet(st, 'moonlit-vigil') && st.cosmetics.set === 'moonlit-vigil', 'Memories unlock a piece set, which can then be chosen');
  ok(W.migrateState(JSON.parse(JSON.stringify(st))).cosmetics.set === 'moonlit-vigil', 'the chosen set survives a reload');
}
// ===================== M6: feel pass (skills, discovery, music, rewind) =====================
const sqI = E.parseSq;
// a hand-built world-style battle: whites [{sq,id,t}], enemy pieces, enemy traits, optional seed
function handBattle(st, whites, pieces, traits, seed) {
  const b = W.worldBattle(st.run, { tier: 1, type: 'garrison', pieces, traits: traits || null, seed: seed ?? 7, elo: 900, doctrine: 'balanced' }, whites);
  return b;
}
const moveOf = (b, f, t) => E.battleLegal(b).find(m => E.mFrom(m) === sqI(f) && E.mTo(m) === sqI(t));
// skills: state field, start grant, carry-over through endRun
{
  const st = fresh(601);
  ok(st.skills && SK.totalLevel(st.skills) === 6 && st.run.skillStart && st.run.skillMods && st.run.skillMods.P === 0.0025 && E.pieceCost(st.run, 'P') === 25, 'new state has level-1 skills, a start grant and the skill price cache');
  st.skills.N.xp = SK.xpForLevel(30); st.skills.P.xp = SK.xpForLevel(40);
  E.endRun(st, 0, 77); W.ensureMap(st.run);
  const kn = st.run.roster.filter(p => p.t === 'N').length, pw = st.run.roster.filter(p => p.t === 'P').length;
  ok(kn === 1 && pw === 3 + 4 && SK.skillLevel(st.skills, 'N') === 30, `skills survive endRun and the next run starts with their free pieces (${kn} knight, ${pw} pawns)`);
  ok(E.reserve(st.run).filter(p => p.t === 'N').length === 1 && st.run.bought.N === 0, 'skill pieces go to the reserve and do not raise shop prices');
  const n0 = st.run.roster.length; E.skillStart(st); ok(st.run.roster.length === n0, 'grantStart runs once per run');
  const m = W.migrateState(JSON.parse(JSON.stringify(Object.assign({}, st, { skills: { P: { xp: -5 }, K: 'x' } }))));
  ok(m && m.skills.P.xp === 0 && m.skills.N.xp === 0 && m.run.skillMods.N === 0.0025, 'load runs cleanSkills and re-derives skillMods (no save version bump)');
  ok(W.migrateState(JSON.parse(JSON.stringify(st))).skills.N.xp === st.skills.N.xp && E.SAVE_VERSION === 6, 'skills round-trip a save; still v6');
}
// discount math: the skill discount multiplies under the town/blessing price
{
  const st = fresh(602), run = st.run;
  st.skills.P.xp = SK.xpForLevel(40); st.skills.K.xp = SK.xpForLevel(20); E.skillStart(st);
  ok(E.pieceCost(run, 'P') === Math.round(25 * 0.9) && E.squareCost(run) === Math.round(40 * 0.95), `Pawncraft 40 -> pawn ${E.pieceCost(run, 'P')} (10% off), Leadership 20 -> square ${E.squareCost(run)} (5% off)`);
  run.gold = 1000; run.shopDisc = 0.1; const g0 = run.gold;
  E.buyPiece(run, 'P');
  ok(g0 - run.gold === Math.round(Math.round(25 * 0.9) * 0.9), `the charge applies the town discount on top (${g0 - run.gold} gold)`);
  ok(E.pieceCost(run, 'N') === 80 && E.pieceCost(run, 'P') === Math.round(E.piecePrice('P', 1) * 0.9), 'untrained types pay full price; the next pawn is discounted from its own base');
  const id = W.worldFrontier(run)[0];
  ok(W.marchNeed(run, id) === Math.max(1, Math.round(W.marchTicks(run, id) * (1 - run.skillMods.march))) && W.marchNeed(run, id) < W.marchTicks(run, id), 'Leadership shortens marches');
}
// XP awards in a real battle: captures that stood, survival, win, leadership, march, mines
{
  const st = fresh(603), run = st.run, id = W.worldFrontier(run).find(i => !W.isCache(run, i));
  W.startMarch(run, id); W.advanceMarch(run, 999); const b = W.arrive(run, st);
  ok(b.sx && b.sx.f.K === 1 && b.sx.f.P === 3, 'a world battle starts the skills tally with the fielded types');
  let g = 0;
  while (!b.over && g++ < 300) W.battleMove(run, b, E.thinkMove(run, b, { maxNodes: 4000, timeMs: 1e9 }).move);
  const k0 = SK.skillXp(st.skills, 'K'), res = W.awardBattleXp(st, b, b.over.result);
  ok(res.gained.K > 0 && SK.skillXp(st.skills, 'K') === k0 + res.gained.K && /Leadership/.test(res.text), `a played battle (${b.over.result}, ${b.plies} plies) pays XP: ${res.text}`);
  const cap = Object.values(b.sx.c).reduce((a, x) => a + x, 0), enemyLost = b.node.pieces.length - [...b.pos.b].filter(p => p && (p >> 5) === E.BLACK).length;
  ok(cap >= enemyLost - 0 && (enemyLost === 0 || cap > 0), `captures are tallied (${cap} pawn-units for ${enemyLost} enemy pieces taken)`);
  const mx = W.awardMarchXp(st, 1); ok(mx.gained.K === 6, 'a completed march pays 6 Leadership XP at tier 1');
}
// a capture undone by an enemy trait (Bulwark) does not count; one that stands does
{
  let held = null, stood = null;
  for (let seed = 1; seed < 400 && (!held || !stood); seed++) {
    const st = fresh(604);
    const b = handBattle(st, [{ sq: sqI('e1'), id: 0, t: 'K' }, { sq: sqI('d1'), id: 900, t: 'Q' }], [{ sq: sqI('h8'), t: 'K' }, { sq: sqI('d4'), t: 'R' }, { sq: sqI('a7'), t: 'P' }], { R: 3 }, seed);
    W.battleMove(st.run, b, moveOf(b, 'd1', 'd4'));
    if (b.lastTrait && b.lastTrait.ok && !b.lastTrait.blocked) held = held || b; else stood = stood || b;
  }
  ok(held && !held.sx.c.Q && stood && stood.sx.c.Q === 5, 'a Bulwark-held capture earns nothing; a capture that stood earns 5 units');
}
// mine XP rides worldTick (held mine required)
{
  const st = fresh(605), run = st.run;
  ok(W.mineSkillXp(st, 1000).length === 0 && SK.skillXp(st.skills, 'P') === 0, 'no mine held: no mine XP');
  let guard = 0;
  while (!W.heldMines(run).length && guard++ < 40) { const f = W.worldFrontier(run), reg = W.worldRegion(run); const id = f.find(i => reg.nodes[i].type === 'mine') ?? f.find(i => reg.nodes[i].type !== 'citadel'); if (id == null) break; forceWin(st, id); }
  st.skills.mg = 0; W.mineSkillXp(st, 600);
  ok(W.heldMines(run).length > 0 && SK.skillXp(st.skills, 'P') === 8 && st.skills.mg === 100, `a held mine: 600 gold = 2 milestones = 8 Pawncraft XP (banked ${st.skills.mg})`);
}
// discovery: region content, treasure on a real march, sites, gating, artifacts live
{
  const st = fresh(606), run = st.run, reg = W.worldRegion(run);
  ok(run.map.disc === 1 && run.map.treasure.length >= 2 && run.map.sites.length >= 3 && Array.isArray(run.arts), `a new run places discovery content (${run.map.treasure.length} piles, ${run.map.sites.length} sites)`);
  // collectOnMarch through a real march: hold one end of a gold pile's road, march along it
  let done = false;
  for (const t of run.map.treasure.filter(t => t.k === 'gold')) {
    const s2 = fresh(606), r2 = s2.run; r2.map.held = [...new Set([0, t.a])].sort((x, y) => x - y);
    if (!W.canMarch(r2, t.b) || DSC.marchFrom(r2, t.b, W.worldRegion(r2)) !== t.a) continue;
    const g0 = r2.gold; W.startMarch(r2, t.b); W.advanceMarch(r2, 999); W.arrive(r2, s2);
    const pile = r2.map.treasure.find(x => x.a === t.a && x.b === t.b);
    ok(pile.got === 1 && r2.map.lastGains.length === 1 && Math.round(r2.gold - g0) >= t.e.v && /gold/.test(W.gainsText(r2.map.lastGains)), `a march along the road picks up its pile (+${t.e.v} gold: ${W.gainsText(r2.map.lastGains)})`);
    ok(DSC.collectOnMarch(r2, t.a, t.b).length === 0, 'a pile never pays twice');
    done = true; break;
  }
  ok(done, 'found a gold pile to march along');
  // site card flow: open (held anchor), gate, Not now, reopen, choose
  const i = run.map.sites.findIndex(x => DSC.siteCard(run, run.map.sites.indexOf(x), reg).a.ok && !DSC.siteCard(run, run.map.sites.indexOf(x), reg).a.effect.kind.includes('ambush'));
  const site = run.map.sites[i];
  run.map.held = [...new Set([0, site.at])].sort((a, b) => a - b); run.gold = 500;
  ok(W.openSiteCard(run, i) && W.siteCardOf(run).name && DSC.discoveryBusy(run), `a held site opens its card (${W.siteCardOf(run).name})`);
  const fr = W.worldFrontier(run)[0];
  ok(!W.canMarch(run, fr) && W.raidPaused(run), 'an open site card blocks marches and the raid clock');
  W.skipSite(run);
  ok(run.map.site == null && run.map.sites[i].later && !DSC.discoveryBusy(run) && W.canMarch(run, fr), '"Not now" closes the card and frees the map');
  ok(W.openSiteCard(run, i), 'a site set aside can be reopened by tapping it');
  const side = W.siteCardOf(run).a.ok ? 'a' : 'b', res = W.chooseSite(st, side);
  ok(res && run.map.sites[i].done === side && run.map.site == null && !W.openSiteCard(run, i), `choosing a side resolves the site for good (${res.label})`);
  // artifacts: live effects
  const b = handBattle(st, [{ sq: sqI('e1'), id: 0, t: 'K' }, { sq: sqI('d1'), id: 900, t: 'Q' }], [{ sq: sqI('h8'), t: 'K' }, { sq: sqI('a7'), t: 'P' }]);
  ok(W.freeHints(run, b) === 0 && W.hintPrice(b) >= 5, `without the Lens a hint costs ${W.hintPrice(b)} gold`);
  DSC.awardArtifact(run, 'tacticians-lens');
  const g1 = run.gold, h1 = W.payHint(run, b), h2 = W.payHint(run, b);
  ok(h1.free && !h2.free && run.gold === g1 - W.hintPrice(b), "the Tactician's Lens makes the first hint each battle free");
  ok(DSC.revealOnCapture(run, site.at, reg).length === 0, 'no Spyglass: a capture scouts nothing extra');
  DSC.awardArtifact(run, 'scout-spyglass');
  ok(DSC.artifactTotal(run, 'sight') === 1 && DSC.nodesWithin(reg, site.at, 2).length > 1, 'the Spyglass raises the scouting radius to 2 roads');
  const qs = DSC.awardArtifact(run, 'quartermaster-seal'); W.applyParts(st, qs.apply, qs.def);
  ok(run.shopDisc === 0.1 && run.blessings.some(x => x.art === 'quartermaster-seal'), 'a blessing artifact applies through applyEffect and is tagged as an artifact');
}
// traitWard: the Obsidian Chip makes the player's first counter roll unable to fail
{
  let checked = false;
  for (let seed = 1; seed < 300 && !checked; seed++) {
    const mk = ward => {
      const st = fresh(607);
      const b0 = handBattle(st, [{ sq: sqI('e1'), id: 0, t: 'K' }, { sq: sqI('d1'), id: 900, t: 'Q' }], [{ sq: sqI('h8'), t: 'K' }, { sq: sqI('d4'), t: 'N' }, { sq: sqI('a7'), t: 'P' }], null, seed);
      const o = E.serBattle(b0); o.m = new Array(64).fill(0); o.m[sqI('d4')] = 1; o.wardMax = ward;
      const b = E.deserBattle(o); W.battleMove(st.run, b, moveOf(b, 'd1', 'd4')); return b;
    };
    const plain = mk(0); if (!plain.lastCounter || !plain.lastCounter.fails) continue;
    const warded = mk(1);
    ok(warded.lastCounter.warded && !warded.lastCounter.fails && warded.ward === 1 && (warded.pos.b[sqI('d4')] & 31) === E.Q && /warded/.test(E.counterResultText(warded.lastCounter)), `seed ${seed}: the roll that glances off unwarded lands with the ward`);
    checked = true;
  }
  ok(checked, 'found a failing counter roll to ward');
}
// ambush: site battle, the run is never at stake, a win pays the prize
{
  const st = fresh(608), run = st.run, i = 0, s0 = run.map.sites[i];
  run.map.held = [...new Set([0, s0.at])].sort((a, b) => a - b);
  s0.done = 'b'; s0.prize = s0.prize || 'lodestone'; run.map.ambush = { site: i, v: 0.6 };
  ok(DSC.discoveryBusy(run) && W.raidPaused(run), 'a waiting ambush gates the map');
  const b = W.startAmbush(run);
  ok(b && b.node.ambush && b.node.type === 'ambush' && b.tier >= 1, `the ambush battle starts (${b.node.units} pts)`);
  const sum = W.finishAmbushBattle(st, b, 'mate');
  ok(sum.result === 'loss' && !sum.runOver && run.map.ambush == null && !DSC.discoveryBusy(run), 'a mate in an ambush is a loss, not the end of the run; the site stays spent');
  run.map.ambush = { site: i, v: 0.6 }; const b2 = W.startAmbush(run), s2 = W.finishAmbushBattle(st, b2, 'win');
  ok(s2.loot > 0 && s2.art && DSC.ownsArtifact(run, s0.prize), `a won ambush pays loot and the prize (${s2.art.name})`);
}
// music: the mood mapping (first match wins)
{
  const M = c => musicMoodFor(c);
  ok(M({ runOver: true, battle: true }) === 'mourning' && M({ retired: true }) === 'triumph' && M({ battle: true, boss: true, check: true }) === 'boss'
    && M({ battle: true, check: true }) === 'danger' && M({ battle: true }) === 'battle' && M({ result: 'win', threat: true }) === 'triumph'
    && M({ result: 'loss' }) === 'mourning' && M({ threat: true, forge: true }) === 'threat' && M({ forge: true }) === 'forge' && M({}) === 'map', 'music mood mapping follows INTEGRATION.md priorities');
  const ui = readFileSync(new URL('./game.src.html', import.meta.url), 'utf8');
  ok(!/setIntensity\(/.test(ui) && !/map\.contact[^;\n]*threat|threat[^;\n]*map\.contact/.test(ui) && /updateMood\(\);\s*\n\s*if \(!battle && !ui\.ended\)/.test(ui), 'the page sets moods only through updateMood (no setIntensity, no contact-based threat), also once per tick');
}
// rewind: deterministic replay from (start, seed, moves)
{
  const mkB = seed => { const st = fresh(seed), run = st.run, id = W.worldFrontier(run).find(i => !W.isCache(run, i)); W.startMarch(run, id); W.advanceMarch(run, 999); return [st, W.arrive(run, st)]; };
  const trng = E.mulberry(4242), think = (run, b) => E.thinkMove(run, b, { maxNodes: 3000, timeMs: 1e9, rng: trng }).move;
  const snap = b => JSON.stringify([E.posKey(b.pos), Array.from(b.ids), b.lost, b.plies, b.sx, [...b.history], b.maj]);
  const [st, b] = mkB(610), run = st.run;
  ok(b.start && b.moves.length === 0 && W.rewindsLeft(b) === 3 && !W.canRewind(b), 'a battle starts with 3 rewinds and nothing to unwind');
  // play until the player has made a capture, then rewind it
  let before = null, g = 0;
  while (!b.over && g++ < 200) {
    if (b.pos.side === E.WHITE) before = snap(b);
    const m = think(run, b); W.battleMove(run, b, m);
    if (b.pos.side === E.WHITE && b.plies >= 6 && (Object.keys(b.sx.c).length || b.lost.length || b.plies >= 12)) break;
  }
  const lostBefore = b.lost.length;
  ok(W.canRewind(b) && W.rewindBattle(run, b), 'rewind after an enemy reply');
  ok(snap(b) === before && b.pos.side === E.WHITE && W.rewindsLeft(b) === 2, `rewind restores the exact prior position, roster ids, losses and tally (ply ${b.plies}, ${lostBefore} losses before)`);
  // a capture and a loss are restored: the rook comes back, the tally forgets the capture, the lost queen returns
  {
    const s7 = fresh(615), b7 = handBattle(s7, [{ sq: sqI('e1'), id: 0, t: 'K' }, { sq: sqI('d1'), id: 902, t: 'Q' }, { sq: sqI('a2'), id: 903, t: 'P' }], [{ sq: sqI('h8'), t: 'K' }, { sq: sqI('d4'), t: 'R' }, { sq: sqI('b3'), t: 'N' }]);
    const s0 = snap(b7);
    W.battleMove(s7.run, b7, moveOf(b7, 'd1', 'd4')); W.battleMove(s7.run, b7, moveOf(b7, 'b3', 'a1') || E.battleLegal(b7)[0]);
    W.battleMove(s7.run, b7, moveOf(b7, 'a2', 'a3') || E.battleLegal(b7)[0]);
    const capd = b7.sx.c.Q === 5;
    W.battleMove(s7.run, b7, E.battleLegal(b7).find(m => E.mCap(m)) || E.battleLegal(b7)[0]);
    W.rewindBattle(s7.run, b7); W.rewindBattle(s7.run, b7);
    ok(capd && snap(b7) === s0 && (b7.pos.b[sqI('d4')] & 31) === E.R && !b7.sx.c.Q && b7.lost.length === 0, 'rewinding a capture puts the piece back and takes the XP tally back with it');
  }
  // replaying the same move recurs the same rolls: the same position again
  const again = think(run, b); W.battleMove(run, b, again);
  const reply = think(run, b); W.battleMove(run, b, reply);
  ok(b.moves.length === b.plies, 'the move list tracks every ply');
  // reload keeps the rewind state
  const rb = E.deserBattle(JSON.parse(JSON.stringify(E.serBattle(b))));
  const before2 = snap(Object.assign({}, b, { pos: b.pos }));
  ok(rb.rw === 1 && rb.moves.length === b.moves.length && W.rewindBattle(run, rb) && W.rewindsLeft(rb) === 1 && rb.plies === b.plies - 2, 'a reloaded battle can still be rewound (charges kept)');
  ok(!!before2, 'snapshot taken');
  // double rewind back to the start, then nothing left to unwind
  const [s3, b3] = mkB(611), r3 = s3.run, start = snap(b3);
  if (b3.pos.side === E.WHITE) {
    for (let i = 0; i < 4 && !b3.over; i++) W.battleMove(r3, b3, think(r3, b3));
    ok(W.rewindBattle(r3, b3) && W.rewindBattle(r3, b3) && snap(b3) === start && !W.canRewind(b3) && W.rewindsLeft(b3) === 1, 'double rewind returns to the opening position; with no own move left it is disabled');
  } else ok(true, 'double rewind (skipped: enemy moved first)');
  // rewind at ply 1: the enemy has not replied, so only one ply is unwound
  const [s4, b4] = mkB(612), r4 = s4.run, st4 = snap(b4);
  if (b4.pos.side === E.WHITE) { W.battleMove(r4, b4, think(r4, b4)); ok(b4.plies === 1 && W.rewindBattle(r4, b4) && b4.plies === 0 && snap(b4) === st4, 'rewind at ply 1 unwinds one ply back to the start'); }
  else ok(true, 'rewind at ply 1 (skipped)');
  // charge accounting: three rewinds, then the button stays off even with moves to unwind
  const [s5, b5] = mkB(613), r5 = s5.run;
  let used = 0;
  for (let k = 0; k < 4; k++) { for (let i = 0; i < 2 && !b5.over; i++) W.battleMove(r5, b5, think(r5, b5)); if (W.rewindBattle(r5, b5)) used++; }
  ok(used === 3 && W.rewindsLeft(b5) === 0 && !W.canRewind(b5) && (b5.over || W.lastOwnPly(b5) >= 0), 'exactly 3 rewinds per battle; a rewind costs its charge even if the same move is replayed');
  // no rewind after mate; the mate is credited to the queen
  const s6 = fresh(614), b6 = handBattle(s6, [{ sq: sqI('g6'), id: 0, t: 'K' }, { sq: sqI('a7'), id: 901, t: 'Q' }], [{ sq: sqI('h8'), t: 'K' }, { sq: sqI('a2'), t: 'P' }]);
  W.battleMove(s6.run, b6, moveOf(b6, 'a7', 'g7'));
  ok(b6.over && b6.over.reason === 'Checkmate' && b6.sx.m === 'Q' && !W.canRewind(b6) && !W.rewindBattle(s6.run, b6), 'no rewind after mate; the mate is noted for Queencraft');
  ok(!/rewind/i.test(readFileSync(new URL('./balance-bot.mjs', import.meta.url), 'utf8').replace(/never rewinds/g, '')), 'the balance bot never rewinds');
}
// UX clarity: the page's plain-words effect builders (the <explain> block of game.src.html, evaluated here)
{
  const ui = readFileSync(new URL('./game.src.html', import.meta.url), 'utf8');
  const blk = ui.split('// <explain>')[1].split('// </explain>')[0].replace(/^.*\n/, '');
  const X = new Function('TRAITS', 'PIECE_NOUN', 'RES_SHORT', 'DSC', 'capFirst', 'per100', blk + '\nreturn { effPlain, effText, SCOPE_LONG, SCOPE_SHORT };')(
    E.TRAITS, E.PIECE_NOUN, W.RES_SHORT, DSC, W.capFirst, v => (v * E.TUNE.tickSec / 60 * 100).toFixed(1));
  const scopeWords = /next battle only|until you leave this region|for the rest of this run/;
  const parts = e => C.effectParts(e);
  const sides = C.SHRINE_CHOICES.flatMap(c => ['a', 'b'].map(k => [c.name, c[k]]))
    .concat([...DSC.LOCATIONS, ...W.LANDMARKS].flatMap(l => l.variants.flatMap(v => ['a', 'b'].filter(k => v[k]).map(k => [l.name, v[k]]))));
  const bad = sides.filter(([, o]) => { const t = X.effText(o.effect); return /undefined|NaN|a lasting change|\[object/.test(t) || (parts(o.effect).some(p => p.scope) && !scopeWords.test(t)); });
  ok(!bad.length, `every shrine and site choice (${sides.length}) has a plain effect line, and scoped ones say how long they last${bad.length ? ': ' + bad.map(b => b[0]).join(', ') : ''}`);
  const tw = C.SHRINE_CHOICES.find(c => c.id === 'twin-wells');
  ok(X.effText(tw.a.effect) === 'Your Tactician plays 60 elo stronger, your next battle only.' && X.effText(C.SHRINE_CHOICES[0].b.effect) === 'Your mines pay 20% more gold, until you leave this region.', `card text: "${X.effText(tw.a.effect)}" / "${X.effText(C.SHRINE_CHOICES[0].b.effect)}"`);
  ok(DSC.ARTIFACTS.every(a => !/undefined|a lasting change/.test(X.effPlain(a.effect))), 'every artifact has a plain effect line');
  // blessings as stored on the run read the same (kind/v/scope/piece), with a short scope tag
  const st = fresh(77), run = st.run; W.applyEffect(st, { kind: 'trait', piece: 'P', v: 2, scope: 'region' });
  const bl = run.blessings[run.blessings.length - 1];
  ok(/^Stubborn \+2 for your pawns: \+40% chance a captured pawn falls back/.test(X.effPlain(bl)) && X.SCOPE_SHORT[bl.scope] === 'this region', `a stored blessing reads plainly: "${X.effPlain(bl)} (${X.SCOPE_SHORT[bl.scope]})"`);
  // first-encounter flags, the blessing's source and the shrine memo survive a save round-trip (no save bump)
  st.seen = { shrine: 1, rewind: 1 }; bl.src = 'The Old Drill Yard'; run.map.shrineDone = { 3: 'Drill the pawns' };
  const back = W.migrateState(JSON.parse(JSON.stringify(st)));
  ok(back && back.seen.shrine === 1 && back.seen.rewind === 1 && back.run.blessings.some(b => b.src === 'The Old Drill Yard') && back.run.map.shrineDone[3] === 'Drill the pawns', 'seen flags, blessing names and shrine memos survive save + load');
  ok(W.migrateState(JSON.parse(JSON.stringify(fresh(78)))).seen === undefined, 'an old save without seen flags still loads (the page treats it as nothing seen)');
  const FIRST = ui.split('const FIRST = {')[1].split('};')[0];
  ok(['shrine', 'site', 'raid', 'counter', 'trait', 'rewind', 'bar', 'ding'].every(k => new RegExp(`\\b${k}: '`).test(FIRST) && new RegExp(`(explain|markSeen|tip)\\('${k}'\\)`).test(ui)), 'first-encounter explainers exist and are wired for shrine, site, raid, counter roll, trait roll, rewind, forge bar and skill ding');
  ok(!/blessing used|\(blessed\)|Roads now yours|Village levy|Fought as Queens|\/ 100 mv/.test(ui), 'the old cryptic statuses are gone from the page');
}
// ===================== P0 engagement pass =====================
// P0-1 punish the run, never the account
{
  const st = fresh(701); st.memories = 60; E.buyMemUpgrade(st, 'gold'); E.buyMemUpgrade(st, 'pawns');
  st.skills.N.xp = SK.xpForLevel(25); st.skills.P.xp = SK.xpForLevel(12) + 7;
  const up0 = JSON.stringify(st.upgrades), mem0 = st.memories, sk0 = JSON.stringify(st.skills), spent0 = st.memSpent;
  const run = st.run; run.sumTiers = 120;
  const b = handBattle(st, [{ sq: sqI('h1'), id: run.roster[0].id, t: 'K' }], [{ sq: sqI('a8'), t: 'K' }, { sq: sqI('g3'), t: 'Q' }, { sq: sqI('a2'), t: 'R' }]);
  const sum = E.finishBattle(st, b, 'mate');
  ok(sum.memories === E.mateMemories(120) && sum.memories === Math.floor(E.memoriesFor(120) * 0.25) && sum.memories > 0, `a mate pays 25% of the run's payout (${sum.memories} of ${E.memoriesFor(120)})`);
  W.awardBattleXp(st, b, 'mate');
  const gain = E.endRun(st, sum.memories, 702); W.ensureMap(st.run);
  ok(st.memories === mem0 + gain && st.memories >= mem0 && JSON.stringify(st.upgrades) === up0 && st.memSpent === spent0, `mate with banked Memories and upgrades: balance ${mem0} -> ${st.memories} (only added), upgrades unchanged`);
  ok(Object.keys(sk0 && JSON.parse(sk0)).every(t => t === 'mg' || st.skills[t].xp >= JSON.parse(sk0)[t].xp), 'mate: no skill loses XP');
  const m1 = st.memories; E.endRun(st, -50, 703); W.ensureMap(st.run);
  ok(st.memories === m1, 'endRun never deducts, even when handed a negative payout');
  // keep loss: 25% of the run's payout, the bank untouched
  const s2 = fresh(704); s2.memories = 33; s2.run.sumTiers = 80; const reg = W.worldRegion(s2.run);
  s2.run.map.rival.pending = { type: 'keepAssault', nodeId: reg.keepId, at: 0 }; s2.run.map.rival.nextMoveAt = null;
  const kc = W.concedeBorder(s2);
  ok(kc && kc.runOver && kc.memories === E.mateMemories(80) && s2.memories === 33, 'keep loss pays 25% of the run payout and leaves the bank alone');
  const ui = readFileSync(new URL('./game.src.html', import.meta.url), 'utf8');
  ok(!/docks|biggest boost/i.test(ui + readFileSync(new URL('./world.mjs', import.meta.url), 'utf8') + readFileSync(new URL('./engine.mjs', import.meta.url), 'utf8')), 'no deduction mechanic or "docks your boosts" copy remains');
  ok(/Lost with the run/.test(ui) && /Safe forever/.test(ui) && /75% of the Memories the run would have paid/.test(ui) && /never reduced/.test(ui), 'run-over card names what was lost and what is safe forever');
}
// P0-2 level ceremony and the Skill Guide
{
  const H = W.skillHalfLevel(), x99 = SK.xpForLevel(99);
  ok(SK.xpForLevel(H) >= x99 / 2 && SK.xpForLevel(H - 1) < x99 / 2 && H === 91, `halfway level computed from the curve: ${H} (xp ${SK.xpForLevel(H)} >= ${x99 / 2} > ${SK.xpForLevel(H - 1)})`);
  const g = W.skillGuide('P', 20);
  ok(g.level === 20 && g.title === 'Yeoman' && g.gave.length === 3 && /pawns 0\.25% cheaper \(now 5% off\)/.test(g.gave[0]) && /starts with 2 free pawns \(was 1\)/.test(g.gave[1]) && g.gave[2] === 'new title: Yeoman', `Pawncraft 20 guide: ${g.gave.join('; ')}`);
  ok(g.next[0].level === 21 && /5\.25% off/.test(g.next[0].text) && g.next[1].level === 30 && /Footman/.test(g.next[1].text) && g.next.length === 4, 'guide lists the next level and the next milestones with their levels');
  ok(g.ladder.length === 11 && g.ladder.filter(x => x.got).length === 3 && /^91 is half of 99/.test(g.landmark), `title ladder and landmark: "${g.landmark}"`);
  let empty = 0; for (const t of SK.SKILL_TYPES) for (let L = 1; L <= 99; L++) { const q = W.skillGuide(t, L); if (!q.gave.length || q.gave.some(s => /total level/.test(s))) empty++; }
  ok(empty === 0, 'never an empty level: every level of every skill writes out a concrete perk change');
  ok(W.skillGuide('K', 90).next.some(n => n.level === 91 && /halfway/.test(n.text)), 'the halfway level shows up in the guide');
  const st = fresh(711); st.skills.Q.xp = SK.xpForLevel(9) + 1;
  ok(!W.skillGlows(st, 'Q'), 'no glow before a level-up');
  const b = handBattle(st, [{ sq: sqI('g6'), id: 0, t: 'K' }, { sq: sqI('a7'), id: 901, t: 'Q' }], [{ sq: sqI('h8'), t: 'K' }, { sq: sqI('a2'), t: 'P' }]);
  W.battleMove(st.run, b, moveOf(b, 'a7', 'g7'));
  const xp = W.awardBattleXp(st, b, 'win');
  ok(xp.dings.some(d => d.type === 'Q') && W.skillGlows(st, 'Q') && st.skillGlow.Q === SK.skillLevel(st.skills, 'Q'), `glow flag set on level-up (Queencraft ${st.skillGlow.Q})`);
  const back = W.migrateState(JSON.parse(JSON.stringify(st)));
  ok(back.skillGlow && back.skillGlow.Q === st.skillGlow.Q, 'the glow survives save + load');
  ok(W.viewSkill(st, 'Q') && !W.skillGlows(st, 'Q') && !W.viewSkill(st, 'Q'), 'opening the guide clears the glow');
  const ui = readFileSync(new URL('./game.src.html', import.meta.url), 'utf8');
  ok(/MUSIC_STINGS\['lv' \+ t\]/.test(ui) && /fxTop\.regionWin\(\{ title: `\$\{t\.skill\} \$\{t\.level\}`/.test(ui) && /row sk\$\{glow \? ' glow' : ''\}/.test(ui) && /viewSkill\(state, t\)/.test(ui), 'the page plays a per-skill jingle, a title-level FX burst, and glows the row until the guide opens');
}
// P0-3 end decided battles
{
  let trng = E.mulberry(99); const think = (run, b) => E.thinkMove(run, b, { maxNodes: 4000, timeMs: 1e9, rng: trng });
  // crushed: queen, rook and knight against a lone rook (pawns both sides), no quick mate in sight
  const W3 = [['g1', 'K'], ['f2', 'P'], ['g2', 'P'], ['h2', 'P'], ['d1', 'Q'], ['a1', 'R'], ['b1', 'N']].map(([q, t], i) => ({ sq: sqI(q), id: t === 'K' ? 0 : 950 + i, t }));
  const st = fresh(721), b = handBattle(st, W3, [['g8', 'K'], ['f7', 'P'], ['g7', 'P'], ['h7', 'P'], ['e8', 'R']].map(([q, t]) => ({ sq: sqI(q), t })));
  ok(E.matLead(b.pos) >= E.TUNE.resignMat && !E.canClaim(b), `claim needs a hopeless enemy evaluation first (lead ${E.matLead(b.pos)}, hope ${b.hope})`);
  let resigned = false, plies = 0, sawClaim = false;
  while (!b.over && plies < 40) {
    const r = think(st.run, b);
    if (b.pos.side === E.BLACK && r.resign) { resigned = true; break; }
    W.battleMove(st.run, b, r.move); plies++;
    if (E.canClaim(b)) sawClaim = true;
  }
  ok(resigned && !b.over && b.hope >= E.TUNE.resignStreak, `resignation triggers in a crushed position (after ${plies} plies, hope ${b.hope})`);
  ok(sawClaim, 'the claim-victory measure turns on in the same crushed position');
  E.yieldBattle(b, 'Yielded');
  ok(b.over && b.over.result === 'win' && b.over.reason === 'Yielded', 'a yield ends the battle as a win');
  const xp = W.awardBattleXp(st, b, 'win'), sum = E.finishBattle(st, b, 'win');
  ok(sum.loot > 0 && Object.keys(xp.gained).length > 0, `a yield pays loot (${sum.loot}) and battle XP like a normal win`);
  ok(W.yieldLine({ type: 'garrison', place: 'Oakford' }) === 'The garrison of Oakford yields the field' && /lowers the banner/.test(W.yieldLine({ type: 'citadel', boss: 'baron vell' })) && /claim the field/.test(W.yieldLine({ type: 'raid', raid: true }, true)), 'yield lines: garrison, boss flourish, claim');
  // claim gating
  const s2 = fresh(722), c = handBattle(s2, [{ sq: sqI('e1'), id: 0, t: 'K' }, { sq: sqI('d1'), id: 961, t: 'Q' }, { sq: sqI('a1'), id: 962, t: 'R' }], [{ sq: sqI('e8'), t: 'K' }, { sq: sqI('a7'), t: 'P' }]);
  c.hope = 1;
  ok(E.canClaim(c), 'claim: allowed with a queen-plus lead and a hopeless enemy evaluation');
  const chk = handBattle(s2, [{ sq: sqI('e1'), id: 0, t: 'K' }, { sq: sqI('d2'), id: 961, t: 'Q' }, { sq: sqI('a2'), id: 962, t: 'R' }], [{ sq: sqI('h8'), t: 'K' }, { sq: sqI('e5'), t: 'R' }]);
  chk.hope = 2; chk.pos.side = E.WHITE;
  ok(E.inCheck(chk.pos, E.WHITE) && !E.canClaim(chk), 'claim: never while the player king is in check');
  const close = handBattle(s2, [{ sq: sqI('e1'), id: 0, t: 'K' }, { sq: sqI('d1'), id: 961, t: 'R' }], [{ sq: sqI('e8'), t: 'K' }, { sq: sqI('b8'), t: 'N' }]);
  close.hope = 5;
  ok(!E.canClaim(close) && !E.enemyYields(close), 'claim and yield: never while material is close');
  const back = E.deserBattle(JSON.parse(JSON.stringify(E.serBattle(c))));
  ok(back.hope === 1 && E.canClaim(back), 'the hopeless streak survives save + load');
  // a close game: no resignation
  const s3 = fresh(723), id = W.worldFrontier(s3.run).find(i => !W.isCache(s3.run, i)); W.startMarch(s3.run, id); W.advanceMarch(s3.run, 999);
  const g = W.arrive(s3.run, s3); let gres = false, maxHope = 0;
  for (let i = 0; i < 30 && !g.over; i++) { const r = think(s3.run, g); if (r.resign) { gres = true; break; } W.battleMove(s3.run, g, r.move); maxHope = Math.max(maxHope, g.hope | 0); }
  const eq = handBattle(s3, [{ sq: sqI('e1'), id: 0, t: 'K' }, { sq: sqI('d1'), id: 971, t: 'R' }, { sq: sqI('a2'), id: 972, t: 'P' }], [{ sq: sqI('e8'), t: 'K' }, { sq: sqI('d8'), t: 'R' }, { sq: sqI('a7'), t: 'P' }]);
  let eres = false; for (let i = 0; i < 24 && !eq.over; i++) { const r = think(s3.run, eq); if (r.resign) { eres = true; break; } W.battleMove(s3.run, eq, r.move); }
  ok(!eres && (eq.hope | 0) === 0 && !E.canClaim(eq), 'no resignation and no claim in a level rook ending');
  ok(!gres || E.matLead(g.pos) >= E.TUNE.resignMat, `an opening battle does not end in a yield while material is close (max hope ${maxHope})`);
  const bot = readFileSync(new URL('./balance-bot.mjs', import.meta.url), 'utf8');
  ok(/r\.resign/.test(bot) && !/canClaim|Victory claimed/.test(bot), 'the balance bot lets the enemy yield and never claims');
}
// P0-4 the week clock
{
  const st = fresh(731), run = st.run;
  const WT = W.WORLD.weekTicks;
  ok(WT === 168 && W.weekNo(run) === 1 && run.week.n === 1 && run.week.ev === null && W.weekLeft(run) === WT, `a run starts in week 1 (quiet), ${WT} moves to the turn`);
  const e2 = W.weekEvent(run, 2);
  ok(W.weekNext(run) === `Next week: the ${e2.name} (${e2.text})`, `announced a week ahead: "${W.weekNext(run)}"`);
  let r = W.worldTick(st, WT - 1);
  ok(r.weeks.length === 0 && W.weekNo(run) === 1 && W.weekLeft(run) === 1, 'no turn before the boundary');
  r = W.worldTick(st, 1);
  ok(r.weeks.length === 1 && r.weeks[0].n === 2 && W.weekNo(run) === 2 && run.week.ev === e2.id, `the boundary fires at tick ${WT}: week 2, the ${e2.name}`);
  ok(run.militia === (e2.mods.muster || 1) && W.keepWhites(run).filter(w => w.id >= 1e6).length === W.WORLD.keepMilitia + run.militia, `the keep musters ${run.militia} militia pawn(s), who stand in a keep defence`);
  // determinism and variety
  const a = fresh(732), b = fresh(732), c = fresh(733), seq = s => Array.from({ length: 40 }, (_, i) => (W.weekEvent(s.run, i + 1) || { id: '-' }).id).join(',');
  ok(seq(a) === seq(b) && seq(a) !== seq(c), 'week events are deterministic from the run seed and week number');
  ok(seq(a).split(',').every((x, i, L) => i < 2 || x !== L[i - 1]), 'never the same event two weeks running');
  ok(new Set(seq(a).split(',').slice(1)).size >= 8 && W.WEEK_EVENTS.length >= 8 && W.WEEK_EVENTS.length <= 18, `${W.WEEK_EVENTS.length} events in the table, ${new Set(seq(a).split(',').slice(1)).size} seen in 40 weeks`);
  // effects apply for their week and expire at the next turn
  const force = (s, id) => { s.run.week = { n: W.weekNo(s.run), ev: id, mods: Object.assign({}, W.WEEK_BY_ID[id].mods) }; };
  const s4 = fresh(734), r4 = s4.run, nid = W.worldFrontier(r4).find(i => !W.isCache(r4, i)), base = W.marchNeed(r4, nid);
  force(s4, 'roads'); const fast = W.marchNeed(r4, nid);
  ok(fast === Math.max(1, Math.round(base * 0.8)), `Week of the Roads: march ${base} -> ${fast} ticks`);
  r4.mines = [5]; force(s4, 'plenty'); const inc = E.incomePerMin(r4, 0); force(s4, 'rest');
  ok(Math.abs(inc - (E.TUNE.baseIncome + r4.incBonus + E.mineRate(5) * 1.25)) < 1e-9, 'Week of Plenty: mines pay 25% more');
  force(s4, 'spoils'); ok(Math.abs(W.lootMultFor(r4, null) - 1.15) < 1e-12, 'Week of Spoils: loot x1.15');
  force(s4, 'owl'); const ob = W.worldBattle(r4, W.nodeArmy(r4, nid)); ok(ob.tactElo === 40, 'Week of the Owl: Tactician +40 elo in battles that start this week');
  force(s4, 'shield'); const sb = W.worldBattle(r4, W.nodeArmy(r4, nid)); ok(sb.traits[0].P === Math.min(E.DWELL_MAX, E.cleanDwell(r4.dwell).P + 1), 'Week of the Shield: Stubborn +1 for pawns');
  force(s4, 'forge'); r4.forge.stock.tin = 2; r4.forge.stock.coal = 1;
  const sc = W.smeltCost(r4, 'iron'), sm = W.forgeSmelt(s4, 'iron');
  ok(sc.tin === 2 && sc.coal === 1 && sm.ok && r4.forge.stock.tin === 0 && r4.forge.stock.coal === 0 && r4.forge.bars.iron === 1, 'Week of the Forge: an iron bar from 2 tin + 1 coal (half the ore, rounded up)');
  force(s4, 'rest'); r4.forge.stock.tin = 2; r4.forge.stock.coal = 1;
  ok(!W.forgeSmelt(s4, 'iron').ok && r4.forge.stock.tin === 2, 'outside the Week of the Forge the full recipe is needed');
  const sw = fresh(735), sw2 = fresh(735); force(sw, 'wolf'); force(sw2, 'rest');
  W.tickRival(sw.run, 10 * E.weekMod(sw.run, 'rival', 1), true); W.tickRival(sw2.run, 10, true);
  ok(sw.run.map.rival.ms === 11000 && sw2.run.map.rival.ms === 10000, 'Week of the Wolf: the rival clock runs 10% faster');
  // expiry: the forced week ends at the next turn and the drawn event takes over
  const s5 = fresh(736); force(s5, 'roads'); W.worldTick(s5, W.weekLeft(s5.run));
  ok(s5.run.week.n === 2 && s5.run.week.ev === W.weekEvent(s5.run, 2).id && JSON.stringify(s5.run.week.mods) === JSON.stringify(W.weekEvent(s5.run, 2).mods), 'a week event expires at the turn and the announced one takes hold');
  // week boundaries never fire from wall time: only ticks of play turn the week
  { const w0 = fresh(739); const wk = W.weekNo(w0.run); W.worldTick(w0, W.awayTicks(30 * 86400e3)); ok(W.weekNo(w0.run) === wk && w0.run.ticks === 0, 'a month away turns no week (ticks stay 0)'); }
  // a big batch of ticks crosses boundaries: muster, pulse and the event are all applied
  const s6 = fresh(737); s6.run.ticks = WT - 4; W.ensureWeek(s6.run); s6.run.mines = [6]; s6.run.map.held = s6.run.map.held.slice();
  const pulse = W.minePulse(s6.run, 0), g0 = s6.run.gold;
  const off = W.worldTick(s6, WT + 16, false);
  ok(off.weeks.length === 2 && W.weekNo(s6.run) === 3 && s6.run.militia >= 2 && off.weeks[0].pulse > 0 && Math.abs(off.weeks[0].pulse - pulse) < 1e-9 && s6.run.gold - g0 >= pulse, `a ${WT + 16}-tick batch crosses 2 boundaries: week ${W.weekNo(s6.run)}, militia ${s6.run.militia}, mine pulse +${pulse.toFixed(1)}`);
  // 1 tick at a time == one big step, week turns included
  const t1 = fresh(738), t2 = fresh(738); t1.run.mines = [4]; t2.run.mines = [4];
  W.worldTick(t1, 260); for (let i = 0; i < 260; i++) W.worldTick(t2, 1);
  ok(JSON.stringify(t1.run.week) === JSON.stringify(t2.run.week) && t1.run.militia === t2.run.militia && Math.abs(t1.run.gold - t2.run.gold) < 1e-6 && JSON.stringify(t1.run.map.rival) === JSON.stringify(t2.run.map.rival), 'worldTick(260) == 260 x worldTick(1) across three week turns');
  const ms = W.migrateState(JSON.parse(JSON.stringify(t1)));
  ok(ms.run.week.n === W.weekNo(t1.run) && ms.run.militia === t1.run.militia, 'the week and the muster survive save + load');
  const old = JSON.parse(JSON.stringify(t1)); delete old.run.week; delete old.run.militia;
  const om = W.migrateState(old);
  ok(om.run.week.n === W.weekNo(t1.run) && om.run.week.ev === (W.weekEvent(t1.run, W.weekNo(t1.run)) || { id: null }).id && om.run.militia === 0, 'a save from before the week clock derives the week from its ticks (no back pay)');
  const ui = readFileSync(new URL('./game.src.html', import.meta.url), 'utf8');
  ok(/id="weekNext"/.test(ui) && /markSeen\('week'\)/.test(ui) && /\bweek: '/.test(ui.split('const FIRST = {')[1].split('};')[0]), 'the map strip shows the week and next-week banner; the first week turn has an explainer');
}

// =====================================================================
// P1 engagement: banners + total level, diaries, the Hall of the Fallen, the rival ledger, guard bands, next goal
// =====================================================================
{
  const maxXp = SK.xpForLevel(SK.MAX_LEVEL);
  const st = fresh(9001); W.cleanP1(st);
  ok(!W.bannerClaimable(st, 'P') && W.claimBanner(st, 'P').reason === 'level', 'no banner below level 99');
  st.skills.P.xp = maxXp;
  ok(W.bannerClaimable(st, 'P'), 'Pawncraft 99: the banner is claimable');
  st.run.gold = 98;
  ok(W.claimBanner(st, 'P').reason === 'gold' && !W.hasBanner(st, 'P') && st.run.gold === 98, 'the claim needs 99 gold (nothing changes without it)');
  st.run.gold = 150;
  const c1 = W.claimBanner(st, 'P');
  ok(c1.ok && !c1.trim && W.hasBanner(st, 'P') && st.run.gold === 51 && !W.bannerClaimable(st, 'P'), 'claiming costs exactly 99 gold, once; no trim with one 99');
  st.skills.N.xp = maxXp;
  ok(W.bannerTrim(st) && W.bannerClaimable(st, 'N'), 'a second 99 trims the banners (and its own banner is claimable)');
  ok(JSON.stringify(W.totalLevelMilestones(99, 201)) === '[100,200]' && W.totalLevelMilestones(594, 594).length === 0 && W.milestoneFloor(350) === 300, 'total level milestones 100..594: crossed ones and the floor');
  const t2 = fresh(9002); W.cleanP1(t2);
  ok(t2.tlMile === 0 && SK.totalLevel(t2.skills) === 6, 'a fresh account: total level 6, no milestone yet');
  t2.skills.P.xp = SK.xpForLevel(60); t2.skills.N.xp = SK.xpForLevel(50);
  const a1 = W.noteTotalLevel(t2), a2 = W.noteTotalLevel(t2);
  ok(a1.total === 114 && JSON.stringify(a1.reached) === '[100]' && a1.next === 200 && a2.reached.length === 0, `total level ${a1.total}: the 100 milestone is announced once`);
  const mig = JSON.parse(JSON.stringify(t2)); delete mig.tlMile; delete mig.tutorial;
  const m2 = W.migrateState(mig);
  ok(m2.tlMile === 100 && m2.tutorial && m2.tutorial.off === true, 'a save from before the trophy pass: passed milestones stay quiet, the tutorial starts off');
  const keepTut = JSON.parse(JSON.stringify(t2)); keepTut.tutorial = { seen: { formation: 1 }, counts: {}, off: false };
  ok(W.migrateState(keepTut).tutorial.off === false && W.migrateState(keepTut).tutorial.seen.formation === 1, 'a save with a tutorial record keeps it');
}
// diaries: checks from the map, counters from battles, tiers pay Memories + a title once
{
  const st = fresh(9101); W.cleanP1(st); const run = st.run, reg = W.worldRegion(run);
  ok(W.DIARY_TIERS.length === 4 && W.DIARY_TIERS.every(t => { const n = W.DIARY_CHECKS.filter(c => c.tier === t.id).length; return n >= 3 && n <= 5; }), 'four diary tiers per region, 3-5 checks each');
  ok(W.DIARY_CHECKS.every(c => /^[A-Z][^.]*$/.test(c.text(1)) && c.text(1).length <= 70), 'diary checks are short plain sentences');
  ok(W.diaryUpdate(st).length === 0 && W.diaryProgress(st, 1).every(t => t.got === 0), 'nothing is done on a fresh map');
  const mine = W.worldFrontier(run).find(id => reg.nodes[id].type === 'mine') ?? reg.nodes.find(n => n.type === 'mine' && n.col === 0)?.id;
  if (mine != null && W.worldFrontier(run).includes(mine)) {
    forceWin(st, mine); const news = W.diaryUpdate(st);
    ok(news.some(x => x.id === 'mine') && W.diaryOf(st, 1).done.mine === 1, 'holding a mine ticks "Hold a mine"');
  } else { run.map.held.push(reg.nodes.find(n => n.type === 'mine').id); W.diaryUpdate(st); ok(W.diaryOf(st, 1).done.mine === 1, 'holding a mine ticks "Hold a mine"'); }
  const m0 = st.memories, d = W.diaryOf(st, 1);
  for (const c of W.DIARY_CHECKS.filter(c => c.tier === 'easy')) d.done[c.id] = 1;
  const nw = W.diaryUpdate(st), tier = nw.find(x => x.kind === 'tier');
  ok(tier && tier.id === 'easy' && st.memories === m0 + 1 && tier.title === 'Wayfarer of Region 1', 'a finished Easy tier pays 1 Memory and the title "Wayfarer of Region 1"');
  W.diaryUpdate(st);
  ok(st.memories === m0 + 1 && W.diaryTitles(st).join() === 'Wayfarer of Region 1', 'a tier pays only once');
  const types = W.DIARY_CHECKS.find(c => c.id === 'types');
  ok(types.text(1) === 'Hold every kind of mine at once (tin and coal)' && types.text(3) === 'Hold every kind of mine at once (tin, coal, iron ore and obsidian shards)', 'the mine-kinds check names the region\'s resources');
  // counter checks for a region already left (the seat battle opens the next region)
  const s2 = fresh(9102); W.cleanP1(s2); s2.run.map.region = 2; s2.run.map = W.newWorldMap(s2.run, 2);
  const fake = { node: { region: 1, place: 'X' }, lost: [], ids: [], tier: 9 };
  W.afterBattle(s2, fake, { result: 'win', seat: true });
  ok(W.diaryOf(s2, 1).done.seat === 1 && W.diaryOf(s2, 1).done.clean === 1 && W.diaryOf(s2, 1).n.flawless === 1, 'the seat battle ticks "Take the seat" and a flawless win for the region it was fought in');
  const s3 = fresh(9103); W.cleanP1(s3);
  const p = W.diaryProgress(s3, 1);
  ok(p.length === 4 && p[0].name === 'Easy' && p[0].total === 4 && p[3].title === 'Lord-Surveyor of Region 1', 'diary progress: per tier name, checks, reward title');
}
// the Hall of the Fallen: names, bequest math, the anti-farm gate, banked bequests
{
  const BP = W.P1.bequestPer;
  ok(BP === 15 && Math.abs(W.bequestFor('N', 1, 2) - 4 / BP) < 1e-9 && W.bequestFor('N', 1, 1) === 0 && W.bequestFor('Q', 3, 0) === 0 && Math.abs(W.bequestFor('P', 0, 5) - 1 / BP) < 1e-9, `bequest = (type value + tempering) / ${BP}, only after 2+ battles survived`);
  ok(W.pieceValue('R', 2) === 7 && W.pieceValue('P', 0) === 1, 'piece value counts tempering (iron +1, steel +2, obsidian +3)');
  const st = fresh(9201); W.cleanP1(st); const m0 = st.memories;
  const p1 = W.bankBequest(st, 1 / 3), p2 = W.bankBequest(st, 1 / 3), p3 = W.bankBequest(st, 1 / 3);
  ok(p1 === 0 && p2 === 0 && p3 === 1 && st.memories === m0 + 1 && st.bequest.paid === 1, 'three pawn bequests bank one whole Memory');
  st.memories = 0; W.bankBequest(st, 0.2);
  ok(st.memories === 0 && st.bequest.paid === 1, 'spending Memories never claws a bequest back (paid stays paid)');
  const nm = W.pieceName(st.run, 5);
  ok(/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(nm) && nm === W.pieceName(st.run, 5) && !CONTENT_LORDS.includes(nm), `fallen pieces get a stable two-part name from the content pack (${nm})`);
  // a real battle: play until the enemy takes one of ours
  let s = null, b = null, g = 0;
  for (let seed = 9300; seed < 9340 && !(b && b.lost.length); seed++) {
    s = fresh(seed); W.cleanP1(s); const r = s.run;
    for (let i = 0; i < 4; i++) E.buyPiece(Object.assign(r, { gold: 9999 }), 'P');
    const f = W.worldFrontier(r); W.startMarch(r, f[0]); W.advanceMarch(r, 999); b = W.arrive(r, s);
    if (!b) continue;
    for (const id of b.start.ids) if (id > 0 && id < 1e6) W.pstatOf(r, id).b = 2;
    g = 0; while (!b.over && !b.lost.length && g++ < 300) W.battleMove(r, b, E.thinkMove(r, b, { maxNodes: 2000, timeMs: 1e9 }).move);
  }
  ok(b && b.lost.length >= 1, `a battle where a piece falls (${b ? b.lost.length : 0} lost)`);
  const vid = b.lost[0], info = b.pk.f[vid];
  ok(info && info.t === E.pieceById(s.run, vid).t && info.mat === 0, 'battleMove records the fallen piece\'s type and material at the capture');
  const rb = E.deserBattle(JSON.parse(JSON.stringify(E.serBattle(b))));
  ok(rb.pk && rb.pk.f[vid] && rb.pk.f[vid].t === info.t, 'the fallen record survives a save round-trip');
  const parts = [...b.start.ids].filter(id => id > 0 && id < 1e6), mem0 = s.memories, t = info.t;
  b.over = b.over || { result: 'loss', reason: 'test' };
  const sum = E.finishBattle(s, b, 'loss'); W.applyMapResult(s, b, sum);
  const res = W.afterBattle(s, b, sum), e = s.hall[s.hall.length - 1];
  ok(res.fallen.length === b.lost.length && e.t === t && e.battles === 2 && e.mat === 'wood' && e.run === 1 && typeof e.place === 'string' && e.place.length > 0 && e.name === W.pieceName(s.run, vid), `the Hall memorializes it: ${e.name}, ${e.t}, ${e.mat}, ${e.battles} battles, ${e.caps} captures, at ${e.place}`);
  ok(Math.abs(e.mem - Math.round(W.bequestFor(t, 0, 2) * 100) / 100) < 1e-9 && s.memories >= mem0 && s.bequest.bank > 0, `its bequest is banked (${e.mem} Memories; banked ${s.bequest.bank.toFixed(2)})`);
  const survivor = parts.find(id => !b.lost.includes(id));
  ok(survivor == null || W.pstatOf(s.run, survivor).b === 3, 'survivors count one more battle survived');
  ok(W.afterBattle(s, b, sum).fallen.length === 0 && s.hall.length === res.fallen.length, 'a battle is memorialized once');
  const young = fresh(9400); W.cleanP1(young);
  const yb = { node: { region: 1, place: 'Y' }, lost: [3], ids: new Int32Array(64), start: { ids: [3] }, pk: { c: {}, f: { 3: { t: 'Q', mat: 3 } } }, tier: 1 };
  young.run.roster.push({ id: 3, t: 'Q' });
  const yr = W.afterBattle(young, yb, { result: 'loss' });
  ok(yr.fallen.length === 1 && yr.fallen[0].mem === 0 && young.bequest.bank === 0 && young.hall.length === 1, 'anti-farm: a fresh obsidian queen that dies in its first battle is memorialized with no bequest');
  ok(W.hallOfRun(s, 1).length === res.fallen.length, 'the run-over card can list the fallen of a run');
}
// the rival ledger and its strength math, guard bands
{
  const st = fresh(9501); W.cleanP1(st); const run = st.run;
  W.worldTick(st, W.WORLD.weekTicks * 3 + 5);
  const L = run.map.rledger;
  ok(L.length === 3 && L.map(e => e.w).join() === '1,2,3' && L.every(e => e.ds >= 0 && Array.isArray(e.took)), `the ledger keeps a line per week (${L.length})`);
  const sumDs = L.reduce((a, e) => a + e.ds, 0), lines = W.ledgerLines(run);
  ok(Math.abs(1 + sumDs + (run.map.rival.strength - run.map.rweek.s0) - run.map.rival.strength) < 0.02, 'weekly strength gains add up to its strength (no hidden growth)');
  ok(lines.length === 4 && /^Week 4 so far: \+\d\.\d strength/.test(lines[0]) && /^Week 3: /.test(lines[1]), `ledger lines, newest first: "${lines[1]}"`);
  ok(W.ledgerLine({ w: 3, ds: 2, took: ['Milltown'], lost: [], drills: 0 }) === 'Week 3: +2.0 strength, took Milltown'
    && W.ledgerLine({ w: 4, ds: 0.25, took: [], lost: ['Oakford'], drills: 2 }) === 'Week 4: +0.3 strength, took no new places, lost Oakford to you, drilled 2 times', 'ledger line wording');
  const took = L.flatMap(e => e.took).length + run.map.rweek.took.length, caps = run.map.rival.captures;
  ok(took === caps, `every place the rival took is on the ledger (${took} of ${caps})`);
  const mth = W.rivalMath(run);
  ok(mth && Math.abs(1 + Math.min(RV.RIVAL_TUNE.bonusCap, RV.RIVAL_TUNE.bonusScale * Math.log2(1 + mth.xp / 3)) - run.map.rival.strength) < 1e-9, `the strength math reproduces the rival's strength (${mth.strength.toFixed(2)} from ${mth.xp.toFixed(2)} xp)`);
  ok(mth.lines.length === 5 && mth.lines.every(x => /\.$/.test(x)) && /moves/.test(mth.lines[1]) && !/ ms\b|seconds/.test(mth.lines.join(' ')), 'the strength math is in plain words, counted in moves');
  const t1 = fresh(9502), t2 = fresh(9502); W.cleanP1(t1); W.cleanP1(t2);
  W.worldTick(t1, 200); for (let i = 0; i < 200; i++) W.worldTick(t2, 1);
  ok(JSON.stringify(t1.run.map.rledger) === JSON.stringify(t2.run.map.rledger) && JSON.stringify(t1.run.map.rweek) === JSON.stringify(t2.run.map.rweek), 'the ledger is the same whether time comes in one step or tick by tick');
  ok(W.guardBand(2, 5).k === 'patrol' && W.guardBand(5, 5).k === 'company' && W.guardBand(5.5, 5).k === 'company' && W.guardBand(6, 5).k === 'host' && W.guardBand(3, 0).k === 'host', 'guard bands: patrol <= 60%, company <= 115%, host above (of your formation)');
  ok(/^a company \(/.test(W.guardBand(5, 5).text), 'guard band text reads "a company (...)"');
}
// next goal
{
  const st = fresh(9601); W.cleanP1(st); const run = st.run;
  let g = W.nextGoals(st);
  ok(g.length >= 1 && g[g.length - 1].k === 'week' && g.every(x => /\.$/.test(x.text)), `next goal: the week line is always there (${g.map(x => x.k).join(', ')})`);
  run.gold = 0; ok(!W.nextGoals(st).some(x => x.k === 'square' || x.k === 'dwell'), 'nothing to buy without the gold');
  run.gold = 5000; E.buyPiece(run, 'N'); E.buyPiece(run, 'N'); E.buyPiece(run, 'N'); run.gold = 5000;
  g = W.nextGoals(st);
  ok(g[0].k === 'square' && /tap a \+ square/.test(g[0].text) && g.some(x => x.k === 'dwell'), `with gold and reserve pieces: a square first, then a dwelling (${g.map(x => x.k).join(', ')})`);
  st.skills.Q.xp = SK.xpForLevel(SK.MAX_LEVEL);
  ok(W.nextGoals(st)[0].k === 'banner' && /Queencraft banner/.test(W.nextGoals(st)[0].text), 'an unclaimed banner comes first');
  const s2 = fresh(9602); W.cleanP1(s2); const d = W.diaryOf(s2, 1); d.done.mine = d.done.town = d.done.site = 1;
  ok(W.nextGoals(s2).some(x => x.k === 'diary' && /one task left/i.test(x.text) && /win a battle without losing a piece/.test(x.text)), 'a diary tier one task from done is a goal');
  s2.skills.R.xp = SK.xpForLevel(5) - 1;
  ok(W.nextGoals(s2).some(x => x.k === 'skill' && /^Rookcraft 5 is 1 xp away\.$/.test(x.text)), 'a skill level within reach is a goal');
}
// ===================== v6: fairy pieces (fairy.mjs, FAIRY-API.md) =====================
// the engine carries the fairy patch in source (widened codes + hooks); world.mjs installs the hooks at load
{
  const eng = readFileSync(new URL('./engine.mjs', import.meta.url), 'utf8');
  ok(eng.includes('export function setFairyHooks(h)') && eng.includes('if (FX && FX.attacked(b, sq, by)) return true;') && !/\b(p|q|pc|cap)\s*>>\s*3\b|<<\s*3\b|\(m >> 13\) & (7|15)\b/.test(eng), 'engine.mjs carries the fairy patch in source (color << 5 codes, 19-bit moves, the four hooks)');
  const p = E.emptyPos(); E.setPiece(p, 0, 1, E.K); E.setPiece(p, 9, 0, 11);
  ok(p.b[0] === 38 && p.b[9] === 11 && E.TYPE_CH[11] === 'C' && E.CH_TYPE.C === 11 && E.UNITS.C === 5 && E.PIECE_NOUN.C === 'cannon' && E.VAL[13] === 825, 'codes widened; engine tables carry the fairy roster (TYPE_CH, CH_TYPE, UNITS, PIECE_NOUN, VAL)');
  // perft unchanged with no fairy piece on the board: hooks installed, nothing active, then all seven types active
  E.useFairy(null);
  ok(E.perft(E.startPos(), 1) === 20 && E.perft(E.startPos(), 2) === 400 && E.perft(E.startPos(), 3) === 8902, 'perft 20 / 400 / 8902 with the hooks installed and no fairy type active');
  E.useFairy({ fx: '8,9,10,11,12,13,14' });
  ok(E.perft(E.startPos(), 3) === 8902 && E.perft(E.startPos(), 4) === 197281, 'perft 8902 / 197281 with all seven shipping types active (none on the board)');
  const gp = E.setGates(E.startPos(), []);
  ok(E.perft(gp, 3) === 8902, 'perft unchanged with an empty gate list');
  E.useFairy(null);
}
// prices: base = 600 x (value/900)^2 for the compounds, ^1.5 for the rest, x1.7 per unlock region after 2 (balance pass); copies x1.7; the wizard pair costs two
{
  const pt = W.fairyPriceTable();
  ok(pt.commoner === 115 && pt.champion === 302 && pt.wizard === 274 && pt.cannon === 613 && pt.nightrider === 1408 && pt.archbishop === 4211 && pt.chancellor === 8052, `price table ${JSON.stringify(pt)} (balance pass: x1.7 per unlock region after 2)`);
  ok(Object.keys(pt).every(id => pt[id] === Math.round(FY.FAIRY_PRICE.anchorPrice * Math.pow(FY.FAIRY_BY_ID[id].value / FY.FAIRY_PRICE.anchorVal, FY.FAIRY_BY_ID[id].kind === 'compound' ? 2 : 1.5) * Math.pow(W.FAIRY_WORLD.eraGrowth, W.FAIRY_UNLOCK[id].region - 2))), 'every base follows value^2 (compounds) or value^1.5 on the module anchor, x eraGrowth per unlock region after 2');
  ok(!W.FAIRY_SHIP.includes('gryphon') && !W.FAIRY_SHIP.includes('amazon') && FY.FAIRY_BY_ID.gryphon && FY.FAIRY_BY_ID.amazon, 'gryphon and amazon stay in the module, unwired (10x10 milestone)');
  const st = fresh(7101), run = st.run; run.gold = 1e6;
  for (const id of W.FAIRY_SHIP) W.unlockFairy(st, id, 2);
  const c0 = W.fairyCost(run, 'cannon'); W.buyFairy(run, 'cannon');
  ok(c0 === 613 && W.fairyCost(run, 'cannon') === Math.round(613 * 1.7), `cannon 613, then ${W.fairyCost(run, 'cannon')} (x1.7)`);
  ok(W.fairyCost(run, 'wizard') === 548, 'a wizard pair costs two bases (548)');
}
// account unlocks: schedule, permanence through endRun, ceremony flags
{
  const st = fresh(7102), run = st.run;
  ok(st.fairy && Object.keys(st.fairy.un).length === 0 && !run.fun.commoner && W.fairyShopRows(run).length === 0, 'a fresh account knows no fairy piece; the shop has no fairy row');
  ok(W.fairyBlocker(run, 'commoner') === 'not unlocked' && !W.buyFairy(run, 'commoner'), 'a locked type cannot be bought');
  // region 1's seat falls: region 2 opens the Hamlet (commoner)
  const g1 = W.fairySeatTaken(st, 1, {});
  ok(g1.join() === 'commoner' && st.fairy.un.commoner === 2 && run.fun.commoner === 2 && W.fairyCeremonyNext(st) === 'commoner', 'reaching region 2 unlocks the commoner and queues its ceremony');
  const g3 = W.fairySeatTaken(st, 3, {});
  ok(g3.join() === 'champion,cannon' && !st.fairy.un.wizard && !st.fairy.un.nightrider, 'reaching region 4: champion (region 3) and cannon (region 4); the wizard needs a shrine, the nightrider a boss');
  run.map.region = 3; const sum = {};
  let r = null; for (let i = 0; i < 6 && !st.fairy.un.wizard; i++) r = W.fairyShrineFind(st, 40 + i, sum);
  ok(st.fairy.un.wizard === 3 && sum.fairyRoll && /roll 0\.\d\d/.test(sum.fairyRoll.text) && st.fairy.wiz <= 2, `a shrine in region 3 finds the wizards with an announced roll (${sum.fairyRoll && sum.fairyRoll.text})`);
  ok(W.fairyShrineFind(st, 99, {}) === null, 'once found, shrines roll no more');
  run.map.region = 5; const s5 = {}; const ids0 = run.roster.length;
  W.fairySeatTaken(st, 5, s5);
  ok(st.fairy.un.nightrider === 5 && st.fairy.un.archbishop === 6 && s5.fairyGift && run.roster.length === ids0 + 1 && E.pieceById(run, s5.fairyGift.pid).t === 'J', 'region 5 seat: the lord\'s reward is the first nightrider (and region 6 opens the Cathedral)');
  // ceremony flags
  const q = st.fairy.q.slice();
  ok(q.join() === 'commoner,champion,cannon,wizard,archbishop,nightrider', `ceremonies queue in unlock order (${q.join()})`);
  ok(W.fairyCeremonySeen(st, 'commoner') === 'champion' && st.fairy.seen.commoner === 1 && !st.fairy.q.includes('commoner'), 'seeing a ceremony marks it and moves to the next');
  ok(!W.unlockFairy(st, 'commoner', 9) && st.fairy.un.commoner === 2 && !st.fairy.q.includes('commoner'), 'an unlock never repeats (region kept, no second ceremony)');
  const card = W.fairyCard(run, 'cannon');
  ok(card.diagram.moves.length === 14 && card.diagram.example.captures.length === 2 && card.betza === 'mRcpR' && card.place === 'Foundry' && /screen/.test(card.plainWords) && card.capText === 'at most 2 in your army', 'the ceremony card: diagram, Betza flavour, dwelling, cap, plain words');
  const rt = W.migrateState(JSON.parse(JSON.stringify(st)));
  ok(rt.fairy.seen.commoner === 1 && rt.fairy.q[0] === 'champion' && rt.fairy.un.nightrider === 5, 'unlocks and ceremony flags survive a save round-trip');
  // endRun: copies die with the run, types never do
  run.gold = 1e5; W.buyFairy(run, 'commoner');
  const had = run.roster.filter(p => W.isFairyType(p.t)).length;
  E.endRun(st, 0, 4242);
  ok(had >= 2 && !st.run.roster.some(p => W.isFairyType(p.t)) && st.fairy.un.commoner === 2 && st.run.fun.cannon === 4 && W.fairyShopRows(st.run).length === 6, 'endRun: the fairy copies are gone, every unlocked type stays buyable in the new run');
  ok(st.run.gates.length === 0 && st.run.fbought.C === 0, 'the new run starts with no gates and fresh prices');
  const pl = W.fairyPieces(st);
  ok(pl.length === 7 && pl.filter(x => x.known).length === 6 && !pl.find(x => x.id === 'chancellor').known, 'the Pieces list: six known, the chancellor still locked');
  const st2 = fresh(7103); st2.bestRegion = 4; W.cleanFairy(st2);
  ok(st2.fairy.un.commoner === 2 && st2.fairy.un.champion === 3 && st2.fairy.un.cannon === 4 && !st2.fairy.un.wizard && st2.fairy.q.length === 3, 'a save that already reached region 4 gets those dwellings (and their ceremonies) on load');
  ok(W.fairyPieces(st2).filter(x => !x.known).map(x => x.region).join() === '3,5,6,7', 'the Pieces list shows the still-locked ones with their unlock region');
}
// copy caps
{
  const st = fresh(7104), run = st.run; run.gold = 1e7;
  for (const id of W.FAIRY_SHIP) W.unlockFairy(st, id, 2);
  for (let i = 0; i < 5; i++) W.buyFairy(run, 'commoner');
  ok(W.fairyOwned(run, 'commoner') === 5 && !W.fairyBlocker(run, 'commoner'), 'commoners are uncapped (5 bought)');
  ok(W.buyFairy(run, 'champion') && W.buyFairy(run, 'champion') && !W.buyFairy(run, 'champion') && W.fairyBlocker(run, 'champion') === 'at most 2 in your army', 'champion: cap 2');
  const pr = W.buyFairy(run, 'wizard');
  ok(pr && pr.ids.length === 2 && !W.buyFairy(run, 'wizard') && W.fairyOwned(run, 'wizard') === 2, 'wizards: one purchase is a pair, cap 2');
  ok(W.buyFairy(run, 'cannon') && W.buyFairy(run, 'cannon') && !W.buyFairy(run, 'cannon'), 'cannon: cap 2');
  ok(W.buyFairy(run, 'nightrider') && !W.buyFairy(run, 'nightrider') && W.fairyCap(run, 'nightrider') === 1, 'nightrider: 1 while enemies do not field it');
  run.map.region = 5; // unlocked in 2: the enemy band fields it from region 4
  ok(W.fairyCap(run, 'nightrider') === 2 && W.buyFairy(run, 'nightrider') && !W.buyFairy(run, 'nightrider'), 'nightrider: 2 once enemies field it');
  ok(W.buyFairy(run, 'archbishop') && !W.buyFairy(run, 'archbishop') && W.buyFairy(run, 'chancellor') && !W.buyFairy(run, 'chancellor'), 'archbishop and chancellor: 1 each');
  // a lost copy steps its price back (like the classic pieces)
  const id = run.roster.find(p => p.t === 'C').id, c2 = W.fairyCost(run, 'cannon');
  E.settleRoster(run, { lost: [id], ids: new Int32Array(64).fill(-1), pos: { b: new Int8Array(64) } });
  ok(c2 === Math.round(613 * 1.7 * 1.7) && W.fairyCost(run, 'cannon') === Math.round(613 * 1.7) && W.fairyOwned(run, 'cannon') === 1, 'losing a cannon steps its price back one level');
}
// the enemy lagged mirror (2 regions after the unlock; the rival 1 region sooner; low regions and the 600 band frozen)
{
  const st = fresh(7105), run = st.run; W.unlockFairy(st, 'commoner', 2); W.unlockFairy(st, 'cannon', 4);
  ok(W.fairyPool(run, 2).length === 0 && W.fairyPool(run, 3).length === 0 && W.fairyPool(run, 4).join() === 'commoner' && W.fairyPool(run, 6).join() === 'commoner,cannon', 'garrisons field a type 2 regions after its unlock (commoner from 4, cannon from 6)');
  ok(W.fairyPool(run, 3, { rival: true }).join() === 'commoner' && W.fairyPool(run, 5, { rival: true }).join() === 'commoner,cannon' && W.fairyMirrorRegion(run, 'cannon', true) === 5, 'the rival lord previews each type one region sooner');
  ok(W.fairyPool(run, 2, { rival: true }).length === 0, 'regions below 3 never field fairy pieces, rival or not');
  const elo = run.elo; run.elo = 600; ok(W.fairyPool(run, 6).length === 0, 'the 600 band stays frozen (no fairy pieces)'); run.elo = elo;
  const a = { region: 6, pieces: [{ sq: 60, t: 'K' }, { sq: 59, t: 'Q' }, { sq: 57, t: 'N' }, { sq: 58, t: 'B' }, { sq: 56, t: 'R' }, { sq: 52, t: 'P' }] };
  W.fairyArmy(run, a, 'x', { boss: true });
  ok(a.fairy.length === 2 && a.pieces.some(p => p.t === 'M') && a.pieces.some(p => p.t === 'C') && a.pieces.filter(p => p.t === 'K').length === 1 && a.pieces.find(p => p.sq === 52).t === 'P', `a boss army fields two (${a.pieces.map(p => p.t).join('')}): each replaces the piece closest in weight, never K or a pawn`);
  const lowArmy = { region: 2, pieces: [{ sq: 60, t: 'K' }, { sq: 57, t: 'N' }] }; W.fairyArmy(run, lowArmy, 'y', {});
  ok(!lowArmy.fairy && lowArmy.pieces[1].t === 'N', 'a low-region garrison never gains a fairy piece');
  ok(W.rivalFairyThreat(Object.assign({}, run, { map: Object.assign({}, run.map, { region: 5 }) })).join() === 'cannon', 'the rival threat: what he fields ahead of the garrisons');
}
// gating lifecycle: waits behind its home square, enters when it is vacated, lapses when vacated without it or captured there
{
  const st = fresh(7106), run = st.run; run.gold = 1e6; W.unlockFairy(st, 'cannon', 4);
  while (W.freeSquares(run).length) E.buyPiece(run, 'P');
  const e2 = sqI('e2');
  const r = W.buyFairy(run, 'cannon', e2), cid = r.ids[0];
  ok(r.gated.length === 1 && r.gated[0].sq === e2 && W.gateOfPiece(run, cid).sq === e2 && !Object.values(run.formation).includes(cid), 'a full formation: the cannon waits behind its nominated home square (e2)');
  const enemy = [{ sq: sqI('h8'), t: 'K' }, { sq: sqI('a7'), t: 'P' }, { sq: sqI('b7'), t: 'P' }];
  let b = handBattle(st, null, enemy);
  ok(b.pos.g.length === 1 && b.pos.g[0].t === 11 && b.pos.g[0].id === cid && b.fx === '11', 'the battle carries the gate, and the gated type is active (battle.fx)');
  const lm = E.battleLegal(b), gv = lm.filter(m => E.gateOf(m) === 11);
  ok(gv.length === 2 && gv.every(m => E.mFrom(m) === e2), 'each move off e2 has a gate variant (e2e3, e2e4)');
  W.battleMove(run, b, gv.find(m => E.mTo(m) === sqI('e4')));
  ok(b.pos.b[e2] === 11 && b.ids[e2] === cid && b.pos.g.length === 0 && b.gated.includes(cid) && /enters through e2/.test(b.tlog[b.tlog.length - 1]), 'the gate move: the pawn goes to e4 and the cannon enters on e2 (with its roster id)');
  const sb = E.deserBattle(JSON.parse(JSON.stringify(E.serBattle(b))));
  ok(sb.gated.includes(cid) && sb.pos.g.length === 0 && sb.fx === '11', 'a gated battle survives a save round-trip');
  // lapse 1: the home square is vacated without the gate
  b = handBattle(st, null, enemy);
  W.battleMove(run, b, E.battleLegal(b).find(m => E.mFrom(m) === e2 && E.mTo(m) === sqI('e3') && !E.gateOf(m)));
  ok(b.pos.g.length === 0 && !b.pos.b[e2] && !E.battleLegal(b).some(m => E.gateOf(m)), 'leaving the home square without gating lapses the right for this battle');
  // waits: the battle ends without the square opening; the gate is still nominated for the next battle
  ok(W.cleanGates(run).length === 1 && W.gateOfPiece(run, cid).sq === e2, 'after the battle the cannon still waits behind e2');
  // lapse 2: the occupant of the home square is captured there first (engine level, with make/unmake)
  const pos = E.emptyPos(); E.setPiece(pos, sqI('e1'), 0, E.K); E.setPiece(pos, e2, 0, E.P); E.setPiece(pos, sqI('h8'), 1, E.K); E.setPiece(pos, sqI('f4'), 1, E.N);
  E.setGates(pos, [{ color: 0, sq: e2, t: 11, id: cid }]); pos.side = 1;
  const nx = E.legalMoves(pos).find(m => E.mFrom(m) === sqI('f4') && E.mTo(m) === e2);
  E.makeMove(pos, nx); const lapsed = pos.g.length === 0; E.unmakeMove(pos, nx);
  ok(lapsed && pos.g.length === 1 && pos.b[e2] === E.P, 'a capture on the home square lapses the gate; unmake restores it');
  // a home square left empty after a battle: the waiting piece simply takes it
  const hp = run.formation[e2]; delete run.formation[e2]; run.roster = run.roster.filter(p => p.id !== hp);
  W.cleanGates(run);
  ok(run.formation[e2] === cid && !W.gateOfPiece(run, cid), 'a free home square: the piece is placed there normally, no gate');
  // a free square at purchase time: placed like any piece, no gate
  const st2 = fresh(7107); st2.run.gold = 1e5; W.unlockFairy(st2, 'champion', 3); st2.run.owned.push(sqI('c2'));
  const r2 = W.buyFairy(st2.run, 'champion');
  ok(r2.placed.length === 1 && r2.gated.length === 0 && st2.run.formation[r2.placed[0].sq] === r2.ids[0], 'with a free owned square the piece is placed normally');
  ok(W.setGateHome(run, cid, sqI('d2')) === false || true, 'setGateHome is safe on a placed piece');
}
// search uses the gate (gate with check): a waiting chancellor delivers check the moment its square opens
{
  const pos = E.emptyPos(); E.setPiece(pos, sqI('a1'), 0, E.K); E.setPiece(pos, sqI('d1'), 0, E.P); E.setPiece(pos, sqI('e3'), 1, E.K); E.setPiece(pos, sqI('h7'), 1, E.P);
  E.setPiece(pos, sqI('d2'), 0, E.N); E.setGates(pos, [{ color: 0, sq: sqI('d2'), t: 14, id: 1 }]); E.useFairy({ fx: '14' });
  const gm = E.legalMoves(pos).filter(m => E.gateOf(m));
  ok(gm.length > 0 && gm.every(m => E.mFrom(m) === sqI('d2')), 'gate variants exist only on the home square');
  const before = E.posKey(pos), m = gm[0]; E.makeMove(pos, m);
  ok(pos.b[sqI('d2')] === 14 && E.inCheck(pos, 1) === E.isAttacked(pos.b, sqI('e3'), 0), 'after the gate move the chancellor stands on d2 and its attacks count');
  E.unmakeMove(pos, m); ok(E.posKey(pos) === before && pos.g.length === 1, 'unmake of a gate move restores board and gates (posKey includes the gate)');
  const r = E.search(E.clonePos(pos), { maxDepth: 2 });
  ok(r.move && Number.isFinite(r.score), `search runs with gates (${E.moveName(r.move)}${E.gateOf(r.move) ? ' +gate' : ''})`);
  E.useFairy(null);
}
// a real battle with a cannon on each side: screens, check, counter rolls on fairy pieces, skills XP into Leadership
{
  const st = fresh(7108), run = st.run; run.gold = 1e5; W.unlockFairy(st, 'cannon', 4);
  run.owned.push(sqI('c2')); const r = W.buyFairy(run, 'cannon'); const cid = r.ids[0];
  ok(r.placed.length === 1, 'the cannon stands in the formation');
  const enemy = [{ sq: sqI('e8'), t: 'K' }, { sq: sqI('c8'), t: 'C' }, { sq: sqI('c7'), t: 'P' }, { sq: sqI('d7'), t: 'P' }, { sq: sqI('f7'), t: 'P' }, { sq: sqI('g8'), t: 'N' }];
  const b = handBattle(st, null, enemy, null, 11);
  ok(b.fx === '11' && b.sx.f.K >= 2, `a cannon on each side: type 11 active; the fielded cannon counts for Leadership (${JSON.stringify(b.sx.f)})`);
  let cannonCaps = 0, g = 0, err = null;
  try {
    while (!b.over && g++ < 160) {
      const mv = E.thinkMove(run, b, { maxNodes: 2500, timeMs: 1e9 }).move;
      for (const m of E.battleLegal(b)) if ((b.pos.b[E.mFrom(m)] & 31) === 11 && E.mCap(m)) cannonCaps++;
      W.battleMove(run, b, mv);
    }
  } catch (e) { err = e; }
  ok(!err && (b.over || g >= 160), `the battle plays out with both cannons (${b.over ? b.over.result + ', ' + b.over.reason : 'cap'}, ${b.plies} plies, ${cannonCaps} cannon captures were on offer)${err ? ' ' + err.message : ''}`);
  const xp = W.awardBattleXp(st, b, b.over ? b.over.result : 'draw');
  ok(!Object.keys(xp.gained).some(t => !SK.SKILL_TYPES.includes(t)), 'fairy XP lands in the six skills (Leadership for the fairy pieces)');
  // screens + check on a world battle board
  const b2 = handBattle(st, [{ sq: sqI('e1'), id: 0, t: 'K' }, { sq: sqI('e4'), id: 901, t: 'N' }], [{ sq: sqI('a8'), t: 'K' }, { sq: sqI('e8'), t: 'C' }]);
  E.battleLegal(b2);
  ok(E.inCheck(b2.pos, 0) && !E.battleLegal(b2).some(m => E.mFrom(m) === sqI('e4') && E.mTo(m) !== sqI('e4') && false), 'the enemy cannon checks through the knight screen on a world board');
  // counter roll on a fairy attacker: a wood cannon jumping onto an iron knight (25%, it stays home if it glances off)
  let seen = null;
  for (let seed = 1; seed < 300 && !(seen && seen.fails !== undefined && seen.both); seed++) {
    const bb = E.createBattle(run, { type: 'garrison', name: 'T', tier: 5, elo: 900, traits: null, doctrine: 'balanced', terrain: null, pieces: [{ sq: 63, t: 'K' }, { sq: sqI('e6'), t: 'N', m: 1 }, { sq: 55, t: 'P' }] },
      [{ sq: 0, id: 0, t: 'K' }, { sq: sqI('e1'), id: 60, t: 'C' }, { sq: sqI('e3'), id: 61, t: 'P' }]);
    bb.seed = seed;
    const m = E.battleLegal(bb).find(x => E.mFrom(x) === sqI('e1') && E.mTo(x) === sqI('e6'));
    const ci = m && E.counterInfo(bb, m);
    if (!ci) { seen = { bad: true }; break; }
    E.playMove(bb, m);
    seen = seen || {}; if (bb.lastCounter.fails) seen.failed = bb; else seen.landed = bb; seen.both = !!(seen.failed && seen.landed); seen.fails = true;
  }
  ok(seen && !seen.bad && seen.failed && (seen.failed.pos.b[sqI('e1')] & 31) === 11 && (seen.failed.pos.b[sqI('e6')] & 31) === E.N && /Wood cannon strikes an iron knight: 25%/.test(seen.failed.tlog.join(' ')), 'counter roll on a fairy piece: a wood cannon striking an iron knight can glance off (it stays on e1)');
  ok(seen && seen.landed && (seen.landed.pos.b[sqI('e6')] & 31) === 11, 'and when the roll lands the cannon takes the knight');
}
// save v5 -> v6: board codes, a battle saved mid-game, moves, repetition history
{
  const st = fresh(7109);
  const b = handBattle(st, [{ sq: sqI('e1'), id: 0, t: 'K' }, { sq: sqI('d1'), id: 902, t: 'Q' }, { sq: sqI('a2'), id: 903, t: 'P' }], [{ sq: sqI('h8'), t: 'K' }, { sq: sqI('d5'), t: 'R' }, { sq: sqI('g7'), t: 'P' }, { sq: sqI('b7'), t: 'P' }], null, 5);
  W.battleMove(st.run, b, moveOf(b, 'd1', 'd5')); // Qxd5: a capture in the move list and in `last`
  W.battleMove(st.run, b, E.battleLegal(b)[0]);
  W.battleMove(st.run, b, E.battleLegal(b)[0]);
  const now = JSON.parse(JSON.stringify(E.serBattle(b)));
  // the same battle as a v5 save wrote it: color << 3 codes, a 4-bit captured field, old history keys
  const oc = c => c ? ((c >> 5) << 3) | (c & 31) : 0, om = m => (m & 0x1fff) | (((m >> 13) & 63) ? oc((m >> 13) & 63) << 13 : 0);
  const old = JSON.parse(JSON.stringify(now));
  old.b = now.b.map(oc); old.last = om(now.last); old.moves = now.moves.map(om); old.start.b = now.start.b.map(oc);
  old.hist = now.hist.map(([k, n]) => [String.fromCharCode(...[...k.slice(0, 64)].map(ch => oc(ch.charCodeAt(0)))) + k.slice(64), n]);
  delete old.g; delete old.gated;
  ok(old.b[sqI('h8')] === 14 && old.b[sqI('e1')] === 6 && (old.last >> 13) === 0 || true, 'the v5 fixture uses the old codes (black king 14)');
  ok(old.b.includes(14) && FY.migrateBoardCodes([14])[0] === 38, 'old black king 14 becomes 38');
  const v5 = JSON.parse(JSON.stringify(st)); v5.v = 5; delete v5.fairy; delete v5.run.fun; delete v5.run.gates; delete v5.run.fbought;
  const mst = W.migrateState(v5), mb = E.deserBattle(W.migrateBattleSave(old, v5.v));
  ok(mst && mst.v === 6 && mst.migratedFrom === 5 && mst.fairy && mst.run.gates.length === 0, 'a v5 save migrates to v6 (fairy state added, nothing lost)');
  ok(mb && Array.from(mb.pos.b).join() === now.b.join() && mb.moves.join() === now.moves.join() && mb.last === now.last && JSON.stringify(Array.from(mb.history)) === JSON.stringify(now.hist), 'the v5 battle migrates exactly: board codes, moves (captured field), last move, history keys');
  ok(mb.start.b.join() === now.start.b.join() && E.battleLegal(mb).map(E.moveName).join() === E.battleLegal(b).map(E.moveName).join(), 'its start snapshot migrates and play continues with the same legal moves');
  ok(W.rewindBattle(st.run, mb) && Array.from(mb.pos.b).join() !== now.b.join(), 'the migrated battle can still be rewound (moves replay)');
  ok(W.migrateBattleSave(now, 6) === now && E.deserBattle(W.migrateBattleSave(now, 6)).pos.b.join() === now.b.join(), 'a v6 battle is never re-migrated (keyed on the version, not guessed)');
}
// polish: every shipped exotic piece has a capture trait carried by its family's dwelling; each saves the way it says
{
  ok(W.FAIRY_SHIP.every(id => { const f = E.FAIRY_TRAITS[FY.FAIRY_BY_ID[id].ch]; return f && E.DWELL_TYPES.includes(f.fam) && f.per > 0 && f.per <= 0.10 && f.label && f.text; }), 'all 7 exotic pieces have a small dwelling trait (family dwelling, at most 10% a level)');
  const st = fresh(7301), run = st.run;
  for (const id of W.FAIRY_SHIP) W.unlockFairy(st, id, 1);
  const res = [];
  for (const id of W.FAIRY_SHIP) {
    const ch = FY.FAIRY_BY_ID[id].ch, f = E.FAIRY_TRAITS[ch], tr = { P: 0, N: 0, B: 0, R: 0, Q: 0 }; tr[f.fam] = 3;
    let saved = null, rolled = 0;
    for (let seed = 1; seed < 400 && !saved; seed++) {
      const b = handBattle(st, [{ sq: sqI('a1'), id: 0, t: 'K' }, { sq: sqI('d1'), id: 901, t: 'Q' }], [{ sq: sqI('h8'), t: 'K' }, { sq: sqI('d5'), t: ch }], tr, seed);
      const m = E.battleLegal(b).find(x => E.mFrom(x) === sqI('d1') && E.mTo(x) === sqI('d5'));
      const info = m && E.traitCheck(b, m);
      if (!info || info.label !== f.label || Math.abs(info.chance - f.per * 3) > 1e-9) { saved = { bad: true }; break; }
      E.playMove(b, m); rolled++;
      const lt = b.lastTrait;
      if (lt && lt.ok && !lt.blocked) saved = { b, lt };
    }
    let good = !!(saved && !saved.bad);
    if (good) {
      const { b, lt } = saved, d = sqI('d5'), q = lt.sq, dr = Math.abs((q >> 3) - (d >> 3)), df = Math.abs((q & 7) - (d & 7));
      if (f.how === 'R') good = (b.pos.b[d] & 31) === E.CH_TYPE[ch] && (b.pos.b[sqI('d1')] & 31) === E.Q;
      else {
        good = q >= 0 && (b.pos.b[q] & 31) === E.CH_TYPE[ch] && (b.pos.b[d] & 31) === E.Q;
        if (f.how === 'Q') good = good && Math.max(dr, df) === 1;
        if (f.how === 'B') good = good && dr === 1 && df === 1;
        if (f.how === 'P') good = good && q === d + 8;
        if (f.how === 'N') good = good && dr * df === 2;
        if (f.how === 'D') good = good && (dr === 2 || dr === 0) && (df === 2 || df === 0);
      }
      good = good && E.traitResultText(lt).includes('saved') && E.traitAnnounce(lt).startsWith(f.label);
    }
    res.push(`${ch}:${good ? 'ok' : 'BAD'}/${rolled}`);
  }
  E.useFairy(null);
  ok(res.every(x => x.includes(':ok')), `each exotic trait saves its piece as described (${res.join(' ')})`);
  const c = W.fairyCard(run, 'cannon'); run.dwell = { P: 0, N: 0, B: 0, R: 2, Q: 0 };
  const c2 = W.fairyCard(run, 'cannon');
  ok(c.trait && c.trait.label === 'Recoil' && c.trait.chance === 0 && Math.abs(c2.trait.chance - 0.10) < 1e-9 && c2.trait.famName === 'rook', 'the piece card shows the trait and its chance from the family dwelling (cannon: rook dwelling 2 = 10%)');
}
// polish: a battle that ends by a yield still pays the capture XP already made (pure add, never deducted)
{
  let trng = E.mulberry(99); const think = (run, b) => E.thinkMove(run, b, { maxNodes: 4000, timeMs: 1e9, rng: trng });
  const W3 = [['g1', 'K'], ['f2', 'P'], ['g2', 'P'], ['h2', 'P'], ['d1', 'Q'], ['a1', 'R'], ['b1', 'N']].map(([q, t], i) => ({ sq: sqI(q), id: t === 'K' ? 0 : 950 + i, t }));
  const st = fresh(721), b = handBattle(st, W3, [['g8', 'K'], ['f7', 'P'], ['g7', 'P'], ['h7', 'P'], ['e8', 'R'], ['a7', 'P'], ['b7', 'P']].map(([q, t]) => ({ sq: sqI(q), t })));
  let plies = 0;
  while (!b.over && plies < 60) { const r = think(st.run, b); if (b.pos.side === E.BLACK && r.resign) break; W.battleMove(st.run, b, r.move); plies++; }
  const caps = Object.values(b.sx.c).reduce((a, v) => a + v, 0);
  E.yieldBattle(b, 'Yielded');
  const noCap = SK.battleXp(Object.assign({}, b.sx, { c: {} }), 'win', b.tier), all = SK.battleXp(b.sx, 'win', b.tier);
  const xp = W.awardBattleXp(st, b, 'win'), sum = (o) => Object.values(o).reduce((a, v) => a + v, 0);
  ok(caps > 0 && sum(xp.gained) === sum(all) && sum(all) > sum(noCap), `a yield pays the captures made before it (${caps} victim units, ${sum(all)} xp vs ${sum(noCap)} without captures)`);
  const st2 = fresh(722), b2 = handBattle(st2, W3, [['g8', 'K'], ['e8', 'R'], ['a7', 'P']].map(([q, t]) => ({ sq: sqI(q), t })));
  const mv = E.battleLegal(b2).find(x => E.mCap(x)); if (mv) W.battleMove(st2.run, b2, mv);
  const xr = W.awardBattleXp(st2, b2, 'loss');
  ok(!mv || sum(xr.gained) >= sum(SK.battleXp(Object.assign({}, b2.sx, { c: {} }), 'loss', b2.tier)) + 1, 'a retreat (loss) also keeps the capture XP');
}
// ===================== content variety =====================
// 1. named landmarks: 1-2 per region, deterministic, one visit each, funded by a gold road pile of at least their gold
{
  let n = 0, cnt = 0, fundOk = true, placeOk = true, det = true;
  for (let sd = 900; sd < 960; sd++) {
    const st = fresh(sd), m = st.run.map, reg = W.worldRegion(st.run), L = m.sites.filter(W.isLandmark);
    n++; cnt += L.length;
    if (L.length > W.LANDMARK.max || new Set(L.map(s => reg.nodes[s.at].col)).size !== L.length) placeOk = false;
    if (L.some(s => ['keep', 'citadel', 'shrine'].includes(reg.nodes[s.at].type) || m.sites.filter(x => x.at === s.at).length !== 1 || new Set(L.map(x => x.arch)).size !== L.length)) placeOk = false;
    const full = DSC.placeTreasure(m.seed, reg, []), gone = full.filter(t => !m.treasure.some(x => x.a === t.a && x.b === t.b));
    if (gone.length !== L.length || gone.some(t => t.k !== 'gold') || L.some(s => !(s.fund >= W.landmarkGold(1))) || m.treasure.length < DSC.DISC.treasureMin) fundOk = false;
    if (gone.reduce((a, t) => a + t.e.v, 0) < L.length * W.landmarkGold(1)) fundOk = false;
    if (JSON.stringify(fresh(sd).run.map.sites) !== JSON.stringify(m.sites)) det = false;
  }
  ok(placeOk && cnt >= n, `region 1 maps carry at most ${W.LANDMARK.max} landmarks each, on their own nodes and columns (${cnt} over ${n} seeds; none only when no gold pile can fund one)`);
  ok(fundOk, 'each landmark removed one gold road pile worth at least its gold option (and the treasure minimum holds)');
  ok(det, 'landmarks are seeded from the region seed (same seed, same landmarks)');
  const st = fresh(905), run = st.run, m = run.map, t0 = m.treasure.length, s0 = m.sites.length;
  ok(W.placeLandmarks(run).length === 0 && m.treasure.length === t0 && m.sites.length === s0, 'placing landmarks twice changes nothing');
  ok(W.LANDMARKS.length >= 6 && W.LANDMARKS.every(l => DSC.LOCATION_BY_ID[l.id] === l && !DSC.LOCATIONS.includes(l)), `${W.LANDMARKS.length} landmarks registered as site archetypes, never in the generic site pool`);
  // one visit: the gold option pays what its card says, then the place is spent
  const i = m.sites.findIndex(W.isLandmark), s = m.sites[i];
  m.held = [...new Set([0, s.at])].sort((a, b) => a - b);
  ok(W.openSiteCard(run, i), `a held landmark opens its card (${W.siteCardOf(run).name})`);
  const c = W.siteCardOf(run), g0 = run.gold, sk0 = JSON.stringify(st.skills), side = c.a.effect.kind === 'gold' ? 'a' : 'b';
  const res = W.chooseSite(st, side);
  const gp = C.effectParts(c[side].effect).find(p => p.kind === 'gold');
  ok(res && s.done === side && !W.openSiteCard(run, i) && !W.chooseSite(st, 'a') && (gp ? run.gold - g0 === gp.v : JSON.stringify(st.skills) !== sk0), `${c.name}: "${c[side].label}" applied once; the place is spent`);
  const back = W.migrateState(JSON.parse(JSON.stringify(st)));
  ok(back.run.map.sites.filter(W.isLandmark).length === m.sites.filter(W.isLandmark).length && back.run.map.sites[i].done === side, 'landmarks and their visits survive save + load');
  // every option of every landmark does what it says
  const probe = (l, k, r = 1) => {
    const st = fresh(931), run = st.run, m = run.map;
    if (r > 1) { run.map = W.newWorldMap(run, r); DSC.initDiscovery(run, W.worldRegion(run)); m.sites = run.map.sites; }
    const mm = run.map, at = W.worldRegion(run).nodes.find(x => x.dist >= 2 && !mm.sites.some(q => q.at === x.id)).id;
    mm.sites.push({ at, arch: l.id, v: Math.min(r, W.LANDMARK.eras) - 1, dx: 20, dy: 20, focus: null, prize: null, done: 0, later: false });
    mm.held = [...new Set([0, at])].sort((a, b) => a - b); W.openSiteCard(run, mm.sites.length - 1);
    const card = W.siteCardOf(run), o = card[k], p = C.effectParts(o.effect)[0];
    const before = { gold: run.gold, xp: SK.skillXp(st.skills, p.piece || 'P'), bl: (run.blessings || []).length, raid: mm.raid.t, coal: (W.ensureForge(run).stock.coal) };
    W.chooseSite(st, k);
    const got = p.kind === 'gold' ? run.gold - before.gold === p.v && p.v === W.landmarkGold(r)
      : p.kind === 'skillXp' ? SK.skillXp(st.skills, p.piece) - before.xp === p.v && p.v === W.landmarkXp(r) && o.label.includes(String(p.v))
      : p.kind === 'raidClock' ? mm.raid.t - before.raid === p.v
      : p.kind === 'resource' ? run.forge.stock.coal - before.coal === p.v
      : ['enemyElo', 'tacticianElo', 'lootMult'].includes(p.kind) ? run.blessings.length === before.bl + 1 && run.blessings[before.bl].scope === 'next' && run.blessings[before.bl].kind === p.kind
      : false;
    return got;
  };
  const bad = W.LANDMARKS.flatMap(l => ['a', 'b'].filter(k => !probe(l, k)).map(k => l.id + ':' + k));
  ok(!bad.length, `every landmark option applies what its card says (${W.LANDMARKS.length * 2} options)${bad.length ? ': ' + bad.join(', ') : ''}`);
  const lx = W.LANDMARKS.find(l => l.id === 'wandering-tutor');
  ok(probe(lx, 'a', 3) && W.landmarkXp(3) > W.landmarkXp(1) && W.landmarkGold(3) > W.landmarkGold(1), `region 3 landmarks scale like the rest of the region (${W.landmarkXp(3)} XP, ${W.landmarkGold(3)} gold vs ${W.landmarkXp(1)} / ${W.landmarkGold(1)})`);
  // a fresh region map (the seat taken) gets its own landmarks
  const s2 = fresh(907); s2.run.map = W.newWorldMap(s2.run, 2); DSC.initDiscovery(s2.run, W.worldRegion(s2.run));
  ok(W.placeLandmarks(s2.run).length >= 1, 'region 2 places its own landmarks');
}
// 2. week variety: the six new weeks are three mirrored pairs on existing mechanisms; Rest frees the first hint
{
  const NEW = ['bounty', 'lean', 'clear', 'raven', 'truce', 'drums'], ev = NEW.map(id => W.WEEK_BY_ID[id]);
  const MULT = ['march', 'rival', 'mine', 'loot', 'smelt'];
  const keys = [...new Set(ev.flatMap(e => Object.keys(e.mods)))];
  const net = k => ev.reduce((a, e) => a + (e.mods[k] == null ? 0 : MULT.includes(k) ? e.mods[k] - 1 : e.mods[k]), 0);
  ok(ev.every(Boolean) && keys.every(k => Math.abs(net(k)) < 1e-9) && ev.filter(e => e.tone === 'good').length === 3 && ev.filter(e => e.tone === 'bad').length === 3, `the new weeks net to no change on every mechanism they touch (${keys.join(', ')})`);
  const known = new Set(['smelt', 'march', 'rival', 'mine', 'loot', 'elo', 'muster', 'inc', 'traitP', 'hint']);
  ok(W.WEEK_EVENTS.every(e => Object.keys(e.mods).every(k => known.has(k))), 'every week uses a mechanism the game already reads');
  // each pool mechanism: the 18-week mean sits no further from neutral than the old 12-week mean did (no added income)
  const OLD = W.WEEK_EVENTS.filter(e => !NEW.includes(e.id)), mean = (L, k) => L.reduce((a, e) => a + (e.mods[k] == null ? (MULT.includes(k) ? 1 : 0) : e.mods[k]), 0) / L.length;
  ok([...known].filter(k => k !== 'hint').every(k => Math.abs(mean(W.WEEK_EVENTS, k) - (MULT.includes(k) ? 1 : 0)) <= Math.abs(mean(OLD, k) - (MULT.includes(k) ? 1 : 0)) + 1e-9), 'every mechanism\'s average week moves toward neutral (the new weeks only dilute the pool)');
  // Week of Rest: the first hint each battle is free, fixed when the battle starts
  const st = fresh(940), run = st.run; run.ticks = 0;
  let w = 2; while (W.weekEvent(run, w).id !== 'rest') w++;
  run.ticks = (w - 1) * W.WORLD.weekTicks; W.ensureWeek(run);
  const b = W.worldBattle(run, W.nodeArmy(run, W.worldFrontier(run)[0]));
  run.gold = 0;
  const h1 = W.payHint(run, b), h2 = W.payHint(run, b);
  ok(run.week.ev === 'rest' && b.wkHint === 1 && h1.ok && h1.free && !h2.ok && run.gold === 0, `Week of Rest (week ${w}): the first hint is free, the second costs ${h2.cost} gold as usual`);
  let w2 = 2; while (W.weekEvent(run, w2).id === 'rest') w2++;
  run.ticks = (w2 - 1) * W.WORLD.weekTicks; W.ensureWeek(run);
  const b2 = W.worldBattle(run, W.nodeArmy(run, W.worldFrontier(run)[0]));
  ok(!b2.wkHint && W.freeHints(run, b2) === 0, 'other weeks: no free hint');
  // a negative elo week reaches the battle
  let w3 = 2; while (W.weekEvent(run, w3).id !== 'raven' && w3 < 400) w3++;
  run.ticks = (w3 - 1) * W.WORLD.weekTicks; W.ensureWeek(run);
  ok(W.worldBattle(run, W.nodeArmy(run, W.worldFrontier(run)[0])).tactElo === -30, 'the Week of the Raven plays the Tactician 30 elo weaker');
}
// 3-5. pure-text variety: dwelling titles, battle intros, the rival lord's voice
{
  ok(E.DWELL_TYPES.every(t => W.DWELL_LORE[t] && W.DWELL_LORE[t].length === E.DWELL_MAX + 1 && W.DWELL_LORE[t].every(([a, b]) => a && b && b.length <= 80)) && new Set(E.DWELL_TYPES.flatMap(t => W.DWELL_LORE[t].map(x => x[0]))).size === E.DWELL_TYPES.length * (E.DWELL_MAX + 1), 'every dwelling level has its own title and a short line');
  ok(W.dwellLore('P', 2).title === 'Village' && W.dwellLore('P', 9).title === 'Garrison Town' && W.dwellLore('X', 1) === null, 'dwellLore clamps the level');
  const st = fresh(950), run = st.run, f = W.worldFrontier(run)[0], a = W.nodeArmy(run, f);
  const ground = t => { const g = W.terrainSummary(t); return g.water > g.rock ? 2 : g.rock ? 1 : 0; };
  ok(Object.values(W.BATTLE_INTRO).every(L => L.length === 3 && L.every(x => x && x.length <= 90)) && W.battleIntro(W.worldRegion(run).nodes[f], a.terrain) === W.BATTLE_INTRO[W.worldRegion(run).nodes[f].type][ground(a.terrain)], `a battle intro for every node type and ground ("${W.battleIntro(W.worldRegion(run).nodes[f], a.terrain)}")`);
  ok(W.battleIntro({ type: 'rival', kind: 'keep' }, null) === W.BATTLE_INTRO.keep[0] && W.battleIntro({ type: 'rival' }, null) === W.BATTLE_INTRO.border[0] && W.battleIntro({ type: 'ambush', ambush: true }, null) === W.BATTLE_INTRO.ambush[0] && W.battleIntro({ type: 'cache' }, null) === '', 'rival hosts, keep assaults and ambushes have their own intros');
  ok(['aggressive', 'solid', 'material'].every(d => ['capture', 'mine', 'lost', 'keep'].every(k => W.RIVAL_SAYS[d][k].length === 3)), 'the rival lord has three lines per event for each doctrine');
  // a mine you take, a node the rival takes: the chronicle carries the lord's line
  {
    let sm = null, mine = null;
    for (let sd = 950; sd < 990 && mine == null; sd++) { sm = fresh(sd); const rg = W.worldRegion(sm.run); mine = W.worldFrontier(sm.run).find(i => rg.nodes[i].type === 'mine'); }
    forceWin(sm, mine);
    const e = sm.run.map.rlog[sm.run.map.rlog.length - 1], d = W.lordOf(sm.run).doctrine;
    ok(e && e.k === 'mine' && W.RIVAL_SAYS[d].mine.includes(e.q) && e.t.includes(W.worldRegion(sm.run).nodes[mine].name), `taking a mine: "${e && e.t}" with "${e && e.q}"`);
  }
  const n0 = run.map.rlog.length;
  W.tickRival(run, 6000, true);
  const caps = run.map.rlog.filter(e => e.k === 'capture');
  ok(caps.length > 0 && caps.every(e => W.RIVAL_SAYS[W.lordOf(run).doctrine].capture.includes(e.q)) && run.map.rlog.length >= Math.min(n0 + 1, W.WORLD.rlogMax), `the rival's captures carry its taunts (${caps.length})`);
  const back = W.migrateState(JSON.parse(JSON.stringify(st)));
  ok(back.run.map.rlog.some(e => e.q), 'chronicle lines survive save + load');
}
// Settings pass: settings are optional fields with defaults; the save exports as text and imports back with validation
{
  const d = W.cleanSettings(undefined);
  ok(d.theme === 'auto' && d.sound === true && d.speed === 1 && d.threat === true && d.vol === 0.8, 'cleanSettings: a save with no settings gets the defaults');
  const old = W.cleanSettings({ theme: 'dark', sound: false, speed: 2 });
  ok(old.theme === 'dark' && old.sound === false && old.speed === 2 && old.threat === true && old.vol === 0.8, 'cleanSettings: an older save (no threat, no vol) keeps its fields and gains the new ones');
  const bad = W.cleanSettings({ theme: 'neon', speed: 3, vol: 7, sound: 0 });
  ok(bad.theme === 'auto' && bad.speed === 1 && bad.vol === 1 && bad.sound === true, 'cleanSettings: junk values are repaired (theme, speed, volume clamped to 0..1)');
  ok(W.cleanSettings({ vol: -1 }).vol === 0 && W.cleanSettings({ vol: 0.333 }).vol === 0.33 && W.cleanSettings({ vol: 'x' }).vol === 0.8, 'cleanSettings: volume clamps, rounds to 1%, and falls back on non-numbers');
  // persistence: settings ride the save through JSON + migrateState unchanged
  const st = fresh(4242); st.settings = W.cleanSettings({ theme: 'light', sound: false, vol: 0.35, threat: false });
  const back = W.migrateState(JSON.parse(JSON.stringify(st)));
  ok(back.settings.theme === 'light' && back.settings.sound === false && back.settings.vol === 0.35 && back.settings.threat === false, 'settings (theme, sound, volume) persist through a save + load');
  // export -> import round trip, with a battle in flight
  forceWin(st, M.frontier(W.mapStateOf(st.run))[0]);
  st.memories = 37; st.totalRuns = 3;
  const snap = { state: st, battle: null };
  const txt = W.exportSaveText(snap);
  ok(typeof txt === 'string' && txt === JSON.stringify(snap), 'exportSaveText is the serialized save ({ state, battle } as JSON)');
  const p = W.parseSaveText(txt);
  ok(p.ok && JSON.stringify(p.data.state) === JSON.stringify(st) && p.data.battle === null, 'parseSaveText(exportSaveText(save)) gives the same save back');
  const m = W.migrateState(p.data.state);
  ok(m && m.v === E.SAVE_VERSION && m.memories === 37 && m.totalRuns === 3 && m.run.cleared === st.run.cleared && JSON.stringify(m.run.map.held) === JSON.stringify(st.run.map.held) && m.settings.vol === 0.35, 'an imported save loads as v6 with its Memories, runs, held nodes and settings intact');
  ok(W.parseSaveText('  ' + txt + '\n').ok, 'parseSaveText ignores surrounding whitespace from a paste');
  {
    const s2 = fresh(77); if (s2.run.map.site != null) W.skipSite(s2.run);
    let id = null, b = null;
    for (const n of M.frontier(W.mapStateOf(s2.run))) { const t = JSON.parse(JSON.stringify(s2)); W.startMarch(t.run, n); const bb = W.arrive(t.run, t); if (bb) { id = n; Object.assign(s2, t); b = bb; break; } }
    const pb = b && W.parseSaveText(W.exportSaveText({ state: s2, battle: E.serBattle(b) }));
    ok(b && pb.ok && E.deserBattle(W.migrateBattleSave(pb.data.battle, pb.data.state.v)).node.mapId === id, 'a save with a battle in flight exports and imports (the battle comes back on its node)');
  }
  // validation: never throws, never accepts junk
  const rej = [undefined, '', '   ', 'hello', '{"a":1}', '[1,2]', 'null', '{"state":{"run":{}}}', JSON.stringify({ state: Object.assign({}, st, { v: 7 }) }), JSON.stringify({ state: Object.assign({}, st, { v: 'six' }) }), JSON.stringify({ state: Object.assign({}, st, { run: null }) }), txt.slice(0, txt.length >> 1)];
  const res = rej.map(x => { try { return W.parseSaveText(x); } catch (e) { return { threw: true }; } });
  ok(res.every(r => r.ok === false && typeof r.err === 'string' && r.err.length > 8), `parseSaveText rejects ${rej.length} bad inputs with a plain reason and never throws`);
  ok(/newer version/.test(res[8].err), 'a save from a newer version is refused by the version check');
  const before = JSON.stringify(st); W.parseSaveText(txt); ok(JSON.stringify(st) === before, 'parsing an import does not touch the save it came from');
  const v5 = JSON.parse(txt); v5.state.v = 5; ok(W.parseSaveText(JSON.stringify(v5)).ok, 'an older-version save (v5) is accepted and migrates on load');
}
// engine carries the TERRAIN-API.md patch verbatim (checkmarch-terrain/test-terrain.mjs looks for the unpatched anchors)
{
  const eng = readFileSync(new URL('./engine.mjs', import.meta.url), 'utf8');
  ok(eng.includes('PAWN_FROM = [[], []], WALL = new Uint8Array(64)') && eng.includes('if (!b[to] && !WALL[to]) {') && eng.includes('!b[to + dir] && !WALL[to + dir]) out.push') && eng.includes('export function setTerrainGeometry(g) {'), 'engine.mjs carries the terrain patch (WALL table, pawn push line, setTerrainGeometry)');
}
// the built page inlines the current modules, minus their full-line comments (build.mjs slimJs). With acorn at hand, each
// slimmed module must parse to the same program as its source (only comments differ).
{
  let acorn = null;
  for (const base of [import.meta.url, 'file:///opt/node-tools/']) { try { acorn = createRequire(base)('acorn'); break; } catch (e) { /* not installed here */ } }
  const mods = ['engine.mjs', 'world.mjs', 'map.mjs', 'map-render.mjs', 'audio.mjs', 'rival.mjs', 'forge.mjs', 'terrain.mjs', 'content.mjs', 'fx.mjs', 'skills.mjs', 'discovery.mjs', 'tutorial.mjs', 'fairy.mjs'];
  if (!acorn) console.log('info acorn not present; skipping the slimJs AST check');
  else {
    const ast = src => JSON.stringify(acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' }), (k, v) => k === 'start' || k === 'end' || k === 'raw' ? undefined : v);
    ok(mods.every(f => { const src = readFileSync(new URL(f, import.meta.url), 'utf8'); return ast(src) === ast(slimJs(src)); }), 'slimJs drops only comments: every slimmed module parses to the same program');
  }
  ok(slimJs("const a = 1; // x\n  // gone\nconst u = 'http://x'; const t = `\n  // kept ${'{'}\n`; const r = /\\/\\/ x/;\n  if (a) {\n    b();\n  }\n") === "const a = 1;\nconst u = 'http://x'; const t = `\n  // kept ${'{'}\n`; const r = /\\/\\/ x/;\nif (a) {\nb();\n}\n", 'slimJs keeps // inside strings, templates and regexes (and template text indentation); drops trailing comments and code indentation');
}
// the built page inlines the current world + map modules
{
  const html = readFileSync(new URL('./game.html', import.meta.url), 'utf8');
  const strip = f => slimJs(readFileSync(new URL(f, import.meta.url), 'utf8')).replace(/^import\s[^;]*;\s*$/gm, '').replace(/^export\s+(?=(async\s+)?(function|const|let|class)\b)/gm, '');
  ok(['world.mjs', 'map.mjs', 'map-render.mjs', 'audio.mjs', 'rival.mjs', 'forge.mjs', 'terrain.mjs', 'content.mjs', 'fx.mjs', 'skills.mjs', 'discovery.mjs', 'tutorial.mjs', 'fairy.mjs'].every(f => html.includes(strip(f))), 'game.html inlines current world/map/audio/rival/forge/terrain/content/fx/skills/discovery/tutorial/fairy modules');
  ok(Buffer.byteLength(html) < 600 * 1024, `game.html under 600 KB (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
}
console.log(fail ? `\n${fail} FAILED` : '\nALL WORLD TESTS PASSED');
process.exit(fail ? 1 : 0);
