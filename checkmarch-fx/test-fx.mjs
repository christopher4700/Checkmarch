// node test-fx.mjs : headless tests for fx.mjs with a mock canvas 2d context, mock rAF, clock and timers.
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFX, fxPaletteFromCSS, FX_MAX_PARTICLES, FX_MAX_EFFECTS, FX_PALETTES } from './fx.mjs';
import { buildDemo, moduleToScript } from './build-demo.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).toString().split('\n').slice(0, 3).join('\n       ')); }
}
function assert(c, msg) { if (!c) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || 'expected equal') + `: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }

// ---------- mock environment ----------
function makeCtx() {
  const calls = { total: 0, byName: Object.create(null), bad: [] };
  const state = { font: '10px sans-serif' };
  const target = {
    measureText(t) { calls.total++; return { width: String(t).length * 7 }; },
  };
  const ctx = new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k];
      if (k in state) return state[k];
      if (typeof k === 'symbol') return undefined;
      return (...args) => {
        calls.total++; calls.byName[k] = (calls.byName[k] || 0) + 1;
        for (const a of args) if (typeof a === 'number' && !Number.isFinite(a)) calls.bad.push(`${k}(${args.join(',')})`);
      };
    },
    set(t, k, v) {
      state[k] = v;
      if (typeof v === 'number' && !Number.isFinite(v)) calls.bad.push(`${String(k)}=${v}`);
      if (k === 'globalAlpha' && (v < -1e-9 || v > 1 + 1e-9)) calls.bad.push(`globalAlpha=${v}`);
      return true;
    },
  });
  return { ctx, calls };
}
function makeEnv({ w = 400, h = 400, reduced = false, ro = true, dpr = 2 } = {}) {
  let now = 1000;
  const rafQ = new Map(); let rafSeq = 0, rafCalls = 0;
  const timers = new Map(); let tSeq = 0;
  const { ctx, calls } = makeCtx();
  const mqListeners = new Set();
  const roInst = [];
  const canvas = { width: 0, height: 0, style: {}, parentNode: null, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getContext: () => ctx };
  const host = {
    clientWidth: w, clientHeight: h, style: {}, children: [],
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; },
  };
  const mq = { matches: reduced, addEventListener: (t, f) => mqListeners.add(f), removeEventListener: (t, f) => mqListeners.delete(f) };
  const win = {
    devicePixelRatio: dpr, innerWidth: w, innerHeight: h,
    matchMedia: () => mq,
    addEventListener() {}, removeEventListener() {},
    ResizeObserver: ro ? class { constructor(cb) { this.cb = cb; this.on = false; roInst.push(this); } observe() { this.on = true; } disconnect() { this.on = false; } } : undefined,
  };
  const doc = { createElement: () => canvas, body: host };
  const env = {
    canvas, host, ctx, calls, mq, mqListeners, roInst, win,
    get now() { return now; },
    get rafPending() { return rafQ.size; }, get rafCalls() { return rafCalls; },
    get timersPending() { return timers.size; },
    opts: {
      window: win, document: doc,
      now: () => now,
      raf: (cb) => { rafCalls++; const id = ++rafSeq; rafQ.set(id, cb); return id; },
      caf: (id) => { rafQ.delete(id); },
      setTimeout: (f, ms) => { const id = ++tSeq; timers.set(id, { f, at: now + ms }); return id; },
      clearTimeout: (id) => { timers.delete(id); },
    },
    // advance one animation frame of `ms`
    frame(ms = 16.7) {
      now += ms;
      const cbs = [...rafQ.values()]; rafQ.clear();
      for (const cb of cbs) cb(now);
      env.runTimers();
      return cbs.length;
    },
    // advance the clock without frames (timers only)
    advance(ms) { now += ms; env.runTimers(); },
    runTimers() {
      for (let guard = 0; guard < 100; guard++) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= now);
        if (!due.length) return;
        for (const [id, t] of due) { timers.delete(id); t.f(); }
      }
    },
    // pump frames until the loop sleeps; returns frames used
    drain(max = 2000) { let n = 0; while (rafQ.size && n < max) { env.frame(); n++; } return n; },
  };
  return env;
}

const EFFECTS = [
  ['captureBurst', (fx) => fx.captureBurst('e4', '#123456')],
  ['moveTrail', (fx) => fx.moveTrail(12, 28, '#2c6a58')],
  ['checkPulse', (fx) => fx.checkPulse(4)],
  ['promoteFlare', (fx) => fx.promoteFlare([1, 0])],
  ['traitSave', (fx) => fx.traitSave(60, 'Stubborn: saved!')],
  ['materialGlint', (fx) => fx.materialGlint(27, 3)],
  ['regionWin', (fx) => fx.regionWin({ title: 'Region cleared', subtitle: '+240 gold' })],
  ['runOver', (fx) => fx.runOver({ title: 'Checkmate' })],
  ['mineTick', (fx) => fx.mineTick(120, 60)],
  ['rivalCapture', (fx) => fx.rivalCapture(300, 80, 1.2)],
];

console.log('fx.mjs');

test('module parses (node --check)', () => {
  execFileSync(process.execPath, ['--check', join(here, 'fx.mjs')], { stdio: 'pipe' });
});

test('exports and constants', () => {
  eq(typeof createFX, 'function'); eq(typeof fxPaletteFromCSS, 'function');
  assert(FX_MAX_PARTICLES >= 100 && FX_MAX_PARTICLES <= 512, 'particle cap sane');
  assert(FX_MAX_EFFECTS >= 16, 'effect cap sane');
  for (const k of ['ink', 'accent', 'good', 'danger', 'gold', 'paper', 'veil']) assert(FX_PALETTES.light[k] && FX_PALETTES.dark[k], 'palette key ' + k);
});

test('createFX / destroy lifecycle', () => {
  const env = makeEnv();
  const fx = createFX(env.host, env.opts);
  assert(env.host.children.includes(env.canvas), 'canvas appended to host');
  eq(env.canvas.width, 800, 'canvas width = css * dpr'); eq(env.canvas.height, 800);
  assert(/pointer-events:none/.test(env.canvas.style.cssText), 'overlay ignores pointer');
  assert(/position:absolute/.test(env.canvas.style.cssText), 'absolute overlay');
  eq(env.canvas.attrs['aria-hidden'], 'true');
  eq(env.roInst.length, 1); assert(env.roInst[0].on, 'ResizeObserver observing');
  eq(env.mqListeners.size, 1, 'listening to prefers-reduced-motion');
  const s = fx.stats(); eq(s.awake, false, 'asleep at birth'); eq(env.rafCalls, 0, 'no rAF before any effect');
  fx.captureBurst(0);
  assert(env.rafPending === 1, 'effect wakes the loop');
  fx.destroy();
  eq(env.rafPending, 0, 'rAF cancelled on destroy');
  assert(!env.host.children.includes(env.canvas), 'canvas removed');
  assert(!env.roInst[0].on, 'ResizeObserver disconnected');
  eq(env.mqListeners.size, 0, 'media listener removed');
  eq(fx.captureBurst(0), false, 'effects are no-ops after destroy');
  eq(env.rafPending, 0);
  fx.destroy(); // idempotent
  eq(fx.stats().destroyed, true);
});

test('fixed (page-level) overlay sizes to the viewport', () => {
  const env = makeEnv({ w: 390, h: 844, dpr: 3 });
  const fx = createFX(null, Object.assign({ fixed: true }, env.opts));
  assert(/position:fixed/.test(env.canvas.style.cssText));
  eq(env.canvas.width, 780, 'dpr capped at 2'); eq(env.canvas.height, 1688);
  assert(fx.regionWin()); env.drain(); fx.destroy();
});

test('resize-safe: ResizeObserver callback re-measures the canvas', () => {
  const env = makeEnv();
  const fx = createFX(env.host, env.opts);
  env.host.clientWidth = 300; env.host.clientHeight = 300;
  env.roInst[0].cb();
  eq(env.canvas.width, 600); eq(fx.cellCenter(0).size, 37.5);
  fx.destroy();
});

test('no-ResizeObserver host hidden at creation still works once shown', () => {
  const env = makeEnv({ w: 0, h: 0, ro: false });
  const fx = createFX(env.host, env.opts);
  eq(fx.captureBurst(0), false, 'zero-size host: nothing scheduled');
  env.host.clientWidth = 320; env.host.clientHeight = 320;
  eq(fx.captureBurst(0), true, 're-measures lazily');
  eq(env.canvas.width, 640);
  env.drain(); fx.destroy();
});

test('cell coordinates: index, algebraic, grid, pixel, flipped', () => {
  const env = makeEnv();
  const fx = createFX(env.host, env.opts);
  const a1 = fx.cellCenter(0); eq(a1.x, 25); eq(a1.y, 375); eq(a1.size, 50);
  const e4 = fx.cellCenter('e4'), e4i = fx.cellCenter(28); eq(e4.x, e4i.x); eq(e4.y, e4i.y);
  const h8 = fx.cellCenter('h8'); eq(h8.x, 375); eq(h8.y, 25);
  const g = fx.cellCenter([2, 3]); eq(g.x, 125); eq(g.y, 175);
  const px = fx.cellCenter({ x: 10, y: 20 }); eq(px.x, 10); eq(px.y, 20);
  fx.setFlipped(true); const f = fx.cellCenter(0); eq(f.x, 375); eq(f.y, 25);
  for (const bad of [undefined, null, -1, 64, 3.5, NaN, 'z9', {}, [NaN, 1], 'hello']) eq(fx.cellCenter(bad), null, 'bad cell ' + String(bad));
  eq(fx.captureBurst(undefined), false); eq(fx.moveTrail(0, 99), false); eq(fx.mineTick(NaN, 3), false);
  eq(env.calls.bad.length, 0);
  fx.destroy();
});

test('bleed option offsets the canvas and keeps host coordinates', () => {
  const env = makeEnv();
  const fx = createFX(env.host, Object.assign({ bleed: 20 }, env.opts));
  eq(env.canvas.width, 880); assert(/left:-20px/.test(env.canvas.style.cssText));
  eq(fx.cellCenter(0).x, 25, 'cellCenter is host-relative');
  fx.destroy();
});

for (const [name, fire] of EFFECTS) {
  test(`${name}: runs, schedules finite work, then the loop sleeps`, () => {
    const env = makeEnv();
    const fx = createFX(env.host, Object.assign({ palette: FX_PALETTES.dark }, env.opts));
    eq(fire(fx), true, 'returns true');
    const s = fx.stats();
    assert(s.particles + s.effects > 0, 'something scheduled');
    assert(s.particles <= FX_MAX_PARTICLES && s.effects <= FX_MAX_EFFECTS, 'within caps');
    assert(s.awake, 'loop awake');
    const frames = env.drain(2000);
    assert(frames > 3, 'animated over several frames (' + frames + ')');
    assert(frames < 400, 'finite: done within ~6.7s of frames (' + frames + ')');
    const e = fx.stats();
    eq(e.particles, 0); eq(e.effects, 0); eq(e.awake, false, 'auto-slept'); eq(env.rafPending, 0, 'no rAF while idle');
    eq(env.calls.bad.length, 0, 'all draw args finite: ' + env.calls.bad.slice(0, 3).join(' '));
    assert(env.calls.total > 20, 'actually drew');
    assert((env.calls.byName.clearRect || 0) >= frames, 'cleared each frame');
    const callsIdle = env.calls.total;
    env.advance(5000); eq(env.calls.total, callsIdle, 'zero draw work while asleep');
    fx.destroy();
  });
}

test('runOver desaturates its target, then restores it', () => {
  const env = makeEnv();
  const target = { style: { filter: 'blur(0px)', transition: 'opacity 1s' } };
  const fx = createFX(env.host, env.opts);
  fx.runOver({ desaturate: target, duration: 2000 });
  assert(/grayscale/.test(target.style.filter), 'grayscale applied');
  env.drain();
  eq(target.style.filter, 'blur(0px)', 'filter restored');
  env.advance(1000); eq(target.style.transition, 'opacity 1s', 'transition restored');
  fx.runOver(); assert(/grayscale/.test(env.host.style.filter), 'defaults to host');
  fx.clear(); eq(env.host.style.filter, '', 'clear() restores');
  fx.destroy();
});

test('pools do not leak: 1000 bursts keep the particle array bounded', () => {
  const env = makeEnv();
  const fx = createFX(env.host, env.opts);
  let maxP = 0, maxE = 0;
  for (let i = 0; i < 1000; i++) {
    fx.captureBurst(i % 64, i & 1 ? '#c42f39' : '#2c6a58');
    if (i % 3 === 0) fx.traitSave(i % 64, 'Stubborn: saved!');
    if (i % 7 === 0) fx.mineTick(i % 400, 50);
    const s = fx.stats(); maxP = Math.max(maxP, s.particles); maxE = Math.max(maxE, s.effects);
    eq(s.poolSize, FX_MAX_PARTICLES, 'particle pool never grows'); eq(s.effectPoolSize, FX_MAX_EFFECTS, 'effect pool never grows');
    if (i % 5 === 0) env.frame();
  }
  assert(maxP <= FX_MAX_PARTICLES, 'particles bounded: ' + maxP);
  assert(maxP === FX_MAX_PARTICLES, 'cap was actually exercised');
  assert(maxE <= FX_MAX_EFFECTS, 'effects bounded: ' + maxE);
  eq(env.rafPending <= 1, true, 'one rAF at a time');
  env.drain();
  const s = fx.stats(); eq(s.particles, 0); eq(s.effects, 0); eq(s.awake, false);
  eq(env.calls.bad.length, 0);
  fx.destroy();
});

test('stress: 20 bursts in one tick stay within the cap', () => {
  const env = makeEnv();
  const fx = createFX(env.host, env.opts);
  for (let i = 0; i < 20; i++) fx.captureBurst(i * 3);
  const s = fx.stats(); assert(s.particles <= FX_MAX_PARTICLES && s.particles > 200, String(s.particles));
  eq(env.rafPending, 1, 'single rAF loop for any number of effects');
  env.drain(); fx.destroy();
});

test('adaptive quality drops on slow frames and recovers', () => {
  const env = makeEnv();
  const fx = createFX(env.host, env.opts);
  fx.regionWin();
  for (let i = 0; i < 60; i++) env.frame(40);
  const low = fx.stats().quality; assert(low < 1, 'quality dropped: ' + low);
  fx.captureBurst(0); const p0 = fx.stats().particles; assert(p0 > 0);
  env.drain(); for (let i = 0; i < 3; i++) { fx.regionWin(); while (env.rafPending) env.frame(10); }
  assert(fx.stats().quality > low, 'quality recovered');
  fx.destroy();
});

test('reduced motion: zero animated frames, zero particles, stills clear by timer', () => {
  const env = makeEnv({ reduced: true });
  const fx = createFX(env.host, env.opts);
  eq(fx.stats().reduced, true);
  for (const [, fire] of EFFECTS) eq(fire(fx), true);
  const s = fx.stats();
  eq(s.particles, 0, 'no particles'); eq(env.rafCalls, 0, 'no rAF requested'); eq(s.frames, 0, 'zero animated frames');
  assert(s.effects > 0, 'informative stills present');
  assert((env.calls.byName.fillText || 0) > 0, 'labels / banners painted');
  assert(/grayscale/.test(env.host.style.filter) && env.host.style.transition === 'none', 'veil desaturates without a transition');
  env.advance(3000);
  eq(fx.stats().effects, 0, 'stills cleared'); eq(env.timersPending, 0, 'no timers left'); eq(env.rafCalls, 0);
  eq(env.host.style.filter, '', 'filter restored');
  eq(env.calls.bad.length, 0);
  fx.destroy();
});

test('reduced motion toggles live (media change + setReducedMotion)', () => {
  const env = makeEnv();
  const fx = createFX(env.host, env.opts);
  fx.captureBurst(10); fx.regionWin(); env.frame();
  assert(fx.stats().particles > 0);
  env.mq.matches = true; for (const f of env.mqListeners) f();
  eq(fx.stats().reduced, true); eq(fx.stats().particles, 0, 'particles dropped'); eq(env.rafPending, 0, 'loop stopped');
  const rc = env.rafCalls; fx.captureBurst(10); eq(env.rafCalls, rc, 'no rAF while reduced');
  fx.setReducedMotion(false); eq(fx.stats().reduced, false);
  fx.captureBurst(10); assert(env.rafPending === 1 && fx.stats().particles > 0, 'animated again');
  fx.setReducedMotion(null); eq(fx.stats().reduced, true, 'auto follows the OS again');
  env.advance(3000); fx.destroy();
});

test('setPalette changes colors used for later effects', () => {
  const env = makeEnv();
  const fx = createFX(env.host, env.opts);
  const seen = new Set();
  fx.setPalette({ danger: '#abcdef' });
  fx.checkPulse(4);
  // the mock keeps the last value assigned; sample it across frames
  for (let i = 0; i < 10; i++) { env.frame(); seen.add(env.ctx.strokeStyle); seen.add(env.ctx.fillStyle); }
  assert(seen.has('#abcdef'), 'danger color used');
  env.drain(); fx.destroy();
});

test('fxPaletteFromCSS reads CSS custom properties with fallbacks', () => {
  const vars = { '--fg': '#111', '--accent': '#0a0', '--danger': '#f00', '--gold': '#fc0', '--panel': '#fff', 'color-scheme': 'dark' };
  const prev = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ getPropertyValue: (n) => vars[n] || '' });
  try {
    const p = fxPaletteFromCSS({});
    eq(p.ink, '#111'); eq(p.accent, '#0a0'); eq(p.good, '#0a0', 'good falls back to accent'); eq(p.rival, '#f00', 'rival falls back to danger');
    eq(p.veil, FX_PALETTES.dark.veil, 'dark fallback base from color-scheme');
  } finally { globalThis.getComputedStyle = prev; }
  const q = fxPaletteFromCSS(null); eq(q.ink, FX_PALETTES.light.ink, 'no DOM: fallback palette');
});

test('inline-safe for checkmarch/build.mjs: prefixed top-level names, no clash with game modules', () => {
  const src = moduleToScript(readFileSync(join(here, 'fx.mjs'), 'utf8'));
  assert(!/^export\s/m.test(src) && !/^import\s/m.test(src), 'no leftover import/export');
  assert(!src.includes('</script'), 'no </script');
  const names = [...src.matchAll(/^(?:async\s+)?(?:function\*?\s+([A-Za-z_$][\w$]*)|(?:const|let|class)\s+([A-Za-z_$][\w$]*))/gm)].map((m) => m[1] || m[2]);
  for (const n of names) assert(/^(FX_|fx|createFX)/.test(n), 'unprefixed top-level name ' + n);
  const game = join(here, '..', 'checkmarch');
  if (existsSync(join(game, 'game.src.html'))) { // read-only clash scan
    const others = ['engine.mjs', 'map.mjs', 'map-render.mjs', 'audio.mjs', 'rival.mjs', 'world.mjs'].filter((f) => existsSync(join(game, f))).map((f) => readFileSync(join(game, f), 'utf8'));
    others.push(readFileSync(join(game, 'game.src.html'), 'utf8'));
    const taken = new Set();
    for (const code of others) for (const m of code.matchAll(/^\s*(?:export\s+)?(?:async\s+)?(?:function\*?\s+([A-Za-z_$][\w$]*)|(?:const|let|class)\s+([A-Za-z_$][\w$]*))/gm)) taken.add(m[1] || m[2]);
    const clash = names.filter((n) => taken.has(n));
    eq(clash.length, 0, 'clashes with game: ' + clash.join(','));
  }
});

console.log('fx-demo.html');

test('demo inline copy is fresh (matches build of fx-demo.src.html + fx.mjs)', () => {
  const cur = readFileSync(join(here, 'fx-demo.html'), 'utf8');
  assert(cur === buildDemo(), 'fx-demo.html is stale: run node build-demo.mjs');
  assert(cur.includes(moduleToScript(readFileSync(join(here, 'fx.mjs'), 'utf8'))), 'contains current fx.mjs');
});

test('demo obeys the artifact page contract', () => {
  const html = readFileSync(join(here, 'fx-demo.html'), 'utf8');
  assert(html.startsWith('<title>Checkmarch FX Demo</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n<style>'), 'title, meta, style first');
  assert(!/<!doctype|<html[\s>]|<head[\s>]|<body[\s>]/i.test(html), 'no document skeleton tags');
  assert(!/\b(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i.test(html) && !/@import|url\(\s*["']?https?:/i.test(html), 'no external resources');
  assert(/:root\s*\{/.test(html), 'tokens on :root');
  assert(/@media \(prefers-color-scheme: dark\) \{ :root:not\(\[data-theme="light"\]\)/.test(html), 'dark media block');
  assert(/:root\[data-theme="dark"\]\s*\{/.test(html), 'forced dark block');
  assert(/color-scheme: dark/.test(html), 'color-scheme dark');
  assert(/body \{ background: var\(--bg\); color: var\(--fg\)/.test(html), 'body bg/fg tokens');
  assert(/padding-left: max\(16px, env\(safe-area-inset-left, 0px\)\)/.test(html), 'side gutter');
  assert(/min-height: 44px/.test(html), '44px buttons');
  assert(!/\balert\(|\bconfirm\(|\bprompt\(/.test(html), 'no alert/confirm/prompt');
  assert(/localStorage/.test(html) === false, 'no storage needed');
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  assert(m, 'inline script');
  const tmp = join(here, '.demo-inline-check.js');
  writeFileSync(tmp, m[1]);
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); } finally { unlinkSync(tmp); }
  for (const fx of ['capture', 'move', 'check', 'promote', 'trait', 'glint', 'mine', 'rival', 'win', 'over', 'stress']) assert(html.includes(`data-fx="${fx}"`), 'button ' + fx);
  assert(html.includes('id="btnMotion"') && html.includes('id="sFps"'), 'motion toggle + FPS readout');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
