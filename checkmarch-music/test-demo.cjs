// node test-demo.cjs  -> loads demo.html in headless Chromium, clicks every control, and renders each mood
// offline (OfflineAudioContext) to check levels: no NaN, no clipping, quiet bed. Exit 0 when all pass.
// Run `node build-demo.mjs` first if audio.mjs changed.
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto('file://' + path.join(__dirname, 'demo.html'));
  await page.waitForFunction(() => !!window.__music);

  await page.click('#enable');
  const moods = await page.$$eval('button.mood', (bs) => bs.map((b) => b.dataset.mood));
  for (const m of moods) {
    await page.click(`button.mood[data-mood="${m}"]`);
    await page.waitForTimeout(250);
    const st = await page.evaluate(() => window.__music.audio.state.mood);
    if (st !== m) errors.push(`mood button ${m} -> state ${st}`);
  }
  for (const b of await page.$$('#stings button, #sfx button')) { await b.click(); await page.waitForTimeout(60); }
  for (const v of ['3', '2', '1', '0']) await page.fill('#intensity', v).catch(() => {});
  await page.evaluate(() => { const r = document.getElementById('intensity'); r.value = '3'; r.dispatchEvent(new Event('input')); });
  const s3 = await page.evaluate(() => window.__music.audio.state);
  if (s3.mood !== 'boss' || s3.intensity !== 3) errors.push('intensity 3 -> ' + JSON.stringify(s3));
  // tab hide / show must not throw
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(400);
  await page.click('#enable'); // mute
  const off = await page.evaluate(() => window.__music.audio.state.enabled);
  if (off !== false) errors.push('mute did not disable');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (overflow) errors.push('horizontal overflow at 390px');

  // Offline render: 24 s per mood at master defaults, measure peak and RMS after the 2 s fade-in.
  const levels = await page.evaluate(async () => {
    const out = {};
    for (const name of Object.keys(window.__music.MUSIC_MOODS)) {
      const sr = 22050, secs = 24, off = new OfflineAudioContext(2, sr * secs, sr);
      const a = window.__music.createAudio({ context: off, seed: 1234, mood: name });
      a.unlock();
      a._scheduleUntil(secs);
      const buf = await off.startRendering();
      let peak = 0, sum = 0, n = 0, bad = 0;
      for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        for (let i = sr * 2; i < d.length; i++) { const x = d[i]; if (!Number.isFinite(x)) { bad++; continue; } const ax = Math.abs(x); if (ax > peak) peak = ax; sum += x * x; n++; }
      }
      out[name] = { peak: +peak.toFixed(3), rms: +Math.sqrt(sum / n).toFixed(4), bad };
    }
    return out;
  });
  for (const [m, l] of Object.entries(levels)) {
    console.log(`  ${m.padEnd(9)} peak ${l.peak.toFixed(3)}  rms ${l.rms.toFixed(4)}`);
    if (l.bad) errors.push(m + ': non-finite samples');
    if (l.peak > 0.5) errors.push(m + ': too loud, peak ' + l.peak);
    if (l.rms < 0.002) errors.push(m + ': near silent, rms ' + l.rms);
  }
  await browser.close();
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  console.log(`ok demo: ${moods.length} moods clicked, stings + sfx triggered, no page errors; offline levels in bounds`);
})().catch((e) => { console.error(e); process.exit(1); });
