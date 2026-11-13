// node test-music.mjs  -> exit 0 when every check passes.
// Pure composition logic (moods, phrases, determinism, voicing, mood mapping) plus the audio graph's code
// paths against a minimal mock AudioContext (no sound in node; this only proves nothing throws and counts nodes).
import assert from 'node:assert/strict';
import {
  MUSIC_MODES, MUSIC_MOODS, MUSIC_LAYERS, MUSIC_STINGS, MUSIC_INTENSITY_MOODS, musicRng, musicDegMidi, musicNearestIdx,
  musicVoicing, musicChordName, musicMoodFor, createMusicComposer, musicStingEvents, createAudio,
} from './audio.mjs';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log('ok   ' + name); } catch (e) { console.error('FAIL ' + name + '\n     ' + (e && e.stack || e)); process.exitCode = 1; }
};
const VOICES = ['lute', 'arp', 'bass', 'drum', 'bell', 'horn', 'heart', 'tick'];
const NAMES = Object.keys(MUSIC_MOODS);
const barSec = (m) => 8 * 60 / MUSIC_MOODS[m].bpm / 2;

test('at least 5 moods, including the required ones', () => {
  assert.ok(NAMES.length >= 5);
  for (const n of ['map', 'forge', 'battle', 'danger', 'boss', 'threat', 'triumph', 'mourning']) assert.ok(MUSIC_MOODS[n], n);
  assert.deepEqual(MUSIC_INTENSITY_MOODS, ['map', 'battle', 'danger', 'boss']);
  MUSIC_INTENSITY_MOODS.forEach((n, i) => assert.equal(MUSIC_MOODS[n].intensity, i));
});

test('mood tables are well formed', () => {
  for (const [n, m] of Object.entries(MUSIC_MOODS)) {
    assert.ok(m.label && m.bpm >= 40 && m.bpm <= 120, n + ' bpm');
    assert.ok(m.barsPerChord >= 1 && m.sections.length >= 1, n);
    for (const k of Object.keys(m.mix)) assert.ok(MUSIC_LAYERS.includes(k), n + ' unknown layer ' + k);
    for (const k of MUSIC_LAYERS) assert.ok(typeof m.mix[k] === 'number' && m.mix[k] >= 0 && m.mix[k] <= 0.6, n + '.' + k);
    for (const s of m.sections) {
      assert.ok(MUSIC_MODES[s.mode], n + ' mode ' + s.mode);
      assert.ok(s.progs.length >= 1);
      for (const p of s.progs) assert.ok(p.length >= 2 && p.every((d) => d >= 0 && d < 7));
    }
    if (m.sting) assert.ok(MUSIC_STINGS[m.sting], n + ' sting');
    if (m.heart) assert.ok(m.mix.heart > 0); if (m.tick) assert.ok(m.mix.tick > 0);
  }
});

test('every chord in every progression is a consonant major or minor triad (no dim/aug)', () => {
  for (const [n, m] of Object.entries(MUSIC_MOODS)) for (const s of m.sections) for (const p of s.progs) for (const d of p) {
    const t = [d, d + 2, d + 4].map((i) => musicDegMidi(s.root, s.mode, i));
    const third = t[1] - t[0], fifth = t[2] - t[0];
    assert.ok((third === 3 || third === 4) && fifth === 7, `${n} ${s.mode} degree ${d}: ${musicChordName(t)}`);
  }
});

test('progressions start on the tonic (modal centre stays clear)', () => {
  for (const [n, m] of Object.entries(MUSIC_MOODS)) for (const s of m.sections) {
    assert.ok(s.progs.filter((p) => p[0] === 0).length >= Math.ceil(s.progs.length / 2), n);
  }
});

test('musicRng is deterministic and in [0,1)', () => {
  const a = musicRng(42), b = musicRng(42), c = musicRng(43);
  const xa = Array.from({ length: 1000 }, a), xb = Array.from({ length: 1000 }, b), xc = Array.from({ length: 1000 }, c);
  assert.deepEqual(xa, xb);
  assert.notDeepEqual(xa, xc);
  assert.ok(xa.every((x) => x >= 0 && x < 1));
  const mean = xa.reduce((s, x) => s + x, 0) / xa.length;
  assert.ok(mean > 0.45 && mean < 0.55);
});

test('scale helpers', () => {
  assert.equal(musicDegMidi(57, 'aeolian', 0), 57);
  assert.equal(musicDegMidi(57, 'aeolian', 7), 69);
  assert.equal(musicDegMidi(57, 'aeolian', -1), 55);
  assert.equal(musicDegMidi(57, 'dorian', 5), 66);
  for (let midi = 40; midi < 90; midi++) {
    const i = musicNearestIdx(57, 'aeolian', midi);
    assert.ok(Math.abs(musicDegMidi(57, 'aeolian', i) - midi) <= 1);
  }
  assert.equal(musicChordName([57, 60, 64]), 'Am');
  assert.equal(musicChordName([53, 57, 60]), 'F');
});

test('voicing stays in range and moves smoothly', () => {
  let prev = null;
  const prog = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62], [57, 60, 64, 71]];
  for (let k = 0; k < 40; k++) {
    const v = musicVoicing(prog[k % prog.length], prev, 52, 71);
    assert.ok(v.every((n) => n >= 52 && n <= 71), String(v));
    assert.deepEqual([...new Set(v.map((n) => n % 12))].sort(), [...new Set(prog[k % prog.length].map((n) => n % 12))].sort());
    if (prev) { const move = v.reduce((a, n) => a + Math.min(...prev.map((p) => Math.abs(p - n))), 0); assert.ok(move <= 8, 'jump ' + move); }
    prev = v;
  }
});

function runBars(seed, plan) {
  const c = createMusicComposer(seed), out = [];
  for (const [mood, n] of plan) for (let i = 0; i < n; i++) out.push(c.nextBar(mood));
  return out;
}

test('composer is deterministic for a seed (and differs across seeds)', () => {
  const plan = [['map', 60], ['battle', 20], ['danger', 6], ['battle', 10], ['triumph', 12], ['map', 30], ['threat', 16], ['mourning', 10], ['forge', 20], ['boss', 20]];
  const a = JSON.stringify(runBars(7, plan)), b = JSON.stringify(runBars(7, plan)), c = JSON.stringify(runBars(8, plan));
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('events are well formed for every mood', () => {
  for (const n of NAMES) {
    for (const seed of [1, 2, 3]) {
      for (const b of runBars(seed, [[n, 80]])) {
        assert.equal(b.mood, n);
        assert.ok(b.chord.tones.length >= 3 && b.chord.bass >= 36 && b.chord.bass < 48 && b.chord.tonic >= 33 && b.chord.tonic < 45);
        for (const e of b.events) {
          assert.ok(Number.isInteger(e.step) && e.step >= 0 && e.step < 8, n + ' step ' + e.step);
          assert.ok(VOICES.includes(e.voice), e.voice);
          assert.ok(e.vel > 0 && e.vel <= 1, n + ' vel ' + e.vel);
          assert.ok(e.len >= 1 && e.len <= 8);
          if (['lute', 'arp', 'bell', 'horn', 'bass'].includes(e.voice)) assert.ok(e.midi >= 36 && e.midi <= 96, n + ' ' + e.voice + ' midi ' + e.midi);
        }
      }
    }
  }
});

test('melody and accompaniment notes stay in the current mode (stings exempt)', () => {
  for (const n of NAMES) {
    const bars = runBars(11, [[n, 200]]);
    bars.forEach((b, i) => {
      if (MUSIC_MOODS[n].sting && i < 2) return;
      const sc = MUSIC_MODES[b.section.mode].map((x) => (b.section.root + x) % 12);
      for (const e of b.events) if (e.voice === 'lute' || e.voice === 'arp') assert.ok(sc.includes(e.midi % 12), `${n} bar ${i} ${e.voice} ${e.midi} not in ${b.section.mode}`);
    });
  }
});

test('lute melody stays inside the mood range', () => {
  for (const n of NAMES) {
    const [lo, hi] = MUSIC_MOODS[n].lute.range;
    runBars(5, [[n, 200]]).forEach((b, i) => {
      if (MUSIC_MOODS[n].sting && i < 2) return;
      for (const e of b.events) if (e.voice === 'lute') assert.ok(e.midi >= lo && e.midi <= hi, n + ' ' + e.midi);
    });
  }
});

test('30+ minutes of map music does not loop obviously', () => {
  const bars = Math.ceil(35 * 60 / barSec('map'));
  const bs = runBars(2024, [['map', bars]]);
  // 4-bar lute phrases: mostly unique
  const phrases = [];
  for (let i = 0; i + 4 <= bs.length; i += 4) phrases.push(bs.slice(i, i + 4).map((b) => b.events.filter((e) => e.voice === 'lute').map((e) => e.step + ':' + e.midi).join(',')).join('|'));
  const voiced = phrases.filter((p) => p.replace(/\|/g, '') !== '');
  const unique = new Set(voiced).size;
  assert.ok(unique / voiced.length > 0.85, `unique phrases ${unique}/${voiced.length}`);
  // all sections (keys/modes) get visited, progression sequence is not a fixed loop
  const secs = new Set(bs.map((b) => b.section.index));
  assert.equal(secs.size, MUSIC_MOODS.map.sections.length);
  const chords = bs.filter((b) => b.chordChange).map((b) => b.chord.name);
  const grams = new Set(); for (let i = 0; i + 8 <= chords.length; i++) grams.add(chords.slice(i, i + 8).join(' '));
  assert.ok(grams.size > 40, '8-chord windows ' + grams.size);
  // rests: some bars have no melody at all, but most do
  const silent = bs.filter((b) => !b.events.some((e) => e.voice === 'lute')).length / bs.length;
  assert.ok(silent > 0.15 && silent < 0.6, 'silent ratio ' + silent.toFixed(2));
  // bells are occasional
  const bells = bs.filter((b) => b.events.some((e) => e.voice === 'bell')).length / bs.length;
  assert.ok(bells > 0.02 && bells < 0.2, 'bell ratio ' + bells.toFixed(3));
});

test('battle moods have drums and bass; calm map has neither', () => {
  for (const n of ['battle', 'danger', 'boss', 'threat']) {
    const ev = runBars(3, [[n, 40]]).flatMap((b) => b.events);
    assert.ok(ev.some((e) => e.voice === 'drum'), n + ' drum');
    assert.ok(ev.some((e) => e.voice === 'bass'), n + ' bass');
  }
  const ev = runBars(3, [['map', 80]]).flatMap((b) => b.events);
  assert.ok(!ev.some((e) => e.voice === 'drum' || e.voice === 'bass' || e.voice === 'heart'));
  const dg = runBars(3, [['danger', 4]]).flatMap((b) => b.events);
  assert.ok(dg.some((e) => e.voice === 'heart') && dg.filter((e) => e.voice === 'tick').length === 32);
});

test('entering triumph/mourning/threat plays its sting first and silences the lute meanwhile', () => {
  for (const n of ['triumph', 'mourning', 'threat']) {
    const bs = runBars(9, [['map', 10], [n, 4]]);
    const b0 = bs[10], b1 = bs[11];
    const sting = musicStingEvents(MUSIC_MOODS[n].sting);
    assert.ok(b0.chordChange && b0.mood === n);
    const first = sting.filter((e) => e.step < 8), second = sting.filter((e) => e.step >= 8);
    for (const e of first) assert.ok(b0.events.some((x) => x.step === e.step && x.voice === e.voice && x.midi === e.midi), n + ' bar0 sting');
    for (const e of second) assert.ok(b1.events.some((x) => x.step === e.step - 8 && x.voice === e.voice && x.midi === e.midi), n + ' bar1 sting');
    // lute notes in those bars come only from the sting itself
    const stingLute = sting.filter((e) => e.voice === 'lute').length;
    assert.equal(b0.events.concat(b1.events).filter((e) => e.voice === 'lute').length, stingLute, n);
  }
});

test('a mood switch takes effect on the very next bar', () => {
  const c = createMusicComposer(1);
  for (let i = 0; i < 5; i++) c.nextBar('map');
  const b = c.nextBar('battle');
  assert.equal(b.mood, 'battle'); assert.ok(b.chordChange); assert.equal(b.bpm, MUSIC_MOODS.battle.bpm);
  assert.equal(c.nextBar('nope').mood, 'map'); // unknown -> map
});

test('musicMoodFor maps game states', () => {
  const T = [
    [{}, 'map'], [undefined, 'map'],
    [{ forge: true }, 'forge'],
    [{ threat: true }, 'threat'], [{ threat: true, forge: true }, 'threat'],
    [{ battle: true }, 'battle'], [{ battle: true, check: true }, 'danger'], [{ battle: true, boss: true, check: true }, 'boss'],
    [{ battle: true, threat: true }, 'battle'],
    [{ result: 'win' }, 'triumph'], [{ result: 'loss' }, 'mourning'], [{ result: 'draw' }, 'map'], [{ result: 'draw', threat: true }, 'threat'],
    [{ runOver: true, battle: true }, 'mourning'], [{ retired: true }, 'triumph'],
  ];
  for (const [c, want] of T) assert.equal(musicMoodFor(c), want, JSON.stringify(c));
  for (const [c] of T) assert.ok(MUSIC_MOODS[musicMoodFor(c)]);
});

// ---------------- audio graph against a mock AudioContext ----------------
function mockContext() {
  const stats = { nodes: 0, osc: 0, started: 0 };
  const param = (v) => ({
    value: v, setValueAtTime(x, t) { chk(x, t); this.value = x; return this; }, linearRampToValueAtTime(x, t) { chk(x, t); return this; },
    exponentialRampToValueAtTime(x, t) { chk(x, t); if (!(x > 0)) throw new Error('exp ramp to ' + x); return this; },
    setTargetAtTime(x, t, tc) { chk(x, t); if (!(tc > 0)) throw new Error('tc'); return this; }, cancelScheduledValues() { return this; },
  });
  const chk = (x, t) => { if (!Number.isFinite(x) || !Number.isFinite(t)) throw new Error('non-finite automation ' + x + ' @ ' + t); };
  const node = (extra) => {
    stats.nodes++;
    return Object.assign({ connect(d) { if (!d) throw new Error('connect to nothing'); return d; }, disconnect() {} }, extra);
  };
  const src = (extra) => node(Object.assign({ start(t) { if (t !== undefined) chk(0, t); stats.started++; }, stop(t) { if (t !== undefined) chk(0, t); } }, extra));
  const ctx = {
    currentTime: 0, sampleRate: 8000, state: 'running', destination: {},
    createGain: () => node({ gain: param(1) }),
    createOscillator: () => { stats.osc++; return src({ type: 'sine', frequency: param(440), detune: param(0) }); },
    createBiquadFilter: () => node({ type: 'lowpass', frequency: param(350), Q: param(1) }),
    createBufferSource: () => src({ buffer: null, loop: false }),
    createConvolver: () => node({ buffer: null }),
    createStereoPanner: () => node({ pan: param(0) }),
    createDynamicsCompressor: () => node({ threshold: param(0), knee: param(0), ratio: param(1), attack: param(0), release: param(0) }),
    createBuffer: (ch, len) => { const d = Array.from({ length: ch }, () => new Float32Array(len)); return { getChannelData: (c) => d[c] }; },
    resume: () => Promise.resolve(), suspend: () => Promise.resolve(),
  };
  return { ctx, stats };
}

test('public API is a superset of the original and is safe without Web Audio', () => {
  const a = createAudio();
  for (const k of ['unlock', 'setEnabled', 'setIntensity', 'play', 'setVolume']) assert.equal(typeof a[k], 'function', k);
  for (const k of ['setMood', 'moodFor', 'sting']) assert.equal(typeof a[k], 'function', k);
  assert.equal(a.unlock(), false); // node: no window.AudioContext
  a.setIntensity(2); a.play('move'); a.setEnabled(false); a.setEnabled(true); a.setVolume({ master: 0.5 }); a.sting('triumph');
  const s = a.state;
  for (const k of ['supported', 'unlocked', 'running', 'enabled', 'intensity']) assert.ok(k in s, k);
  assert.equal(s.supported, false); assert.equal(s.unlocked, false);
  assert.equal(s.intensity, 2); assert.equal(s.mood, 'danger');
  assert.equal(a.setMood('threat'), true); assert.equal(a.state.mood, 'threat'); assert.equal(a.state.intensity, 1);
  assert.equal(a.setMood('nonsense'), false); assert.equal(a.state.mood, 'threat');
  a.setIntensity(0); assert.equal(a.state.mood, 'map');
  a.setIntensity(9); assert.equal(a.state.mood, 'boss'); a.setIntensity(-3); assert.equal(a.state.mood, 'map'); a.setIntensity('x'); assert.equal(a.state.mood, 'map');
  assert.deepEqual(a.moods, NAMES);
  assert.equal(a.moodFor({ battle: true }), 'battle');
});

test('mock context: every mood schedules for 2 minutes without errors, CPU budget per minute is small', () => {
  for (const n of NAMES) {
    const { ctx, stats } = mockContext();
    const a = createAudio({ context: ctx, seed: 5 });
    assert.equal(a.unlock(), true);
    a.setMood(n);
    for (let t = 1; t <= 120; t += 0.5) { ctx.currentTime = t - 0.5; a._scheduleUntil(t); }
    const perMin = stats.osc / 2;
    // roughly: map ~ 100-200 short oscillators/min; nothing should approach thousands
    assert.ok(perMin < 1500, `${n}: ${perMin} oscillators/min`);
    assert.equal(a.state.mood, n);
    assert.ok(a.state.chord);
  }
});

test('mock context: mood hopping, sfx, stings, disable/enable', () => {
  const { ctx } = mockContext();
  const a = createAudio({ context: ctx, seed: 77 });
  a.unlock();
  let t = 0;
  for (let k = 0; k < 60; k++) {
    a.setMood(NAMES[k % NAMES.length]);
    if (k % 7 === 0) a.setIntensity(k % 4);
    for (const ev of ['move', 'capture', 'check', 'promote', 'win', 'lose', 'coin', 'buy', 'raid', 'nope']) a.play(ev);
    a.sting(['triumph', 'mourning', 'threat', 'nope'][k % 4]);
    if (k === 20) a.setEnabled(false);
    if (k === 24) a.setEnabled(true);
    t += 1.7; ctx.currentTime = t; a._scheduleUntil(t + 0.35);
  }
  assert.ok(a.state.enabled);
});

test('setEnabled(false) before unlock is remembered', () => {
  const { ctx, stats } = mockContext();
  const a = createAudio({ context: ctx, enabled: false });
  a.unlock();
  const before = stats.started;
  a.play('move');
  assert.equal(stats.started, before);
  assert.equal(a.state.enabled, false);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
