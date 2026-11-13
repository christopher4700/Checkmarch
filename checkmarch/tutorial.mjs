// Checkmarch tutorial: data-driven coach marks + one-line toasts. No dependencies, no imports.
//
// - createTutorial({ steps, storage, onEvent, ... }) -> engine. Feed it game-state snapshots with
//   update(snap) and game events with event(name). It shows at most ONE coach mark at a time: a soft
//   scrim with a cutout over the anchor and a card (text + "Got it") that never covers the anchor.
// - Steps fire once each. Seen ids and event counts persist through the injected storage
//   ({ getItem, setItem, removeItem }, e.g. localStorage); every storage call is wrapped in try/catch.
// - The scrim and cutout have pointer-events: none, so the anchored element (and the rest of the page)
//   keeps receiving input. Only the card itself takes taps.
// - CHECKMARCH_STEPS is the game's step content; checkmarchSnapshot() builds the snapshot it expects.
//
// Inline-friendly: only top-level `export function` / `export const`, every top-level name starts
// with `tut` / `TUT_` / `createTutorial` / `smallToast` / `checkmarch`, so checkmarch/build.mjs can
// strip the exports and inline it without name clashes.

export const TUT_TEXT_MAX = 140;
export const TUT_DISMISS = ['tap', 'auto'];          // or any event name (a string passed to event())
export const TUT_PLACEMENTS = ['auto', 'top', 'bottom'];
export const TUT_DEFAULTS = {
  storageKey: 'checkmarch.tutorial.v1',
  gutter: 16,        // min distance from the card to the viewport edge
  gap: 10,           // distance between the cutout and the card
  pad: 6,            // cutout padding around the anchor
  cardMaxW: 340,     // card width cap (phone-first: on a 375px phone it is 343px)
  minCardH: 72,      // below this much free space the card may not fit beside the anchor (see tutPlaceCard)
  autoMs: 7000,      // 'auto' steps hide after this long (step.ms overrides)
  cooldownMs: 1200,  // quiet gap between two coach marks
  seenAfterMs: 1500, // a mark whose condition lapses after being on screen this long counts as seen
  pollMs: 250,       // while a mark is up: re-check anchor/condition and reposition (game re-renders via innerHTML)
  z: 60,             // above the game's toast (20) and board overlay
  gotIt: 'Got it',
  skipLabel: 'No more tips',
  scroll: true,      // scroll an off-screen anchor into view when its mark shows
};

// ---------------------------------------------------------------------------------------------
// pure geometry
// ---------------------------------------------------------------------------------------------
export function tutClamp(v, lo, hi) { return hi < lo ? lo : v < lo ? lo : v > hi ? hi : v; }
export function tutRect(r) {
  if (!r) return null;
  const x = r.x ?? r.left ?? 0, y = r.y ?? r.top ?? 0;
  return { x, y, w: r.w ?? r.width ?? 0, h: r.h ?? r.height ?? 0 };
}
// cutout: the anchor rect grown by pad and clipped to the viewport (null when it is fully off screen)
export function tutCutout(anchor, pad, view) {
  const a = tutRect(anchor); if (!a) return null;
  const x0 = Math.max(0, a.x - pad), y0 = Math.max(0, a.y - pad);
  const x1 = Math.min(view.w, a.x + a.w + pad), y1 = Math.min(view.h, a.y + a.h + pad);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
// Where the card goes. anchor: {x,y,w,h} in viewport px (or null = centred card), card: {w,h} natural size,
// view: {w,h}. Returns {x, y, w, h, side, arrowX, covers}:
// - w = min(card.w, view.w - 2*gutter); x is clamped so the card keeps `gutter` px from both edges.
// - side 'bottom'/'top': the card sits fully below/above the (clipped) anchor, `gap` px away; never on it.
//   'auto' prefers below, then above; if neither fits whole, the roomier side is used and h shrinks to the
//   room (the card scrolls). Only when that room is under minH does it fall back to side 'overlay'
//   (pinned to the viewport edge farther from the anchor centre) and report covers: true.
// - arrowX: the arrow's x inside the card, pointing at the anchor centre (kept 16px from card corners).
export function tutPlaceCard({ anchor, card, view, placement = 'auto', gutter = 16, gap = 10, minH = 72 }) {
  const vw = view.w, vh = view.h;
  const w = Math.max(0, Math.min(card.w, vw - 2 * gutter));
  const fullH = Math.max(0, vh - 2 * gutter);
  const a = tutRect(anchor);
  if (!a) {
    const h = Math.min(card.h, fullH);
    return { x: tutClamp((vw - w) / 2, gutter, vw - gutter - w), y: tutClamp((vh - h) / 2, gutter, vh - gutter - h), w, h, side: 'center', arrowX: null, covers: false };
  }
  const top = tutClamp(a.y, 0, vh), bot = tutClamp(a.y + a.h, 0, vh);
  // card edges facing the anchor: `gap` px off it, but never inside the viewport gutters
  const edge = { top: Math.min(top - gap, vh - gutter), bottom: Math.max(bot + gap, gutter) };
  const room = { top: edge.top - gutter, bottom: vh - gutter - edge.bottom };
  const order = placement === 'top' ? ['top', 'bottom'] : ['bottom', 'top'];
  let side = order.find(s => room[s] >= card.h);
  if (!side) side = room.top > room.bottom ? 'top' : 'bottom';
  let h = Math.min(card.h, Math.max(0, room[side])), y, covers = false;
  if (h < Math.min(minH, card.h)) {
    // anchor fills (nearly) the whole viewport: pin to the edge away from its centre
    side = 'overlay'; covers = true; h = Math.min(card.h, fullH);
    const cy = (top + bot) / 2;
    y = cy > vh / 2 ? gutter : vh - gutter - h;
  } else y = side === 'top' ? edge.top - h : edge.bottom;
  const cx = tutClamp(a.x + a.w / 2, 0, vw);
  const x = tutClamp(cx - w / 2, gutter, vw - gutter - w);
  const arrowX = side === 'overlay' ? null : tutClamp(cx - x, 16, w - 16);
  return { x, y, w, h, side, arrowX, covers };
}
export function tutOverlaps(p, q) { return p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h; }

// ---------------------------------------------------------------------------------------------
// step validation + feature filtering
// ---------------------------------------------------------------------------------------------
// returns a list of problems (empty = valid)
export function tutValidateStep(s) {
  const e = [];
  if (!s || typeof s !== 'object') return ['step is not an object'];
  if (typeof s.id !== 'string' || !s.id) e.push('missing id');
  if (typeof s.when !== 'function') e.push(`${s.id}: when must be a function`);
  if (typeof s.text !== 'string' || !s.text.trim()) e.push(`${s.id}: missing text`);
  else if ([...s.text].length > TUT_TEXT_MAX) e.push(`${s.id}: text is ${[...s.text].length} chars (max ${TUT_TEXT_MAX})`);
  if (s.anchor != null && typeof s.anchor !== 'string' && typeof s.anchor !== 'function') e.push(`${s.id}: anchor must be a selector, a function or null`);
  if (s.placement != null && !TUT_PLACEMENTS.includes(s.placement)) e.push(`${s.id}: bad placement ${s.placement}`);
  if (s.dismiss != null && (typeof s.dismiss !== 'string' || !s.dismiss)) e.push(`${s.id}: dismiss must be 'tap', 'auto' or an event name`);
  if (s.after != null && !Array.isArray(s.after)) e.push(`${s.id}: after must be an array of step ids`);
  return e;
}
// features: undefined = keep every step; an array / Set / {flag: bool} = drop steps whose `feature` is not on
export function tutFilterSteps(steps, features) {
  if (features == null) return steps.slice();
  const on = features instanceof Set ? f => features.has(f) : Array.isArray(features) ? f => features.includes(f) : f => !!features[f];
  return steps.filter(s => !s.feature || on(s.feature));
}
export function tutPrepareSteps(steps, features) {
  const errors = [], out = [], ids = new Set();
  for (const s of tutFilterSteps(steps || [], features)) {
    const e = tutValidateStep(s);
    if (!e.length && ids.has(s.id)) e.push(`${s.id}: duplicate id`);
    if (e.length) { errors.push(...e); continue; }
    ids.add(s.id);
    out.push(Object.assign({ placement: 'auto', dismiss: 'tap', anchor: null }, s));
  }
  return { steps: out, errors };
}

// ---------------------------------------------------------------------------------------------
// styles (theme tokens: every colour is a --tut-* custom property falling back to the game's tokens)
// ---------------------------------------------------------------------------------------------
export const TUT_CSS = `
.tut-layer{position:fixed;inset:0;pointer-events:none;z-index:var(--tut-z,60)}
.tut-hole{position:fixed;left:0;top:0;width:0;height:0;border-radius:var(--tut-radius,12px);pointer-events:none;
  box-shadow:0 0 0 2px var(--tut-ring,var(--accent,#2c6a58)),0 0 0 200vmax var(--tut-scrim,rgba(12,16,14,.42));
  transition:left .2s,top .2s,width .2s,height .2s}
.tut-hole.solo{box-shadow:0 0 0 200vmax var(--tut-scrim,rgba(12,16,14,.42))}
.tut-card{position:fixed;left:0;top:0;pointer-events:auto;box-sizing:border-box;
  background:var(--tut-card,var(--panel,#fff));color:var(--tut-fg,var(--fg,#1d2420));border:1px solid var(--tut-line,var(--line,#cfd5cb));
  border-radius:14px;box-shadow:var(--tut-shadow,0 10px 30px rgba(0,0,0,.25));padding:12px 14px 10px;
  font:15px/1.45 var(--tut-font,var(--body,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif));animation:tut-in .18s ease-out}
.tut-card p{margin:0 0 8px;text-wrap:pretty}
.tut-row{display:flex;justify-content:flex-end;align-items:center;gap:8px}
.tut-card button{font:inherit;min-height:44px;border-radius:10px;padding:0 14px;cursor:pointer;touch-action:manipulation}
.tut-ok{background:var(--tut-accent,var(--accent,#2c6a58));color:var(--tut-accent-fg,var(--accent-fg,#fff));border:0;font-weight:650}
.tut-skip{background:transparent;border:0;color:var(--tut-muted,var(--muted,#5d685f));font-size:13px;margin-right:auto;padding:0 6px}
.tut-ok:focus-visible,.tut-skip:focus-visible{outline:2px solid var(--tut-accent,var(--accent,#2c6a58));outline-offset:2px}
.tut-arrow{position:absolute;width:12px;height:12px;background:inherit;border:inherit;border-width:0 1px 1px 0;transform:translateX(-50%) rotate(45deg)}
.tut-card[data-side="bottom"] .tut-arrow{top:-7px;transform:translateX(-50%) rotate(225deg)}
.tut-card[data-side="top"] .tut-arrow{bottom:-7px}
.tut-card[data-side="overlay"] .tut-arrow,.tut-card[data-side="center"] .tut-arrow{display:none}
.tut-body{overflow-y:auto;overscroll-behavior:contain}
.tut-toast{position:fixed;left:50%;bottom:calc(64px + env(safe-area-inset-bottom,0px));transform:translate(-50%,12px);opacity:0;pointer-events:none;
  z-index:calc(var(--tut-z,60) + 1);max-width:calc(100vw - 32px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  background:var(--tut-toast-bg,var(--fg,#1d2420));color:var(--tut-toast-fg,var(--bg,#fff));padding:8px 14px;border-radius:999px;
  font:14px/1.3 var(--tut-font,var(--body,system-ui,sans-serif));transition:opacity .2s,transform .2s}
.tut-toast.show{opacity:1;transform:translate(-50%,0)}
@keyframes tut-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion: reduce){.tut-hole,.tut-toast{transition:none}.tut-card{animation:none}}
`;
export function tutInjectCss(doc) {
  if (!doc || !doc.createElement) return;
  try {
    if (doc.getElementById && doc.getElementById('tut-style')) return;
    const st = doc.createElement('style'); st.id = 'tut-style'; st.textContent = TUT_CSS;
    (doc.head || doc.body).appendChild(st);
  } catch (e) { /* styling is optional */ }
}
// theme: { scrim, card, fg, line, accent, 'accent-fg', muted, ring, ... } -> --tut-<key> on the element
export function tutApplyTheme(el, theme) {
  if (!el || !theme) return;
  for (const k of Object.keys(theme)) try { el.style.setProperty('--tut-' + k, String(theme[k])); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------------------------
// storage helpers
// ---------------------------------------------------------------------------------------------
export function tutMemoryStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); } };
}
// storage backed by a field on a plain object (e.g. the game's state, so tips ride its save + hot snapshot)
export function tutObjectStorage(getObj, field = 'tutorial') {
  return {
    getItem: () => { const o = getObj(); return o && o[field] != null ? JSON.stringify(o[field]) : null; },
    setItem: (k, v) => { const o = getObj(); if (o) o[field] = JSON.parse(v); },
    removeItem: () => { const o = getObj(); if (o) delete o[field]; },
  };
}
function tutFreshData() { return { seen: {}, counts: {}, off: false }; }
function tutNormData(d) {
  const f = tutFreshData();
  if (!d || typeof d !== 'object') return f;
  if (d.seen && typeof d.seen === 'object') for (const k of Object.keys(d.seen)) f.seen[k] = +d.seen[k] || 1;
  if (d.counts && typeof d.counts === 'object') for (const k of Object.keys(d.counts)) f.counts[k] = Math.max(0, d.counts[k] | 0);
  f.off = !!d.off;
  return f;
}

// ---------------------------------------------------------------------------------------------
// one-line toast (standalone)
// ---------------------------------------------------------------------------------------------
export function smallToast(text, opts = {}) {
  const doc = opts.doc ?? (typeof document !== 'undefined' ? document : null);
  const st = opts.timers ?? globalThis;
  if (!doc || !doc.createElement) return null;
  tutInjectCss(doc);
  let el = doc.getElementById && doc.getElementById('tut-toast');
  if (!el) {
    el = doc.createElement('div'); el.id = 'tut-toast'; el.className = 'tut-toast';
    el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
    doc.body.appendChild(el);
  }
  el.textContent = String(text).replace(/\s+/g, ' ').trim();
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  st.clearTimeout(smallToast.t);
  smallToast.t = st.setTimeout(() => el.classList.remove('show'), opts.ms ?? 2600);
  return el;
}

// ---------------------------------------------------------------------------------------------
// the engine
// ---------------------------------------------------------------------------------------------
export function createTutorial(options = {}) {
  const o = Object.assign({}, TUT_DEFAULTS, options);
  const doc = o.doc !== undefined ? o.doc : (typeof document !== 'undefined' ? document : null);
  const win = o.win !== undefined ? o.win : (typeof window !== 'undefined' ? window : null);
  const tm = o.timers || globalThis;
  const now = o.now || (() => Date.now());
  const emit = (type, extra) => { if (o.onEvent) try { o.onEvent(Object.assign({ type }, extra)); } catch (e) { /* listener bugs never break the game */ } };

  const prep = tutPrepareSteps(o.steps, o.features);
  for (const err of prep.errors) emit('invalid', { error: err });
  const steps = prep.steps, ids = new Set(steps.map(s => s.id));

  // ---- persistence ----
  let data = tutFreshData();
  try { const raw = o.storage ? o.storage.getItem(o.storageKey) : null; data = tutNormData(raw ? JSON.parse(raw) : null); }
  catch (e) { emit('storage-error', { op: 'read', error: String(e && e.message || e) }); }
  function persist() {
    if (!o.storage) return;
    try { o.storage.setItem(o.storageKey, JSON.stringify(data)); }
    catch (e) { emit('storage-error', { op: 'write', error: String(e && e.message || e) }); }
  }

  // ---- runtime ----
  let snap = null, cur = null, lastHide = -Infinity, wakeT = 0, pollT = 0, destroyed = false, layer = null;
  const ctx = {
    seen: id => !!data.seen[id],
    count: name => data.counts[name] | 0,
    now: () => now(),
    current: () => (cur ? cur.step.id : null),
  };
  const viewport = () => {
    const w = (o.viewport && o.viewport().w) || (win && win.innerWidth) || (doc && doc.documentElement && doc.documentElement.clientWidth) || 375;
    const h = (o.viewport && o.viewport().h) || (win && win.innerHeight) || (doc && doc.documentElement && doc.documentElement.clientHeight) || 667;
    return { w, h };
  };
  function resolve(step) {
    if (!step.anchor) return null;
    let el = null;
    try { el = typeof step.anchor === 'function' ? step.anchor(doc, snap) : doc ? doc.querySelector(step.anchor) : null; } catch (e) { el = null; }
    if (!el || !el.getBoundingClientRect) return null;
    if (el.isConnected === false) return null;
    const r = el.getBoundingClientRect();
    return r && (r.width > 0 || r.height > 0) ? el : null;
  }
  function holds(step) { try { return !!step.when(snap, ctx); } catch (e) { return false; } }
  function eligible(step) {
    if (data.seen[step.id]) return false;
    if (step.after && !step.after.every(id => data.seen[id] || !ids.has(id))) return false;
    return holds(step);
  }

  // ---- DOM ----
  function buildLayer() {
    if (!doc || !doc.createElement || !doc.body) return null;
    tutInjectCss(doc);
    const L = doc.createElement('div'); L.className = 'tut-layer'; L.setAttribute('aria-hidden', 'false');
    L.style.setProperty('--tut-z', String(o.z));
    tutApplyTheme(L, o.theme);
    const hole = doc.createElement('div'); hole.className = 'tut-hole';
    const card = doc.createElement('div'); card.className = 'tut-card'; card.setAttribute('role', 'status'); card.setAttribute('aria-live', 'polite');
    const body = doc.createElement('div'); body.className = 'tut-body';
    const p = doc.createElement('p');
    const row = doc.createElement('div'); row.className = 'tut-row';
    const skip = doc.createElement('button'); skip.type = 'button'; skip.className = 'tut-skip'; skip.textContent = o.skipLabel;
    const ok = doc.createElement('button'); ok.type = 'button'; ok.className = 'tut-ok'; ok.textContent = o.gotIt;
    const arrow = doc.createElement('i'); arrow.className = 'tut-arrow';
    ok.addEventListener('click', () => dismiss('button'));
    skip.addEventListener('click', () => { setEnabled(false); emit('skip-all', {}); });
    if (o.skipLabel) row.appendChild(skip);
    row.appendChild(ok); body.appendChild(p); body.appendChild(row); card.appendChild(arrow); card.appendChild(body);
    L.appendChild(hole); L.appendChild(card); doc.body.appendChild(L);
    return { L, hole, card, body, p, ok, arrow };
  }
  function px(n) { return Math.round(n) + 'px'; }
  function position() {
    if (!cur || !layer) return;
    const v = viewport();
    const el = cur.el = resolve(cur.step);
    const ar = el ? tutRect(el.getBoundingClientRect()) : null;
    const cut = ar ? tutCutout(ar, o.pad, v) : null;
    const { hole, card, arrow, body } = layer;
    if (cut) { hole.className = 'tut-hole'; Object.assign(hole.style, { left: px(cut.x), top: px(cut.y), width: px(cut.w), height: px(cut.h) }); }
    else { hole.className = 'tut-hole solo'; Object.assign(hole.style, { left: px(v.w / 2), top: px(v.h / 2), width: '0px', height: '0px' }); }
    const w = Math.min(o.cardMaxW, v.w - 2 * o.gutter);
    card.style.width = px(w); card.style.maxHeight = ''; body.style.maxHeight = '';
    const cr = card.getBoundingClientRect();
    const pl = tutPlaceCard({ anchor: cut, card: { w, h: cr.height || 96 }, view: v, placement: cur.step.placement, gutter: o.gutter, gap: o.gap, minH: o.minCardH });
    Object.assign(card.style, { left: px(pl.x), top: px(pl.y), width: px(pl.w), maxHeight: px(pl.h) });
    if (pl.h < (cr.height || 0)) body.style.maxHeight = px(Math.max(24, pl.h - 24)); // card padding: the text scrolls
    card.setAttribute('data-side', pl.side);
    if (pl.arrowX != null) arrow.style.left = px(pl.arrowX);
    cur.place = pl; cur.cut = cut;
  }
  const onViewport = () => { if (cur) position(); };
  const onPointer = e => {
    if (!cur || cur.step.dismiss !== 'tap' || !cur.el || !e || !e.target) return;
    try { if (cur.el === e.target || (cur.el.contains && cur.el.contains(e.target))) dismiss('anchor'); } catch (err) { /* ignore */ }
  };
  let listening = false;
  function listen(on) {
    if (on === listening) return; listening = on;
    const f = on ? 'addEventListener' : 'removeEventListener';
    try {
      if (win && win[f]) { win[f]('resize', onViewport); win[f]('scroll', onViewport, true); }
      if (doc && doc[f]) doc[f]('pointerdown', onPointer, true);
    } catch (e) { /* ignore */ }
  }

  // ---- show / hide ----
  function show(step, el) {
    cur = { step, el, shownAt: now(), place: null, cut: null, autoT: 0 };
    layer = buildLayer();
    if (layer) {
      layer.p.textContent = step.text;
      if (el && o.scroll && el.scrollIntoView) {
        const r = el.getBoundingClientRect(), v = viewport();
        if (r.top < 0 || r.bottom > v.h) try { el.scrollIntoView({ block: 'nearest', behavior: 'auto' }); } catch (e) { /* ignore */ }
      }
      position();
      listen(true);
      pollT = tm.setInterval(() => update(), o.pollMs);
    }
    if (step.dismiss === 'auto') cur.autoT = tm.setTimeout(() => dismiss('timeout'), step.ms ?? o.autoMs);
    emit('show', { id: step.id });
  }
  function teardown() {
    if (!cur) return;
    tm.clearTimeout(cur.autoT); tm.clearInterval(pollT); pollT = 0;
    if (layer && layer.L.parentNode) layer.L.parentNode.removeChild(layer.L);
    layer = null; cur = null; listen(false);
    lastHide = now();
    tm.clearTimeout(wakeT); wakeT = tm.setTimeout(() => { wakeT = 0; update(); }, o.cooldownMs + 10);
  }
  function markSeen(id) { data.seen[id] = now() || 1; persist(); }
  function dismiss(how = 'api') {
    if (!cur) return false;
    const id = cur.step.id;
    markSeen(id); teardown();
    emit('dismiss', { id, how });
    return true;
  }
  function lapse(reason) {
    const id = cur.step.id, long = now() - cur.shownAt >= o.seenAfterMs;
    if (long) markSeen(id);
    teardown();
    emit('hide', { id, reason, seen: long });
  }

  // ---- public ----
  function update(s) {
    if (s !== undefined) snap = s;
    if (destroyed) return null;
    if (cur) {
      if (data.off) { lapse('disabled'); return null; }
      if (!holds(cur.step)) { lapse('condition'); }
      else if (cur.step.anchor && doc && !resolve(cur.step)) { lapse('anchor'); }
      else { position(); return cur.step.id; }
    }
    if (data.off || snap == null) return null;
    const wait = o.cooldownMs - (now() - lastHide);
    if (wait > 0) { if (!wakeT) wakeT = tm.setTimeout(() => { wakeT = 0; update(); }, wait + 10); return null; }
    for (const step of steps) {
      if (!eligible(step)) continue;
      const el = resolve(step);
      if (step.anchor && doc && !el) continue;   // anchor not on screen yet: try the next step
      show(step, el);
      return step.id;
    }
    return null;
  }
  function event(name, opts = {}) {
    if (destroyed || typeof name !== 'string') return;
    data.counts[name] = (data.counts[name] | 0) + 1; persist();
    if (cur && cur.step.dismiss === name) dismiss('event');
    if (opts.update !== false) update();
  }
  function setEnabled(on) {
    data.off = !on; persist();
    if (!on && cur) lapse('disabled');
    else if (on) update();
  }
  function reset() {
    if (cur) { const id = cur.step.id; teardown(); emit('hide', { id, reason: 'reset', seen: false }); }
    data = tutFreshData(); persist(); lastHide = -Infinity;
    emit('reset', {});
    update();
  }
  function destroy() {
    if (cur) teardown();
    tm.clearTimeout(wakeT); wakeT = 0; destroyed = true; listen(false);
  }
  const api = {
    update, event, dismiss: () => dismiss('api'), reset, setEnabled, destroy,
    reposition: position,
    toast: (text, opt) => smallToast(text, Object.assign({ doc, timers: tm }, opt)),
    current: () => (cur ? cur.step.id : null),
    placement: () => (cur ? cur.place : null),
    cutout: () => (cur ? cur.cut : null),
    seen: id => !!data.seen[id],
    count: name => data.counts[name] | 0,
    enabled: () => !data.off,
    steps: () => steps.map(s => s.id),
    progress: () => ({ seen: steps.filter(s => data.seen[s.id]).length, total: steps.length }),
  };
  return api;
}

// ---------------------------------------------------------------------------------------------
// Checkmarch content
// ---------------------------------------------------------------------------------------------
// Snapshot the tutorial steps read. Build it in game.src.html from the live game:
//   checkmarchSnapshot({ state, battle, ui, frontierSelected: isFrontier(ui.node), mineSelected: heldMineSel() != null })
// Everything else is read from the raw state so the module does not depend on engine/world names.
export function checkmarchSnapshot({ state, battle = null, ui = {}, frontierSelected = false, mineSelected = false, overlayOpen } = {}) {
  const st = state || {}, r = st.run || {}, m = r.map || {};
  const rival = m.rival || null, rivalActive = !!(rival && rival.status === 'active');
  const garrison = m.garrison || {};
  const garrisoned = Object.keys(garrison).reduce((a, k) => a + ((garrison[k] && garrison[k].length) || 0), 0);
  const dwell = r.dwell || {};
  const res = ui.result || null;
  const modal = ui.ended ? null
    : !st.eloPicked ? 'elo'
    : res ? 'result'
    : rivalActive && rival.pending && !(m.raid && m.raid.pending) ? 'border'
    : m.raid && m.raid.pending ? 'raid'
    : m.shrine != null && !ui.shrinePick ? 'shrine'
    : null;
  return {
    screen: ui.ended ? 'ended' : battle ? 'battle' : 'map',
    modal: overlayOpen === false ? null : modal,
    tab: ui.tab || 'shop',
    eloPicked: !!st.eloPicked,
    elo: r.elo ?? st.elo ?? null,
    runNo: (st.totalRuns | 0) + 1,
    region: m.region || 1,
    gold: r.gold || 0,
    memories: st.memories || 0,
    cleared: r.cleared | 0, wins: r.wins | 0, losses: r.losses | 0,
    mines: (r.mines && r.mines.length) || 0,
    garrisoned,
    raidPending: !!(m.raid && m.raid.pending),
    marching: !!m.march,
    frontierSelected: !!frontierSelected,
    mineSelected: !!mineSelected,
    shrinePick: !!ui.shrinePick,
    rival: rivalActive, rivalContact: !!m.contact,
    dwellings: Object.keys(dwell).reduce((a, k) => a + (dwell[k] | 0), 0),
    roster: (r.roster && r.roster.length) || 0,
    reserve: r.roster && r.formation ? r.roster.length - Object.keys(r.formation).length : 0,
    battle: battle && !battle.over ? {
      auto: ui.auto !== false,
      myTurn: battle.pos ? battle.pos.side === 0 : false,
      type: battle.node ? battle.node.type : null,
      raid: !!(battle.node && battle.node.raid),
      plies: battle.plies | 0,
      lost: (battle.lost && battle.lost.length) || 0,
    } : null,
    result: res ? { result: res.result, lost: res.lost | 0, mine: !!res.mine, raid: !!res.raid } : null,
    ended: ui.ended ? ui.ended.kind : null,
  };
}

// Game events the steps listen for (game.src.html calls tutorial.event(name) at these points):
//   'formation-edit' a piece was placed / moved / swapped / benched (onSquare, act('bench'))
//   'node-select'    a frontier node was selected on the map (onMapTap)
//   'march'          a march started (beginMarch)
//   'takeover'       the player took manual control in battle (act('auto') -> ui.auto false)
//   'hint'           Hint was pressed
//   'piece-lost'     a battle ended with lost > 0 (endBattle; pass once per battle)
//   'station'        a piece was stationed at a mine (act('station'))
//   'buy'            a piece / square / Tactician level was bought
//   'tab:shop' | 'tab:army' | 'tab:run'   a tab was opened
//   'order'          a standing order was changed (act('odoc:'|'oqueen'|'oret:'))
//   'mem-buy'        a Memories upgrade was bought
//   'dwell'          a dwelling level was bought
const tutFree = s => s.screen === 'map' && !s.modal && !s.shrinePick && !s.mineSelected;

export const CHECKMARCH_STEPS = [
  // 1. formation (first thing after picking the elo band)
  { id: 'formation', anchor: '#board', placement: 'auto', dismiss: 'formation-edit',
    when: (s, c) => tutFree(s) && !s.marching && c.count('formation-edit') === 0 && c.count('march') === 0,
    text: 'This is your formation. Tap one of your pieces, then another of your squares to move it. Battles start from exactly this setup.' },
  // 2. the map
  { id: 'pick-target', anchor: '#map', placement: 'bottom', dismiss: 'node-select', after: ['formation'],
    when: (s, c) => tutFree(s) && !s.marching && !s.frontierSelected && c.count('march') === 0,
    text: 'Glowing nodes on the map are your frontier. Tap one to see its defenders as ghosts on your board.' },
  // 3. first march
  { id: 'first-march', anchor: '#controls [data-act="march"]', placement: 'top', dismiss: 'march', after: ['formation'],
    when: (s, c) => tutFree(s) && s.frontierSelected && !s.marching && c.count('march') === 0,
    text: 'Tap March when ready. The battle begins on arrival, from your formation as it stands then.' },
  // 4. battle: take over
  { id: 'takeover', anchor: '#controls [data-act="auto"]', placement: 'top', dismiss: 'takeover',
    when: s => s.screen === 'battle' && !!s.battle && s.battle.auto && s.battle.plies >= 2,
    text: 'Your Tactician fights for you. Tap Take over to play by hand: you can outplay it, and it plays only as well as your foes.' },
  // 5. battle: hint
  { id: 'hint', anchor: '#controls [data-act="hint"]', placement: 'top', dismiss: 'tap', after: ['takeover'],
    when: s => s.screen === 'battle' && !!s.battle && !s.battle.auto && s.battle.myTurn,
    text: 'Stuck? Hint lights up a strong move. Tap a piece to see where it can go; Auto play hands control back.' },
  // 6. losses are permanent (back on the map after a battle that cost pieces)
  { id: 'losses', anchor: '#tabShop', placement: 'top', dismiss: 'tap',
    when: (s, c) => tutFree(s) && c.count('piece-lost') > 0,
    text: 'Captured pieces are gone for good this run. The Shop sells new ones, and a loss makes that piece a little cheaper again.' },
  // 7. first spend
  { id: 'shop', anchor: '#tabShop', placement: 'top', dismiss: 'tap',
    when: (s, c) => tutFree(s) && s.wins >= 1 && s.gold >= 25 && c.count('buy') === 0,
    text: 'Spend gold in the Shop: recruits join your reserve. You can also tap a + square on the board to widen your formation.' },
  // 8. mine income
  { id: 'mine-income', anchor: '#sInc', placement: 'bottom', dismiss: 'tap',
    when: s => tutFree(s) && s.mines >= 1,
    text: 'You hold a mine! It pays gold as the world moves: on the map, on the march and with every battle move.' },
  // 9. garrison
  { id: 'garrison', anchor: '#map', placement: 'bottom', dismiss: 'station', after: ['mine-income'],
    when: s => tutFree(s) && s.mines >= 1 && s.garrisoned === 0 && !s.rivalContact,
    text: 'Raiders will come for your mines. Tap a held mine to station pieces there; only a garrison can defend a raid.' },
  // 10. raid card
  { id: 'raid', anchor: '#ov .choice', placement: 'auto', dismiss: 'tap',
    when: s => s.modal === 'raid',
    text: 'A raid! Defend sends your garrison and a castellan. Losing costs the mine, never the run. Concede gives it up for now.' },
  // 11. Memories shop on the first run end
  { id: 'memories', anchor: '#endSec [data-act^="mem:"]', placement: 'auto', dismiss: 'tap',
    when: s => s.screen === 'ended',
    text: 'The run is over, but Memories last. Spend them on permanent upgrades; bought now, they apply to the run you begin next.' },
  // 12. standing orders (once the player has a few wins)
  { id: 'orders-nudge', anchor: '#tabRun', placement: 'top', dismiss: 'tab:run',
    when: (s, c) => tutFree(s) && s.wins >= 3 && s.tab !== 'run' && c.count('order') === 0,
    text: 'Open Run to give your Tactician standing orders: how it plays, guarding the queen, and when to retreat.' },
  { id: 'orders', anchor: '#panel [aria-label="Doctrine"]', placement: 'auto', dismiss: 'tap',
    when: s => tutFree(s) && s.tab === 'run' && s.wins >= 1,
    text: 'Doctrine sets your Tactician\'s style. Auto-retreat saves survivors from a lost fight. Orders carry over to new runs.' },
  // 13. abdicate (Run tab, a decent run behind you)
  { id: 'abdicate', anchor: '#panel [data-act="abdicate"]', placement: 'top', dismiss: 'tap', after: ['orders'],
    when: s => tutFree(s) && s.tab === 'run' && s.cleared >= 6,
    text: 'Abdicate ends the run on your terms for full Memories. Checkmate pays only a quarter, so stop while you are ahead.' },
  // 14. dwellings (feature flag: may be cut or renamed)
  { id: 'dwellings-nudge', feature: 'dwellings', anchor: '#tabArmy', placement: 'top', dismiss: 'tab:army',
    when: (s, c) => tutFree(s) && s.wins >= 2 && s.gold >= 150 && s.dwellings === 0 && s.tab !== 'army' && c.count('dwell') === 0,
    text: 'Dwellings are open on the Army tab. They give a whole piece type a trait that can save it from capture.' },
  { id: 'dwellings', feature: 'dwellings', anchor: '#panel [data-act^="dwell:"]', placement: 'auto', dismiss: 'tap',
    when: s => tutFree(s) && s.tab === 'army' && s.wins >= 1,
    text: 'A dwelling trains one piece type. When one is captured its trait may save it; the roll is shown before it lands.' },
  // 15. elo meaning (after the first battle, when a target is picked and the foe card shows its elo)
  { id: 'elo', feature: 'elo', anchor: '#foe', placement: 'auto', dismiss: 'tap',
    when: s => tutFree(s) && s.frontierSelected && s.wins + s.losses >= 1,
    text: 'Elo is chess strength: 600 blunders, 1500 is a master. Foes grow stronger each region, and your Tactician matches them.' },
  // 16. rival lord (feature flag)
  { id: 'rival', feature: 'rival', anchor: '#rivalBar', placement: 'bottom', dismiss: 'tap', after: ['pick-target'],
    when: s => tutFree(s) && s.rival && s.wins >= 2,
    text: 'A rival lord is growing on this map. When your borders meet, the rival attacks your nodes itself. Keep your keep strong.' },
  // 17. shrine (feature flag)
  { id: 'shrine', feature: 'shrine', anchor: '#ov .choice', placement: 'auto', dismiss: 'tap',
    when: s => s.modal === 'shrine',
    text: 'A shrine grants one blessing: pick one of the two gifts and the other is lost. Each gift says what it does and for how long.' },
];
// feature flags the steps use; integration passes the built ones: createTutorial({ features: [...] })
export const CHECKMARCH_FEATURES = ['dwellings', 'elo', 'rival', 'shrine'];
