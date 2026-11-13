// Headless balance sim for Checkmarch, on the real world map (world.mjs + map.mjs).
//  Part 1: RUNS sequential runs. Memories carry over and are spent in the Memories shop (cheapest first).
//          Greedy route: attack the weakest frontier node (mines first on ties); take the citadel as soon as
//          the army is strong enough for it. Greedy buys, auto-battles, raids (defend with a garrison, else concede).
//  Part 2: T5 fresh default-start runs played until region 1 is cleared (or REGION_CAP ticks):
//          region-1 clear times, win rates per tier band, and the tier-5 battle win rate, flagged outside 60-98%.
//  Part 4 (balance pass, DEEP runs, default 24): fresh accounts at ELO, one run each, up to DEEP_TICKS: the per-region
//          table (clear ticks, win rate by node type, gold in/out, Memories, bars, skill XP, exotic buys, raids,
//          keep assaults, deaths by cause), exotic buy timing, the week clock and the push-or-abdicate ledger.
//  Part 5 (MARATHON attempts per band, default 40): one account per elo band 600/900/1200/1500 plays run after run
//          (Memories carried and spent) until it has entered MARATHON regions: per-region win rates at each band,
//          Memories per run against what the shop costs.
//  Parts 4-5 run in parallel worker processes (JOBS, default the core count, max 4); each job is deterministic.
// Engines use node budgets instead of wall time (timeMs * NODES_PER_MS, roughly a mid phone),
// so results don't depend on the machine running the sim.
// Sim time is in world TICKS, as in the game: 1 tick per chess move (both sides), march ticks per road step,
// v6: no ambient map time (shopping and waiting for gold pass no ticks; the old SHOP_TICKS and waits are gone).
// Every tick goes through world.mjs worldTick(): income, the raid clock and the rival
// (which pauses itself while a border battle waits). Border policy: always defend the keep and garrisoned mines; defend other nodes with
// the formation when it has at least 75% of the rival's points, else concede.
//  v6: unlocked fairy pieces are bought greedily by weight like the others; enemies field them per the lagged mirror.
//  Balance pass: the bot also works the Forge (smelts the best bar it can, tempers its most valuable pieces).
//  Part 0 (CAL, default 24 games per cell): elo calibration. Mirrored armies (9 pts), colours alternate, so
//          equal elo is ~50% by symmetry; reports +1 pawn / +knight material edges and +100/+200/+300 elo.
//  Part 3 (OFF, default 12): play 1200 ticks of region 1, go away (v6: away time grants zero ticks, W.awayTicks),
//          then play 2000 more ticks.
// ELO (default 900): the opposition band for parts 1-4. PARTS (default "0,1,2,3,4,5") picks the parts to run.
import * as E from './engine.mjs';
import * as W from './world.mjs';
import * as SK from './skills.mjs';
import { spawn } from 'node:child_process';
import { availableParallelism, cpus } from 'node:os';

const NODES_PER_MS = +(process.env.NPMS || 120);
const RUN_TICKS = +(process.env.RUN_TICKS || 8000);
const T5_RUNS = +(process.env.T5 || 40);
const RUNS = +(process.env.RUNS || 3);
const REGION_CAP = +(process.env.REGION_CAP || 6000);
const GARRISON = process.env.GARRISON !== '0';
const VERBOSE = !!process.env.V;
const ELO = +(process.env.ELO || 900);
const CAL = +(process.env.CAL ?? 24);
const OFF = +(process.env.OFF ?? 12);
const DEEP = +(process.env.DEEP ?? 24);
const DEEP_TICKS = +(process.env.DEEP_TICKS || 12000);
const MARATHON = +(process.env.MARATHON ?? 40);
const MARATHON_BANDS = (process.env.BANDS || '600,900,1200,1500').split(',').map(Number);
const PARTS = new Set((process.env.PARTS || '0,1,2,3,4,5').split(',').map(Number));
const JOBS = Math.max(1, Math.min(4, +(process.env.JOBS || (availableParallelism ? availableParallelism() : cpus().length))));
const RIVAL = process.env.RIVAL !== '0';
if (process.env.TUNE_JSON) Object.assign(E.TUNE, JSON.parse(process.env.TUNE_JSON));
if (process.env.WORLD_JSON) { const o = JSON.parse(process.env.WORLD_JSON); if (o.rivalTune) o.rivalTune = Object.assign({}, W.WORLD.rivalTune, o.rivalTune); Object.assign(W.WORLD, o); W.applyRivalTune(); }
if (process.env.FAIRY_JSON) Object.assign(W.FAIRY_WORLD, JSON.parse(process.env.FAIRY_JSON));
if (process.env.ELO_JSON) Object.assign(E.ELO_TUNE, JSON.parse(process.env.ELO_JSON));
const rng = E.mulberry(+(process.env.SEED || 7));

const YIELDS = { n: 0 }, SLOW = +(process.env.SLOW || 0);
function fight(run, b) {
  while (!b.over) {
    const cfg = E.battleEngineCfg(run, b, b.pos.side);
    const tm = SLOW ? Date.now() : 0;
    const r = E.thinkMove(run, b, { timeMs: 1e9, maxNodes: cfg.timeMs * NODES_PER_MS, rng });
    if (SLOW && Date.now() - tm > SLOW) console.error(`slow move ${Date.now() - tm}ms ply ${b.plies} side ${b.pos.side} cfg ${JSON.stringify(cfg)} board ${Array.from(b.pos.b).join(',')} gates ${JSON.stringify(b.pos.g || null)}`);
    if (r.retreat) { b.over = { result: 'loss', reason: 'Retreat' }; break; }
    // P0-3: a hopeless enemy yields (deterministic: the same search the page runs); the bot never claims victory
    if (r.resign) { E.yieldBattle(b, 'Yielded'); YIELDS.n++; break; }
    W.battleMove(run, b, r.move);
  }
  return { result: b.over.result, reason: b.over.reason, ticks: b.plies };
}

const freeSquares = run => run.owned.filter(sq => run.formation[sq] == null).length;
const nextSquare = run => E.SQUARE_ORDER.map(E.parseSq).find(sq => !run.owned.includes(sq));
const add = (o, k, v) => { if (o) o[k] = (o[k] || 0) + v; };
// greedy: Tactician first, then the most valuable affordable piece; buy a square when none is free.
// acc (optional, the region's ledger): gold spent per kind, exotic pieces bought (and the first buy of each)
function greedyBuy(run, acc) {
  for (let guard = 0; guard < 50; guard++) {
    const g0 = run.gold;
    // M4: the Tactician buys elo steps; recruit a real army (6+ pts) before paying for it
    if (run.tact < E.TACT_MAX && E.armyUnits(run.roster) >= 6 && run.gold >= E.effPrice(run, E.tactPrice(run.tact))) { E.buyTact(run); add(acc && acc.cost, 'tact', g0 - run.gold); continue; }
    if (freeSquares(run) === 0) {
      const sq = nextSquare(run);
      if (sq != null && run.gold >= E.effPrice(run, E.squareCost(run))) { E.buySquare(run, sq); add(acc && acc.cost, 'square', g0 - run.gold); continue; }
      break;
    }
    // v6: unlocked fairy pieces join the greedy list by weight (pawn-units); a wizard pair counts double
    const opts = ['Q', 'R', 'B', 'N', 'P'].map(t => ({ t, u: E.UNITS[t], cost: E.pieceCost(run, t) }))
      .concat(W.fairyShopRows(run).filter(f => !f.blocker).map(f => ({ id: f.id, u: f.units * (f.pair ? 2 : 1), cost: f.cost })))
      .sort((a, b) => b.u - a.u || a.cost - b.cost);
    const o = opts.find(o => run.gold >= E.effPrice(run, o.cost));
    if (!o) break;
    if (o.id) {
      if (!W.buyFairy(run, o.id)) break;
      add(acc && acc.cost, 'exotic', g0 - run.gold);
      if (acc) { add(acc.fairy, o.id, 1); if (acc.onFairy) acc.onFairy(o.id, g0 - run.gold); }
    } else { E.buyPiece(run, o.t); add(acc && acc.cost, 'piece', g0 - run.gold); }
  }
  // fill free squares from the reserve
  for (const p of E.reserve(run)) { const sq = run.owned.find(s => run.formation[s] == null); if (sq == null) break; run.formation[sq] = p.id; }
}
// the Forge: smelt the best bar the stock allows (as often as the cap lets), then temper the most valuable
// pieces of the formation with what is in store. Returns bars smelted.
function botForge(state) {
  const run = state.run; let n = 0;
  for (let g = 0; g < 8; g++) {
    const r = ['obsidian', 'steel', 'iron'].find(rc => W.forgeSmelt(state, rc).ok);
    if (!r) break; n++;
  }
  const placed = new Set(Object.values(run.formation));
  const order = run.roster.filter(p => p.t !== 'K' && placed.has(p.id)).sort((a, b) => (E.UNITS[b.t] || 0) - (E.UNITS[a.t] || 0));
  for (const p of order) for (let k = 0; k < 3; k++) if (!W.forgeApplyBar(run, p.id).ok) break;
  return n;
}
// garrison policy: with a big enough army, keep one pawn at each held mine of the region
function garrisonPolicy(run) {
  if (!GARRISON) return;
  for (const id of W.heldMines(run)) {
    if (W.garrisonOf(run, id).length) continue;
    const spare = run.roster.filter(p => p.t !== 'K' && !E.garrisonedIds(run).has(p.id));
    if (spare.length < 4) return;
    const pawn = spare.find(p => p.t === 'P' && !Object.values(run.formation).includes(p.id)) || spare.find(p => p.t === 'P');
    if (pawn) W.stationPiece(run, id, pawn.id);
  }
}
function memSpend(state) {
  let spent = 0;
  for (let g = 0; g < 100; g++) {
    const k = E.MEM_KEYS.map(k => [k, E.memCost(k, state.upgrades[k])]).sort((a, b) => a[1] - b[1])[0];
    if (!k || !(state.memories >= k[1])) break;
    E.buyMemUpgrade(state, k[0]); spent += k[1];
  }
  return spent;
}
const skillXpTotal = st => SK.SKILL_TYPES.reduce((s, t) => s + SK.skillXp(st.skills, t), 0);
const shopTotal = () => E.MEM_KEYS.reduce((s, k) => { let c = 0; for (let l = 0; l < E.MEM_SHOP[k].max; l++) c += E.memCost(k, l); return s + c; }, 0);
const shopLeft = up => E.MEM_KEYS.reduce((s, k) => { let c = 0; for (let l = (up[k] | 0); l < E.MEM_SHOP[k].max; l++) c += E.memCost(k, l); return s + c; }, 0);

// plays one run in place. stopRegion: stop once this region is cleared.
function simulateRun(state, { maxT = RUN_TICKS, stopRegion = Infinity } = {}) {
  const run = state.run;
  W.ensureMap(run);
  let simT = 0, end = 'time cap', streak = 0, regionStart = 0;
  const regions = [], battles = [], raids = { n: 0, defended: 0, held: 0, conceded: 0 }, cycles = [], fairyFirst = {};
  // the region ledger: everything the balance pass reports per region
  const newCur = () => ({ region: run.map.region, wins: 0, n: 0, t0: simT, type: {}, inc: {}, cost: {}, fairy: {}, lost: {}, lostBy: {}, bars: 0,
    bq0: (state.bequest && state.bequest.paid) | 0, dm0: state.diaryMem | 0, xp0: skillXpTotal(state), mem0: E.abdicateMemories(run),
    raids: 0, raidsHeld: 0, border: 0, borderWon: 0, keep: 0, keepWon: 0, weeks0: Math.floor(run.ticks / W.WORLD.weekTicks), sumT0: run.sumTiers,
    onFairy: (id, c) => { if (!fairyFirst[id]) fairyFirst[id] = { region: run.map.region, into: simT - cur.t0, tick: simT, cost: c }; } });
  let cur = newCur();
  const closeCur = open => {
    const c = cur; delete c.onFairy;
    c.min = simT - regionStart; c.open = !!open;
    c.bq = ((state.bequest && state.bequest.paid) | 0) - c.bq0; c.dm = (state.diaryMem | 0) - c.dm0; c.xp = skillXpTotal(state) - c.xp0;
    c.weeks = Math.floor(run.ticks / W.WORLD.weekTicks) - c.weeks0; c.memAt = E.abdicateMemories(run); c.sumT = run.sumTiers - c.sumT0;
    c.army = E.armyUnits(run.roster); c.squares = run.owned.length; c.gold = Math.round(run.gold);
    c.next = { N: E.pieceCost(run, 'N'), R: E.pieceCost(run, 'R'), Q: E.pieceCost(run, 'Q') };
    regions.push(c);
  };
  // gold accounting: the change in gold over fn() goes to cat (income when positive, cost when negative)
  const G = (cat, fn) => { const g0 = run.gold, r = fn(), d = run.gold - g0; if (d > 0) add(cur.inc, cat, d); else if (d < 0) add(cur.cost, cat, -d); return r; };
  const rv = { border: 0, borderWon: 0, conceded: 0, keep: 0, keepWon: 0, lostNodes: 0 };
  // n world ticks pass (RIVAL=0: income and raids only)
  const pass = n => G('time', () => { simT += n; if (RIVAL) W.worldTick(state, n, true); else { E.accrueTicks(state, n); W.raidTick(run, n); } });
  const lostAt = new Map();
  // deaths: the roster pieces a battle took, by type and by cause
  const fallen = (ids0, b, cause) => { for (const id of b.lost || []) { const t = ids0.get(id); if (t) { add(cur.lost, t, 1); add(cur.lostBy, cause, 1); } } };
  const typeTally = (k, won) => { const x = cur.type[k] || (cur.type[k] = [0, 0]); x[1]++; if (won) x[0]++; };
  const forge = () => { cur.bars += botForge(state); };
  let spin = 0, lastT = -1;
  while (simT < maxT) {
    if (simT === lastT) { if (++spin > 2000) { end = 'stalled (bot loop)'; if (SLOW) console.error('stall', JSON.stringify({ shrine: run.map.shrine, site: run.map.site, amb: !!run.map.ambush, raid: run.map.raid.pending, rp: !!W.rivalPending(run), march: run.map.march, busy: W.discoveryBusy ? W.discoveryBusy(run) : null })); break; } } else { spin = 0; lastT = simT; }
    if (run.map.shrine != null) { G('shrine', () => { if (!W.chooseShrineSide(state, W.sideBlocker(run, 'a') ? 'b' : 'a')) run.map.shrine = null; }); }
    // M6 discovery: take a site's first affordable side (else "Not now"); fight any ambush it springs
    if (run.map.site != null) { G('site', () => { const c = W.siteCardOf(run), side = c && c.a.ok ? 'a' : c && c.b && c.b.ok ? 'b' : null; if (!side || !W.chooseSite(state, side)) W.skipSite(run); }); continue; }
    if (run.map.ambush) {
      const b = W.startAmbush(run); if (!b) { W.withdrawAmbush(run); continue; }
      const ids0 = new Map(run.roster.map(p => [p.id, p.t]));
      const f = fight(run, b); W.awardBattleXp(state, b, f.result); G('ambush', () => W.afterBattle(state, b, W.finishAmbushBattle(state, b, f.result))); pass(f.ticks);
      fallen(ids0, b, 'ambush'); typeTally('ambush', f.result === 'win');
      battles.push([b.tier, f.result === 'win', 'ambush']); continue;
    }
    if (run.map.raid.pending) {
      raids.n++; cur.raids++;
      if (W.canDefend(run)) {
        raids.defended++;
        const b = W.defendRaid(run), ids0 = new Map(run.roster.map(p => [p.id, p.t])), f = fight(run, b);
        W.awardBattleXp(state, b, f.result); const s = G('raid', () => { const s = W.finishDefence(state, b, f.result); W.afterBattle(state, b, s); return s; });
        pass(f.ticks); fallen(ids0, b, 'raid');
        if (s.kept) { raids.held++; cur.raidsHeld++; }
        typeTally('raid', s.kept);
        battles.push([b.tier, f.result === 'win', 'raid']);
      } else { raids.conceded++; W.concedeRaid(run); }
      continue;
    }
    const rp = W.rivalPending(run);
    if (rp) {
      const mode = W.borderMode(run), ba = W.borderArmy(run);
      const mine = E.armyUnits(run.roster.filter(p => Object.values(run.formation).includes(p.id)));
      if (mode === 'keep') { rv.keep++; cur.keep++; } else { rv.border++; cur.border++; }
      if (mode === 'keep' || mode === 'garrison' || mine >= ba.units * 0.75) {
        const b = W.defendBorder(run), ids0 = new Map(run.roster.map(p => [p.id, p.t])), f = fight(run, b);
        W.awardBattleXp(state, b, f.result); const s = G('border', () => { const s = W.finishBorder(state, b, f.result); W.afterBattle(state, b, s); return s; });
        fallen(ids0, b, mode === 'keep' ? 'keep' : 'border'); typeTally(mode === 'keep' ? 'keep' : 'border', s.kept);
        battles.push([b.tier, s.kept, 'border']);
        if (s.kept) { if (mode === 'keep') { rv.keepWon++; cur.keepWon++; } else { rv.borderWon++; cur.borderWon++; } } else if (!s.runOver) rv.lostNodes++;
        if (VERBOSE) console.log(`  r${cur.region} border ${mode} t${b.tier} ${f.result} ${b.node.units} pts vs ${mine} @${simT}t`);
        if (s.runOver) { end = mode === 'keep' ? 'KEEP FELL' : `MATED at border tier ${b.tier}`; break; }
        pass(f.ticks);
      } else { rv.conceded++; rv.lostNodes++; W.concedeBorder(state); }
      greedyBuy(run, cur); garrisonPolicy(run);
      continue;
    }
    const reg = W.worldRegion(run), fr = W.worldFrontier(run);
    const army = E.armyUnits(run.roster.filter(p => Object.values(run.formation).includes(p.id)));
    const opts = fr.map(id => ({ id, a: W.nodeArmy(run, id), n: reg.nodes[id] }))
      .map(o => ({ ...o, score: o.a.units + (o.n.type === 'mine' ? -1.5 : o.n.type === 'town' ? -0.5 : 0) + 2 * (lostAt.get(o.id) || 0) }));
    const cit = opts.find(o => o.n.type === 'citadel');
    let pick = cit && army >= cit.a.units * 0.9 ? cit : opts.filter(o => o !== cit).sort((x, y) => x.score - y.score)[0] || cit;
    // v6: no waiting for gold on the map (time passes only from play): every pick is marched to
    if (!W.startMarch(run, pick.id, 0)) continue; // a raid struck while waiting
    const need = run.map.march.need, cyc0 = simT, cache = W.isCache(run, pick.id);
    pass(need); W.advanceMarch(run, need);
    const b = G(cache ? 'cache' : 'road', () => W.arrive(run, state));
    if (!b) continue; // a supply cache (taken at once) or a node lost meanwhile
    W.awardMarchXp(state, b.tier);
    const ids0 = new Map(run.roster.map(p => [p.id, p.t]));
    const f = fight(run, b);
    pass(f.ticks);
    W.awardBattleXp(state, b, f.result); // M6 skills (the bot never rewinds)
    const sum = G('loot', () => { const sum = W.applyMapResult(state, b, E.finishBattle(state, b, f.result)); W.afterBattle(state, b, sum); return sum; }); // P1: per-piece stats, Hall of the Fallen bequests, diary counters
    cycles.push(simT - cyc0);
    fallen(ids0, b, f.result === 'mate' ? 'mate' : 'attack'); typeTally(pick.n.type, f.result === 'win');
    battles.push([b.tier, f.result === 'win', pick.n.type, cur.region]);
    cur.n++; if (f.result === 'win') cur.wins++;
    if (VERBOSE) console.log(`  r${cur.region} t${b.tier} ${pick.n.type} ${f.result} (${f.reason}, ${b.plies} plies) army ${run.roster.map(p => p.t).join('')} gold ${Math.round(run.gold)} @${simT}t`);
    if (f.result === 'mate') { end = `MATED at tier ${b.tier}`; break; }
    if (f.result === 'win') { streak = 0; lostAt.delete(pick.id); } else { streak++; lostAt.set(pick.id, (lostAt.get(pick.id) || 0) + 1); }
    if (sum.nextRegion) {
      closeCur(false); regionStart = simT; lostAt.clear();
      cur = newCur();
      if (cur.region > stopRegion) { end = 'done'; break; }
    }
    forge();
    greedyBuy(run, cur);
    garrisonPolicy(run);
    if (streak >= 12) { end = `stuck in region ${cur.region}`; break; }
  }
  if (cur.n || cur.raids || cur.border || cur.keep) closeCur(true);
  return { simT, end, regions, battles, raids, rv, cycles, fairyFirst };
}

const bands = [[1, 5], [6, 10], [11, 15], [16, 20], [21, 30], [31, 999]];
const bandOf = t => bands.findIndex(([a, z]) => t >= a && t <= z);
const fmtBands = list => {
  const st = bands.map(() => [0, 0]);
  for (const [t, w] of list) { const i = bandOf(t); st[i][1]++; if (w) st[i][0]++; }
  return bands.map(([a, z], i) => st[i][1] ? `t${a}-${z === 999 ? '+' : z} ${st[i][0]}/${st[i][1]} (${(100 * st[i][0] / st[i][1]).toFixed(0)}%)` : null).filter(Boolean).join(', ');
};
const sumOf = a => a.reduce((x, y) => x + y, 0);
const avg = a => a.length ? sumOf(a) / a.length : NaN;
const med = a => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (w, n) => n ? `${Math.round(100 * w / n)}%` : '-';
const fx0 = v => Number.isFinite(v) ? Math.round(v).toString() : '-';

// ---- jobs (Parts 4-5): one deterministic unit of work per child process ----
// deep: a fresh account plays one run. marathon: one account plays runs until it has entered `attempts` regions.
function jobDeep({ seed, elo, maxT }) {
  const st = E.newState(0, seed, elo); W.ensureMap(st.run);
  const s = simulateRun(st, { maxT });
  const run = st.run, mated = s.end.startsWith('MATED') || s.end === 'KEEP FELL';
  return { seed, elo, end: s.end, simT: s.simT, regions: s.regions, cycles: s.cycles, fairyFirst: s.fairyFirst, region: run.map.region,
    payout: mated ? E.mateMemories(run.sumTiers) : E.abdicateMemories(run), full: E.abdicateMemories(run), battles: s.battles };
}
function jobMarathon({ seed, elo, attempts, maxT, maxRuns }) {
  const st = E.newState(0, seed, elo), runs = [];
  let entered = 0;
  for (let r = 0; r < maxRuns && entered < attempts; r++) {
    st.run = E.newRun(seed + r * 77, st.upgrades, st.run.orders, elo); E.skillStart(st);
    const bq0 = (st.bequest && st.bequest.paid) | 0, dm0 = st.diaryMem | 0, memStart = st.memories;
    const s = simulateRun(st, { maxT }), run = st.run;
    entered += s.regions.length;
    const mated = s.end.startsWith('MATED') || s.end === 'KEEP FELL';
    const pay = mated ? E.mateMemories(run.sumTiers) : E.abdicateMemories(run);
    const bq = ((st.bequest && st.bequest.paid) | 0) - bq0, dm = (st.diaryMem | 0) - dm0;
    E.endRun(st, pay, seed + 5000 + r);
    const banked = st.memories, spent = memSpend(st);
    runs.push({ end: s.end, simT: s.simT, region: s.regions.length ? s.regions[s.regions.length - 1].region : 1, pay, bq, dm, memStart, banked, spent, after: st.memories,
      shopLeft: shopLeft(st.upgrades), up: Object.assign({}, st.upgrades), regions: s.regions.map(g => ({ region: g.region, open: g.open, min: g.min, wins: g.wins, n: g.n, type: g.type, lostBy: g.lostBy })) });
  }
  return { seed, elo, runs };
}
if (process.argv[2] === '--job') {
  const j = JSON.parse(process.argv[3]);
  const out = j.kind === 'deep' ? jobDeep(j) : jobMarathon(j);
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(0);
}
// run jobs in up to JOBS child processes (same env, so TUNE_JSON / WORLD_JSON sweeps reach them)
function runJobs(list) {
  return new Promise((resolve, reject) => {
    const out = new Array(list.length); let next = 0, done = 0;
    if (!list.length) return resolve(out);
    const launch = () => {
      if (next >= list.length) return;
      const i = next++, ch = spawn(process.execPath, [new URL(import.meta.url).pathname, '--job', JSON.stringify(list[i])], { stdio: ['ignore', 'pipe', 'inherit'] });
      let buf = '';
      ch.stdout.on('data', d => { buf += d; });
      ch.on('close', code => {
        if (code !== 0) return reject(new Error(`job ${i} exited ${code}`));
        out[i] = JSON.parse(buf.trim().split('\n').pop());
        if (++done === list.length) resolve(out); else launch();
      });
    };
    for (let k = 0; k < Math.min(JOBS, list.length); k++) launch();
  });
}

// --check (CI): fixed seeds through early region 1, in seconds, plus cheap guards that trip loudly when the
// economy moves. Exits 1 when any assertion fails. Without the flag the full report runs (exit 0).
//  1. tier 1-5 attack win rate in CHECK_BAND (CHECK_SEEDS seeds x CHECK_TICKS ticks: wider than the old 12 x 1500,
//     so a small economy change no longer swings it by several points)
//  2. region-1 clear ticks (seeds that clear within the window) in CHECK_R1
//  3. Memories: the payout of a reference run that clears regions 1-3 (sum of tiers of its battles) stays a
//     modest share of the Memories shop (CHECK_MEM: payout / whole-shop price), a regions 1-6 run stays under
//     CHECK_MEM6 of it, and the first upgrade is a real save (it costs more than a region-1 abdication)
//  4. the elo table is honest: every band step (600 -> 900 -> 1200 -> 1500) raises search depth or quiescence
const CHECK_BAND = [0.70, 0.97], CHECK_R1 = [1200, 3200], CHECK_MEM = [0.03, 0.12], CHECK_MEM6 = 0.35, CHECK_SEEDS = 36, CHECK_TICKS = 1800;
// the reference run's sum of tiers: ~20 battles per region at the region's mean tier (5, 15, 25)
const REF_SUMTIERS = 20 * (5 + 15 + 25), REF_SUMTIERS6 = 20 * (5 + 15 + 25 + 35 + 45 + 55);
if (process.argv.includes('--check')) {
  const t1 = Date.now(), early = [], r1 = [];
  for (let i = 0; i < CHECK_SEEDS; i++) {
    const st = E.newState(0, 20000 + i * 31, 900); W.ensureMap(st.run);
    const s = simulateRun(st, { maxT: CHECK_TICKS, stopRegion: 1 });
    for (const b of s.battles) if (b[0] <= 5 && b[2] !== 'raid' && b[2] !== 'border' && b[2] !== 'ambush') early.push(b[1]);
    if (s.regions[0] && !s.regions[0].open && s.regions[0].region === 1) r1.push(s.regions[0].min);
  }
  const w = early.filter(Boolean).length, rate = early.length ? w / early.length : 0, fails = [];
  const okRate = rate >= CHECK_BAND[0] && rate <= CHECK_BAND[1]; if (!okRate) fails.push('win rate');
  console.log(`balance check: tier 1-5 attack win rate ${w}/${early.length} = ${(100 * rate).toFixed(1)}% (band ${CHECK_BAND[0] * 100}-${CHECK_BAND[1] * 100}%), ${CHECK_SEEDS} fixed seeds x ${CHECK_TICKS} ticks, ${YIELDS.n} yielded: ${okRate ? 'OK' : 'OUT OF BAND'}`);
  const r1m = avg(r1), okR1 = r1.length >= CHECK_SEEDS / 4 && r1m >= CHECK_R1[0] && r1m <= CHECK_R1[1]; if (!okR1) fails.push('region-1 clear');
  console.log(`  region-1 clear: ${r1.length}/${CHECK_SEEDS} seeds clear within ${CHECK_TICKS} ticks, mean ${fx0(r1m)} ticks (band ${CHECK_R1.join('-')}, at least ${CHECK_SEEDS / 4} clears): ${okR1 ? 'OK' : 'OUT OF BAND'}`);
  const pay = E.memoriesFor(REF_SUMTIERS), shop = shopTotal(), share = pay / shop, first = Math.min(...E.MEM_KEYS.map(k => E.memCost(k, 0))), r1pay = E.memoriesFor(20 * 5);
  const pay6 = E.memoriesFor(REF_SUMTIERS6), okMem = share >= CHECK_MEM[0] && share <= CHECK_MEM[1] && pay6 / shop <= CHECK_MEM6 && first > r1pay; if (!okMem) fails.push('Memories');
  console.log(`  Memories: a regions 1-3 run pays ${pay} of a ${shop} shop (${(100 * share).toFixed(1)}%, band ${CHECK_MEM.map(x => x * 100).join('-')}%), a regions 1-6 run ${pay6} (${(100 * pay6 / shop).toFixed(0)}%, at most ${CHECK_MEM6 * 100}%); cheapest upgrade ${first} > a region-1 payout ${r1pay}: ${okMem ? 'OK' : 'OUT OF BAND'}`);
  const cf = E.ELO_BANDS.map(e => E.eloCfg(e)), okElo = cf.every((c, i) => i === 0 || c.maxDepth > cf[i - 1].maxDepth || c.qsDepth > cf[i - 1].qsDepth); if (!okElo) fails.push('elo table');
  console.log(`  elo bands: ${cf.map(c => `${c.elo} d${c.maxDepth}/q${c.qsDepth}/${c.timeMs}ms/j${c.jitter}`).join(', ')}: ${okElo ? 'OK' : 'A BAND STEP ADDS NO DEPTH'}`);
  console.log(`  ${((Date.now() - t1) / 1000).toFixed(1)}s: ${fails.length ? 'FAILED (' + fails.join(', ') + ')' : 'OK'}`);
  process.exit(fails.length ? 1 : 0);
}

const t0 = Date.now();
console.log(`Checkmarch balance bot (world map + living rival): ${RUNS} runs x ${RUN_TICKS} tick cap, greedy route + buys + forge, auto-battles (${NODES_PER_MS} nodes/ms), garrisons ${GARRISON ? 'on' : 'off'}, opposition elo ${ELO}, parts ${[...PARTS].join(',')}, ${JOBS} workers\n`);

// Part 0: elo calibration
if (CAL > 0 && PARTS.has(0)) {
  const crng = E.mulberry(3);
  const game = (eloW, eloB, extra, seed) => {
    const a = E.enemyArmy(seed, 8, { type: 'garrison', key: seed, budget: 9 });
    const run = E.newRun(seed); run.formation = {}; run.roster = [];
    const whites = a.pieces.map((p, i) => ({ sq: p.sq ^ 56, id: i + 1, t: p.t }));
    if (extra) whites.push({ sq: [...Array(16).keys()].find(q => q >= 8 && !whites.some(w => w.sq === q)), id: 99, t: extra });
    const b = E.createBattle(run, Object.assign({}, a, { tier: 8, elo: eloB }), whites);
    while (!b.over) {
      const cfg = E.eloCfg(b.pos.side === 0 ? eloW : eloB);
      E.playMove(b, E.search(b.pos, Object.assign(cfg, { timeMs: 1e9, maxNodes: cfg.timeMs * NODES_PER_MS, rng: crng, history: b.history })).move);
    }
    return b.over.result === 'win' ? 1 : b.over.result === 'draw' ? 0.5 : 0;
  };
  console.log(`Part 0: elo calibration, ${CAL} games per cell (score of the first side; colours alternate)`);
  for (const elo of E.ELO_BANDS) {
    const cells = [];
    for (const [lbl, dW, extra] of [['equal', 0, null], ['+1 pawn', 0, 'P'], ['+knight', 0, 'N'], ['+100', 100, null], ['+200', 200, null], ['+300', 300, null]]) {
      let sc = 0;
      for (let i = 0; i < CAL; i++) sc += (i % 2 && !extra) ? 1 - game(elo, elo + dW, null, 100 + (i >> 1) * 13) : game(elo + dW, elo, extra, 100 + (i >> 1) * 13);
      cells.push(`${lbl} ${(100 * sc / CAL).toFixed(0)}%`);
    }
    const c = E.eloCfg(elo);
    console.log(`  elo ${elo} (depth ${c.maxDepth}, qs ${c.qsDepth}, ${c.timeMs} ms, jitter ${c.jitter}): ${cells.join(', ')}`);
  }
  console.log('');
}
const all = [];
if (PARTS.has(1)) {
  const state = E.newState(0, 1, ELO);
  for (let r = 0; r < RUNS; r++) {
    state.run = E.newRun(1000 + r * 77, state.upgrades, state.run.orders, ELO); E.skillStart(state);
    const memStart = state.memories, up = JSON.stringify(state.upgrades), bq0 = (state.bequest && state.bequest.paid) | 0, dm0 = state.diaryMem | 0, hall0 = state.hallN | 0;
    const s = simulateRun(state), run = state.run;
    all.push(...s.battles);
    const mem = s.end.startsWith('MATED') || s.end === 'KEEP FELL' ? E.mateMemories(run.sumTiers) : E.abdicateMemories(run);
    console.log(`run ${r + 1} (memories ${memStart}, upgrades ${up}): region ${run.map.region}, ${s.simT} ticks, ended: ${s.end}; +${mem} memories`);
    for (const g of s.regions) console.log(`  region ${g.region}: ${g.open ? 'not cleared after' : 'cleared in'} ${g.min} ticks, battles won ${g.wins}/${g.n}`);
    console.log(`  rival: border battles ${s.rv.border} (repelled ${s.rv.borderWon}, conceded ${s.rv.conceded}), keep assaults ${s.rv.keep} (held ${s.rv.keepWon}), nodes lost ${s.rv.lostNodes}`);
    console.log(`  raids ${s.raids.n}: defended ${s.raids.defended} (held ${s.raids.held}), conceded ${s.raids.conceded}; army ${run.roster.map(p => p.t).sort().join('')}, Tactician ${run.tact}, mines ${run.mines.length} (${(100 * E.incomePerTick(run, state.memories)).toFixed(1)} g/100 ticks)`);
    console.log(`  win rate: ${fmtBands(s.battles)}`);
    console.log(`  P1 Memories: bequests +${((state.bequest && state.bequest.paid) | 0) - bq0} (${(state.hallN | 0) - hall0} fallen), diaries +${(state.diaryMem | 0) - dm0} (titles: ${W.diaryTitles(state).length}); vs +${mem} from the run`);
    E.endRun(state, mem, 5000 + r);
    memSpend(state);
  }
  console.log(`\nPart 1 win rate by tier band: ${fmtBands(all)}`);
}

// Part 2
if (PARTS.has(2)) {
  const clear = [], p2 = [];
  let t5w = 0, t5n = 0, mated = 0, raidN = 0, raidHeld = 0, raidDef = 0;
  const ends = {}, rvTot = {};
  for (let i = +(process.env.FIRST || 0); i < T5_RUNS; i++) {
    const st = E.newState(0, 20000 + i * 31, ELO); W.ensureMap(st.run);
    const s = simulateRun(st, { maxT: REGION_CAP, stopRegion: 1 });
    if (s.regions[0] && !s.regions[0].open) clear.push(s.regions[0].min);
    if (s.end.startsWith('MATED')) mated++;
    const ek = s.end.replace(/\d+/g, '#'); ends[ek] = (ends[ek] || 0) + 1;
    if (process.env.V2) console.log(`  seed ${20000 + i * 31}: ${s.end}, ${s.simT} ticks, battles ${s.battles.length}, raids ${s.raids.n}`);
    raidN += s.raids.n; raidDef += s.raids.defended; raidHeld += s.raids.held;
    for (const k in s.rv) rvTot[k] = (rvTot[k] || 0) + s.rv[k];
    for (const b of s.battles) { p2.push(b); if (b[0] === 5 && b[2] !== 'raid') { t5n++; if (b[1]) t5w++; } }
  }
  clear.sort((a, b) => a - b);
  const q = f => clear.length ? clear[Math.min(clear.length - 1, Math.floor(f * clear.length))] : '-';
  const mean = clear.length ? clear.reduce((a, b) => a + b, 0) / clear.length : 0;
  console.log(`\nRegion 1 (default start, ${T5_RUNS} fresh runs, cap ${REGION_CAP} ticks): cleared ${clear.length}/${T5_RUNS}, mated ${mated}`);
  const capped = clear.concat(Array(T5_RUNS - clear.length).fill(REGION_CAP)).sort((a, b) => a - b);
  console.log(`  median over all runs (uncleared = ${REGION_CAP}): ${capped.length ? capped[Math.floor(capped.length / 2)] : '-'} ticks`);
  console.log(`  run ends: ${Object.entries(ends).map(([k, v]) => k + ' ' + v).join(', ')}`);
  console.log(`  clear time (ticks): mean ${mean.toFixed(0)}, p10 ${q(0.1)}, median ${q(0.5)}, p90 ${q(0.9)}`);
  console.log(`  win rate: ${fmtBands(p2)}`);
  console.log(`  win rate by tier (attacks): ${[1, 2, 3, 4, 5].map(t => { const l = p2.filter(b => b[0] === t && b[2] !== 'raid' && b[2] !== 'border'); return `t${t} ${l.length ? Math.round(100 * l.filter(b => b[1]).length / l.length) : '-'}% (${l.length})`; }).join(', ')}`);
  console.log(`  raids: ${raidN} (${(raidN / T5_RUNS).toFixed(1)} per run), defended ${raidDef}, held ${raidHeld}`);
  console.log(`  rival: border battles ${rvTot.border || 0} (repelled ${rvTot.borderWon || 0}, conceded ${rvTot.conceded || 0}), keep assaults ${rvTot.keep || 0} (held ${rvTot.keepWon || 0}), nodes lost ${rvTot.lostNodes || 0}`);
  const t5 = t5n ? t5w / t5n : 0;
  console.log(`  tier-5 battles: ${t5w}/${t5n} = ${(100 * t5).toFixed(0)}%`);
  if (t5 < 0.6 || t5 > 0.98) console.log(`FLAG: tier-5 win rate ${(100 * t5).toFixed(0)}% is outside 60-98%`);
  else console.log('OK: tier-5 win rate within 60-98%');
  if (!(mean >= 1500 && mean <= 3000)) console.log(`FLAG: mean region-1 clear time ${mean.toFixed(0)} ticks is outside 1500-3000`);
  else console.log('OK: region-1 clear time within 1500-3000 ticks');
}

// Part 3: a region-1 player goes away mid-region (v6: the world simply waits)
if (OFF > 0 && PARTS.has(3)) {
  console.log(`\nPart 3: ${OFF} runs: 1200 ticks of region 1, then away (v6: ${W.awayTicks(8 * 3600e3)} ticks granted for 8 h), then 2000 more ticks`);
  const agg = { str: [], nodes: [], pend: 0, first: [0, 0], lost: 0, cleared: 0, keep: 0, mated: 0, ok: 0 };
  for (let i = 0; i < OFF; i++) {
    const st = E.newState(0, 40000 + i * 17, ELO); W.ensureMap(st.run);
    const a = simulateRun(st, { maxT: 1200, stopRegion: 1 });
    if (a.end !== 'time cap') { console.log(`  seed ${40000 + i * 17}: ended before going offline (${a.end})`); continue; }
    const run = st.run, held0 = run.map.held.length;
    W.worldTick(st, W.awayTicks(8 * 3600e3), false);
    const rvs = run.map.rival, pend = W.rivalPending(run);
    agg.str.push(rvs.strength); agg.nodes.push(rvs.held.length); if (pend) agg.pend++;
    let first = null;
    if (pend) { const ba = W.borderArmy(run); first = `${W.borderMode(run)} vs ${ba.units} pts (army ${E.armyUnits(run.roster)})`; }
    const b = simulateRun(st, { maxT: 2000, stopRegion: 1 });
    const fb = b.battles.find(x => x[2] === 'border');
    if (fb) { agg.first[1]++; if (fb[1]) agg.first[0]++; }
    agg.lost += b.rv.lostNodes;
    if (b.end === 'done') agg.cleared++; else if (b.end === 'KEEP FELL') agg.keep++; else if (b.end.startsWith('MATED')) agg.mated++; else agg.ok++;
    console.log(`  seed ${40000 + i * 17}: held ${held0} nodes; rival on return: strength ${rvs.strength.toFixed(1)}, ${rvs.held.length} nodes, dwellings ${rvs.dwellings}${first ? ', waiting: ' + first : ''}; next 2000 ticks: ${b.end}, border ${b.rv.borderWon}/${b.rv.border} repelled, nodes lost ${b.rv.lostNodes}, held ${run.map.region > 1 ? 'region 2' : run.map.held.length}`);
  }
  const avg1 = a => a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : '-';
  console.log(`  summary: rival strength on return ${avg1(agg.str)}, rival nodes ${avg1(agg.nodes)}, battle waiting ${agg.pend}/${agg.str.length}; first border battle won ${agg.first[0]}/${agg.first[1]}; nodes lost ${agg.lost}; after 2000 ticks: cleared ${agg.cleared}, still fighting ${agg.ok}, keep fell ${agg.keep}, mated ${agg.mated}`);
}

// Part 4: deep runs, the per-region picture
if (DEEP > 0 && PARTS.has(4)) {
  const res = await runJobs(Array.from({ length: DEEP }, (_, i) => ({ kind: 'deep', seed: 60000 + i * 41, elo: ELO, maxT: DEEP_TICKS })));
  console.log(`\nPart 4: ${DEEP} fresh accounts at elo ${ELO}, one run each (cap ${DEEP_TICKS} ticks), per region (means per run that entered it):`);
  const maxR = Math.max(...res.map(r => r.regions.length ? r.regions[r.regions.length - 1].region : 1));
  const types = ['garrison', 'mine', 'town', 'shrine', 'citadel', 'ambush', 'raid', 'border', 'keep'];
  for (let R = 1; R <= maxR; R++) {
    const gs = res.map(r => r.regions.find(g => g.region === R)).filter(Boolean);
    if (!gs.length) continue;
    const cl = gs.filter(g => !g.open), ty = {};
    for (const g of gs) for (const k in g.type) { const x = ty[k] || (ty[k] = [0, 0]); x[0] += g.type[k][0]; x[1] += g.type[k][1]; }
    const inc = {}, cost = {}, lost = {}, by = {}, fy = {};
    for (const g of gs) { for (const k in g.inc) add(inc, k, g.inc[k]); for (const k in g.cost) add(cost, k, g.cost[k]); for (const k in g.lost) add(lost, k, g.lost[k]); for (const k in g.lostBy) add(by, k, g.lostBy[k]); for (const k in g.fairy) add(fy, k, g.fairy[k]); }
    const n = gs.length, per = o => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${fx0(v / n)}`).join(', ');
    const incT = sumOf(Object.values(inc)) / n, costT = sumOf(Object.values(cost)) / n, att = gs.reduce((s, g) => s + g.n, 0) / n;
    const ends = res.filter(r => r.regions.length && r.regions[r.regions.length - 1].region === R && r.regions[r.regions.length - 1].open).map(r => r.end.replace(/\d+/g, '#'));
    const endTally = {}; for (const e of ends) add(endTally, e, 1);
    console.log(`  region ${R}: entered ${n}, cleared ${cl.length} (${pct(cl.length, n)}); clear ticks mean ${fx0(avg(cl.map(g => g.min)))} median ${fx0(med(cl.map(g => g.min)))}; weeks ${(avg(cl.map(g => g.weeks))).toFixed(1)}; attacks ${att.toFixed(1)}`);
    console.log(`    win rate: ${types.filter(k => ty[k]).map(k => `${k} ${ty[k][0]}/${ty[k][1]} (${pct(ty[k][0], ty[k][1])})`).join(', ')}`);
    console.log(`    gold in ${fx0(incT)} (${per(inc)}) | out ${fx0(costT)} (${per(cost)}) | per attack ${fx0(incT / Math.max(1, att))}; next N/R/Q at exit ${fx0(avg(gs.map(g => g.next.N)))}/${fx0(avg(gs.map(g => g.next.R)))}/${fx0(avg(gs.map(g => g.next.Q)))}; army ${fx0(avg(gs.map(g => g.army)))} pts on ${fx0(avg(gs.map(g => g.squares)))} squares`);
    console.log(`    Memories: abdicate value at exit ${fx0(avg(gs.map(g => g.memAt)))}, bequests +${(avg(gs.map(g => g.bq))).toFixed(1)}, diaries +${(avg(gs.map(g => g.dm))).toFixed(1)}; bars ${(avg(gs.map(g => g.bars))).toFixed(1)}; skill XP +${fx0(avg(gs.map(g => g.xp)))}; exotics bought ${per(fy) || 'none'}`);
    console.log(`    raids ${(avg(gs.map(g => g.raids))).toFixed(1)} (held ${(avg(gs.map(g => g.raidsHeld))).toFixed(1)}), border ${(avg(gs.map(g => g.border))).toFixed(1)} (won ${(avg(gs.map(g => g.borderWon))).toFixed(1)}), keep assaults ${sumOf(gs.map(g => g.keep))} (held ${sumOf(gs.map(g => g.keepWon))}); deaths ${per(lost) || 'none'} | by cause ${per(by) || 'none'}${ends.length ? '; runs ended here: ' + Object.entries(endTally).map(([k, v]) => `${k} ${v}`).join(', ') : ''}`);
  }
  // exotic buy timing
  console.log('  exotic first buys (runs that bought it: region, ticks into the region, price):');
  for (const id of W.FAIRY_SHIP) {
    const f = res.map(r => r.fairyFirst[id]).filter(Boolean);
    const un = W.FAIRY_UNLOCK[id].region;
    if (f.length) console.log(`    ${id} (unlock region ${un}): ${f.length}/${res.filter(r => r.region >= un).length} runs, median region ${med(f.map(x => x.region))}, ${fx0(med(f.map(x => x.into)))} ticks in, ${fx0(med(f.map(x => x.cost)))} gold`);
    else console.log(`    ${id} (unlock region ${un}): never bought (${res.filter(r => r.region >= un).length} runs reached it)`);
  }
  // week clock: battles per week
  const cyc = res.flatMap(r => r.cycles).sort((a, b) => a - b);
  const q = f => cyc[Math.min(cyc.length - 1, Math.floor(f * cyc.length))];
  console.log(`  march + battle cycle (ticks): p10 ${q(0.1)}, median ${q(0.5)}, p90 ${q(0.9)}, mean ${fx0(avg(cyc))}: ${(W.WORLD.weekTicks / avg(cyc)).toFixed(2)} battles per ${W.WORLD.weekTicks}-tick week`);
  // push or abdicate: at each region exit, what pushing one more region was worth
  console.log('  push or abdicate (at the clear of region R: bank now, or push R+1; a mate pays 25%):');
  for (let R = 1; R < maxR; R++) {
    const cleared = res.filter(r => r.regions.some(g => g.region === R && !g.open));
    if (cleared.length < 3) continue;
    const bank = avg(cleared.map(r => r.regions.find(g => g.region === R).memAt));
    const push = avg(cleared.map(r => { const nx = r.regions.find(g => g.region === R + 1); if (nx && !nx.open) return nx.memAt; return r.end.startsWith('MATED') || r.end === 'KEEP FELL' ? r.payout : r.full; }));
    const died = cleared.filter(r => { const nx = r.regions.find(g => g.region === R + 1); return nx && nx.open && (r.end.startsWith('MATED') || r.end === 'KEEP FELL'); }).length;
    console.log(`    R${R}: bank ${fx0(bank)} vs push ${fx0(push)} (${(push / bank).toFixed(2)}x), died in R${R + 1} ${died}/${cleared.length}`);
  }
  const pays = res.map(r => r.payout);
  console.log(`  run payouts: mean ${fx0(avg(pays))}, median ${fx0(med(pays))}; whole Memories shop ${shopTotal()}; ends: ${Object.entries(res.reduce((o, r) => (add(o, r.end.replace(/\d+/g, '#'), 1), o), {})).map(([k, v]) => `${k} ${v}`).join(', ')}`);
}

// Part 5: marathons per elo band
if (MARATHON > 0 && PARTS.has(5)) {
  const res = await runJobs(MARATHON_BANDS.map((elo, i) => ({ kind: 'marathon', seed: 90000 + i * 1013, elo, attempts: MARATHON, maxT: RUN_TICKS, maxRuns: 30 })));
  console.log(`\nPart 5: marathons, one account per band, runs until ${MARATHON} regions entered (cap ${RUN_TICKS} ticks per run); whole Memories shop ${shopTotal()}`);
  for (const m of res) {
    console.log(`  elo ${m.elo}: ${m.runs.length} runs`);
    m.runs.forEach((r, i) => console.log(`    run ${i + 1}: reached region ${r.region} (${r.end}, ${r.simT} ticks); +${r.pay} payout, +${r.bq} bequests, +${r.dm} diaries; banked ${r.banked}, spent ${r.spent} on upgrades, ${r.shopLeft} of the shop left`));
    const maxR = Math.max(...m.runs.flatMap(r => r.regions.map(g => g.region)));
    const line = [];
    for (let R = 1; R <= maxR; R++) {
      const gs = m.runs.flatMap(r => r.regions.filter(g => g.region === R));
      if (!gs.length) continue;
      const att = gs.reduce((s, g) => [s[0] + (g.type.garrison ? g.type.garrison[0] : 0) + (g.type.citadel ? g.type.citadel[0] : 0), s[1] + (g.type.garrison ? g.type.garrison[1] : 0) + (g.type.citadel ? g.type.citadel[1] : 0)], [0, 0]);
      line.push(`R${R} ${gs.filter(g => !g.open).length}/${gs.length} cleared, garrison+seat wins ${pct(att[0], att[1])}, ${fx0(avg(gs.filter(g => !g.open).map(g => g.min)))}t`);
    }
    console.log(`    per region: ${line.join('; ')}`);
  }
}
console.log(`(wall time ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
