# Wiring the music expansion into Checkmarch

You need three edits in `game.src.html` and one file copy. I applied exactly these edits to a scratch copy of the current game. It built cleanly (clash check and `node --check` passed) and ran headless with no page errors: the map played `map`, the Forge tab switched to `forge`, and Shop switched back to `map`.

## 0. Copy the module
`audio.mjs` here is a drop-in replacement. The game keeps its existing calls (`createAudio`, `unlock`, `setEnabled`, `setIntensity`, `play`, `state`), and they behave as before.

**Watch out: the freshness test.** `checkmarch/test-world.mjs` checks that `checkmarch/audio.mjs` is byte-identical to `../checkmarch-audio/audio.mjs`. Pick one of these:
- copy this `audio.mjs` into **both** `checkmarch-audio/` and `checkmarch/`, or
- point that test entry at `../checkmarch-music/audio.mjs`. The comment in `build.mjs` line 4 names the source folder too.

## 1. Replace `updateMood()` (game.src.html, under "sound")
```diff
-// bed intensity: 0 map, 1 battle, 2 a king in check, 3 citadel
-function updateMood() {
-  let i = 0;
-  if (battle && !battle.over) i = battle.node.type === 'citadel' || battle.node.kind === 'keep' ? 3 : inCheck(battle.pos) ? 2 : 1;
-  audio.setIntensity(i);
-}
+// music mood (checkmarch-music/INTEGRATION.md): pick a named mood from the game state; repeat calls are free
+function updateMood() {
+  const r = run(), b = battle && !battle.over ? battle : null, s = ui.result, e = ui.ended;
+  audio.setMood(audio.moodFor({
+    runOver: !!e && e.kind !== 'abdicate',
+    retired: !!e && e.kind === 'abdicate',
+    battle: !!b,
+    boss: !!b && (b.node.type === 'citadel' || b.node.kind === 'keep'),
+    check: !!b && inCheck(b.pos),
+    result: !b && s ? (s.cache || s.result === 'win' || s.kept ? 'win' : s.result === 'draw' ? 'draw' : 'loss') : null,
+    threat: !!(r.map.raid.pending || rivalPending(r)),
+    forge: ui.tab === 'forge',
+  }));
+}
```

## 2. Re-evaluate the mood when the tab changes (bindUi click handler)
```diff
-    const tb = e.target.closest('[data-tab]'); if (tb) { ui.tab = tb.dataset.tab; ui.armed = null; renderPanel(); }
+    const tb = e.target.closest('[data-tab]'); if (tb) { ui.tab = tb.dataset.tab; ui.armed = null; renderPanel(); updateMood(); }
```

## 3. Re-evaluate once a second in the income `tick()`
This catches raids or rival attacks that appear during ambient ticks without a `renderAll`. It is cheap, because a repeat `setMood` with the same mood does nothing.
```diff
   updateRivalEta();
   renderTop();
+  updateMood();
```

## The mapping (first match wins; see `musicMoodFor` in audio.mjs)
| priority | game state | input flag | mood |
|---|---|---|---|
| 1 | run-over screen (`ui.ended`, kind `mate` / `keep`) | `runOver` | `mourning` |
| 2 | abdicated (`ui.ended.kind === 'abdicate'`) | `retired` | `triumph` |
| 3 | battle running, citadel or keep | `battle` + `boss` | `boss` (was intensity 3) |
| 4 | battle running, a king in check | `battle` + `check` | `danger` (was 2) |
| 5 | battle running (including raid defence and border fights) | `battle` | `battle` (was 1) |
| 6 | result card: win, raid repelled, rival withdrew (`kept`), supply cache taken, region cleared | `result: 'win'` | `triumph` |
| 7 | result card: defeat, retreat, mine or node lost | `result: 'loss'` | `mourning` |
| 8 | raid or rival attack waiting for orders (`map.raid.pending` / `rivalPending`) | `threat` | `threat` |
| 9 | Forge tab open | `forge` | `forge` |
| 10 | everything else (map, march, draw card, shop, army, run tabs) | none | `map` |

The `win`/`lose` sfx still play from `endBattle` as before. The `triumph` fanfare is in the same A major as `win`, and both duck the bed. If the pair sounds too busy by ear, change `MUSIC_MOODS.triumph.sting` to `null`. Doing so keeps the mood but drops the fanfare.

## Things to watch
- **Mood switches are quantised to the bar.** The new harmony and tempo arrive within one bar (about 2.5 s in battle, 3.3 s on the map, 4.3 s in mourning). The layer crossfade starts at once.
- **`setIntensity` and `setMood` share one state**, and the last call wins. Do not keep an old `audio.setIntensity(...)` call anywhere else, or it will flip the mood back.
- **The `threat` trigger.** Do not use `run().map.contact`. Once set, it stays true for the whole region, which would make `threat` permanent. The pending raid or attack is the right trigger.
- **Mourning on a lost battle.** It is short-lived because it lasts only while the result card is up. If it feels too heavy for an ordinary retreat, map `'loss'` to `null` for non-`runOver` cases. The card then plays `map`.
- **Optional: `audio.sting('triumph')`** marks moments that show no result card, such as a node captured on the map by a marching garrison. It does not change the mood.
- **Level tuning.** Change each mood's `mix` row in `MUSIC_MOODS`. All values are already conservative (≤ 0.55 per layer, bed 0.5, master 0.8), measured at or below the old bed's loudness.
- **The seed.** It is random per page load by default. Pass `createAudio({ seed: <any save-stable number> })` if you want the same soundtrack per save.
