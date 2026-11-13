// Checkmarch world map: canvas 2D renderer + pan + tap hit-testing.
// Depends only on map.mjs (MAP_W, MAP_H, visibility). When inlining into one script,
// drop the import line below; both files then share one scope.
import { MAP_W, MAP_H, visibility } from './map.mjs';

// Layout padding (layout units) around the 1000x600 region.
export const MAP_PAD = 34;

// Palette keys. Pages should drive these from theme tokens (see mapPaletteFromCSS).
export const MAP_PALETTE_KEYS = [
  'paper', 'paperEdge', 'paperMark', 'road', 'roadHeld', 'roadFog', 'heldTint', 'heldRing',
  'frontier', 'fog', 'fogEdge', 'ink', 'inkSoft', 'glyph', 'badgeEdge', 'shadow', 'danger',
  'keep', 'garrison', 'mine', 'town', 'shrine', 'citadel', 'labelBg',
];

export const MAP_PALETTES = {
  light: {
    paper: '#f3e7cc', paperEdge: '#d9c59b', paperMark: 'rgba(120,90,40,0.13)',
    road: '#a88a5c', roadHeld: '#3f7d5a', roadFog: 'rgba(120,95,60,0.35)',
    heldTint: 'rgba(63,125,90,0.16)', heldRing: '#3f7d5a', frontier: '#b5832a',
    fog: '#d8c9a8', fogEdge: '#c4b28c', ink: '#3b2f22', inkSoft: '#7a6a55',
    glyph: '#fffaf0', badgeEdge: 'rgba(40,28,12,0.35)', shadow: 'rgba(60,40,10,0.22)',
    danger: '#c0392b', keep: '#3f7d5a', garrison: '#6b5b8a', mine: '#b07a1f',
    town: '#3d7aa6', shrine: '#2f9a94', citadel: '#9b2f2a', labelBg: 'rgba(255,250,238,0.94)',
  },
  dark: {
    paper: '#232a33', paperEdge: '#38424f', paperMark: 'rgba(170,190,215,0.08)',
    road: '#6d7c8f', roadHeld: '#6cc495', roadFog: 'rgba(130,145,165,0.30)',
    heldTint: 'rgba(108,196,149,0.14)', heldRing: '#6cc495', frontier: '#e0b354',
    fog: '#353e4a', fogEdge: '#44505e', ink: '#e7ecf2', inkSoft: '#9aa6b5',
    glyph: '#101418', badgeEdge: 'rgba(0,0,0,0.45)', shadow: 'rgba(0,0,0,0.40)',
    danger: '#ef6a5b', keep: '#6cc495', garrison: '#a998d0', mine: '#e1ad4e',
    town: '#74b2e0', shrine: '#5fcfc8', citadel: '#ef6a5b', labelBg: 'rgba(24,29,36,0.94)',
  },
};

/** Build a palette from CSS custom properties `--map-<kebab-key>` (falls back per key). */
export function mapPaletteFromCSS(el, fallback = MAP_PALETTES.light) {
  const cs = getComputedStyle(el || document.documentElement);
  const out = {};
  for (const k of MAP_PALETTE_KEYS) {
    const v = cs.getPropertyValue('--map-' + k.replace(/[A-Z]/g, m => '-' + m.toLowerCase())).trim();
    out[k] = v || fallback[k];
  }
  return out;
}

// ---------- badges ----------
function mapGlyphPath(ctx, type, s) {
  // s = badge radius; draws a path centered at 0,0
  ctx.beginPath();
  switch (type) {
    case 'keep': { // tower with crenels
      const w = s * 0.5, top = -s * 0.42, bot = s * 0.5, m = w / 2.5;
      ctx.moveTo(-w, bot); ctx.lineTo(-w, top);
      ctx.lineTo(-w + m, top); ctx.lineTo(-w + m, top + m * 0.9);
      ctx.lineTo(-m / 2, top + m * 0.9); ctx.lineTo(-m / 2, top);
      ctx.lineTo(m / 2, top); ctx.lineTo(m / 2, top + m * 0.9);
      ctx.lineTo(w - m, top + m * 0.9); ctx.lineTo(w - m, top);
      ctx.lineTo(w, top); ctx.lineTo(w, bot); ctx.closePath();
      break;
    }
    case 'garrison': { // shield
      const w = s * 0.46;
      ctx.moveTo(-w, -s * 0.5); ctx.lineTo(w, -s * 0.5); ctx.lineTo(w, -s * 0.02);
      ctx.quadraticCurveTo(w, s * 0.42, 0, s * 0.6);
      ctx.quadraticCurveTo(-w, s * 0.42, -w, -s * 0.02); ctx.closePath();
      break;
    }
    case 'mine': { // gem
      ctx.moveTo(-s * 0.52, -s * 0.12); ctx.lineTo(-s * 0.26, -s * 0.44);
      ctx.lineTo(s * 0.26, -s * 0.44); ctx.lineTo(s * 0.52, -s * 0.12);
      ctx.lineTo(0, s * 0.54); ctx.closePath();
      break;
    }
    case 'town': { // house
      const w = s * 0.46;
      ctx.moveTo(-w, s * 0.48); ctx.lineTo(-w, -s * 0.06); ctx.lineTo(0, -s * 0.52);
      ctx.lineTo(w, -s * 0.06); ctx.lineTo(w, s * 0.48); ctx.closePath();
      break;
    }
    case 'shrine': { // four-point star
      const o = s * 0.6, i = s * 0.17;
      ctx.moveTo(0, -o); ctx.lineTo(i, -i); ctx.lineTo(o, 0); ctx.lineTo(i, i);
      ctx.lineTo(0, o); ctx.lineTo(-i, i); ctx.lineTo(-o, 0); ctx.lineTo(-i, -i); ctx.closePath();
      break;
    }
    case 'citadel': { // crown
      const w = s * 0.56, b = s * 0.4, t = -s * 0.42;
      ctx.moveTo(-w, b); ctx.lineTo(-w, t + s * 0.12); ctx.lineTo(-w * 0.5, -s * 0.02);
      ctx.lineTo(0, t); ctx.lineTo(w * 0.5, -s * 0.02); ctx.lineTo(w, t + s * 0.12);
      ctx.lineTo(w, b); ctx.closePath();
      break;
    }
  }
}

function mapGlyphDetail(ctx, type, s, fill) {
  // small cut-outs in badge color for legibility
  ctx.fillStyle = fill;
  if (type === 'keep') {
    ctx.beginPath();
    ctx.moveTo(-s * 0.14, s * 0.5); ctx.lineTo(-s * 0.14, s * 0.18);
    ctx.arc(0, s * 0.18, s * 0.14, Math.PI, 0); ctx.lineTo(s * 0.14, s * 0.5); ctx.closePath(); ctx.fill();
  } else if (type === 'town') {
    ctx.fillRect(-s * 0.11, s * 0.14, s * 0.22, s * 0.34);
  } else if (type === 'garrison') {
    ctx.fillRect(-s * 0.05, -s * 0.36, s * 0.1, s * 0.74);
  } else if (type === 'mine') {
    ctx.beginPath(); ctx.moveTo(-s * 0.52, -s * 0.12); ctx.lineTo(s * 0.52, -s * 0.12);
    ctx.lineWidth = Math.max(1, s * 0.08); ctx.strokeStyle = fill; ctx.stroke();
  } else if (type === 'citadel') {
    ctx.fillRect(-s * 0.56, s * 0.18, s * 1.12, s * 0.07);
  }
}

/**
 * drawBadge(ctx, type, cx, cy, r, palette, mode)
 * mode: 'full' (badge + glyph) | 'fog' (silhouette disc; citadel keeps a crown outline)
 * cx, cy, r in the ctx's current units (CSS px for the map view).
 */
export function drawBadge(ctx, type, cx, cy, r, palette, mode = 'full') {
  ctx.save();
  ctx.translate(cx, cy);
  // soft drop shadow
  ctx.fillStyle = palette.shadow;
  ctx.beginPath(); ctx.arc(0, r * 0.14, r * 1.02, 0, Math.PI * 2); ctx.fill();
  if (mode === 'fog') {
    ctx.fillStyle = palette.fog;
    ctx.strokeStyle = palette.fogEdge;
    ctx.lineWidth = Math.max(1, r * 0.1);
    ctx.beginPath(); ctx.arc(0, 0, r * 0.86, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    if (type === 'citadel') {
      mapGlyphPath(ctx, 'citadel', r * 0.9);
      ctx.fillStyle = palette.fogEdge; ctx.fill();
    }
    ctx.restore();
    return;
  }
  const fill = palette[type] || palette.inkSoft;
  ctx.fillStyle = fill;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = palette.badgeEdge;
  ctx.lineWidth = Math.max(1, r * 0.08);
  ctx.stroke();
  mapGlyphPath(ctx, type, r);
  ctx.fillStyle = palette.glyph; ctx.fill();
  mapGlyphDetail(ctx, type, r, fill);
  ctx.restore();
}

// ---------- road geometry ----------
function mapRoadCurve(a, b) {
  // deterministic gentle bend, perpendicular to the segment
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const h = ((a.id * 73856093) ^ (b.id * 19349663)) >>> 0;
  const bend = (((h % 1000) / 1000) - 0.5) * 0.22 * len;
  return { cx: mx + (-dy / len) * bend, cy: my + (dx / len) * bend };
}

function mapTerrainMarks(region) {
  // deterministic decorative marks (hills / tufts) from the region seed, avoiding nodes
  let a = 0;
  const s = region.seed + '|' + region.regionNumber;
  for (let i = 0; i < s.length; i++) a = (Math.imul(a, 31) + s.charCodeAt(i)) | 0;
  const rnd = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const marks = [];
  for (let i = 0; i < 70 && marks.length < 34; i++) {
    const x = rnd() * MAP_W, y = 20 + rnd() * (MAP_H - 40);
    if (region.nodes.some(n => Math.hypot(n.x - x, n.y - y) < 55)) continue;
    marks.push({ x, y, k: rnd() < 0.55 ? 'hill' : 'tuft', s: 0.7 + rnd() * 0.6 });
  }
  return marks;
}

/**
 * drawMap(ctx, opts) — low-level, stateless draw in CSS px.
 * opts: { region, held (array|Set), selected (id|null), palette, scale, offsetX, offsetY,
 *         width, height (CSS px of the canvas), time (ms, for frontier pulse; 0 = static),
 *         marks (optional cached terrain marks) }
 */
export function drawMap(ctx, o) {
  const { region, palette: P, scale, width, height } = o;
  const offX = o.offsetX || 0, offY = o.offsetY || 0;
  const vis = visibility({ region, held: o.held });
  const sx = (x) => offX + (x + MAP_PAD) * scale;
  const sy = (y) => offY + (y + MAP_PAD) * scale;
  const nodes = region.nodes;

  ctx.clearRect(0, 0, width, height);
  // paper
  const pw = (MAP_W + MAP_PAD * 2) * scale, ph = (MAP_H + MAP_PAD * 2) * scale;
  ctx.fillStyle = P.paper;
  mapRoundRect(ctx, offX + 1, offY + 1, pw - 2, ph - 2, 14);
  ctx.fill();
  ctx.strokeStyle = P.paperEdge; ctx.lineWidth = 2; ctx.stroke();

  // terrain marks
  ctx.strokeStyle = P.paperMark; ctx.lineWidth = 1.5; ctx.lineCap = 'round';
  for (const m of (o.marks || mapTerrainMarks(region))) {
    const x = sx(m.x), y = sy(m.y), w = 14 * m.s * Math.max(scale, 0.5) * 1.6;
    ctx.beginPath();
    if (m.k === 'hill') { ctx.moveTo(x - w, y); ctx.quadraticCurveTo(x, y - w * 0.9, x + w, y); }
    else { ctx.moveTo(x - w * 0.4, y); ctx.lineTo(x - w * 0.2, y - w * 0.45); ctx.moveTo(x, y); ctx.lineTo(x, y - w * 0.6); ctx.moveTo(x + w * 0.4, y); ctx.lineTo(x + w * 0.2, y - w * 0.45); }
    ctx.stroke();
  }

  // held territory tint (one path => union, uniform alpha)
  ctx.fillStyle = P.heldTint;
  ctx.beginPath();
  const tr = 68 * scale;
  for (const n of nodes) if (vis[n.id] === 'held') { ctx.moveTo(sx(n.x) + tr, sy(n.y)); ctx.arc(sx(n.x), sy(n.y), tr, 0, Math.PI * 2); }
  for (const [a, b] of region.roads) {
    if (vis[a] === 'held' && vis[b] === 'held') {
      // fill the corridor between held nodes so territory reads as one shape
      const A = nodes[a], B = nodes[b];
      const dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy) || 1;
      // corner order chosen so the winding matches ctx.arc (clockwise on screen):
      // with nonzero fill, same-direction subpaths union instead of punching holes.
      const nx = (dy / L) * 40, ny = (-dx / L) * 40;
      ctx.moveTo(sx(A.x + nx), sy(A.y + ny)); ctx.lineTo(sx(B.x + nx), sy(B.y + ny));
      ctx.lineTo(sx(B.x - nx), sy(B.y - ny)); ctx.lineTo(sx(A.x - nx), sy(A.y - ny)); ctx.closePath();
    }
  }
  ctx.fill('nonzero');

  // roads
  ctx.lineCap = 'round';
  for (const [a, b] of region.roads) {
    const A = nodes[a], B = nodes[b];
    const c = mapRoadCurve(A, B);
    const va = vis[a], vb = vis[b];
    ctx.beginPath();
    ctx.moveTo(sx(A.x), sy(A.y));
    ctx.quadraticCurveTo(sx(c.cx), sy(c.cy), sx(B.x), sy(B.y));
    if (va === 'held' && vb === 'held') { ctx.setLineDash([]); ctx.strokeStyle = P.roadHeld; ctx.lineWidth = 4; }
    else if (va === 'fog' || vb === 'fog') { ctx.setLineDash([3, 6]); ctx.strokeStyle = P.roadFog; ctx.lineWidth = 2; }
    else { ctx.setLineDash([]); ctx.strokeStyle = P.road; ctx.lineWidth = 2.5; }
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // nodes
  const t = o.time || 0;
  const pulse = t ? 0.5 + 0.5 * Math.sin(t / 380) : 0.35;
  for (const n of nodes) {
    const x = sx(n.x), y = sy(n.y);
    const r = mapBadgeRadius(n.type, vis[n.id]);
    if (vis[n.id] === 'fog') { drawBadge(ctx, n.type, x, y, r, P, 'fog'); continue; }
    if (vis[n.id] === 'frontier') {
      ctx.strokeStyle = n.type === 'citadel' ? P.danger : P.frontier;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.arc(x, y, r + 4 + pulse * 3, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    drawBadge(ctx, n.type, x, y, r, P, 'full');
    if (vis[n.id] === 'held') {
      ctx.strokeStyle = P.heldRing; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(x, y, r + 2.5, 0, Math.PI * 2); ctx.stroke();
    }
    // tier tag
    if (n.type !== 'keep') {
      const label = String(n.tier);
      ctx.font = '700 11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      const tw = ctx.measureText(label).width + 8;
      const ty = y + r + 3;
      ctx.fillStyle = P.labelBg;
      mapRoundRect(ctx, x - tw / 2, ty, tw, 14, 7); ctx.fill();
      ctx.fillStyle = n.type === 'citadel' ? P.danger : P.ink;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, x, ty + 7.5);
    }
  }

  // selection + name label
  if (o.selected != null && nodes[o.selected]) {
    const n = nodes[o.selected];
    const x = sx(n.x), y = sy(n.y), r = mapBadgeRadius(n.type, vis[n.id]);
    ctx.strokeStyle = P.ink; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(x, y, r + 7, 0, Math.PI * 2); ctx.stroke();
    const label = vis[n.id] === 'fog' ? (n.type === 'citadel' ? 'Citadel (unscouted)' : 'Unscouted') : n.name;
    ctx.font = '600 13px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    const tw = ctx.measureText(label).width + 16;
    let lx = Math.min(Math.max(x - tw / 2, 4), width - tw - 4);
    let ly = y - r - 34;
    if (ly < 4) ly = y + r + 22;
    ctx.fillStyle = P.labelBg; ctx.strokeStyle = P.paperEdge; ctx.lineWidth = 1;
    mapRoundRect(ctx, lx, ly, tw, 24, 12); ctx.fill(); ctx.stroke();
    ctx.fillStyle = P.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, lx + tw / 2, ly + 12.5);
  }
}

export function mapBadgeRadius(type, vis) {
  const base = type === 'citadel' ? 19 : type === 'keep' ? 17 : 14;
  return vis === 'fog' && type !== 'citadel' ? base * 0.8 : base;
}

function mapRoundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * createMapView(canvas, opts) — stateful view: sizing, DPR, drag-to-pan, tap.
 * opts: { palette, onTap(id|null, event), minScale = 0.5, animate = true }
 * The canvas width follows its CSS box (set width:100% in CSS); its CSS height is set here.
 */
export function createMapView(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  const view = {
    region: null, held: [], selected: null,
    palette: opts.palette || MAP_PALETTES.light,
    scale: 1, offsetX: 0, cssW: 0, cssH: 0, marks: null,
  };
  const minScale = opts.minScale ?? 0.5;
  let raf = 0, destroyed = false;
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let animate = opts.animate !== false && !reduced;

  function contentW() { return (MAP_W + MAP_PAD * 2) * view.scale; }
  function clampOffset() {
    const minOff = Math.min(0, view.cssW - contentW());
    view.offsetX = Math.max(minOff, Math.min(0, view.offsetX));
  }
  function resize() {
    const w = canvas.clientWidth || (canvas.parentElement && canvas.parentElement.clientWidth) || 360;
    view.cssW = w;
    view.scale = Math.max(w / (MAP_W + MAP_PAD * 2), minScale);
    view.cssH = Math.round((MAP_H + MAP_PAD * 2) * view.scale);
    canvas.style.height = view.cssH + 'px';
    const dpr = Math.min(3, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(view.cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    clampOffset();
    draw();
  }
  function draw(time) {
    if (!view.region || destroyed) return;
    drawMap(ctx, {
      region: view.region, held: view.held, selected: view.selected, palette: view.palette,
      scale: view.scale, offsetX: view.offsetX, offsetY: 0, width: view.cssW, height: view.cssH,
      time: animate ? (time || performance.now()) : 0, marks: view.marks,
    });
  }
  function loop(t) {
    raf = 0;
    if (destroyed || !animate) return;
    draw(t);
    raf = requestAnimationFrame(loop);
  }
  function startLoop() { if (animate && !raf && !destroyed) raf = requestAnimationFrame(loop); }

  function toLayout(px, py) {
    return { x: (px - view.offsetX) / view.scale - MAP_PAD, y: py / view.scale - MAP_PAD };
  }
  /** nodeAt(px, py): px/py in CSS px relative to the canvas top-left. Returns id or null. */
  function nodeAt(px, py) {
    if (!view.region) return null;
    let best = null, bestD = Infinity;
    for (const n of view.region.nodes) {
      const dx = view.offsetX + (n.x + MAP_PAD) * view.scale - px;
      const dy = (n.y + MAP_PAD) * view.scale - py;
      const d = Math.hypot(dx, dy);
      if (d < bestD) { bestD = d; best = n.id; }
    }
    return bestD <= 24 ? best : null; // ~48px touch target
  }

  // pointer handling: drag pans horizontally, a short press without movement taps
  let down = null;
  function onDown(e) {
    down = { x: e.clientX, y: e.clientY, off: view.offsetX, moved: false, id: e.pointerId };
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  }
  function onMove(e) {
    if (!down || e.pointerId !== down.id) return;
    const dx = e.clientX - down.x;
    if (!down.moved && Math.abs(dx) > 6) down.moved = true;
    if (down.moved) { view.offsetX = down.off + dx; clampOffset(); if (!animate) draw(); }
  }
  function onUp(e) {
    if (!down || e.pointerId !== down.id) return;
    const wasTap = !down.moved;
    down = null;
    if (wasTap && opts.onTap) {
      const r = canvas.getBoundingClientRect();
      opts.onTap(nodeAt(e.clientX - r.left, e.clientY - r.top), e);
    }
  }
  function onCancel() { down = null; }
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onCancel);
  canvas.style.touchAction = 'pan-y';

  let ro = null;
  if (typeof ResizeObserver === 'function') {
    let lastW = -1;
    ro = new ResizeObserver(() => { if (canvas.clientWidth !== lastW) { lastW = canvas.clientWidth; resize(); } });
    ro.observe(canvas);
  }

  const api = {
    setRegion(region, held) {
      view.region = region; view.marks = mapTerrainMarks(region);
      view.held = held || [region.keepId]; view.selected = null; view.offsetX = 0;
      resize(); startLoop();
    },
    setHeld(held) { view.held = held; draw(); },
    setSelected(id) { view.selected = id; draw(); },
    setPalette(p) { view.palette = p; draw(); },
    setAnimate(on) { animate = !!on && !reduced; if (animate) startLoop(); else draw(); },
    centerOn(id) {
      const n = view.region && view.region.nodes[id];
      if (!n) return;
      view.offsetX = view.cssW / 2 - (n.x + MAP_PAD) * view.scale; clampOffset(); draw();
    },
    nodeAt, toLayout, resize, draw: () => draw(),
    get scale() { return view.scale; }, get offsetX() { return view.offsetX; },
    destroy() {
      destroyed = true; if (raf) cancelAnimationFrame(raf); if (ro) ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointercancel', onCancel);
    },
  };
  return api;
}
