# Checkmarch audio API (music expansion)

`audio.mjs` exports `createAudio()` plus a small set of pure composition helpers. It uses only Web Audio, loads no files and has no dependencies (about 45 KB of source). Every call that worked before still works the same way. The music expansion only adds API.

## Inlining into game.html
1. Inline `audio.mjs` the same way as before. The game's `build.mjs` already strips `export` from every top-level `function`/`const`, and so does `build-demo.mjs`. Every new top-level name starts with `music`/`MUSIC_` (for example `MUSIC_MOODS` or `createMusicComposer`), so it does not clash with the other modules. A dry-run game build with this file passes the clash check and `node --check`.
2. Create one instance at boot: `const audio = createAudio();`. This makes no sound and creates no AudioContext.
3. Call `audio.unlock()` inside the first real user gesture. The current wiring (`pointerup`, which is idempotent) is fine.
4. No call throws. Before `unlock()`, while disabled, or when Web Audio is missing, every call quietly does nothing. `setMood`/`setIntensity` still record the mood, so the right music starts on unlock.

## API
| call | effect |
|---|---|
| `createAudio(opts?)` | `opts`: `{ enabled=true, master=0.8, bed=0.5, sfx=0.35, mood='map', seed=random }`. `seed` makes the soundtrack reproducible. |
| `unlock() -> bool` | Unchanged. It creates or resumes the context inside a gesture, fades the bed in and starts the scheduler. |
| `setEnabled(bool)` | Unchanged. `false` fades out, stops the scheduler and suspends the context. |
| `setIntensity(0..3)` | **Kept for compatibility.** It is now shorthand for `setMood(['map','battle','danger','boss'][n])`. Values are clamped and rounded. |
| **`setMood(name) -> bool`** | New. It switches to a named mood (table below). The layer mix crossfades straight away (time constant 1.2 s). Harmony, tempo and patterns change at the next bar line, which comes within 2.5–4.3 s. Unknown names are ignored and return `false`. A repeat call with the current mood does nothing, so it is safe to call every frame. Whichever of `setMood`/`setIntensity` was called last wins. |
| **`moodFor(ctx) -> name`** | New. A pure helper that maps game state to a mood (rules below). It is the same function as the exported `musicMoodFor`. |
| **`sting(name)`** | New. It plays a short phrase (`'triumph'`, `'mourning'` or `'threat'`) on the music bus without changing the mood. It is rate-limited to once per 4 s per name. Optional: entering those moods already plays their sting. |
| **`moods`** (getter) | New. The list of mood names. |
| `play(event)` | Unchanged sfx: `'move' 'capture' 'check' 'promote' 'win' 'lose' 'coin' 'buy' 'raid'`, all rate-limited. |
| `setVolume({master?, bed?, sfx?})` | Unchanged. The music is the "bed". |
| `state` (getter) | `{ supported, unlocked, running, enabled, intensity, mood, chord, section }`. `intensity` is the mood's legacy 0..3 level. `chord`/`section` are for debugging (for example `"Am"`, `"dorian"`). |
| `_scheduleUntil(t)` | Test hook only, used with `opts.context` (an OfflineAudioContext). Do not use it in the game. |

The tab-visibility handling is unchanged. A hidden page suspends the context and the scheduler, and a visible page resumes them if sound is enabled. Because the composer is driven bar by bar from the scheduler, a resumed tab picks up mid-phrase with no burst of late notes.

## Moods
| mood | game state | key / mode (it drifts between sections) | tempo | character |
|---|---|---|---|---|
| `map` (default) | open map, idle, marching | A aeolian → D dorian → A dorian → C ionian | 72, chord every 2 bars | soft pad, wind, sparse lute melody with frequent rests, occasional distant bell, faint drone. No drums or bass. |
| `forge` | Forge tab open on the map ("home") | C ionian, G mixolydian, D dorian | 80 | warmer major: lute arpeggios, light tabor, soft bass, high anvil-like bell tinks. |
| `battle` | a battle is running (= intensity 1) | A aeolian, D dorian | 88, chord every bar | busier lute melody, bass, hand-drum patterns with fills. |
| `danger` | a king is in check (= intensity 2) | A harmonic minor (E major dominant) | 92 | adds the heartbeat and clock tick, sparser drum, more drone. |
| `boss` | citadel / keep battle (= intensity 3) | A harmonic minor, A phrygian (Bb) | 96 | full drums with fills, low horn chords on chord changes, strongest drone. |
| `threat` | raid or rival attack waiting for orders | E phrygian, A aeolian | 66 | slow and low: distant war drum, two-note horn calls on the fifth, dark lute. On entry: a horn call sting. |
| `triumph` | win result card (node taken, raid repelled, region cleared, supply cache), abdication | A ionian, A mixolydian | 76 | On entry: an A major horn fanfare with bells (same key as the `win` sfx). After 8 bars it settles: drums thin out and the arpeggio density drops. |
| `mourning` | run-over screen; lost-battle result card | D aeolian, A aeolian | 56 | On entry: two low bell tolls and a falling lute sigh. Then a slow pad, sparse lute, low tolls, no drums. |

### Variety inside a track
- **Sections.** Each mood has 1–4 key/mode sections. It moves to a different one every 16–40 bars, and only at the end of a progression.
- **Progressions.** Each section has 2–5 progressions. After each pass there is a 45 % chance of switching progression. Every chord is a consonant major or minor triad (a test enforces this), and calm moods sometimes add a 9th or 7th. Pad voicings use smallest-motion voice leading.
- **Melody.** It works in 4-bar phrases: motif, variant, variant, cadence. Variants are invert, retrograde, new rhythm on the same contour, or a scale shift. A new motif is drawn 25–40 % of the time. Notes are snapped to chord tones on strong beats and stay in the mood's range and mode. A test checks both.
- **Rests.** Whole phrases go silent with some probability (map: about a third of bars have no melody). There are also "breath" phrases where only the pad, drone and wind play, and dropped notes inside phrases.
- **Measured result.** Over 35 simulated minutes of `map` (630 bars), about 99 % of the voiced 4-bar phrases are unique, all 4 sections are visited, and there are more than 40 distinct 8-chord windows.
- **Determinism.** A given `seed` and sequence of moods gives the same notes. Timbral jitter (detune, noise) still uses `Math.random`.

### Instruments (all oscillators + filters)
| layer | sound |
|---|---|
| pad | one saw or triangle per chord tone (alternating, detuned ±7 cents) plus a sine sub, through a shared lowpass. The cutoff is set per mood (700–1700 Hz). |
| lute / arp | a lute-ish pluck: saw + triangle through a lowpass that closes fast (about 6×f0 down to 1.3×f0 in 0.28 s). The arp is darker. |
| bass | triangle + sine, lowpass at 480 Hz |
| drum | hand drum / tabor: "dum" (sine 112 → 62 Hz) and "tek" (bandpassed noise rim) |
| bell | sine partials at 1, 2.76 and 5.4, with a long decay and heavy reverb send. High = distant bell; low = toll. |
| horn | saw + triangle through a dark lowpass with a 0.12 s attack |
| drone | persistent bourdon: 2 saws + 1 triangle on the tonic, fifth and octave. It is lowpassed and retuned only when the key moves. |
| ocean | looped pink noise "wind", with LFOs on cutoff, swell and pan |
| heart / tick | the same as before (danger and boss only) |

There are no square waves. Every saw goes through a lowpass.

## Levels and CPU
- Offline renders in Chromium (24 s per mood, default volumes, seed 1234) gave these levels.

  | mood | peak | RMS |
  |---|---|---|
  | map | 0.18 | 0.034 |
  | forge | 0.15 | 0.025 |
  | battle | 0.25 | 0.035 |
  | danger | 0.26 | 0.046 |
  | boss | 0.34 | 0.063 |
  | threat | 0.24 | 0.054 |
  | triumph | 0.17 | 0.029 |
  | mourning | 0.20 | 0.045 |

- For comparison, the previous bed measured map 0.20 / 0.040 and citadel 0.41 / 0.066, so the new music is at or below the old loudness.
- The graph is built once and reused: 11 layer gain buses, 1 convolver, the wind loop and 3 drone oscillators. Notes are short-lived oscillator→gain(→filter) chains that stop themselves.
- At most about 4 notes per eighth step in `boss`. `map` averages about 2.5 events per bar. Each pad chord uses 5 oscillators, and the previous chord is released through its own gain node.
- A layer whose mood gain is 0 schedules nothing after about 6 s.

## Pure exports (for tests and tools)
- `MUSIC_MOODS`, `MUSIC_MODES`, `MUSIC_LAYERS`, `MUSIC_STINGS` and `MUSIC_INTENSITY_MOODS` are the tables.
- `createMusicComposer(seed).nextBar(mood)` returns `{ mood, bpm, chordChange, chordBars, chord:{name,bass,tones,tonic}, section, events:[{step 0..7, voice, midi, vel, len}] }`.
- The helpers are `musicMoodFor(ctx)`, `musicRng(seed)`, `musicVoicing(notes, prev, lo, hi)`, `musicDegMidi`, `musicNearestIdx`, `musicChordName` and `musicStingEvents(name)`.

## Known limits
- The music has not been heard by a person. The checks so far are unit tests, a mock-context run, and offline level and NaN checks in Chromium. Tune these by ear on a real phone: each mood's `mix`, `padCutoff`, `bpm`, `lute.rest`, and the `vol` defaults.
- A mood switch changes harmony only at the next bar line, which can take up to about 4.3 s in `mourning` and about 2.7 s in battle moods. The layer crossfade starts at once, so a battle starting is felt immediately.
- `promote` and `win` briefly route the whole sfx bus into the reverb (as before). This is harmless.
