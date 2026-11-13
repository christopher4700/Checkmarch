// node test-discovery.mjs: road treasure, artifacts, named locations, scouting and save migration.
import * as D from './discovery.mjs';
import * as M from './map.mjs';
import * as CT from './content.mjs';
import { readFileSync, existsSync } from 'node:fs';
let fail = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fail++; };
const J = x => JSON.stringify(x);

// copies of the map/content modules must match their source projects (no behaviour changes)
const SRC = '/mnt/project-files/checkmarch-src/';
for (const [f, src] of [['map.mjs', SRC + 'checkmarch-map/map.mjs'], ['content.mjs', SRC + 'checkmarch-content/content.mjs']]) {
  if (!existsSync(src)) { console.log(`info ${src} not present; skipping copy check`); continue; }
  ok(readFileSync(new URL(f, import.meta.url), 'utf8') === readFileSync(src, 'utf8'), `${f} is a verbatim copy of ${src}`);
}

// a bare run: what discovery.mjs reads (run.gold, run.map.{seed, region, held})
function fresh(seed, region = 1) {
  const run = { seed, gold: 0, map: { seed: (seed >>> 0).toString(36) + '-r' + region, region, held: [0] } };
  D.initDiscovery(run);
  return run;
}
const regionFor = run => M.generateRegion(run.map.seed, run.map.region);

// ---- vocabulary: new kinds registered, tables validate ----
{
  ok(Object.keys(D.DISCOVERY_EFFECT_KINDS).every(k => CT.EFFECT_KINDS[k]), 'discovery kinds are registered into content EFFECT_KINDS');
  ok(CT.EFFECT_KIND_LIST.every(k => !D.DISCOVERY_EFFECT_KINDS[k]), 'no discovery kind shadows a content kind');
  ok(D.ARTIFACTS.length >= 8 && D.ARTIFACTS.length <= 12 && new Set(D.ARTIFACTS.map(a => a.id)).size === D.ARTIFACTS.length, `${D.ARTIFACTS.length} artifacts, unique ids`);
  const aErr = D.ARTIFACTS.flatMap(a => CT.validateEffect(a.effect, a.id));
  ok(!aErr.length, 'every artifact effect validates' + (aErr.length ? ': ' + aErr.join('; ') : ''));
  ok(D.ARTIFACTS.every(a => CT.effectParts(a.effect).every(p => !p.scope || p.scope === 'run')), 'artifact effects are run-scoped or one-shot (no next/region)');
  ok(D.ARTIFACTS.every(a => a.minRegion >= D.discMinRegion(a.effect)), 'artifact minRegion respects the content region gates');
  ok(D.ARTIFACTS.every(a => a.name.length <= CT.LIMITS.name && a.text.length <= CT.LIMITS.note), 'artifact names/texts within content limits');
  ok(D.LOCATIONS.length >= 6 && D.LOCATIONS.length <= 10, `${D.LOCATIONS.length} location archetypes`);
  const lErr = [];
  for (const l of D.LOCATIONS) l.variants.forEach((v, vi) => {
    if (v.minRegion < l.minRegion) lErr.push(l.id + vi + ' minRegion below archetype');
    for (const r of [v.minRegion, 10]) {
      const run = { seed: 1, gold: 1e6, arts: [], map: { seed: 'x', region: r, held: [0], scouted: [], sites: [{ at: 1, arch: l.id, v: vi, dx: 0, dy: 0, focus: null, prize: 'lodestone', done: 0, later: false }] } };
      const card = D.siteCard(run, 0, M.generateRegion('x', r));
      for (const side of ['a', 'b']) {
        if (!card[side]) { if (side === 'a') lErr.push(l.id + ' has no a'); continue; }
        lErr.push(...CT.validateEffect(card[side].effect, `${l.id}[${vi}].${side}@r${r}`));
        if (D.discMinRegion(card[side].effect) > v.minRegion) lErr.push(`${l.id}[${vi}].${side} needs region ${D.discMinRegion(card[side].effect)}`);
        if (v[side].label.length > CT.LIMITS.label) lErr.push(`${l.id}[${vi}].${side} label over ${CT.LIMITS.label}`);
        if (card[side].label.includes('{')) lErr.push(`${l.id}[${vi}].${side} unfilled placeholder`);
      }
      if (card.b && card.a.label === card.b.label) lErr.push(l.id + vi + ' identical labels');
    }
  });
  ok(!lErr.length, 'every location variant builds valid, region-gated cards at its minRegion and region 10' + (lErr.length ? ': ' + lErr.join('; ') : ''));
}

ok(D.LOCATION_BY_ID['abandoned-camp'].variants.every(v => /even odds/.test(v.a.label) && /ambush/.test(v.a.label)) && D.LOCATION_BY_ID['abandoned-camp'].variants.length === 2,
  'Abandoned Camp discloses its odds (two equally likely variants, "even odds" in the label)');

// ---- determinism + density + value scaling ----
{
  const reg = M.generateRegion('abc-r1', 1);
  ok(J(D.placeTreasure('abc-r1', reg)) === J(D.placeTreasure('abc-r1', reg)), 'same seed -> same treasure');
  ok(J(D.placeSites('abc-r1', reg)) === J(D.placeSites('abc-r1', reg)), 'same seed -> same sites');
  ok(J(fresh(77).map) === J(fresh(77).map), 'initDiscovery is deterministic per run seed');
  ok(J(D.placeTreasure('abc-r1', reg)) !== J(D.placeTreasure('abd-r1', M.generateRegion('abd-r1', 1))), 'different seeds -> different treasure');
  let piles = 0, roads = 0, bad = 0, mem = 0, early = 0, arts = 0, dup = 0;
  const gold = { 1: [], 3: [] };
  for (let s = 0; s < 80; s++) for (const r of [1, 3, 5]) {
    const seed = 's' + s + '-r' + r, rg = M.generateRegion(seed, r), T = D.placeTreasure(seed, rg);
    const roadSet = new Set(rg.roads.map(([a, b]) => a + ',' + b)), keys = T.map(t => t.a + ',' + t.b);
    piles += T.length; roads += rg.roads.length;
    bad += T.filter(t => !roadSet.has(t.a + ',' + t.b) || t.t < 0.3 || t.t > 0.7 || CT.validateEffect(t.e).length).length;
    dup += keys.length - new Set(keys).size;
    mem += T.filter(t => t.k === 'memory').length; early += T.filter(t => t.k === 'memory' && r < 3).length;
    arts += T.filter(t => t.k === 'art').length;
    if (gold[r]) gold[r].push(...T.filter(t => t.k === 'gold').map(t => t.e.v));
  }
  const per = roads / piles, avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  ok(per >= 3.8 && per <= 5.5, `density: 1 pile per ${per.toFixed(2)} roads`);
  ok(!bad && !dup, 'every pile sits on a real road, mid-road, with a valid effect, at most one per road');
  ok(!early && mem > 0, `Memories appear (${mem}) but never before region 3`);
  ok(arts > 0 && arts < piles * 0.08, `artifacts in treasure are rare (${arts}/${piles})`);
  ok(avg(gold[1]) >= 15 && avg(gold[1]) <= 40 && avg(gold[3]) > 2 * avg(gold[1]), `gold scales with region (r1 ${avg(gold[1]).toFixed(0)}, r3 ${avg(gold[3]).toFixed(0)})`);
  let sitesOk = true, cnt = [];
  for (let s = 0; s < 80; s++) for (const r of [1, 2, 4]) {
    const seed = 'q' + s + '-r' + r, rg = M.generateRegion(seed, r), S = D.placeSites(seed, rg), vis = M.visibility({ region: rg, held: [0] });
    cnt.push(S.length);
    if (S.length < 3 || S.length > 5 || new Set(S.map(x => x.at)).size !== S.length || new Set(S.map(x => x.arch)).size !== S.length) sitesOk = false;
    if (S.some(x => vis[x.at] !== 'fog' || D.LOCATION_BY_ID[x.arch].minRegion > r || D.LOCATION_BY_ID[x.arch].variants[x.v].minRegion > r)) sitesOk = false;
    if (S.some(x => Math.hypot(x.dx, x.dy) < 20 || (D.LOCATION_BY_ID[x.arch].prize && !D.ARTIFACT_BY_ID[x.prize]))) sitesOk = false;
  }
  ok(sitesOk, `sites: 3-5 per region (mean ${avg(cnt).toFixed(2)}), distinct anchors + archetypes, start in fog, region-gated`);
}

// ---- collectOnMarch: pickups, idempotence, sweep ----
{
  const run = fresh(5), reg = regionFor(run), T = run.map.treasure, t = T[0], i0 = 0;
  const g1 = D.collectOnMarch(run, t.a, t.b);
  ok(g1.length === 1 && g1[0].id === i0 && g1[0].text && g1[0].short && T[0].got === 1, `a march over a pile picks it up ("${g1[0].text}" ${g1[0].short})`);
  ok(D.collectOnMarch(run, t.a, t.b).length === 0 && D.collectOnMarch(run, t.b, t.a).length === 0, 'no double pickup (either direction)');
  ok(D.collectOnMarch(run, 0, 0).length === 0 && D.collectOnMarch(run, null, 3).length === 0, 'non-roads give nothing');
  const g = T.find(x => x.k === 'gold' && !x.got);
  if (g) { const r2 = D.collectOnMarch(run, g.b, g.a)[0]; ok(r2.apply.length === 1 && r2.apply[0].kind === 'gold' && r2.apply[0].v === g.e.v, 'a gold pile returns its gold effect for the game to apply'); }
  const f = M.frontier({ region: reg, held: run.map.held })[0];
  ok(D.marchFrom(run, f) === 0 && D.marchFrom(run, reg.citadelId) === null, 'marchFrom: the held end of the road');
  run.map.held = reg.nodes.map(n => n.id);
  const sw = D.sweepHeld(run);
  ok(sw.length === T.length - 1 - (g ? 1 : 0) && T.every(x => x.got) && D.sweepHeld(run).length === 0, 'sweepHeld collects every pile inside your territory once');
  // an artifact pile: awarded once; owned already -> gold fallback
  const ra = { seed: 1, gold: 0, arts: [{ id: 'gilded-purse', r: 1 }], map: { seed: 'x', region: 2, held: [0], treasure: [
    { a: 0, b: 1, t: 0.5, k: 'art', art: 'obsidian-chip', e: { kind: 'gold', v: 50 }, got: 0 },
    { a: 0, b: 2, t: 0.5, k: 'art', art: 'gilded-purse', e: { kind: 'gold', v: 50 }, got: 0 }] } };
  const x1 = D.collectOnMarch(ra, 0, 1)[0], x2 = D.collectOnMarch(ra, 2, 0)[0];
  ok(x1.art && x1.art.id === 'obsidian-chip' && D.artifactTotal(ra, 'traitWard') === 1 && x1.apply.length === 0, 'an artifact pile awards the artifact (passive kinds are read live, nothing to apply)');
  ok(!x2.art && x2.apply[0].kind === 'gold' && ra.arts.length === 2 && !ra.map.arts, 'an already-owned artifact pays its gold fallback instead');
}

// ---- artifact rolls + awards ----
{
  let inPool = true, rares = 0, commons = 0;
  for (let r = 1; r <= 10; r++) for (let s = 0; s < 400; s++) {
    const id = D.rollArtifact('seed' + s, r), a = D.ARTIFACT_BY_ID[id];
    if (!a || a.minRegion > r) inPool = false; else if (a.rarity === 'rare') rares++; else commons++;
    const ex = ['lodestone', 'gilded-purse'], id2 = D.rollArtifact('seed' + s, r, ex);
    if (ex.includes(id2)) inPool = false;
  }
  ok(inPool, 'rollArtifact: always a known artifact, minRegion respected, exclusions respected');
  ok(rares > 0 && rares < commons, `rares are rarer (${rares} rare / ${commons} common)`);
  ok(D.rollArtifact('z', 1, D.ARTIFACTS.map(a => a.id)) === null, 'rollArtifact: null when the pool is empty');
  ok(D.ARTIFACTS.filter(a => a.minRegion <= 1).every(a => [...Array(4000).keys()].some(s => D.rollArtifact('w' + s, 1) === a.id)), 'every region-1 artifact can roll');
  const run = { seed: 1, gold: 0, map: { seed: 'x', region: 1, held: [0] } };
  const w = D.awardArtifact(run, 'vanguard-banner');
  ok(w && w.apply.length === 1 && w.apply[0].kind === 'squares' && D.awardArtifact(run, 'vanguard-banner') === null && run.arts.length === 1 && !run.map.arts, 'awardArtifact: one-shot effect returned once, no duplicates');
  ok(D.awardArtifact(run, 'nope') === null, 'awardArtifact: unknown id refused');
  D.awardArtifact(run, 'tacticians-lens');
  ok(D.artifactTotal(run, 'hints') === 1 && D.artifactTotal(run, 'sight') === 0, 'artifactTotal reads passives from held artifacts');
}

// ---- scouting ----
{
  const run = fresh(9), reg = regionFor(run);
  const far = reg.nodes.find(n => n.dist === 3);
  const fresh1 = D.revealAround(run, far.id, 1, reg), vis = D.discVisibility(reg, run.map.held, run.map.scouted);
  ok(fresh1.includes(far.id) && vis[far.id] === 'scouted' && M.visibility({ region: reg, held: run.map.held })[far.id] === 'fog', 'revealAround lifts fog on a far patch (scouted, not frontier)');
  ok(D.revealAround(run, far.id, 1, reg).length === 0, 'revealing the same patch again reveals nothing new');
  const fv = D.discFogView(reg, run.map.held, run.map.scouted);
  ok(fv[far.id].name && fv.filter(n => n.vis === 'fog').every(n => n.silhouette && !n.name && !n.type), 'discFogView: scouted nodes show info, fog leaks nothing');
  ok(D.revealOnCapture(run, 0, reg).length === 0, 'no sight artifact: capture reveals nothing extra');
  run.arts.push({ id: 'scout-spyglass', r: 1 });
  { const rs = D.revealOnCapture(run, 0, reg); ok(rs.length > 0 && rs.every(id => reg.nodes[id].dist === 2), 'Spyglass: capture scouts 2 roads around (the dist-2 ring was fog)'); }
  const run2 = fresh(9);
  ok(D.visibleTreasure(run2).every(t => M.visibility({ region: reg, held: [0] })[t.a] !== 'fog' && M.visibility({ region: reg, held: [0] })[t.b] !== 'fog'), 'visible treasure never sits on a fogged road');
  ok(D.visibleSites(run2).length === 0, 'at the start every site is still hidden in fog');
  const p = D.roadPoint({ x: 0, y: 0 }, { x: 10, y: 0 }, { cx: 5, cy: 4 }, 0.5);
  ok(p.x === 5 && p.y === 2, 'roadPoint follows the quadratic road curve');
}

// ---- sites: open, resolve, ambush ----
{
  const reg = M.generateRegion('x', 2);
  const mk = (arch, v, gold = 0, prize = null) => ({ seed: 1, gold, arts: [], map: { seed: 'x', region: 2, held: [0, 1], scouted: [], treasure: [], site: null, ambush: null,
    sites: [{ at: 1, arch, v, dx: 20, dy: -20, focus: reg.citadelId - 1, prize, done: 0, later: false }] } });
  const run = mk('cartographer', 0, 10);
  ok(D.openSite(run, 0) && D.discoveryBusy(run), 'openSite on a held anchor opens the card (marches should wait)');
  const card = D.siteCard(run, 0, reg);
  ok(!card.a.ok && !card.b.ok && D.resolveSite(run, 'a', reg) === null, `cannot afford "${card.a.label}" with 10 gold`);
  run.gold = 1000;
  const res = D.resolveSite(run, 'a', reg);
  ok(res && res.apply.some(p => p.kind === 'gold' && p.v === -65) && res.revealed.length > 0 && run.map.sites[0].done === 'a' && run.map.site === null, 'resolve: gold cost scaled (r2: 40 -> 65) for the game to apply, fog lifted');
  ok(!D.openSite(run, 0) && D.resolveSite(run, 'b', reg) === null, 'a visited site cannot be used again');
  const ob = mk('obelisk', 0); D.openSite(ob, 0);
  const ro = D.resolveSite(ob, 'a', reg);
  ok(ro.revealed.includes(reg.citadelId - 1) && !ob.map.scouted.includes(1), 'obelisk reveals a patch around its far focus');
  const vault = mk('sunken-vault', 0, 1000, 'war-drum'); D.openSite(vault, 0);
  ok(/War Drum/.test(D.siteCard(vault, 0, reg).a.label), 'vault card names its prize');
  const rv = D.resolveSite(vault, 'b', reg);
  ok(rv.ambush && D.ambushSpec(vault, reg).budgetMult === 0.9 && D.ambushSpec(vault, reg).mapId === 1 && D.discoveryBusy(vault), 'forcing the vault starts an ambush');
  const fa = D.finishAmbush(vault, true);
  ok(fa.art && fa.art.id === 'war-drum' && fa.apply[0].kind === 'tacticianElo' && !vault.map.ambush && D.finishAmbush(vault, true) === null, 'winning the ambush pays the prize once');
  const camp = mk('abandoned-camp', 1); D.openSite(camp, 0); D.dismissSite(camp);
  ok(camp.map.site === null && camp.map.sites[0].later && !camp.map.sites[0].done, '"Not now" keeps the site for later');
  const ac = D.afterCapture(camp, 1, reg);
  ok(ac.site === null && D.openSite(camp, 0), 'a dismissed site does not pop up again, but a tap reopens it');
  const camp2 = mk('abandoned-camp', 0); camp2.map.held = [0];
  const ac2 = D.afterCapture(Object.assign(camp2, { map: Object.assign(camp2.map, { held: [0, 1] }) }), 1, reg);
  ok(ac2.site === 0 && camp2.map.site === 0, 'afterCapture opens the card of the site at the captured node');
}

// ---- save: migration of old saves, clean round-trip, next region ----
{
  const old = { seed: 3, gold: 50, map: { seed: '3-r2', region: 2, held: [0, 1], march: null, shrine: null, garrison: {}, raid: { t: 1, n: 0, pending: null }, rlog: [] } };
  D.cleanDiscovery(old);
  ok(old.map.disc === 0 && J(old.map.treasure) === '[]' && J(old.map.sites) === '[]' && J(old.arts) === '[]' && !('arts' in old.map) && old.map.site === null && old.map.ambush === null, 'a v4 save without discovery fields loads with no discovery content (disc 0)');
  ok(D.collectOnMarch(old, 0, 1).length === 0 && D.visibleSites(old).length === 0 && !D.discoveryBusy(old), 'an old-save map is inert');
  const junk = { seed: 3, gold: 0, map: { seed: '3-r1', region: 1, held: [0], disc: 1, treasure: [null, { a: 0, b: 999, k: 'gold', e: { kind: 'gold', v: 5 } }, { a: 0, b: 1, k: 'gold', e: { kind: 'bogus' } }],
    sites: 'x', scouted: [1, 1, -4, 'a', 2], arts: [{ id: 'lodestone' }, { id: 'lodestone' }, { id: 'zzz' }, 7], site: 5, ambush: { site: 0, v: 9 } } };
  D.cleanDiscovery(junk);
  ok(junk.map.treasure.length === 0 && junk.map.sites.length === 0 && J(junk.map.scouted) === '[1,2]' && J(junk.arts) === '[{"id":"lodestone","r":0}]' && !('arts' in junk.map) && junk.map.site === null && junk.map.ambush === null, 'garbage fields are dropped; valid artifacts migrate from run.map.arts to run.arts');
  const run = fresh(21); D.collectOnMarch(run, run.map.treasure[0].a, run.map.treasure[0].b); D.awardArtifact(run, 'war-drum');
  const back = JSON.parse(J(run)); D.cleanDiscovery(back);
  ok(J(back.map) === J(run.map) && J(back.arts) === J(run.arts), 'a populated map survives a JSON round-trip + clean unchanged');
  // next region: the game replaces run.map (newWorldMap), then initDiscovery carries the artifacts
  old.arts = [{ id: 'gilded-purse', r: 2 }]; old.map = { seed: '3-r3', region: 3, held: [0] };   // newWorldMap replaces run.map
  D.initDiscovery(old);
  ok(old.map.disc === 1 && old.map.treasure.length >= 2 && old.map.sites.length >= 3 && old.arts.length === 1 && old.arts[0].id === 'gilded-purse' && D.ownsArtifact(old, 'gilded-purse'), 'the next region gets discovery content; run.arts survives the map swap with no extra hook');
  ok(!old.map.treasure.some(t => t.art === 'gilded-purse') && !old.map.sites.some(s => s.prize === 'gilded-purse'), 'owned artifacts are never placed again');
}

console.log(fail ? `\n${fail} FAILED` : '\nall discovery tests passed');
process.exit(fail ? 1 : 0);
