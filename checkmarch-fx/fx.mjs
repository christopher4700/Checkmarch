// Checkmarch FX: a lightweight overlay-canvas effect system ("visual juice").
// Pure ES module, no dependencies, touches no DOM globals at import time.
//
//   const fx = createFX(hostElement, { palette, cells: 8, flipped: false });
//   fx.captureBurst('e4', color); fx.checkPulse(60); fx.mineTick(x, y); ...
//   fx.destroy();
//
// Design rules:
// - One transparent <canvas> laid over the host (absolute, pointer-events:none). Resize-safe
//   (ResizeObserver, window resize fallback), devicePixelRatio capped at 2.
// - Auto-sleep: requestAnimationFrame runs only while live particles/effects exist.
// - Fixed object pools (particles + effects), never grown: overload recycles the oldest slot.
// - prefers-reduced-motion: no particles, no rAF; informative effects (labels, banners, the
//   run-over veil, check ring) are painted once as a still and cleared by a single timer.
// - Flat vector shapes only; every color comes from the injected palette, so it follows themes.
// - All top-level names are prefixed (FX_ / fx / createFX) so the module can be inlined
//   next to the game's other modules without name clashes (see checkmarch/build.mjs).

export const FX_MAX_PARTICLES = 320;
export const FX_MAX_EFFECTS = 48;

export const FX_PALETTES = {
  light: {
    ink: '#1d2420', paper: '#f8f9f5', muted: '#5d685f', accent: '#2c6a58', good: '#2c6a58',
    danger: '#c42f39', gold: '#b07a1f', rival: '#8a3a6c', glint: '#ffffff',
    veil: '#0d1114', veilInk: '#eef0ea', bronze: '#a8683a', silver: '#8e9aa6',
  },
  dark: {
    ink: '#e3e8ec', paper: '#192026', muted: '#8f9ca6', accent: '#74c7a9', good: '#74c7a9',
    danger: '#ff5c63', gold: '#e4b54c', rival: '#d68ac0', glint: '#ffffff',
    veil: '#030507', veilInk: '#e3e8ec', bronze: '#d08a52', silver: '#c4ced8',
  },
};

// palette key -> CSS custom properties tried in order (first non-empty wins)
const FX_CSS_KEYS = {
  ink: ['--fx-ink', '--fg'], paper: ['--fx-paper', '--panel', '--bg'], muted: ['--fx-muted', '--muted'],
  accent: ['--fx-accent', '--accent'], good: ['--fx-good', '--good', '--accent'],
  danger: ['--fx-danger', '--danger'], gold: ['--fx-gold', '--gold', '--map-mine'],
  rival: ['--fx-rival', '--rival', '--danger'], glint: ['--fx-glint'], veil: ['--fx-veil'],
  veilInk: ['--fx-veil-ink'], bronze: ['--fx-bronze'], silver: ['--fx-silver'],
};

/** Build a palette from the page's CSS custom properties (falls back per key). */
export function fxPaletteFromCSS(el, fallback) {
  let cs = null;
  try { cs = getComputedStyle(el || document.documentElement); } catch (e) { cs = null; }
  let base = fallback;
  if (!base) {
    let dark = false;
    try { dark = (cs && cs.getPropertyValue('color-scheme') || '').indexOf('dark') >= 0; } catch (e) { dark = false; }
    base = dark ? FX_PALETTES.dark : FX_PALETTES.light;
  }
  const out = Object.assign({}, base);
  if (!cs) return out;
  for (const k in FX_CSS_KEYS) {
    for (const name of FX_CSS_KEYS[k]) {
      let v = '';
      try { v = (cs.getPropertyValue(name) || '').trim(); } catch (e) { v = ''; }
      if (v) { out[k] = v; break; }
    }
  }
  return out;
}

export function createFX(host, opts = {}) {
  const TAU = Math.PI * 2;
  const fixed = !!opts.fixed;
  const win = opts.window || (typeof window !== 'undefined' ? window : null);
  const doc = opts.document || (typeof document !== 'undefined' ? document : null);
  const clock = opts.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const rnd = opts.random || Math.random;
  const raf = opts.raf || (win && win.requestAnimationFrame ? (cb) => win.requestAnimationFrame(cb) : (cb) => setTimeout(() => cb(clock()), 16));
  const caf = opts.caf || (win && win.cancelAnimationFrame ? (id) => win.cancelAnimationFrame(id) : (id) => clearTimeout(id));
  const setT = opts.setTimeout || ((f, ms) => setTimeout(f, ms));
  const clearT = opts.clearTimeout || ((id) => clearTimeout(id));
  const cells = Math.max(1, opts.cells || 8);
  const bleed = fixed ? 0 : Math.max(0, +opts.bleed || 0);
  const maxDpr = opts.maxDpr || 2;
  const MAXP = Math.max(16, Math.min(opts.maxParticles || FX_MAX_PARTICLES, 4000));
  const MAXE = Math.max(8, Math.min(opts.maxEffects || FX_MAX_EFFECTS, 256));
  const FONT = opts.font || 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const DISPLAY = opts.displayFont || '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif';
  let pal = Object.assign({}, FX_PALETTES.light, opts.palette || {});
  let flipped = !!opts.flipped;
  const parent = fixed ? (host || (doc && doc.body)) : host;
  if (!parent) throw new Error('createFX: host element required');

  // ---------- canvas ----------
  const canvas = opts.canvas || doc.createElement('canvas');
  const z = opts.zIndex != null ? opts.zIndex : (fixed ? 60 : 6);
  const css = fixed
    ? `position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:${z}`
    : `position:absolute;left:${-bleed}px;top:${-bleed}px;width:calc(100% + ${2 * bleed}px);height:calc(100% + ${2 * bleed}px);pointer-events:none;z-index:${z}`;
  if (canvas.style) canvas.style.cssText = css;
  try { canvas.setAttribute('aria-hidden', 'true'); } catch (e) { /* mock canvas */ }
  let restorePos = null;
  if (!fixed) {
    try { if (getComputedStyle(host).position === 'static') { restorePos = host.style.position || ''; host.style.position = 'relative'; } } catch (e) { /* no layout engine */ }
  }
  parent.appendChild(canvas);
  const g = canvas.getContext('2d');

  let W = 0, H = 0, hostW = 0, hostH = 0, dpr = 1;
  function measure() {
    const w = fixed ? (win ? win.innerWidth : 0) : host.clientWidth;
    const h = fixed ? (win ? win.innerHeight : 0) : host.clientHeight;
    hostW = Math.max(0, w || 0); hostH = Math.max(0, h || 0);
    W = hostW + 2 * bleed; H = hostH + 2 * bleed;
    dpr = Math.max(1, Math.min(maxDpr, (win && win.devicePixelRatio) || 1));
    const bw = Math.max(1, Math.round(W * dpr)), bh = Math.max(1, Math.round(H * dpr));
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
  }
  measure();

  // ---------- reduced motion ----------
  let mq = null, forced = null, reduced = false;
  const onMq = () => { if (forced === null) applyReduced(!!(mq && mq.matches)); };
  if (opts.reducedMotion === true || opts.reducedMotion === false) forced = opts.reducedMotion;
  try {
    mq = win && win.matchMedia ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
    if (mq) { if (mq.addEventListener) mq.addEventListener('change', onMq); else if (mq.addListener) mq.addListener(onMq); }
  } catch (e) { mq = null; }
  reduced = forced !== null ? forced : !!(mq && mq.matches);

  // ---------- resize ----------
  let ro = null;
  const onResize = () => { if (dead) return; measure(); if (!rafId && en) paint(clock()); };
  try {
    if (!fixed && win && win.ResizeObserver) { ro = new win.ResizeObserver(onResize); ro.observe(host); }
    else if (win && win.addEventListener) win.addEventListener('resize', onResize);
  } catch (e) { ro = null; }

  // ---------- pools ----------
  // particle kinds
  const DOT = 0, SHARD = 1, SPARK = 2, STAR = 3, CONF = 4;
  const PP = new Array(MAXP);
  for (let i = 0; i < MAXP; i++) PP[i] = { k: 0, x: 0, y: 0, vx: 0, vy: 0, g: 0, drag: 0, life: 0, max: 1, size: 1, rot: 0, vr: 0, a: 1, color: '#000' };
  let pn = 0, pCursor = 0;
  function spawn(kind, x, y, vx, vy, size, life, color, grav, drag, vr) {
    let p;
    if (pn < MAXP) p = PP[pn++];
    else { p = PP[pCursor]; pCursor = (pCursor + 1) % MAXP; } // full: recycle in place (bounded)
    p.k = kind; p.x = x; p.y = y; p.vx = vx; p.vy = vy; p.size = size; p.life = life; p.max = life;
    p.color = color; p.g = grav || 0; p.drag = drag || 0; p.vr = vr || 0; p.rot = rnd() * TAU; p.a = 1;
    return p;
  }

  // effect types
  const RING = 1, FLASH = 2, TRAIL = 3, PILLAR = 4, RAYS = 5, GLINT = 6, LABEL = 7, BANNER = 8, VEIL = 9, KING = 10, COIN = 11, CROSS = 12;
  const EE = new Array(MAXE);
  for (let i = 0; i < MAXE; i++) EE[i] = { type: 0, t0: 0, dur: 1, delay: 0, x: 0, y: 0, x2: 0, y2: 0, size: 0, n: 0, w: 0, a: 1, color: '#000', text: '', sub: '', tw: 0, sw: 0, layer: 0, still: false, sk: 0.4 };
  let en = 0;
  function addFx(type, dur, layer) {
    let e;
    if (en < MAXE) e = EE[en++];
    else { // full: recycle the oldest
      let oi = 0;
      for (let i = 1; i < en; i++) if (EE[i].t0 + EE[i].delay < EE[oi].t0 + EE[oi].delay) oi = i;
      e = EE[oi];
    }
    e.type = type; e.t0 = clock(); e.dur = Math.max(1, dur); e.delay = 0; e.x = e.y = e.x2 = e.y2 = 0;
    e.size = e.n = e.w = 0; e.a = 1; e.color = pal.ink; e.text = ''; e.sub = ''; e.tw = e.sw = 0;
    e.layer = layer || 0; e.still = false; e.sk = 0.4;
    return e;
  }
  function addStill(type, hold, sk, layer) { const e = addFx(type, hold, layer); e.still = true; e.sk = sk; return e; }

  // ---------- loop state ----------
  let rafId = 0, stillTimer = 0, lastT = 0, dead = false, frames = 0, ema = 16.7, q = 1;
  let filterEl = null, filterPrev = null, filterTransPrev = null, filterTimer = 0;
  const live = () => { if (dead) return false; if (!hostW) measure(); return hostW > 0; };

  function wake() {
    if (dead) return;
    if (reduced) { paint(clock()); scheduleStill(); return; }
    if (!rafId) { measure(); lastT = clock(); rafId = raf(frame); } // re-measure once per wake (covers no-ResizeObserver hosts)
  }
  function frame() {
    rafId = 0;
    if (dead) return;
    const t = clock();
    const ms = t - lastT; lastT = t;
    frames++;
    if (ms > 0 && ms < 250) {
      ema += (ms - ema) * 0.08;
      if (ema > 26) q = Math.max(0.35, q - 0.03); else if (ema < 19) q = Math.min(1, q + 0.01);
    }
    step(Math.min(0.05, Math.max(0, ms / 1000)), t);
    paint(t);
    if (pn > 0 || en > 0) rafId = raf(frame);
    else clearCanvas(); // auto-sleep: nothing scheduled until the next effect call
  }
  function scheduleStill() {
    if (stillTimer) { clearT(stillTimer); stillTimer = 0; }
    if (!en || dead) return;
    const t = clock(); let next = Infinity;
    for (let i = 0; i < en; i++) next = Math.min(next, EE[i].t0 + EE[i].delay + EE[i].dur);
    stillTimer = setT(() => { stillTimer = 0; if (dead) return; const now = clock(); step(0, now); paint(now); if (en) scheduleStill(); else clearCanvas(); }, Math.max(0, next - t) + 1);
  }

  function step(dt, t) {
    for (let i = pn - 1; i >= 0; i--) {
      const p = PP[i];
      p.life -= dt;
      if (p.life <= 0) { const last = PP[pn - 1]; PP[pn - 1] = p; PP[i] = last; pn--; if (pCursor >= pn) pCursor = 0; continue; }
      if (p.drag) { const f = Math.exp(-p.drag * dt); p.vx *= f; p.vy *= f; }
      p.vy += p.g * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
    }
    for (let i = en - 1; i >= 0; i--) {
      const e = EE[i];
      if (t - e.t0 - e.delay >= e.dur) { const last = EE[en - 1]; EE[en - 1] = e; EE[i] = last; en--; }
    }
  }

  // ---------- drawing ----------
  const easeOut = (k) => 1 - (1 - k) * (1 - k) * (1 - k);
  const easeIn = (k) => k * k;
  const easeInOut = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
  const easeBack = (k) => { const c = 1.7; const u = k - 1; return 1 + (c + 1) * u * u * u + c * u * u; };
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  function clearCanvas() {
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
  }
  function rrect(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.arcTo(x + w, y, x + w, y + r, r);
    g.lineTo(x + w, y + h - r); g.arcTo(x + w, y + h, x + w - r, y + h, r);
    g.lineTo(x + r, y + h); g.arcTo(x, y + h, x, y + h - r, r);
    g.lineTo(x, y + r); g.arcTo(x, y, x + r, y, r); g.closePath();
  }
  function star4(x, y, r, rot) {
    const c = Math.cos(rot), s = Math.sin(rot), i = r * 0.32;
    g.beginPath();
    for (let j = 0; j < 8; j++) {
      const rr = j & 1 ? i : r, a = (j * Math.PI) / 4;
      const px = Math.cos(a) * rr, py = Math.sin(a) * rr;
      const X = x + px * c - py * s, Y = y + px * s + py * c;
      if (j) g.lineTo(X, Y); else g.moveTo(X, Y);
    }
    g.closePath(); g.fill();
  }

  function paint(t) {
    if (!g || dead) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!W || !H) return;
    for (let i = 0; i < en; i++) if (EE[i].layer === 0) drawFx(EE[i], t);
    drawParticles();
    for (let i = 0; i < en; i++) if (EE[i].layer === 1) drawFx(EE[i], t);
    g.globalAlpha = 1;
  }

  function drawParticles() {
    let rotated = false;
    for (let i = 0; i < pn; i++) {
      const p = PP[i], f = p.life / p.max;
      const al = Math.min(1, f * 1.8) * p.a;
      if (al <= 0.01) continue;
      g.globalAlpha = al;
      if (p.k === DOT) {
        if (rotated) { g.setTransform(dpr, 0, 0, dpr, 0, 0); rotated = false; }
        g.fillStyle = p.color; g.beginPath(); g.arc(p.x, p.y, Math.max(0.3, p.size * (0.4 + 0.6 * f)), 0, TAU); g.fill();
      } else if (p.k === SPARK) {
        if (rotated) { g.setTransform(dpr, 0, 0, dpr, 0, 0); rotated = false; }
        g.strokeStyle = p.color; g.lineWidth = p.size; g.lineCap = 'round';
        g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(p.x - p.vx * 0.045, p.y - p.vy * 0.045); g.stroke();
      } else if (p.k === STAR) {
        if (rotated) { g.setTransform(dpr, 0, 0, dpr, 0, 0); rotated = false; }
        g.fillStyle = p.color; star4(p.x, p.y, p.size * (0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, f * 1.15))), p.rot);
      } else { // SHARD, CONF: rotated rects via setTransform (no save/restore)
        const c = Math.cos(p.rot) * dpr, s = Math.sin(p.rot) * dpr;
        const flip = p.k === CONF ? Math.cos(p.rot * 1.7 + p.vr) : 1;
        g.setTransform(c, s, -s * flip, c * flip, p.x * dpr, p.y * dpr); rotated = true;
        g.fillStyle = p.color;
        const w = p.size, h = p.k === CONF ? p.size * 0.55 : p.size;
        g.fillRect(-w / 2, -h / 2, w, h);
      }
    }
    if (rotated) g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawFx(e, t) {
    const k = e.still ? e.sk : (t - e.t0 - e.delay) / e.dur;
    if (k < 0 || k >= 1) return;
    switch (e.type) {
      case RING: {
        const r = e.size + (e.n - e.size) * easeOut(k);
        g.globalAlpha = e.a * (1 - k); g.strokeStyle = e.color; g.lineWidth = Math.max(0.6, e.w * (1 - 0.7 * k));
        g.beginPath(); g.arc(e.x, e.y, r, 0, TAU); g.stroke(); break;
      }
      case FLASH: {
        g.globalAlpha = e.a * (1 - k) * (1 - k); g.fillStyle = e.color;
        g.beginPath(); g.arc(e.x, e.y, e.size * (0.6 + 0.4 * easeOut(k)), 0, TAU); g.fill(); break;
      }
      case TRAIL: {
        const h = easeOut(clamp01(k * 1.7)), tl = easeInOut(clamp01((k - 0.2) / 0.8));
        if (h - tl < 0.002) break;
        const hx = e.x + (e.x2 - e.x) * h, hy = e.y + (e.y2 - e.y) * h;
        const tx = e.x + (e.x2 - e.x) * tl, ty = e.y + (e.y2 - e.y) * tl;
        g.lineCap = 'round'; g.strokeStyle = e.color;
        g.globalAlpha = e.a * 0.32 * (1 - k * 0.6); g.lineWidth = e.w;
        g.beginPath(); g.moveTo(tx, ty); g.lineTo(hx, hy); g.stroke();
        g.globalAlpha = e.a * 0.55 * (1 - k); g.lineWidth = e.w * 0.36;
        g.beginPath(); g.moveTo(tx, ty); g.lineTo(hx, hy); g.stroke(); break;
      }
      case PILLAR: {
        const top = e.y + e.size * 0.5 - e.size * 2.2 * easeOut(Math.min(1, k * 1.6));
        const w = e.size * 0.56 * (1 - k * 0.8);
        g.globalAlpha = 0.42 * (1 - k); g.fillStyle = e.color;
        g.fillRect(e.x - w / 2, top, w, e.y + e.size * 0.5 - top);
        g.globalAlpha = 0.6 * (1 - k); g.fillRect(e.x - w / 6, top, w / 3, e.y + e.size * 0.5 - top); break;
      }
      case RAYS: {
        const a0 = k * 0.9, r0 = e.size * 0.28, r1 = e.size * (0.42 + 0.42 * easeOut(k));
        g.globalAlpha = 0.85 * (1 - k); g.strokeStyle = e.color; g.lineWidth = Math.max(1, e.size * 0.045); g.lineCap = 'round';
        g.beginPath();
        for (let j = 0; j < 8; j++) { const a = a0 + (j * TAU) / 8, c = Math.cos(a), s = Math.sin(a); g.moveTo(e.x + c * r0, e.y + s * r0); g.lineTo(e.x + c * r1, e.y + s * r1); }
        g.stroke(); break;
      }
      case GLINT: {
        const s = e.size, x0 = e.x - s / 2, y0 = e.y - s / 2, u = -s * 0.6 + s * 2.2 * easeInOut(k), bw = s * 0.22;
        g.save(); g.beginPath(); g.rect(x0, y0, s, s); g.clip();
        g.globalAlpha = 0.55 * Math.sin(Math.PI * k); g.fillStyle = e.text || pal.glint;
        g.beginPath(); g.moveTo(x0 + u, y0); g.lineTo(x0 + u + bw, y0); g.lineTo(x0 + u + bw - s * 0.6, y0 + s); g.lineTo(x0 + u - s * 0.6, y0 + s); g.closePath(); g.fill();
        g.restore();
        g.globalAlpha = 0.9 * (1 - k); g.strokeStyle = e.color; g.lineWidth = Math.max(1.5, s * 0.06);
        g.beginPath(); rrect(x0 + 2, y0 + 2, s - 4, s - 4, s * 0.12); g.stroke(); break;
      }
      case LABEL: {
        const fs = e.size, rise = e.n * easeOut(k);
        const al = k < 0.1 ? k / 0.1 : k > 0.72 ? (1 - k) / 0.28 : 1;
        const sc = k < 0.14 ? 0.75 + 0.25 * easeBack(k / 0.14) : 1;
        const pw = (e.tw + fs * 1.3) * sc, ph = fs * 1.75 * sc;
        const cx = Math.max(pw / 2 + 4, Math.min(W - pw / 2 - 4, e.x)), cy = Math.max(ph / 2 + 4, e.y - rise);
        g.globalAlpha = al * 0.96; g.fillStyle = pal.paper; g.beginPath(); rrect(cx - pw / 2, cy - ph / 2, pw, ph, ph / 2); g.fill();
        g.globalAlpha = al; g.strokeStyle = e.color; g.lineWidth = 1.5; g.stroke();
        g.fillStyle = e.color; g.font = `700 ${Math.round(fs * sc)}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(e.text, cx, cy + fs * 0.05); break;
      }
      case BANNER: {
        const al = k < 0.08 ? k / 0.08 : k > 0.84 ? (1 - k) / 0.16 : 1;
        const sc = k < 0.16 ? 0.7 + 0.3 * easeBack(k / 0.16) : 1;
        const fs = e.size, hasSub = !!e.sub;
        const bw = Math.min(W - 24, Math.max(e.tw, e.sw) + fs * 2.6) * sc, bh = (hasSub ? fs * 2.9 : fs * 2.1) * sc;
        const cx = W / 2, cy = H * 0.42;
        g.globalAlpha = al * 0.97; g.fillStyle = pal.paper; g.beginPath(); rrect(cx - bw / 2, cy - bh / 2, bw, bh, 14 * sc); g.fill();
        g.globalAlpha = al; g.strokeStyle = e.color; g.lineWidth = 2; g.stroke();
        g.fillStyle = e.color; g.fillRect(cx - bw * 0.3, cy - bh / 2 + 6 * sc, bw * 0.6, 3 * sc);
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillStyle = pal.ink; g.font = `700 ${Math.round(fs * sc)}px ${DISPLAY}`;
        g.fillText(e.text, cx, cy - (hasSub ? fs * 0.38 : 0) * sc);
        if (hasSub) { g.fillStyle = pal.muted; g.font = `600 ${Math.round(fs * 0.5 * sc)}px ${FONT}`; g.fillText(e.sub, cx, cy + fs * 0.72 * sc); }
        g.fillStyle = pal.gold; const sx = (Math.max(e.tw, e.sw) / 2 + fs * 0.75) * sc;
        star4(cx - sx, cy - (hasSub ? fs * 0.38 : 0) * sc, fs * 0.36 * sc, k * 3); star4(cx + sx, cy - (hasSub ? fs * 0.38 : 0) * sc, fs * 0.36 * sc, -k * 3);
        break;
      }
      case VEIL: {
        const al = k < 0.18 ? easeOut(k / 0.18) : k > 0.86 ? (1 - k) / 0.14 : 1;
        g.globalAlpha = 0.58 * al; g.fillStyle = pal.veil; g.fillRect(0, 0, W, H); break;
      }
      case KING: {
        const s = e.size, cx = W / 2, by = H * 0.5 + s * 0.35;
        if (!e.still) {
          let ang, dy = 0, al = 1;
          if (k < 0.28) ang = Math.sin((k / 0.28) * TAU) * 0.05;
          else if (k < 0.6) ang = (Math.PI / 2) * easeIn((k - 0.28) / 0.32);
          else { const u = (k - 0.6) / 0.4; ang = Math.PI / 2 + u * 0.35; dy = u * u * H * 0.55; al = 1 - u; }
          const fade = k < 0.08 ? k / 0.08 : 1;
          g.globalAlpha = 0.35 * fade * (k < 0.6 ? 1 : al); g.strokeStyle = pal.veilInk; g.lineWidth = 2;
          g.beginPath(); g.moveTo(cx - s * 0.7, by); g.lineTo(cx + s * 0.7, by); g.stroke();
          g.save(); g.translate(cx + s * 0.36, by + dy); g.rotate(ang); g.translate(-s * 0.36, 0);
          g.globalAlpha = 0.92 * fade * al; g.fillStyle = pal.veilInk;
          g.beginPath();
          rrect(-s * 0.36, -s * 0.12, s * 0.72, s * 0.12, s * 0.03);
          g.rect(-s * 0.28, -s * 0.2, s * 0.56, s * 0.08);
          g.moveTo(-s * 0.24, -s * 0.2); g.lineTo(-s * 0.15, -s * 0.66); g.lineTo(s * 0.15, -s * 0.66); g.lineTo(s * 0.24, -s * 0.2); g.closePath();
          g.rect(-s * 0.2, -s * 0.74, s * 0.4, s * 0.08);
          g.moveTo(s * 0.085, -s * 0.8); g.arc(0, -s * 0.8, s * 0.085, 0, TAU);
          g.rect(-s * 0.035, -s * 1.02, s * 0.07, s * 0.2); g.rect(-s * 0.1, -s * 0.97, s * 0.2, s * 0.06);
          g.fill(); g.restore();
        }
        const ta = e.still ? 1 : k < 0.36 ? 0 : k < 0.5 ? (k - 0.36) / 0.14 : k > 0.86 ? (1 - k) / 0.14 : 1;
        if (ta > 0) {
          const bh = e.n * (e.sub ? 2.5 : 1.7), bwid = Math.min(W - 16, Math.max(e.n * e.text.length * 0.62, e.sub ? e.n * 0.27 * e.sub.length : 0) + e.n * 2);
          g.globalAlpha = ta * 0.55; g.fillStyle = pal.veil; g.beginPath(); rrect(cx - bwid / 2, by + e.n * 0.45, bwid, bh, 12); g.fill();
          g.globalAlpha = ta; g.fillStyle = pal.veilInk; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.font = `700 ${Math.round(e.n)}px ${DISPLAY}`; g.fillText(e.text, cx, by + e.n * 1.3);
          if (e.sub) { g.globalAlpha = ta * 0.8; g.font = `500 ${Math.round(e.n * 0.5)}px ${FONT}`; g.fillText(e.sub, cx, by + e.n * 2.4); }
        }
        break;
      }
      case COIN: {
        const r = e.size, y = e.y - e.n * easeOut(k), sx = Math.max(0.12, Math.abs(Math.cos(k * TAU * 1.25)));
        const al = k < 0.12 ? k / 0.12 : k > 0.65 ? (1 - k) / 0.35 : 1;
        g.setTransform(dpr * sx, 0, 0, dpr, e.x * dpr, y * dpr);
        g.globalAlpha = al; g.fillStyle = e.color; g.beginPath(); g.arc(0, 0, r, 0, TAU); g.fill();
        g.globalAlpha = al * 0.35; g.strokeStyle = pal.ink; g.lineWidth = Math.max(0.8, r * 0.18); g.beginPath(); g.arc(0, 0, r * 0.62, 0, TAU); g.stroke();
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (k > 0.25 && k < 0.6) { g.globalAlpha = al * Math.sin(Math.PI * (k - 0.25) / 0.35); g.fillStyle = pal.glint; star4(e.x + r * 0.5, y - r * 0.55, r * 0.9, k * 4); }
        break;
      }
      case CROSS: {
        const L = e.size * (0.55 + 0.45 * easeBack(clamp01(k * 3)));
        g.globalAlpha = 1 - k * k; g.strokeStyle = e.color; g.lineWidth = Math.max(2, e.size * 0.28); g.lineCap = 'round';
        g.beginPath(); g.moveTo(e.x - L, e.y - L); g.lineTo(e.x + L, e.y + L); g.moveTo(e.x + L, e.y - L); g.lineTo(e.x - L, e.y + L); g.stroke(); break;
      }
      default: break;
    }
  }

  // ---------- coordinates ----------
  // cell: engine square index (0 = a1 ... 63 = h8, white at the bottom unless flipped),
  //       algebraic 'e4', screen grid [col, row] (row 0 = top), or pixel {x, y[, size]}.
  const pt = { x: 0, y: 0, cs: 0 };
  function cellPt(c) {
    const cw = hostW / cells, ch = hostH / cells, cs = Math.min(cw, ch);
    let col, row;
    if (typeof c === 'string' && /^[a-z][1-9][0-9]?$/i.test(c)) c = (parseInt(c.slice(1), 10) - 1) * cells + (c.toLowerCase().charCodeAt(0) - 97);
    if (typeof c === 'number') {
      if (!Number.isInteger(c) || c < 0 || c >= cells * cells) return null;
      col = c % cells; row = cells - 1 - Math.floor(c / cells);
      if (flipped) { col = cells - 1 - col; row = cells - 1 - row; }
    } else if (Array.isArray(c)) {
      col = +c[0]; row = +c[1];
      if (!Number.isFinite(col) || !Number.isFinite(row)) return null;
    } else if (c && typeof c === 'object') {
      const x = +c.x, y = +c.y;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      pt.x = x + bleed; pt.y = y + bleed; pt.cs = Number.isFinite(+c.size) && +c.size > 0 ? +c.size : cs || 40;
      return pt;
    } else return null;
    pt.x = bleed + (col + 0.5) * cw; pt.y = bleed + (row + 0.5) * ch; pt.cs = cs;
    return pt;
  }
  function xyPt(x, y) {
    if (!Number.isFinite(+x) || !Number.isFinite(+y)) return null;
    pt.x = +x + bleed; pt.y = +y + bleed; pt.cs = 0; return pt;
  }
  const cnt = (n) => Math.max(1, Math.round(n * q));
  const R = (a, b) => a + (b - a) * rnd();

  // ---------- effects ----------
  function captureBurst(cell, color) {
    if (!live()) return false;
    const p = cellPt(cell); if (!p) return false;
    const { x, y, cs } = p; color = color || pal.ink;
    if (reduced) { const e = addStill(RING, 260, 0.3); e.x = x; e.y = y; e.size = cs * 0.2; e.n = cs * 0.55; e.w = cs * 0.08; e.color = color; e.a = 0.8; wake(); return true; }
    let e = addFx(RING, 420); e.x = x; e.y = y; e.size = cs * 0.18; e.n = cs * 0.66; e.w = cs * 0.09; e.color = color; e.a = 0.8;
    e = addFx(FLASH, 200); e.x = x; e.y = y; e.size = cs * 0.42; e.color = color; e.a = 0.32;
    for (let i = 0, n = cnt(14); i < n; i++) {
      const a = rnd() * TAU, sp = cs * R(2.2, 5.4);
      spawn(SHARD, x, y, Math.cos(a) * sp, Math.sin(a) * sp - cs * 1.2, cs * R(0.07, 0.14), R(0.45, 0.8), color, cs * 9, 2.4, R(-12, 12));
    }
    for (let i = 0, n = cnt(6); i < n; i++) {
      const a = rnd() * TAU, sp = cs * R(4, 7);
      spawn(SPARK, x, y, Math.cos(a) * sp, Math.sin(a) * sp, Math.max(1, cs * 0.035), R(0.2, 0.34), pal.gold, 0, 5);
    }
    for (let i = 0, n = cnt(5); i < n; i++) {
      const p2 = spawn(DOT, x + R(-0.2, 0.2) * cs, y + R(0, 0.3) * cs, R(-0.6, 0.6) * cs, -R(0.2, 0.8) * cs, cs * R(0.04, 0.08), R(0.5, 0.9), pal.muted, 0, 1.5);
      p2.a = 0.5;
    }
    wake(); return true;
  }

  function moveTrail(fromCell, toCell, color) {
    if (!live()) return false;
    const a = cellPt(fromCell); if (!a) return false;
    const ax = a.x, ay = a.y, cs = a.cs;
    const b = cellPt(toCell); if (!b) return false;
    if (reduced) return true; // decorative only
    const e = addFx(TRAIL, 460); e.x = ax; e.y = ay; e.x2 = b.x; e.y2 = b.y; e.w = cs * 0.24; e.color = color || pal.accent;
    for (let i = 0, n = cnt(4); i < n; i++) {
      const u = (i + 0.5) / 4;
      const p = spawn(DOT, ax + (b.x - ax) * u, ay + (b.y - ay) * u, R(-0.4, 0.4) * cs, R(-0.4, 0.2) * cs, cs * R(0.03, 0.06), R(0.35, 0.6), color || pal.accent, 0, 3);
      p.a = 0.6;
    }
    wake(); return true;
  }

  function checkPulse(kingCell) {
    if (!live()) return false;
    const p = cellPt(kingCell); if (!p) return false;
    const { x, y, cs } = p;
    if (reduced) { const e = addStill(RING, 700, 0.25); e.x = x; e.y = y; e.size = cs * 0.3; e.n = cs * 0.7; e.w = cs * 0.08; e.color = pal.danger; wake(); return true; }
    for (let j = 0; j < 2; j++) { const e = addFx(RING, 720); e.delay = j * 220; e.x = x; e.y = y; e.size = cs * 0.3; e.n = cs * 0.98; e.w = cs * 0.085; e.color = pal.danger; e.a = 0.95; }
    const f = addFx(FLASH, 520); f.x = x; f.y = y; f.size = cs * 0.55; f.color = pal.danger; f.a = 0.28;
    for (let i = 0, n = cnt(6); i < n; i++) {
      const a = (i / 6) * TAU + R(-0.2, 0.2), sp = cs * R(3, 4.5);
      spawn(SPARK, x + Math.cos(a) * cs * 0.3, y + Math.sin(a) * cs * 0.3, Math.cos(a) * sp, Math.sin(a) * sp, Math.max(1.2, cs * 0.04), 0.3, pal.danger, 0, 4);
    }
    wake(); return true;
  }

  function promoteFlare(cell) {
    if (!live()) return false;
    const p = cellPt(cell); if (!p) return false;
    const { x, y, cs } = p;
    if (reduced) { const e = addStill(RING, 500, 0.3); e.x = x; e.y = y; e.size = cs * 0.3; e.n = cs * 0.6; e.w = cs * 0.08; e.color = pal.gold; wake(); return true; }
    let e = addFx(PILLAR, 700); e.x = x; e.y = y; e.size = cs; e.color = pal.gold;
    e = addFx(RAYS, 760); e.x = x; e.y = y; e.size = cs; e.color = pal.gold;
    e = addFx(RING, 520); e.x = x; e.y = y; e.size = cs * 0.25; e.n = cs * 0.8; e.w = cs * 0.07; e.color = pal.accent;
    for (let i = 0, n = cnt(12); i < n; i++) {
      spawn(STAR, x + R(-0.4, 0.4) * cs, y + R(-0.1, 0.45) * cs, R(-0.5, 0.5) * cs, -R(1.2, 2.8) * cs, cs * R(0.07, 0.13), R(0.6, 1.0), i & 1 ? pal.accent : pal.gold, -cs * 0.4, 1.2, R(-3, 3));
    }
    wake(); return true;
  }

  function traitSave(cell, label, color) {
    if (!live()) return false;
    const p = cellPt(cell); if (!p) return false;
    const { x, y } = p, cs = p.cs || 40;
    color = color || pal.good;
    const text = String(label == null || label === '' ? 'Saved!' : label).slice(0, 40);
    const fs = Math.max(11, Math.min(16, cs * 0.3));
    g.font = `700 ${Math.round(fs)}px ${FONT}`;
    const tw = g.measureText(text).width || text.length * fs * 0.55;
    const e = reduced ? addStill(LABEL, 1300, 0.3, 1) : addFx(LABEL, 1450, 1);
    e.x = x; e.y = y - cs * 0.42; e.n = cs * 0.45; e.size = fs; e.tw = tw; e.text = text; e.color = color;
    if (!reduced) {
      const r = addFx(RING, 520); r.x = x; r.y = y; r.size = cs * 0.3; r.n = cs * 0.62; r.w = cs * 0.06; r.color = color;
      for (let i = 0, n = cnt(8); i < n; i++) {
        const a = (i / 8) * TAU + R(-0.3, 0.3), rr = cs * R(0.3, 0.45);
        spawn(STAR, x + Math.cos(a) * rr, y + Math.sin(a) * rr, Math.cos(a) * cs * 0.7, Math.sin(a) * cs * 0.7 - cs * 0.3, cs * R(0.08, 0.13), R(0.5, 0.85), i & 1 ? pal.gold : color, 0, 2, R(-4, 4));
      }
    }
    wake(); return true;
  }

  function materialGlint(cell, tier) {
    if (!live()) return false;
    const p = cellPt(cell); if (!p) return false;
    if (reduced) return true; // decorative only
    const { x, y, cs } = p;
    const t = Math.max(1, Math.min(9, Math.floor(+tier) || 1));
    const col = t === 1 ? pal.bronze : t === 2 ? pal.silver : t === 3 ? pal.gold : pal.accent;
    const e = addFx(GLINT, 640); e.x = x; e.y = y; e.size = cs; e.color = col;
    for (let i = 0, n = cnt(Math.min(6, t + 1)); i < n; i++) {
      spawn(STAR, x + R(-0.42, 0.42) * cs, y + R(-0.42, 0.42) * cs, 0, -cs * 0.25, cs * R(0.07, 0.12) * (1 + t * 0.06), R(0.4, 0.7), t >= 4 && i & 1 ? pal.gold : col, 0, 0, R(-2, 2));
    }
    wake(); return true;
  }

  function regionWin(o) {
    if (!live()) return false;
    o = o || {};
    const title = String(o.title || 'Region cleared').slice(0, 48), sub = o.subtitle ? String(o.subtitle).slice(0, 80) : '';
    let fs = Math.max(18, Math.min(30, W / 13));
    g.font = `700 ${Math.round(fs)}px ${DISPLAY}`;
    let tw = g.measureText(title).width || title.length * fs * 0.55;
    if (tw > W - 64 && tw > 0) { fs = Math.max(13, fs * (W - 64) / tw); g.font = `700 ${Math.round(fs)}px ${DISPLAY}`; tw = g.measureText(title).width || title.length * fs * 0.55; }
    g.font = `600 ${Math.round(fs * 0.5)}px ${FONT}`;
    const sw = sub ? (g.measureText(sub).width || sub.length * fs * 0.28) : 0;
    const e = reduced ? addStill(BANNER, 1800, 0.5, 1) : addFx(BANNER, 2700, 1);
    e.text = title; e.sub = sub; e.size = fs; e.tw = tw; e.sw = sw; e.color = o.color || pal.accent;
    if (!reduced) {
      const cols = [pal.accent, pal.gold, pal.good, pal.danger, pal.rival];
      const n = cnt(Math.min(110, Math.floor(MAXP * 0.4)));
      for (let i = 0; i < n; i++) {
        const left = i & 1, a = (left ? -1.05 : -2.09) + R(-0.3, 0.3), sp = H * R(1.1, 1.9);
        spawn(CONF, left ? W * 0.02 : W * 0.98, H * 0.98, Math.cos(a) * sp, Math.sin(a) * sp, Math.max(5, Math.min(11, W / 50)) * R(0.8, 1.2), R(1.5, 2.4), cols[i % cols.length], H * 1.15, 1.4, R(-9, 9));
      }
    }
    wake(); return true;
  }

  function restoreFilter() {
    if (filterTimer) { clearT(filterTimer); filterTimer = 0; }
    if (!filterEl) return;
    const el = filterEl, prevT = filterTransPrev;
    filterEl = null;
    try { el.style.filter = filterPrev; } catch (e) { /* ignore */ }
    // let the un-desaturate transition play, then put the original transition back
    if (reduced || dead) { try { el.style.transition = prevT; } catch (e) { /* ignore */ } }
    else setT(() => { try { if (filterEl !== el) el.style.transition = prevT; } catch (e) { /* ignore */ } }, 750);
  }
  function runOver(o) {
    if (!live()) return false;
    o = o || {};
    const dur = reduced ? 2400 : Math.max(1500, +o.duration || 3400);
    const v = reduced ? addStill(VEIL, dur, 0.5, 0) : addFx(VEIL, dur, 0);
    const k = reduced ? addStill(KING, dur, 0.5, 1) : addFx(KING, dur, 1);
    k.size = Math.min(150, Math.max(60, Math.min(W, H) * 0.3)); k.n = Math.max(16, Math.min(28, W / 15));
    k.text = String(o.title || 'Checkmate').slice(0, 40); k.sub = o.subtitle == null ? 'The king has fallen' : String(o.subtitle).slice(0, 80);
    v.color = pal.veil;
    const el = o.desaturate === undefined ? (fixed ? null : host) : o.desaturate;
    if (el && el.style) {
      restoreFilter();
      filterEl = el; filterPrev = el.style.filter || ''; filterTransPrev = el.style.transition || '';
      try {
        el.style.transition = reduced ? 'none' : 'filter 700ms ease';
        el.style.filter = 'grayscale(0.85) brightness(0.92)';
      } catch (e) { /* ignore */ }
      filterTimer = setT(() => { filterTimer = 0; restoreFilter(); }, Math.max(0, dur - (reduced ? 0 : 650)));
    }
    wake(); return true;
  }

  function mineTick(x, y, scale) {
    if (!live()) return false;
    const p = xyPt(x, y); if (!p) return false;
    if (reduced) return true; // decorative only
    let coins = 0; for (let i = 0; i < en; i++) if (EE[i].type === COIN) coins++;
    if (coins >= 10) return true; // throttle: map tick spam stays cheap
    const s = Number.isFinite(+scale) && +scale > 0 ? +scale : 1;
    const e = addFx(COIN, 820, 1); e.x = p.x; e.y = p.y; e.size = 6 * s; e.n = 18 * s; e.color = pal.gold;
    for (let i = 0, n = cnt(3); i < n; i++) spawn(STAR, p.x + R(-8, 8) * s, p.y + R(-4, 4) * s, R(-10, 10) * s, -R(12, 30) * s, R(2.5, 4) * s, R(0.4, 0.7), pal.gold, 0, 1, R(-3, 3));
    wake(); return true;
  }

  function rivalCapture(x, y, scale) {
    if (!live()) return false;
    const p = xyPt(x, y); if (!p) return false;
    const s = Number.isFinite(+scale) && +scale > 0 ? +scale : 1;
    const px = p.x, py = p.y;
    if (reduced) { const e = addStill(RING, 600, 0.3); e.x = px; e.y = py; e.size = 6 * s; e.n = 26 * s; e.w = 3 * s; e.color = pal.rival; wake(); return true; }
    for (let j = 0; j < 3; j++) { const e = addFx(RING, 900); e.delay = j * 170; e.x = px; e.y = py; e.size = 5 * s; e.n = 36 * s; e.w = 3.2 * s; e.color = pal.rival; e.a = 0.9; }
    let e = addFx(FLASH, 380); e.x = px; e.y = py; e.size = 16 * s; e.color = pal.danger; e.a = 0.35;
    e = addFx(CROSS, 760, 1); e.x = px; e.y = py; e.size = 7 * s; e.color = pal.danger;
    wake(); return true;
  }

  // ---------- control ----------
  function applyReduced(v) {
    reduced = !!v;
    if (reduced) {
      if (rafId) { caf(rafId); rafId = 0; }
      pn = 0; pCursor = 0;
      for (let i = en - 1; i >= 0; i--) if (!EE[i].still) { const last = EE[en - 1]; EE[en - 1] = EE[i]; EE[i] = last; en--; }
      if (filterEl) { try { filterEl.style.transition = 'none'; } catch (e) { /* ignore */ } }
      paint(clock()); scheduleStill(); if (!en) clearCanvas();
    } else if (en) { if (stillTimer) { clearT(stillTimer); stillTimer = 0; } wake(); }
  }
  function clear() {
    if (rafId) { caf(rafId); rafId = 0; }
    if (stillTimer) { clearT(stillTimer); stillTimer = 0; }
    pn = 0; pCursor = 0; en = 0;
    restoreFilter();
    clearCanvas();
  }
  function destroy() {
    if (dead) return;
    clear();
    dead = true;
    try { if (ro) ro.disconnect(); else if (win && win.removeEventListener) win.removeEventListener('resize', onResize); } catch (e) { /* ignore */ }
    try { if (mq) { if (mq.removeEventListener) mq.removeEventListener('change', onMq); else if (mq.removeListener) mq.removeListener(onMq); } } catch (e) { /* ignore */ }
    try { if (canvas.parentNode) canvas.parentNode.removeChild(canvas); } catch (e) { /* ignore */ }
    if (restorePos !== null) { try { host.style.position = restorePos; } catch (e) { /* ignore */ } }
  }

  return {
    canvas,
    captureBurst, moveTrail, checkPulse, promoteFlare, traitSave, materialGlint,
    regionWin, runOver, mineTick, rivalCapture,
    setPalette(p) { pal = Object.assign({}, pal, p || {}); if (!rafId && en) paint(clock()); },
    setFlipped(v) { flipped = !!v; },
    /** null / 'auto' follows the OS setting; true / false forces it. */
    setReducedMotion(v) { forced = v === true || v === false ? v : null; applyReduced(forced !== null ? forced : !!(mq && mq.matches)); },
    resize() { if (!dead) onResize(); },
    /** Center (canvas CSS px) and size of a cell, or null. Same cell forms as the effects. */
    cellCenter(c) { const p = cellPt(c); return p ? { x: p.x - bleed, y: p.y - bleed, size: p.cs } : null; },
    clear, destroy,
    stats() {
      return { particles: pn, effects: en, awake: !!rafId, frames, fps: Math.round(1000 / ema), quality: q, reduced,
        poolSize: PP.length, effectPoolSize: EE.length, maxParticles: MAXP, maxEffects: MAXE,
        width: W, height: H, dpr, destroyed: dead };
    },
  };
}
