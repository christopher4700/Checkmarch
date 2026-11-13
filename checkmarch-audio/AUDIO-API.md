# Checkmarch audio API

`audio.mjs` exports one function, `createAudio()`. It uses only Web Audio, loads no files and has no dependencies. It is about 20 KB of source.

## Inlining into game.html
1. Paste the whole of `audio.mjs` into the game's `<script>`, and change `export function createAudio` to `function createAudio`. `build-demo.mjs` does the same thing for the demo page.
2. Create one instance at boot: `const audio = createAudio();`. This does nothing audible and creates no AudioContext.
3. Call `audio.unlock()` inside the first real user gesture, such as a pointerup or click handler (Start button, first board tap). It can be called again on later gestures at no cost, and doing so also fixes iOS "interrupted" contexts. A good pattern is
   `document.addEventListener('pointerup', () => audio.unlock(), { once: false })`
   or calling it from the sound toggle.
4. No call throws. Before `unlock()`, while disabled, or when Web Audio is missing, every call quietly does nothing.

## API
| call | effect |
|---|---|
| `createAudio(opts?)` | `opts`: `{ enabled=true, master=0.8, bed=0.5, sfx=0.35 }` (all 0..1). Returns the object below. |
| `unlock() -> bool` | Creates or resumes the AudioContext and builds the graph on the first call. If enabled, it fades the ambient bed in and starts its scheduler. Returns false if Web Audio is unavailable. **Must run in a user gesture.** |
| `setEnabled(bool)` | `false` fades out over about 0.3 s, stops the scheduler and suspends the context, so it uses no CPU or battery. `true` resumes. The value is remembered when set before `unlock()`. Persist the user's choice yourself, for example in the save. |
| `setIntensity(0..3)` | Crossfades the bed's layers smoothly over about 3 s. Values are clamped and rounded. 0 = map idle, 1 = battle, 2 = check/danger, 3 = citadel boss. You can call it every frame; repeat calls with the same value do nothing. |
| `play(event)` | One-shot: `'move' 'capture' 'check' 'promote' 'win' 'lose' 'coin' 'buy' 'raid'`. Unknown names are ignored. Each event has a built-in rate limit (for example coin 35 ms, raid 2.5 s, win/lose 1.5 s), so spamming it is safe. |
| `setVolume({master?, bed?, sfx?})` | Optional mix trims (0..1). |
| `state` (getter) | `{ supported, unlocked, running, enabled, intensity }`, which can drive a mute icon. |

The tab-visibility handling is built in. When the page is hidden the module suspends the context and the scheduler, and it resumes them when the page is visible again, if sound is enabled.

## Suggested game wiring
- Map/road screen: `setIntensity(0)`. Battle start: `1`. While either king is in check: `2`, then back to `1` once the check clears. Citadel battle: `3` for the whole fight. Battle over: `0`.
- `play('move')` on every normal move and `play('capture')` instead of it on captures. Use `play('check')` when a move gives check; it can follow the move or capture sound in the same frame. Call `promote` on promotion, and `win`/`lose` on the battle result (`lose` also on run-over mate).
- `coin` for loot ticks and mine income pops (it is rate-limited, so a counter animation can call it each tick). `buy` on any shop purchase. `raid` is an alarm for rare danger events only; use it sparingly.
- `win`, `lose` and `raid` briefly duck the bed so they read clearly.

## How the bed works
- The key is A minor at 72 BPM, scheduled on eighth notes with a 0.35 s look-ahead from a 60 ms `setInterval`. Each chord lasts 16 steps (about 6.7 s).
- At intensity 0–1 the chords cycle Am(add9), Fmaj7, C6/9, G. At intensity 2 or higher the next chord change switches to Am, F, Dm, E7 (the harmonic-minor dominant, which sounds tense).
- Every layer has its own gain bus feeding `bed`, then `duck`, then `master`, then a `DynamicsCompressor` (-18 dB, 4:1), then the speakers. A generated convolver reverb is shared by the pad, plucks, drums and the bright one-shots.
- The table shows each layer's gain at each intensity.

| layer | sound | 0 | 1 | 2 | 3 |
|---|---|---|---|---|---|
| pad | detuned saw+triangle per chord tone, lowpass (cutoff rises with intensity), 2.4 s attack, plus a sine sub | .55 | .50 | .48 | .48 |
| ocean | looped pink noise, lowpass, slow swell, cutoff and pan LFOs | .40 | .28 | .22 | .18 |
| pluck | triangle pluck motif (16-step pattern on chord tones, played with some probability); at 3 it fills the rests with an arpeggio | .28 | .32 | .32 | .36 |
| bass | soft triangle+sine on steps 0/3/6 of each bar | 0 | .42 | .45 | .50 |
| heart | "lub-dub" sine pitch-drop once per bar | 0 | 0 | .55 | .35 |
| tick | highpassed noise clock tick each eighth | 0 | 0 | .30 | .25 |
| drum | taiko-style sine-drop toms with a noise attack | 0 | 0 | 0 | .55 |
| drone | persistent lowpassed saws (root, fifth, octave), retuned on each chord | 0 | 0 | .10 | .26 |

- The module does not schedule notes for a layer that has been silent for more than about 6 s, so a quiet layer costs nothing.

## Known limits
- The sound has not been heard. Only syntax and code paths were tested, with `node --check` and a mock AudioContext. The levels and timbres need a listening pass on a real phone. The values to tune are the `MIX` table, `PAD_CUTOFF`, and the `vol` defaults.
- The scheduler uses `setInterval`. If the main thread stalls for more than about 300 ms, a note can be late; the scheduler then resyncs instead of bursting.
- `promote` and `win` briefly route the whole sfx bus into the reverb, so any other one-shot played in that window also gets reverb. This is harmless.
