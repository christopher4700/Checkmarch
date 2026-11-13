// node calibrate-fairy.mjs [gamesPerPiece=40] [depth=2] [nodes=2500]
// Muller-style self-play calibration: engine-vs-engine games from imbalanced starts. For each fairy piece X the
// "X side" plays the standard array with one piece S swapped for X (wizards: both bishops for a wizard pair);
// the other side keeps S. Every opening (4 seeded random plies) is played twice with colours swapped.
// A pawn-odds baseline (one side without its b- and g-pawns) converts score into centipawns at this search strength:
//   implied value(X) = value(S) + (score(X) - 0.5) / (0.5 - score(pawn odds)) * 100
// Games end on mate / stalemate / threefold, or are adjudicated on "neutral" material (X counted as S, so the
// adjudication never assumes the value being measured) at a lead of 250 after ply 40 or 150 at the ply cap.
import * as F from './fairy.mjs';
import { loadPatchedEngine } from './engine-patch.mjs';

const GAMES = +(process.argv[2] || 40), DEPTH = +(process.argv[3] || 2), NODES = +(process.argv[4] || 2500), CAP = 120;
const { E } = await loadPatchedEngine(new URL('../checkmarch/engine.mjs', import.meta.url));
E.setFairyHooks(F.fairyHooks); F.setFairyPieces(F.FAIRY_ROSTER.map(d => d.id));
const sq = s => (s.charCodeAt(0) - 97) + (parseInt(s.slice(1), 10) - 1) * 8, mir = s => s ^ 56;

// [id, white squares swapped (black uses the mirror), reference type, reference value]
const MATCHES = [
  ['commoner', ['g1'], E.N], ['champion', ['g1'], E.N], ['wizard', ['c1', 'f1'], E.B], ['cannon', ['c1'], E.B],
  ['nightrider', ['h1'], E.R], ['gryphon', ['h1'], E.R], ['archbishop', ['d1'], E.Q], ['chancellor', ['d1'], E.Q], ['amazon', ['d1'], E.Q],
];
function setup(xColor, id, squares) {
  const pos = E.startPos();
  if (id === 'pawnodds') { for (const s of squares) pos.b[xColor ? mir(sq(s)) : sq(s)] = 0; return pos; }
  for (const s of squares) pos.b[xColor ? mir(sq(s)) : sq(s)] = xColor << 5 | F.FAIRY_BY_ID[id].type;
  return pos;
}
function neutralLead(pos, refVal) { // white minus black
  let s = 0; for (const p of pos.b) { if (!p) continue; const t = p & 31; const v = t > 7 ? refVal : E.VAL[t]; s += (p >> 5) ? -v : v; }
  return s;
}
// result from white's view: 1, 0.5, 0
function play(pos, rng, refVal) {
  const hist = new Map(), cfg = { maxDepth: DEPTH, qsDepth: 4, maxNodes: NODES, timeMs: 1e6, jitter: 8, rng };
  for (let i = 0; i < 4; i++) { const lm = E.legalMoves(pos); if (!lm.length) break; E.makeMove(pos, lm[Math.floor(rng() * lm.length)]); }
  for (let ply = 0; ply < CAP; ply++) {
    const gs = E.gameState(pos);
    if (gs === 'mate') return pos.side ? 1 : 0;
    if (gs === 'stalemate') return 0.5;
    const k = E.posKey(pos), c = (hist.get(k) || 0) + 1; hist.set(k, c); if (c >= 3) return 0.5;
    const lead = neutralLead(pos, refVal);
    if (ply >= 40 && Math.abs(lead) >= 250) return lead > 0 ? 1 : 0;
    const r = E.search(pos, Object.assign({ history: hist }, cfg));
    if (!r.move) return 0.5;
    E.makeMove(pos, r.move);
  }
  const lead = neutralLead(pos, refVal);
  return lead >= 150 ? 1 : lead <= -150 ? 0 : 0.5;
}
function match(id, squares, refVal, seed) {
  const rng = E.mulberry(seed); let score = 0, w = 0, d = 0, l = 0, n = 0;
  const t0 = Date.now();
  for (let g = 0; g < GAMES; g++) {
    const xColor = g & 1, open = E.mulberry(seed * 31 + (g >> 1));
    const r = play(setup(xColor, id, squares), () => open() * 0.999 + rng() * 0.001, refVal);
    const xs = xColor ? 1 - r : r; score += xs; n++; if (xs === 1) w++; else if (xs === 0) l++; else d++;
  }
  return { score: score / n, w, d, l, n, ms: Date.now() - t0 };
}

console.log(`calibrate-fairy: ${GAMES} games per piece, depth ${DEPTH}, ${NODES} nodes/move, ply cap ${CAP}`);
// baseline: the side without its b- and g-pawns (two pawns down) -> score per pawn at this strength
const base = match('pawnodds', ['b2', 'g2'], 100, 99);
const perPawn = Math.max(0.03, (0.5 - base.score) / 2);
console.log(`baseline: side two pawns down scores ${(base.score * 100).toFixed(1)}% (+${base.w} =${base.d} -${base.l}) -> ${(perPawn * 100).toFixed(1)}% score per pawn  [${base.ms} ms]`);
console.log('piece        vs ref  score    W/D/L        implied        table   ms');
for (const [id, squares, ref] of MATCHES) {
  const refVal = E.VAL[ref] * squares.length, r = match(id, squares, refVal, 1000 + F.FAIRY_BY_ID[id].type);
  const implied = Math.round((refVal + (r.score - 0.5) / perPawn * 100) / squares.length);
  const table = F.FAIRY_BY_ID[id].value + (id === 'wizard' ? 20 : 0);
  const sig = Math.round(Math.sqrt(Math.max(0.05, r.score * (1 - r.score)) / r.n) / perPawn * 100 / squares.length);
  console.log(`${id.padEnd(12)} ${('PNBRQ'[ref - 1] + (squares.length > 1 ? 'x2' : '')).padEnd(6)} ${(r.score * 100).toFixed(1).padStart(5)}%   +${r.w} =${r.d} -${r.l}`.padEnd(46) + `${String(implied).padStart(5)} +-${String(sig).padEnd(4)} ${String(table).padStart(5)}   ${r.ms}`);
}
console.log('(wizard: per-piece value incl. half the pair bonus; small samples: 1 sigma of a score over n games is about 50/sqrt(n) %, i.e. +-8% at 40 games)');
