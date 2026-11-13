// node test-content.mjs  -- schema, legality, balance and demo-freshness tests for the content pack.
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as C from './content.mjs';
import { demoHtml } from './build-demo.mjs';

const here = p => fileURLToPath(new URL(p, import.meta.url));
let pass = 0, fail = 0; const warns = [];
function test(name, fn) {
  try { const r = fn(); if (r && r.length) throw new Error(r.slice(0, 12).join('\n    ') + (r.length > 12 ? `\n    ... +${r.length - 12} more` : '')); pass++; console.log('ok   ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '\n    ' + e.message); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

// optional live engine (READ ONLY: imported, never written; in-memory use only)
const ENGINE_PATH = '/home/user/checkmarch/engine.mjs';
const E = existsSync(ENGINE_PATH) ? await import(ENGINE_PATH) : null;

// ---------------------------------------------------------------- counts + uniqueness
test('collection counts meet the brief', () => {
  const e = [];
  if (C.SHRINE_CHOICES.length < 24) e.push('shrines < 24');
  if (C.RIVAL_LORDS.length !== 16) e.push('lords != 16');
  if (C.ENEMY_FORMATION_PACK.length < 20) e.push('formations < 20');
  if (C.PIECE_SETS.length !== 8) e.push('piece sets != 8');
  for (const k of ['battleWin', 'battleLoss', 'raid', 'raidRepelled', 'raidLost', 'cache', 'regionWin', 'regionLose'])
    if (!C.EVENT_LINES[k] || C.EVENT_LINES[k].length < 10) e.push('EVENT_LINES.' + k + ' < 10');
  return e;
});
test('validateAll() is clean (reference budget)', () => C.validateAll());
test('ids unique within and across collections', () => {
  const all = [...C.SHRINE_CHOICES, ...C.RIVAL_LORDS, ...C.ENEMY_FORMATION_PACK, ...C.PIECE_SETS].map(x => x.id);
  const seen = new Set(), e = [];
  for (const id of all) { if (seen.has(id)) e.push('duplicate id ' + id); seen.add(id); }
  return e;
});

// ---------------------------------------------------------------- shrine choices
test('every shrine label <= 60 chars, names unique, labels unique', () => {
  const e = [], labels = new Set();
  for (const c of C.SHRINE_CHOICES) for (const s of ['a', 'b']) {
    if (c[s].label.length > 60) e.push(`${c.id}.${s} ${c[s].label.length} chars`);
    if (labels.has(c[s].label)) e.push('duplicate label ' + c[s].label); labels.add(c[s].label);
  }
  return e;
});
test('effect vocabulary is closed and fully used', () => {
  const e = [], used = new Set();
  for (const c of C.SHRINE_CHOICES) for (const s of [c.a, c.b]) for (const p of [s.effect, ...(s.effect.parts || [])]) {
    if (!(p.kind in C.EFFECT_KINDS)) e.push(`${c.id}: kind ${p.kind} not in vocabulary`);
    used.add(p.kind);
  }
  for (const k of C.EFFECT_KIND_LIST) if (!used.has(k)) e.push('vocabulary kind never used: ' + k);
  return e;
});
test('shrine trade-offs: both sides worth something, within 2x of each other', () => {
  const e = [];
  for (const c of C.SHRINE_CHOICES) {
    const a = C.effectValue(c.a.effect, c.minRegion), b = C.effectValue(c.b.effect, c.minRegion);
    if (!(a > 0 && b > 0)) e.push(`${c.id}: non-positive side (a ${a}, b ${b})`);
    else if (Math.max(a, b) / Math.min(a, b) > 2) e.push(`${c.id}: lopsided a ${a.toFixed(0)} vs b ${b.toFixed(0)}`);
    if (c.a.effect.kind === c.b.effect.kind && c.a.effect.kind !== 'combo' && c.a.effect.scope === c.b.effect.scope) e.push(c.id + ': both sides are the same kind');
  }
  return e;
});
test('every combo carries a real cost (one part is negative)', () => {
  const e = [];
  for (const c of C.SHRINE_CHOICES) for (const s of ['a', 'b']) {
    const ef = c[s].effect; if (ef.kind !== 'combo') continue;
    const vals = ef.parts.map(p => C.effectValue(p, c.minRegion));
    if (!vals.some(v => v < 0) || !vals.some(v => v > 0)) e.push(`${c.id}.${s}: combo without a cost and a gain`);
  }
  return e;
});
test('minRegion sane: 1..10, gates strong effects, region 1 has >= 6 shrines, every region 1-6 has some', () => {
  const e = [];
  for (const c of C.SHRINE_CHOICES) {
    if (!Number.isInteger(c.minRegion) || c.minRegion < 1 || c.minRegion > C.MAX_REGION) e.push(c.id + ': minRegion ' + c.minRegion);
    for (const s of ['a', 'b']) if (C.effectMinRegion(c[s].effect) > c.minRegion) e.push(`${c.id}.${s}: needs region ${C.effectMinRegion(c[s].effect)}`);
  }
  if (C.shrineChoicesFor(1).length < 6) e.push('region 1 pool < 6');
  for (let r = 1; r <= 6; r++) if (!C.SHRINE_CHOICES.some(c => c.minRegion === r)) e.push('no shrine introduced at region ' + r);
  return e;
});
test('world.mjs compatibility: today\'s knight / mines choices are representable', () => {
  const m = C.SHRINE_CHOICES.find(c => c.id === 'mossy-altar');
  assert(m && m.a.effect.kind === 'promotePawn' && m.a.effect.to === 'N', 'knight side missing');
  assert(m.b.effect.kind === 'mineIncomeMult' && m.b.effect.scope === 'region' && (!E || m.b.effect.v === E.TUNE.shrineMineBoost), 'mines side != TUNE.shrineMineBoost');
});
test('validators reject malformed effects / shrines (negative cases)', () => {
  const bad = [
    { kind: 'rations' }, { kind: 'gold', v: 0 }, { kind: 'gold', v: 1.5 }, { kind: 'trait', piece: 'K', v: 1, scope: 'region' },
    { kind: 'trait', piece: 'P', v: 1 }, { kind: 'mineIncomeMult', v: 1.2, scope: 'next' }, { kind: 'squares', v: 1, extra: 1 },
    { kind: 'combo', parts: [{ kind: 'gold', v: 1 }] }, { kind: 'combo', parts: [{ kind: 'combo', parts: [] }, { kind: 'gold', v: 1 }] },
  ];
  const e = [];
  for (const b of bad) if (!C.validateEffect(b).length) e.push('accepted ' + JSON.stringify(b));
  const s = JSON.parse(JSON.stringify(C.SHRINE_CHOICES[0]));
  s.a.label = 'x'.repeat(61); if (!C.validateShrine(s).length) e.push('accepted a 61-char label');
  const q = JSON.parse(JSON.stringify(C.SHRINE_CHOICES.find(c => c.id === 'queens-cradle'))); q.minRegion = 1;
  if (!C.validateShrine(q).length) e.push('accepted a region-1 queen promotion');
  return e;
});

// ---------------------------------------------------------------- rival lords
test('lords: schema, taunt <= 80, all doctrines used, each has matching formations', () => {
  const e = [];
  for (const l of C.RIVAL_LORDS) {
    e.push(...C.validateLord(l));
    if (l.taunt.length > 80) e.push(l.id + ': taunt too long');
    if (!C.formationsForLord(l).length) e.push(l.id + ': no formation matches doctrine + favored pieces');
  }
  for (const d of C.DOCTRINES) if (C.RIVAL_LORDS.filter(l => l.doctrine === d).length < 4) e.push('doctrine ' + d + ' has < 4 lords');
  return e;
});
test('lords: names original (not engine BOSSES), doctrines map to engine DOCTRINES', () => {
  const e = [];
  if (E) {
    const bossWords = new Set(E.BOSSES.join(' ').split(/\W+/).filter(w => w.length > 3));
    for (const l of C.RIVAL_LORDS) for (const w of l.name.split(/\W+/)) if (bossWords.has(w)) e.push(`${l.id}: "${w}" reused from BOSSES`);
    for (const d of C.DOCTRINES) if (!E.DOCTRINES[C.ENGINE_DOCTRINE[d]]) e.push('engine has no doctrine ' + C.ENGINE_DOCTRINE[d]);
  } else warns.push('engine.mjs not found: skipped BOSSES / DOCTRINES cross-check');
  return e;
});
test('lordForRegion is deterministic and cycles through the roster', () => {
  const seen = new Set();
  for (let r = 1; r <= 16; r++) seen.add(C.lordForRegion(12345, r).id);
  assert(seen.size === 16, 'regions 1-16 of one run should meet all 16 lords, got ' + seen.size);
  assert(C.lordForRegion(99, 3) === C.lordForRegion(99, 3), 'not deterministic');
});

// ---------------------------------------------------------------- formations
const FILES = 'abcdefgh';
function indepLegality(f) {
  const e = [], seen = new Set();
  const ks = f.pieces.filter(p => p.type === 'K').length;
  if (ks !== 1) e.push(`${f.id}: ${ks} kings`);
  for (const p of f.pieces) {
    const file = FILES.indexOf(p.square[0]), rank = Number(p.square.slice(1));
    if (p.square.length !== 2 || file < 0 || !(rank >= 1 && rank <= 8)) e.push(`${f.id}: bad square ${p.square}`);
    if (rank < 5 || rank > 8) e.push(`${f.id}: ${p.square} outside ranks 5-8`);
    if (!'PNBRQK'.includes(p.type) || p.type.length !== 1) e.push(`${f.id}: bad type ${p.type}`);
    if (p.type === 'P' && rank === 8) e.push(`${f.id}: pawn on the back rank`);
    if (seen.has(p.square)) e.push(`${f.id}: duplicate ${p.square}`); seen.add(p.square);
  }
  const units = f.pieces.reduce((a, p) => a + ({ P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 })[p.type], 0);
  if (units !== f.budget) e.push(`${f.id}: budget tag ${f.budget} vs ${units}`);
  return e;
}
test('formation legality (independent check): one king, legal squares, ranks 5-8, no duplicates, budget tag', () =>
  C.ENEMY_FORMATION_PACK.flatMap(indepLegality));
test('formation bands: budget within [0.5x, 1.1x] at both ends of the band (reference budget)', () => {
  const e = [];
  for (const f of C.ENEMY_FORMATION_PACK) {
    const t = f.citadel ? 'citadel' : 'garrison', lo = C.refBudget(f.tiers[0], t), hi = C.refBudget(f.tiers[1], t);
    if (lo < 0.5 * f.budget - 1e-9 || hi > 1.1 * f.budget + 1e-9) e.push(`${f.id}: band ${f.tiers} -> ${lo.toFixed(1)}..${hi.toFixed(1)} vs ${f.budget}`);
    const b = C.bandFor(f.budget, f.citadel);
    if (!b || f.tiers[0] < b[0] || f.tiers[1] > b[1]) e.push(`${f.id}: tags ${f.tiers} outside bandFor ${b}`);
  }
  return e;
});
test('formation coverage: every tier 2-45 has >= 2 garrison formations; >= 3 citadels; each doctrine >= 6', () => {
  const e = [];
  for (let t = 2; t <= 45; t++) if (C.formationsForTier(t, { citadel: false }).length < 2) e.push('tier ' + t + ' has < 2 garrison formations');
  if (C.ENEMY_FORMATION_PACK.filter(f => f.citadel).length < 3) e.push('< 3 citadels');
  for (const d of C.DOCTRINES) if (C.ENEMY_FORMATION_PACK.filter(f => f.doctrine === d).length < 6) e.push(d + ' < 6 formations');
  return e;
});
test('validateFormation rejects broken formations (negative cases)', () => {
  const base = C.ENEMY_FORMATION_PACK.find(f => f.id === 'bell-tower');
  const mk = fn => { const f = JSON.parse(JSON.stringify(base)); fn(f); return f; };
  const cases = {
    'two kings': mk(f => f.pieces.push({ type: 'K', square: 'a8' })),
    'no king': mk(f => { f.pieces[0].type = 'Q'; }),
    'rank 4': mk(f => { f.pieces[1].square = 'd4'; }),
    'bad square': mk(f => { f.pieces[1].square = 'i6'; }),
    'duplicate': mk(f => { f.pieces[2].square = f.pieces[1].square; }),
    'pawn on 8': mk(f => { f.pieces[1].square = 'a8'; }),
    'budget tag': mk(f => { f.budget++; }),
    'band too wide': mk(f => { f.tiers = [1, 60]; }),
  };
  const e = [];
  for (const [n, f] of Object.entries(cases)) if (!C.validateFormation(f).length) e.push('accepted: ' + n);
  return e;
});
test('engine merge (in memory): toEngineFormation round-trips and enemyArmy builds legal armies', () => {
  if (!E) { warns.push('engine.mjs not found: skipped engine merge test'); return []; }
  const e = [];
  const FORM = E.FORMATIONS, saved = FORM.slice();
  try {
    for (const f of C.ENEMY_FORMATION_PACK) {
      const ef = C.toEngineFormation(f);
      // round-trip through the engine's own slot parsing
      const slots = ef.s.split(' ').map(x => ({ t: x[0], sq: E.parseSq(x.slice(1)) }));
      if (slots.length !== f.pieces.length - 1 || E.parseSq(ef.k) !== E.parseSq(f.pieces[0].square)) e.push(f.id + ': round-trip mismatch');
      // swap the table to just this formation and let the engine build armies across the band
      FORM.length = 0; FORM.push(f.citadel ? Object.assign({}, ef) : ef);
      if (f.citadel) FORM.push(Object.assign({}, ef, { citadel: false })); else FORM.push(Object.assign({}, ef, { citadel: true }));
      for (const tier of [f.tiers[0], Math.round((f.tiers[0] + f.tiers[1]) / 2), f.tiers[1]]) {
        const a = E.enemyArmy(7, tier, { type: f.citadel ? 'citadel' : 'garrison', key: 1 });
        const kings = a.pieces.filter(p => p.t === 'K').length, sqs = new Set(a.pieces.map(p => p.sq));
        if (kings !== 1 || sqs.size !== a.pieces.length) e.push(`${f.id}@${tier}: engine army illegal`);
        if (a.name !== f.name) e.push(`${f.id}@${tier}: engine picked ${a.name}`);
        const pos = E.emptyPos(); E.setPiece(pos, E.parseSq('e1'), E.WHITE, E.K);
        for (const p of a.pieces) E.setPiece(pos, p.sq, E.BLACK, E.CH_TYPE[p.t]);
        pos.side = E.BLACK;
        if (E.inCheck(pos, E.BLACK) || !E.legalMoves(pos).length) e.push(`${f.id}@${tier}: black has no legal start`);
      }
    }
  } finally { FORM.length = 0; FORM.push(...saved); }
  return e;
});
test('reference budget matches live engine.mjs enemyBudget (drift = warning)', () => {
  if (!E) { warns.push('engine.mjs not found: skipped drift check'); return []; }
  let worst = 0;
  for (let t = 1; t <= 60; t++) for (const ty of ['garrison', 'citadel']) worst = Math.max(worst, Math.abs(E.enemyBudget(t, ty) / C.refBudget(t, ty) - 1));
  if (worst > 1e-9) {
    const stale = C.ENEMY_FORMATION_PACK.filter(f => C.validateFormation(f, E.enemyBudget).length).map(f => f.id);
    warns.push(`engine enemyBudget drifted from REF_TUNE (max ${(worst * 100).toFixed(1)}%); stale bands: ${stale.join(', ') || 'none'}`);
  }
  return [];
});

// ---------------------------------------------------------------- piece sets
test('piece sets: schema, exactly one default, CSS vars well-formed', () => {
  const e = [];
  for (const s of C.PIECE_SETS) {
    e.push(...C.validatePieceSet(s));
    const v = C.pieceSetVars(s);
    for (const k of ['--pc-weight', '--pc-player-hue', '--pc-player-light', '--pc-enemy-hue', '--pc-enemy-light', '--pc-outline'])
      if (typeof v[k] !== 'string' || !v[k]) e.push(s.id + ': missing ' + k);
  }
  if (C.PIECE_SETS.filter(s => s.unlockedBy.kind === 'default').length !== 1) e.push('need exactly one default set');
  const bad = JSON.parse(JSON.stringify(C.PIECE_SETS[1])); bad.outline = 'neon'; bad.glyphWeight = 450;
  if (C.validatePieceSet(bad).length < 2) e.push('validator accepted a bad outline / weight');
  return e;
});

// ---------------------------------------------------------------- event lines + text hygiene
test('event lines: <= 90 chars raw and after sample substitution, closed placeholders, no duplicates', () => {
  const e = [];
  for (const [k, lines] of Object.entries(C.EVENT_LINES)) lines.forEach((l, i) => {
    e.push(...C.validateLine(l, `${k}[${i}]`));
    const filled = C.fillLine(l, C.LINE_SAMPLE);
    if (filled.length > 90) e.push(`${k}[${i}]: ${filled.length} chars after substitution`);
    if (/\{\w+\}/.test(filled)) e.push(`${k}[${i}]: unfilled placeholder`);
  });
  if (!C.validateLine('Hello {player}', 'x').length) e.push('accepted unknown placeholder');
  if (!C.validateLine('x'.repeat(91), 'x').length) e.push('accepted a 91-char line');
  return e;
});
test('text hygiene: printable ASCII only, no real-world names or brands', () => {
  const BANNED = /\b(google|apple|disney|marvel|nintendo|london|paris|rome|tokyo|america|england|france|christ|jesus|allah|buddha|napoleon|caesar|kasparov|carlsen|fischer|magnus|tolkien|gandalf|westeros|hogwarts|coca|pepsi|iphone|internet|euro|dollar)\b/i;
  const e = [];
  const texts = [];
  for (const c of C.SHRINE_CHOICES) texts.push(c.name, c.a.label, c.b.label);
  for (const l of C.RIVAL_LORDS) texts.push(l.name, l.epithet, l.taunt, l.personalityNote);
  for (const f of C.ENEMY_FORMATION_PACK) texts.push(f.name);
  for (const s of C.PIECE_SETS) texts.push(s.name);
  for (const lines of Object.values(C.EVENT_LINES)) texts.push(...lines);
  for (const t of texts) {
    if (!/^[\x20-\x7e]+$/.test(t)) e.push('non-ASCII text: ' + t);
    if (BANNED.test(t)) e.push('real-world reference: ' + t);
  }
  return e;
});

// ---------------------------------------------------------------- syntax + demo
test('node --check on content.mjs, build-demo.mjs, test-content.mjs and the demo inline script', () => {
  const e = [];
  for (const f of ['content.mjs', 'build-demo.mjs', 'test-content.mjs']) {
    try { execFileSync(process.execPath, ['--check', here('./' + f)], { stdio: 'pipe' }); } catch (x) { e.push(f + ': ' + String(x.stderr || x.message).split('\n')[0]); }
  }
  const html = readFileSync(here('./content-demo.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  if (scripts.length !== 1) e.push('expected one inline script, got ' + scripts.length);
  const dir = mkdtempSync(join(tmpdir(), 'cm-content-'));
  scripts.forEach((s, i) => {
    const p = join(dir, 'inline' + i + '.js'); writeFileSync(p, s);
    try { execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' }); } catch (x) { e.push('inline script ' + i + ': ' + String(x.stderr || x.message).split('\n').slice(0, 4).join(' ')); }
  });
  return e;
});
test('demo is fresh (content-demo.html == build-demo.mjs output); run `node build-demo.mjs` if not', () => {
  const html = readFileSync(here('./content-demo.html'), 'utf8');
  assert(html === demoHtml(), 'content-demo.html is stale');
});
test('demo follows the artifact page contract', () => {
  const html = readFileSync(here('./content-demo.html'), 'utf8'), e = [];
  if (!html.startsWith('<title>Checkmarch Content Demo</title>')) e.push('must start with the <title>');
  if (/<(!doctype|html|head|body)[\s>]/i.test(html)) e.push('has document skeleton tags');
  if (/(src|href)\s*=\s*["']?(https?:)?\/\//i.test(html) || /@import|url\(\s*["']?https?:/i.test(html)) e.push('external resource');
  if (!/@media \(prefers-color-scheme: dark\)\{ :root:not\(\[data-theme="light"\]\)/.test(html)) e.push('missing dark-mode token block');
  if (!html.includes(':root[data-theme="dark"]')) e.push('missing explicit dark theme block');
  if (!/body\{[^}]*background:var\(--bg\)/.test(html)) e.push('body background not a token');
  if (/\balert\(|\bconfirm\(|\bprompt\(/.test(html)) e.push('uses alert/confirm/prompt');
  if (!/localStorage[\s\S]{0,80}catch/.test(html)) e.push('localStorage not guarded');
  return e;
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const w of warns) console.log('WARN ' + w);
console.log(`counts: shrines ${C.SHRINE_CHOICES.length}, lords ${C.RIVAL_LORDS.length}, formations ${C.ENEMY_FORMATION_PACK.length} ` +
  `(${C.ENEMY_FORMATION_PACK.filter(f => f.citadel).length} citadel), piece sets ${C.PIECE_SETS.length}, event lines ` +
  Object.entries(C.EVENT_LINES).map(([k, l]) => k + ' ' + l.length).join(', ') + `, effect kinds ${C.EFFECT_KIND_LIST.length}`);
process.exit(fail ? 1 : 0);
