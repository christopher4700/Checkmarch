// engine-patch.mjs: the fairy integration patch for ../checkmarch/engine.mjs, as code.
// patchEngineSource(src) returns the patched source text (the original file is never written). The tests and
// the calibration harness import the result in memory (data: URL). FAIRY-API.md lists the same edits for a
// hand integration. Two parts:
//   A. widen the piece encoding from color<<3|type (3-bit type) to color<<5|type (5-bit type, fairy types 8+);
//   B. add the fairy hooks: setFairyHooks(h), genMoves branch for t > 7, isAttacked tail call, evaluate terms.
import { readFileSync } from 'node:fs';

// A. encoding: only expressions on piece codes are rewritten (p, q, pc, cap and board reads b[..] / pos.b[..]);
// square arithmetic (sq >> 3, to & 7, ...) is untouched. Each rule states how many hits it expects so a drift
// in engine.mjs fails loudly instead of silently mis-patching.
export const ENCODING_RULES = [
  { re: /\b(p|q|pc|cap)(\s*)>>(\s*)3\b/g, to: '$1$2>>$35', what: 'colour of a piece code' },
  { re: /(\.b\[[^\]]+\])\s*>>\s*3\b/g, to: '$1 >> 5', what: 'colour of a board read' },
  { re: /<<\s*3\b/g, to: '<< 5', what: 'colour << 3 when building a code' },
  { re: /\b(p|pc|cap)(\s*)&(\s*)7\b/g, to: '$1$2&$331', what: 'type of a piece code' },
  { re: /(\.b\[[^\]]+\])\s*&\s*7\b/g, to: '$1 & 31', what: 'type of a board read' },
  { re: /\(m >> 13\) & 7\b/g, to: '(m >> 13) & 31', what: 'type of the captured piece' },
  { re: /\(m >> 13\) & 15\b/g, to: '(m >> 13) & 63', what: 'captured piece code (6 bits)' },
];

// B. hook insertions: [anchor, replacement]; each anchor must occur exactly once
export const HOOK_EDITS = [
  ['let SKM = null;',
   'let SKM = null;\n// fairy pieces (fairy.mjs): FX = fairyHooks; types > 7 go to FX.gen / FX.attacked / FX.evalPiece / FX.evalAdjust\nlet FX = null;\nexport function setFairyHooks(h) { FX = h || null; if (h) h.bind({ WALL, VAL, TYPE_CH, CH_TYPE, UNITS, PIECE_NOUN }); }'],
  ['    }\n  }\n  return false;\n}\nexport function inCheck',
   '    }\n  }\n  if (FX && FX.attacked(b, sq, by)) return true;\n  return false;\n}\nexport function inCheck'],
  ['    } else {\n      const d0 = t === B ? 4 : 0, d1 = t === R ? 4 : 8, rays = RAYS[sq];\n      for (let d = d0; d < d1; d++) {\n        const ray = rays[d];\n        for',
   '    } else if (t > 7) {\n      if (FX) FX.gen(b, sq, t, side, out, capturesOnly);\n    } else {\n      const d0 = t === B ? 4 : 0, d1 = t === R ? 4 : 8, rays = RAYS[sq];\n      for (let d = d0; d < d1; d++) {\n        const ray = rays[d];\n        for'],
  ['        break;\n    }\n    sc[c] += v;',
   '        break;\n      default: if (t > 7 && FX) v += FX.evalPiece(b, sq, c, t, endgame);\n    }\n    sc[c] += v;'],
  ['  let s = sc[0] - sc[1];\n',
   '  let s = sc[0] - sc[1];\n  if (FX) s += FX.evalAdjust(b);\n'],
];

export function patchEngineSource(src) {
  const log = [];
  for (const r of ENCODING_RULES) {
    const n = (src.match(r.re) || []).length;
    src = src.replace(r.re, r.to); log.push(`${n} x ${r.what}`);
  }
  for (const [a, b] of HOOK_EDITS) {
    const n = src.split(a).length - 1;
    if (n !== 1) throw new Error(`fairy patch anchor found ${n} times: ${JSON.stringify(a.slice(0, 60))}`);
    src = src.replace(a, b);
  }
  // PIECE_NOUN is declared after setFairyHooks is defined; it is only read when setFairyHooks runs (after load)
  return { src, log };
}
export async function loadPatchedEngine(path = new URL('../checkmarch/engine.mjs', import.meta.url)) {
  const { src, log } = patchEngineSource(readFileSync(path, 'utf8'));
  const E = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
  return { E, src, log };
}
