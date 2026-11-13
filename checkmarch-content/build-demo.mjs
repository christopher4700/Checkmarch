// Builds content-demo.html from content-demo.src.html + the data in content.mjs.
// node build-demo.mjs        -> writes content-demo.html
// import { demoHtml }        -> the expected page text (test-content.mjs checks freshness)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as C from './content.mjs';

const here = p => fileURLToPath(new URL(p, import.meta.url));

export function demoData() {
  const used = {};
  for (const k of C.EFFECT_KIND_LIST) used[k] = 0;
  for (const c of C.SHRINE_CHOICES) for (const s of [c.a, c.b]) {
    used[s.effect.kind]++;
    if (s.effect.kind === 'combo') for (const p of s.effect.parts) used[p.kind]++;
  }
  return {
    version: C.CONTENT_VERSION,
    shrines: C.SHRINE_CHOICES.map(c => ({ ...c,
      a: { ...c.a, value: Math.round(C.effectValue(c.a.effect, c.minRegion)) },
      b: { ...c.b, value: Math.round(C.effectValue(c.b.effect, c.minRegion)) } })),
    lords: C.RIVAL_LORDS.map(l => ({ ...l, formations: C.formationsForLord(l).map(f => f.name) })),
    formations: C.ENEMY_FORMATION_PACK,
    pieceSets: C.PIECE_SETS.map(s => ({ ...s, css: C.pieceSetVars(s) })),
    lines: C.EVENT_LINES,
    effects: Object.fromEntries(Object.entries(C.EFFECT_KINDS).map(([k, d]) => [k, { ...d, used: used[k] }])),
  };
}

export function demoHtml() {
  const src = readFileSync(here('./content-demo.src.html'), 'utf8');
  const json = JSON.stringify(demoData()).replace(/</g, '\\u003c');
  if (!src.includes('/*__CONTENT__*/null')) throw new Error('placeholder missing in content-demo.src.html');
  return src.replace('/*__CONTENT__*/null', json);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(here('./content-demo.html'), demoHtml());
  console.log('wrote content-demo.html');
}
