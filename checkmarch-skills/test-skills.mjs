// node test-skills.mjs: permanent per-type skills (skills.mjs). Pure logic, no engine needed.
import * as S from './skills.mjs';
import { readFileSync, statSync } from 'node:fs';
let fail = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fail++; };
const T = S.SKILL_TYPES;

// ---- module hygiene ----
{
  const src = readFileSync(new URL('skills.mjs', import.meta.url), 'utf8');
  const size = statSync(new URL('skills.mjs', import.meta.url)).size;
  ok(size < 25 * 1024, `skills.mjs is under 25 KB (${size} bytes)`);
  ok(!/\b(document|window|localStorage|Math\.random|Date\.now|performance)\b/.test(src.replace(/\/\/.*$/gm, '')), 'no DOM, storage, clock or randomness in the module');
  ok(!/^\s*import\b/m.test(src), 'skills.mjs has no imports (standalone)');
}

// ---- level curve ----
{
  ok(S.xpForLevel(1) === 0 && S.xpForLevel(2) === 81 && S.xpForLevel(10) === 1022, `curve anchors: L2 ${S.xpForLevel(2)}, L10 ${S.xpForLevel(10)}`);
  ok(S.xpForLevel(99) === 1918756, `L99 = ${S.xpForLevel(99)} xp (aspirational)`);
  let mono = true, accel = true;
  for (let l = 2; l <= 99; l++) {
    if (!(S.xpForLevel(l) > S.xpForLevel(l - 1))) mono = false;
    if (l >= 3 && !(S.xpForLevel(l) - S.xpForLevel(l - 1) >= S.xpForLevel(l - 1) - S.xpForLevel(l - 2))) accel = false;
  }
  ok(mono, 'xpForLevel strictly increases 1..99');
  ok(accel, 'each level costs at least as much as the one before (exponential-ish)');
  let inv = true;
  for (let l = 1; l <= 99; l++) {
    const x = S.xpForLevel(l);
    if (S.levelForXp(x) !== l) inv = false;
    if (l > 1 && S.levelForXp(x - 1) !== l - 1) inv = false;
  }
  ok(inv, 'levelForXp inverts xpForLevel exactly at every threshold (and xp-1 is one level lower)');
  let lm = true, prev = 1;
  for (let x = 0; x < 2.1e6; x += 997) { const l = S.levelForXp(x); if (l < prev) lm = false; prev = l; }
  ok(lm, 'levelForXp is monotone over a sweep');
  ok(S.levelForXp(-5) === 1 && S.levelForXp(NaN) === 1 && S.levelForXp('abc') === 1 && S.levelForXp(1e12) === 99, 'levelForXp clamps garbage to 1 and huge to 99');
  ok(S.xpForLevel(0) === 0 && S.xpForLevel(-3) === 0 && S.xpForLevel(150) === S.xpForLevel(99) && S.xpForLevel(NaN) === 0, 'xpForLevel clamps out-of-range levels');
  const p = S.levelProgress(S.xpForLevel(5) + Math.floor((S.xpForLevel(6) - S.xpForLevel(5)) / 2));
  ok(p.level === 5 && p.frac > 0.45 && p.frac < 0.55 && p.next === S.xpForLevel(6) && p.into + p.need === S.xpForLevel(6) - S.xpForLevel(5), 'levelProgress: halfway through level 5');
  ok(S.progressFrac(0) === 0 && S.progressFrac(S.xpForLevel(99)) === 1 && S.levelProgress(S.XP_CAP).next === null, 'progress 0 at start, 1 (no next) at 99');
  let inRange = true; for (let x = 0; x < 3e6; x += 4321) { const f = S.progressFrac(x); if (!(f >= 0 && f <= 1)) inRange = false; }
  ok(inRange, 'progress fraction always within 0..1');
}

// ---- perks ----
{
  const k12 = S.perksFor('N', 12);
  ok(k12.discount === 0.03 && k12.discountOn === 'piece' && k12.skill === 'Knightcraft', 'Knightcraft 12: knights 3% cheaper');
  ok(S.perksFor('P', 20).title === 'Yeoman' && S.perksFor('P', 19).title === 'Militiaman' && S.perksFor('P', 1).title === 'Recruit', 'Pawncraft 20: Yeoman (title ladder)');
  let capped = true, mono = true;
  for (const t of T) for (let l = 1; l <= 99; l++) {
    const a = S.perksFor(t, l), b = S.perksFor(t, l - 1 || 1);
    if (a.discount > S.PERK_TABLE.discCap + 1e-12 || a.marchCut > S.PERK_TABLE.marchCap + 1e-12) capped = false;
    if (a.discount < b.discount || a.start < b.start || a.marchCut < b.marchCut) mono = false;
  }
  ok(capped, 'discount never exceeds 25% and march cut never exceeds 15%');
  ok(mono, 'perks never decrease with level');
  ok(S.perksFor('Q', 98).discount === 0.245 && S.perksFor('Q', 99).discount === 0.25 && S.perksFor('Q', 500).discount === 0.25, 'discount: 24.5% at 98, the 25% cap lands exactly at 99');
  ok(S.perksFor('P', 9).start === 0 && S.perksFor('P', 10).start === 1 && S.perksFor('P', 99).start === 9, 'pawns: +1 starting pawn per 10 levels (9 at 99)');
  ok(S.perksFor('N', 29).start === 0 && S.perksFor('N', 30).start === 1 && S.perksFor('N', 99).start === 3, 'knights: starting knight at 30/60/90');
  ok(S.perksFor('R', 99).start === 2 && S.perksFor('Q', 98).start === 0 && S.perksFor('Q', 99).start === 1 && S.perksFor('K', 99).start === 0, 'rooks 45/90, queen only at 99, king none');
  ok(S.perksFor('K', 10).discountOn === 'square' && S.perksFor('K', 10).marchCut === 0.015 && S.perksFor('N', 50).marchCut === 0, 'Leadership: square discount + march cut (K only)');
  ok(S.perksFor('X', 5) === null && S.perksFor('P', -4).level === 1 && S.perksFor('P', 500).level === 99 && S.perksFor('P', 'x').level === 1, 'perksFor: unknown type null, levels clamped');
  ok(T.every(t => S.TITLES[t].length === S.TITLE_LEVELS.length), 'every type has a full title ladder');
  ok(S.perksFor('B', 99).nextTitle === null && S.perksFor('B', 95).nextTitle.level === 99, 'nextTitle points at the next rung (null at 99)');
}

// ---- levelUps ----
{
  ok(S.levelUps(0, 0, 'P').length === 0 && S.levelUps(500, 100, 'P').length === 0, 'no dings without a gain (or on a loss of xp)');
  ok(S.levelUps(S.xpForLevel(5), S.xpForLevel(6) - 1, 'P').length === 0, 'no ding one xp short of the threshold');
  const one = S.levelUps(S.xpForLevel(12) - 1, S.xpForLevel(12), 'N');
  ok(one.length === 1 && one[0].level === 12 && one[0].text === 'Knightcraft 12 — knights now 3% cheaper' && !one[0].big, `exact threshold dings once: "${one[0] && one[0].text}"`);
  const jump = S.levelUps(0, S.xpForLevel(21), 'P');
  ok(jump.length === 20 && jump[0].level === 2 && jump[19].level === 21 && jump.every((d, i) => d.level === i + 2), 'multi-level jump lists each level crossed, lowest first');
  const d10 = jump.find(d => d.level === 10), d20 = jump.find(d => d.level === 20);
  ok(d10.big && d10.title === 'Militiaman' && d10.start === 1 && /runs start with 1 extra pawn/.test(d10.text) && /title: Militiaman/.test(d10.text), `level 10 ding: "${d10.text}"`);
  ok(d20.text === 'Pawncraft 20 — pawns now 5% cheaper, runs start with 2 extra pawns, title: Yeoman', `level 20 ding: "${d20.text}"`);
  const cap = S.levelUps(S.xpForLevel(98), S.xpForLevel(99), 'R');
  ok(cap[0].text === 'Rookcraft 99 — rooks now 25% cheaper (max), title: Unbreached', `cap ding: "${cap[0].text}"`);
  const mid = S.levelUps(S.xpForLevel(85), S.xpForLevel(86), 'R');
  ok(mid[0].text === 'Rookcraft 86 — rooks now 21.5% cheaper', `a plain level: "${mid[0].text}"`);
  let pays = true;
  for (const t of T) for (const d of S.levelUps(0, S.xpForLevel(99), t)) if (/mastery deepens/.test(d.text)) pays = false;
  ok(pays, 'every level 2..99 of every skill pays a perk (no empty dings)');
  const k = S.levelUps(S.xpForLevel(11), S.xpForLevel(12), 'K');
  ok(k[0].text === 'Leadership 12 — squares now 3% cheaper, marches 1.8% faster', `king ding: "${k[0].text}"`);
  const top = S.levelUps(S.xpForLevel(98), S.XP_CAP * 10, 'Q');
  ok(top.length === 1 && top[0].level === 99 && top[0].big && top[0].title === 'Queen Eternal' && top[0].start === 1, 'level 99 ding: big, title, the starting queen; nothing past 99');
  const gen = S.levelUps(0, S.xpForLevel(3));
  ok(gen.length === 2 && gen[1].text === 'Level 3' && gen[1].type === null, 'without a type: generic entries');
  ok(S.levelUps('junk', null, 'P').length === 0 && S.levelUps(-100, S.xpForLevel(2), 'P').length === 1, 'garbage xp is treated as 0');
  const toasts = S.dingToasts(S.levelUps(S.xpForLevel(9), S.xpForLevel(12), 'P').concat(S.levelUps(0, S.xpForLevel(2), 'K')));
  ok(toasts.length === 2 && toasts[0].type === 'P' && toasts[0].level === 12 && toasts[0].big && toasts[0].title === 'Militiaman' && toasts[0].from === 9, 'dingToasts folds a jump into one toast per skill, big first');
  ok(/runs start with 1 extra pawn/.test(toasts[0].text) && /3% cheaper/.test(toasts[0].text), `folded toast keeps deltas over the jump: "${toasts[0].text}"`);
}

// ---- XP sources ----
{
  ok(S.tierMult(1) === 1 && S.tierMult(26) === 2 && S.tierMult(1000) === S.XP_TABLE.tierMultMax && S.tierMult('x') === 1, 'tier multiplier: 1 at tier 1, +4%/tier, capped');
  const t = S.newTally(['K', 'P', 'P', 'P', 'N', 'zz']);
  ok(t.f.P === 3 && t.f.K === 1 && t.f.N === 1 && !t.f.zz, 'newTally counts fielded types, ignores junk');
  S.noteCapture(t, 'P', 'P'); S.noteCapture(t, 'N', 'R'); S.noteCapture(t, 'P', 'K'); S.noteCapture(t, 'Z', 'Q');
  S.noteLoss(t, 'P'); S.notePromotion(t); S.noteMate(t, 'N');
  ok(t.c.P === 1 && t.c.N === 5 && t.l.P === 1 && t.p === 1 && t.m === 'N', 'tally records captures (victim units), losses, promotions, the mater');
  const w = S.battleXp(t, 'win', 1);
  // P: capture 10 + survive 2x4 + win 3x8 + promote 30 = 72 ; N: 50 + 4 + 8 + mate 150 = 212 ; K: 4 + 8 + lead 4x2 = 20
  ok(w.P === 72 && w.N === 212 && w.K === 20 && !w.B, `win at tier 1: ${JSON.stringify(w)}`);
  const d = S.battleXp(t, 'draw', 1);
  ok(d.P === 48 && d.N === 54 && d.K === 4, `draw: survival + captures, no win/mate xp: ${JSON.stringify(d)}`);
  const m = S.battleXp(t, 'mate', 1);
  ok(m.P === 40 && m.N === 50 && !m.K, `own King mated: captures + promotion only: ${JSON.stringify(m)}`);
  const w26 = S.battleXp(t, 'win', 26);
  ok(w26.P === 144 && w26.N === 424, 'tier 26 doubles battle xp');
  ok(JSON.stringify(S.battleXp(null, 'win', 3)) === '{}' && JSON.stringify(S.battleXp({ f: { P: -3 }, l: { P: 99 }, c: 'x' }, 'win', 3)) === '{}', 'battleXp of empty/garbage tally is {}');
  const lostMore = S.battleXp({ f: { P: 1 }, l: { P: 5 } }, 'loss', 1);
  ok(!lostMore.P, 'survivors never go negative');
  ok(JSON.stringify(S.captureXp('B', 'Q', 1)) === '{"B":90}' && JSON.stringify(S.captureXp('B', 'K', 1)) === '{}', 'captureXp: bishop takes queen = 90; kings are worth 0');
  ok(S.marchXp(1).K === 6 && S.marchXp(26).K === 12, 'march: tiny Leadership xp');
  const sk = S.newSkills();
  ok(JSON.stringify(S.mineXp(sk, 249, [])) === '{}' && sk.mg === 249, 'mine gold banks below a milestone');
  const g = S.mineXp(sk, 2, ['N', 'N', 'K', 'B', 'junk']);
  ok(g.N === 4 && g.B === 4 && !g.K && sk.mg === 1, `milestone pays garrisoned types (not K): ${JSON.stringify(g)}`);
  ok(S.mineXp(sk, 500, null).P === 8 && sk.mg === 1, 'no garrison: pawns work the mine (2 milestones)');
  ok(S.mineXp(sk, 1e9, ['R']).R === S.XP_TABLE.mineMaxPerCall * S.XP_TABLE.mine && sk.mg < S.XP_TABLE.mineEvery, 'huge mine amounts are capped per call');
  ok(JSON.stringify(S.mineXp(sk, NaN, [])) === '{}' && JSON.stringify(S.mineXp(sk, -50, [])) === '{}' && JSON.stringify(S.mineXp(null, 500)) === '{}', 'mineXp tolerates garbage');
  ok(JSON.stringify(S.mergeGains({ P: 3, K: 1 }, null, { P: 2.7, Q: -5 })) === '{"P":5,"K":1}', 'mergeGains sums positive integer gains');
}

// ---- applyGains ----
{
  const sk = S.newSkills();
  const r = S.applyGains(sk, { P: S.xpForLevel(10), K: 0, N: -40, X: 99 });
  ok(sk.P.xp === 1022 && sk.N.xp === 0 && r.gained.P === 1022 && !r.gained.N && r.dings.length === 9 && r.dings[8].level === 10, 'applyGains adds xp, ignores junk, returns 9 dings for 1 -> 10');
  ok(S.gainText(r.gained) === '+1022 Pawncraft', 'gainText');
  sk.Q.xp = S.XP_CAP - 5;
  const c = S.applyGains(sk, { Q: 100 });
  ok(sk.Q.xp === S.XP_CAP && c.gained.Q === 5, 'xp is capped at XP_CAP');
  ok(S.applyGains(sk, { Q: 100 }).dings.length === 0 && !S.applyGains(sk, { Q: 100 }).gained.Q, 'nothing gained at the cap');
  const broken = { P: 'x' };
  S.applyGains(broken, { P: 10, R: 5 });
  ok(broken.P.xp === 10 && broken.R.xp === 5, 'applyGains repairs missing/broken entries');
  ok(S.applyGains(null, { P: 5 }).dings.length === 0, 'applyGains(null) is a no-op');
  const sk2 = S.newSkills(), sk3 = S.newSkills(), tl = S.newTally(['K', 'P', 'P']);
  S.noteCapture(tl, 'P', 'N');
  S.applyGains(sk2, S.battleXp(tl, 'win', 7)); S.applyGains(sk3, S.battleXp(S.cleanTally(JSON.parse(JSON.stringify(tl))), 'win', 7));
  ok(JSON.stringify(sk2) === JSON.stringify(sk3), 'deterministic: same tally (also after a JSON round-trip) -> same skills');
}

// ---- save / migration ----
{
  const fresh = S.newSkills();
  ok(T.every(t => fresh[t].xp === 0) && fresh.mg === 0, 'newSkills: all zero');
  const garbage = [undefined, null, 0, 42, 'skills', [], [1, 2], true, { P: null }, { P: { xp: 'NaN' }, N: { xp: -5 }, B: { xp: Infinity }, R: { xp: 1e99 }, Q: [], mg: 'x' },
    { P: 123.9, K: '456', junk: { xp: 1 }, mg: -7 }, { mg: 1e9 }, JSON.parse('{"__proto__":{"xp":5},"P":{"xp":7}}')];
  let allClean = true;
  for (const gb of garbage) {
    const c = S.cleanSkills(gb);
    const keys = Object.keys(c).sort().join();
    if (keys !== 'B,K,N,P,Q,R,mg') allClean = false;
    for (const t of T) if (!(Number.isInteger(c[t].xp) && c[t].xp >= 0 && c[t].xp <= S.XP_CAP) || Object.keys(c[t]).join() !== 'xp') allClean = false;
    if (!(c.mg >= 0 && c.mg <= S.XP_TABLE.mineEvery)) allClean = false;
  }
  ok(allClean, `cleanSkills turns ${garbage.length} kinds of garbage into a valid sub-schema`);
  const m = S.cleanSkills({ P: 123.9, K: '456', junk: { xp: 1 } });
  ok(m.P.xp === 123 && m.K.xp === 456 && !('junk' in m), 'bare-number entries are accepted, extra keys dropped');
  const r = S.cleanSkills({ R: { xp: 1e99 }, B: { xp: Infinity } });
  ok(r.R.xp === S.XP_CAP && r.B.xp === 0, 'huge xp clamps to the cap; Infinity is rejected');
  const real = S.newSkills(); S.applyGains(real, { P: 5000, N: 777, K: 321 }); real.mg = 12.5;
  ok(JSON.stringify(S.cleanSkills(JSON.parse(JSON.stringify(real)))) === JSON.stringify(real), 'a real save round-trips through JSON + cleanSkills unchanged');
  const big = S.newSkills(); for (const t of T) big[t].xp = S.XP_CAP; big.mg = 249.99;
  const bytes = JSON.stringify(big).length;
  ok(bytes < 140, `maxed-out save is tiny (${bytes} bytes)`);
  ok(JSON.stringify(S.cleanTally({ f: { P: 'x', N: 2 }, c: null, p: -1, m: 'Z' })) === '{"f":{"N":2},"l":{},"c":{},"p":0,"m":null}', 'cleanTally repairs a corrupt battle tally');
  // persistence across a run reset: skills live on state, endRun only replaces state.run
  const state = { skills: S.newSkills(), run: { roster: [], nextId: 1 } };
  S.applyGains(state.skills, { P: S.xpForLevel(30) });
  const endRun = st => { st.run = { roster: [{ id: 1, t: 'K' }], nextId: 2 }; }; // engine endRun shape
  endRun(state);
  ok(S.skillLevel(state.skills, 'P') === 30, 'skills survive a run reset (stored on state)');
  const b = S.grantStart(state.run, state.skills);
  ok(b.P === 3 && state.run.roster.filter(p => p.t === 'P').length === 3 && state.run.nextId === 5 && !('bought' in state.run), 'grantStart: 3 free reserve pawns at Pawncraft 30, ids advance, prices untouched');
  ok(S.grantStart(state.run, state.skills) === null && state.run.roster.length === 4, 'grantStart is once per run');
  ok(S.grantStart(null, state.skills) === null && S.grantStart({}, state.skills) === null, 'grantStart ignores a bad run');
}

// ---- price helpers ----
{
  const sk = S.newSkills(); sk.N.xp = S.xpForLevel(12); sk.K.xp = S.xpForLevel(50);
  ok(S.skillPrice(sk, 'N', 1000) === 970 && S.skillPrice(sk, 'P', 25) === 25, 'skillPrice: Knightcraft 12 takes 3% off; Pawncraft 1 rounds back to base on cheap pawns');
  ok(S.squarePriceSkill(sk, 1000) === 875 && S.marchTicksSkill(sk, 100) === 93 && S.marchTicksSkill(sk, 1) === 1, 'Leadership 50: squares -12.5%, marches -7.5% (never below 1 tick)');
  ok(JSON.stringify(S.skillMods(sk)) === '{"P":0.0025,"N":0.03,"B":0.0025,"R":0.0025,"Q":0.0025,"sq":0.125,"march":0.075}', `skillMods flat cache: ${JSON.stringify(S.skillMods(sk))}`);
  ok(JSON.stringify(S.skillMods(null)) === JSON.stringify(S.skillMods(S.newSkills())), 'skillMods(null) = fresh skills');
  ok(S.skillPrice(sk, 'X', 50) === 50, 'skillPrice on an unknown type is the base price');
  ok(S.totalLevel(S.newSkills()) === 6 && S.totalLevel(sk) === 6 - 2 + 12 + 50, 'totalLevel sums the six skills');
}

// ---- pacing (info + loose guard): a typical early battle, a typical late battle ----
{
  const early = S.newTally(['K', 'P', 'P', 'P']); S.noteCapture(early, 'P', 'P'); S.noteCapture(early, 'P', 'P'); S.noteLoss(early, 'P');
  const e = S.battleXp(early, 'win', 3);
  const n10 = Math.ceil(S.xpForLevel(10) / e.P);
  console.log(`info early battle (tier 3, 3 pawns, 2 pawn captures, 1 lost): ${JSON.stringify(e)} -> Pawncraft 10 in ~${n10} wins`);
  ok(n10 >= 10 && n10 <= 40, 'Pawncraft 1-10 takes a session or two (10-40 early wins)');
  const late = S.newTally(['K', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'N', 'N', 'B', 'R']);
  for (let i = 0; i < 4; i++) S.noteCapture(late, 'P', 'P'); S.noteCapture(late, 'N', 'B'); S.noteLoss(late, 'P'); S.noteLoss(late, 'P');
  const l = S.battleXp(late, 'win', 40);
  const n99 = Math.ceil(S.xpForLevel(99) / l.P);
  console.log(`info late battle (tier 40, 8 pawns): ${JSON.stringify(l)} -> Pawncraft 99 in ~${n99} such wins`);
  ok(n99 > 3000, 'Pawncraft 99 stays aspirational (thousands of late wins)');
}

console.log(fail ? `\n${fail} FAILED` : '\nall skills tests passed');
process.exit(fail ? 1 : 0);
