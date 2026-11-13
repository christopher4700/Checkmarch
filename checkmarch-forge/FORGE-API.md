# Checkmarch Forge — API and integration notes

`forge.mjs` is a pure ES module: no DOM, no `Date.now()`, no `Math.random()`. Time comes in as `now` (ms since
epoch) and randomness as an injected `rng()` returning a number in [0,1). The state is plain JSON. No function
changes the state you pass in. Each one returns a new state.

Files: `forge.mjs` (the module), `test-forge.mjs` (`node test-forge.mjs`), `forge-demo.src.html`, `build-demo.mjs`
(`node build-demo.mjs` inlines forge.mjs into `forge-demo.html`; a test fails if the two drift), `forge-demo.html`.

## Tuning (constants exported)

| What | Value |
|---|---|
| Materials (tier 0..3) | wood, iron, steel, obsidian |
| Resources, units/hour per mine | tin 8, coal 8, iron ore 7, obsidian shards 6 (`RATES`) |
| Stockpile cap | 24h of output per resource (`RATES[r] * 24 * max(1, minesOfR)`) |
| Offline cap | any single gap between ticks is capped at 8h (`OFFLINE_CAP_MS`) |
| Recipes (`RECIPES`) | iron bar = 3 tin + 2 coal; steel bar = 3 iron ore + 3 coal; obsidian bar = 4 shards |
| Smelts per day | 1 + `smelt.level` (level 0..3, so at most 4/day); suggested gold price `smeltLevelPrice(l)` = 500·3^l |
| Counter chance | 0.25, only when the target is exactly one tier above the attacker |
| Eval bonus | +15 cp per tier: wood 0, iron 15, steel 30, obsidian 45 |

With one mine of each type: an iron bar's ore takes about 23 min, a steel bar's about 26 min and an obsidian bar's
about 40 min. So the daily smelt cap is the real limit, and the mines decide which kind of bar you can make.

## Time model
- **Trickle is exact.** Each resource keeps `frac`, a whole-number remainder counted in 1/3,600,000 of a unit. One
  tick over 2h gives exactly the same state as 7200 one-second ticks (tested).
- **Clock going back:** `lastTs` never decreases. A tick with `now <= lastTs` gives nothing, and earning resumes once
  the clock passes `lastTs` again. Winding the clock back and forward gains nothing.
- **Daily cap uses UTC calendar days:** `day = floor(now / 86_400_000)`, and the cap resets at 00:00 UTC
  (`nextResetAt(now)`). UTC has no DST, so a day is always exactly 24h. Downside: for a player in UTC-5 the reset
  lands at 19:00 local. If that matters, switch to a rolling 24h window in `rollDay`.

## API

```js
createForge(now) -> state
loadForge(raw, now) -> state                 // sanitize a save (or null) into a valid state
tickForge(state, heldMines:[{id, resource}], now) -> state   // resource in 'tin'|'coal'|'iron'|'shards'; dup ids count once
mineCounts(heldMines), ratePerHour(heldMines), stockCap(resource, count), stockFraction(state, resource)

canSmelt(state, recipe, now) -> {ok, reason?}
smelt(state, recipe, now) -> {state, ok, reason?}   // recipe 'iron'|'steel'|'obsidian'
   reasons: 'unknown-recipe' | 'daily-cap' | 'missing-<resource>'  (a failure consumes nothing)
smeltsPerDay(state), smeltsLeft(state, now), nextResetAt(now)
upgradeSmeltCap(state) -> {state, ok, reason?}      // forge does not charge gold; the caller does

materialOf(state, pieceId) -> material              // absent = 'wood'
applyBar(state, pieceId, currentMaterial?) -> {ok, newMaterial, state, reason?}
   one tier only; consumes the bar named after the NEW material (wood->iron uses an iron bar)
   reasons: 'max-tier' | 'no-<material>-bar' | 'material-mismatch' (caller disagrees with the forge's record)
losePiece(state, pieceId) -> {state, lostBars:[...]}   // perma-death: record removed, bars counted in state.lost
barsInvested(material) -> ['iron','steel',...]

counterCheck(attackerMaterial, targetMaterial, rng) -> {fails, chance, roll}
   chance 0.25 and one rng() call ONLY when target tier == attacker tier + 1; otherwise {false, 0, null}, no rng call.
   `roll` is returned so the UI can announce it ("roll 0.14 < 0.25: the capture fails").
captureFallback(move, boardN=8, blockedFn?) -> landing square
   move = {from, to, piece}; from/to are engine square indices (sq = rank*boardN + file) or [file, rank] pairs
   (the result uses the same form); piece 'P'|'N'|'B'|'R'|'Q'|'K' or engine type 1..6.
   B/R/Q: last free square before the target along the ray (an adjacent capture returns the origin).
   N/P/K, or geometry that is not a slide: the origin.
evalBonus(material) -> centipawns
mulberry32(seed) -> rng      // same algorithm as engine.mjs `mulberry`
```

## Integration

### world.mjs / game tick
- Keep it in the save as `state.run.forge` (it is lost with the run, like the roster) or as `state.forge` (kept across
  runs). We suggest **run-scoped** `run.forge` plus the material stored on the roster.
- Mines need a resource. Add `resource` to mine nodes in map generation, chosen by seed and weighted by region:
  tin and coal from region 1, iron ore from region 2, shards from region 3 or later. Then
  `heldMines(run).map(id => ({ id, resource: reg.nodes[id].resource }))`.
- Call `run.forge = tickForge(run.forge, held, Date.now())` in the 1s `tick()` in game.src.html, and once at boot.
  The forge's 8h cap handles offline time by itself. Do not pass it through `accrue`'s `dt < 60000` guard.
  Call tickForge **before** you change which mines are held (capture, raid loss, `loseMine`), so time already passed
  is paid at the old rates.
- Raids: losing a mine stops that resource from earning. Stock is kept even if it is now over the new cap. It just
  stops growing.

### Roster and perma-death
- Roster entries keep their own `id`. The material lives in `forge.mats[id]`. Mirror it to `roster[i].mat` only if
  rendering needs it, and treat forge as the source of truth.
- Battle end, for each captured roster piece: `run.forge = losePiece(run.forge, id).state`, and show "lost N bars".
- Promotion: a promoted pawn keeps its id, so it keeps its material.

### Battle engine (engine.mjs)
- Board state needs a material per square. Use a parallel `Int8Array(64)` `pos.m` of tiers. Move it in `makeMove`
  and `unmakeMove` alongside `pos.b`, and set the enemy garrison's tiers from formation data (higher tiers deeper in
  the run).
- **When a capture resolves**, in the battle step, not inside search:
  `const r = counterCheck(MATERIALS[pos.m[from]], MATERIALS[pos.m[to]], battleRng)`. If `r.fails`, the move becomes
  "attacker moves to `captureFallback({from, to, piece}, 8)`, nothing is captured, side to move flips". Announce it
  with the roll (a log line plus a short shake on the target).
  Use a seeded `battleRng = mulberry32(hash3(battleSeed, ply, 0))` so replays and hot-reload snapshots repeat the
  same rolls.
- **Check rule. Needs a decision; we recommend this one:** if the capture is the mover's only way out of check, or
  the fallback square would leave the mover's king in check, do **not** roll. The capture always lands. Otherwise a
  failed roll could leave a king in check after the move, which is an illegal position. Pins are safe: a pinned
  slider moves along its pin ray, so it stays on it. Promotion captures by a pawn that fail leave the pawn on its
  origin square, unpromoted.
- Search: keep search deterministic and treat counter captures as successful. In move ordering, scale the victim's
  value by 0.75 for such captures. Optionally take `0.25 * victimValue` off in quiescence/SEE. Adding chance nodes
  to search is not worth it at these depths.
- Eval: `score += evalBonus(material)` per piece, signed by colour. The +15 cp per tier keeps the engine from giving
  up an obsidian knight for a wood one, without changing the piece's material value.

### Save format (new fields)
```
run.forge = {
  v: 1, lastTs: <ms>,
  stock: {tin, coal, iron, shards},      // whole units
  frac:  {tin, coal, iron, shards},      // remainder in 1/3_600_000 unit
  bars:  {iron, steel, obsidian},
  smelt: {day: <UTC day index>, used, level},
  mats:  {<pieceId>: 'iron'|'steel'|'obsidian'},
  lost:  {iron, steel, obsidian}         // lifetime stat
}
map node: resource: 'tin'|'coal'|'iron'|'shards'   (mine nodes only)
```
Load it with `loadForge(saved.run.forge, Date.now())`. That also covers saves made before the forge existed (→ fresh
forge).

## Known gaps
- The check rule above is a recommendation and is not built. The battle engine must enforce it.
- There is no gold cost inside the forge (`smeltLevelPrice` is only a suggestion). The economy has not been
  balanced against bars.
- Enemy garrisons have no material yet. Their tier schedule is still to be designed.
- With UTC days the reset time varies by local time zone (see Time model).
