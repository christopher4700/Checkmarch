# Checkmarch living rival: API

A rival lord starts at the region's east keep (the map's citadel node, `region.citadelId`) and plays
the player's game back at them. It takes neutral nodes, prefers mines, then towns, then the road
toward the player keep. It grows an army over time, faster while it holds mines. Where the frontiers
meet, it starts border battles, which the game resolves. Whoever takes the other side's keep wins the
region.

| File | Role |
|---|---|
| `rival.mjs` | Pure module. No DOM, no imports, no `Math.random`, no `Date`. The state is plain JSON. |
| `test-rival.mjs` | `node test-rival.mjs`, 14 tests. It also checks that the demo is fresh and passes `node --check`. |
| `rival-demo.src.html` + `build-demo.mjs` | `node build-demo.mjs` inlines `map.mjs`, `map-render.mjs` and `rival.mjs` and writes `rival-demo.html`. |
| `map.mjs`, `map-render.mjs` | Byte-identical copies from `/home/user/checkmarch-map`, used by the tests and the demo. |

Inlining: same as the map modules. Delete `import` lines and strip `export `. `moduleToScript()` in
`build-demo.mjs` does both. Top-level names are the API names below plus `RIVAL_*` / `rival*`
private helpers. There are no clashes with `map.mjs`, `engine.mjs` or `world.mjs` names. The output
contains no `</script`.

## State

`createRival` returns a plain object. Save it as it is (for example as `run.map.rival`).

```
RivalState = {
  v: 1, seed, regionNumber, eloBase, nodeCount, seat /* citadelId */, playerKeep /* keepId */,
  status: 'active' | 'won' /* took the player keep */ | 'defeated' /* lost its seat */,
  held: id[]            // sorted; starts [citadelId]
  ms, frac              // rival clock: integer ms plus a sub-ms carry
  mineMs                // integral of (mines held x ms), for growth
  moves, captures, sorties, borderWins, borderLosses, lost,
  nextMoveAt: ms|null   // null while a battle is pending or the rival is done
  pending: null | { type: 'borderBattle'|'keepAssault', nodeId, at /* ms */ },
  cooldown: { [nodeId]: untilMs },   // nodes the rival may not attack yet
  handover: id|null,    // node the rival just won; the game must remove it from player held
  strength, dwellings   // derived, refreshed on every call
}
```

## Functions

### `createRival(region, { regionNumber?, eloBase?, seed? }) -> RivalState`
`region` comes from `generateRegion`. `seed` defaults to `region.seed`, `regionNumber` to
`region.regionNumber`, and `eloBase` to 800. The first move is scheduled at 90 s ± 8%.

### `advanceRival(state, region, playerHeld, dtSeconds, now?, opts?) -> { state, events }`
- Immutable: the input state is not changed.
- `playerHeld`: a Set or array of player node ids. The game is authoritative. Any rival node that
  appears in `playerHeld` leaves rival territory at the start of the call, because the player took it.
  The exception is `state.handover`. If `playerHeld` contains the seat, `status` becomes `'defeated'`.
- `now` (optional): wall-clock ms at the end of this advance. Events then also carry
  `wall = now - (end - event time)`. `now` may also be the options object.
- `opts.online`: `true` for live ticks, `false` for offline catch-up. When it is omitted, the call
  counts as online if `dtSeconds <= 30`.
- Deterministic. One call with dt = N gives exactly the same state and events (except `wall`) as N
  calls with dt = 1, given the same `playerHeld` and the same `online` flag. The tests check this for
  8 h of 1 s ticks. Time is kept in integer ms, and the fractional part of dt is carried in `frac`.

Each move, at `nextMoveAt`, the rival scores every node next to its territory and takes the best one:

| Target | Score | Result |
|---|---|---|
| neutral node | type + 50 − 10·dist (+0..9 jitter) | `capture`: the node joins rival territory |
| player-held node (not keep, not on cooldown) | type − 10·dist | `borderBattle`: pending, the rival pauses |
| player keep (online only, ≥ 5 rival nodes, not on cooldown) | 140 − 10 | `keepAssault`: pending, the rival pauses |
| nothing allowed | — | `sortie`: it drills at its westernmost node (+0.25 xp) |

Type scores are mine 300, town 200, shrine 100 and garrison 0. `dist` is the road distance from
the player keep, `node.dist`. So the rival takes a neutral mine before a player mine, and a player
mine before a neutral garrison.

**It never captures a player-held node without a battle.** Player nodes only produce `borderBattle`
or `keepAssault` events, and only `resolveBorder(..., false)` hands them over.

**Offline rules** (`online: false`):
- No `keepAssault`.
- No capture of a neutral node closer to the player keep than `max(2, deepest player-held node.dist)`.
  This is the westward cap at the player's frontier edge.
- At most one pending battle, because any pending battle pauses the rival.

Events, sorted by time:
`{ type: 'capture'|'borderBattle'|'sortie'|'keepAssault', nodeId, at /* rival-clock seconds */, ms, rivalStrength, wall? }`

### `resolveBorder(state, nodeId, playerWon) -> state`
Reports the outcome of the pending battle on `nodeId`. If `nodeId` does not match, it returns an
unchanged copy.
- **Player won:** the rival retreats. The node is safe for 5 min (the keep for 10 min). The next
  move comes after 1.5× the normal gap.
- **Rival won a borderBattle:** the node joins rival territory and `handover = nodeId`. The game
  removes the node from its own held list, and `handover` clears on the next advance that no
  longer sees it in `playerHeld`.
- **Rival won a keepAssault:** `status = 'won'`. The region is lost for the player; the game decides
  what that means.

### `nextMoveEta(state) -> seconds | null`
Returns rival-clock seconds until the next action. It is `null` while a battle is pending or when
the rival is done. Divide by any game speed multiplier before showing it.

### `rivalArmyFor(state, nodeId, region?) -> Army`
```
{ name, role: 'border'|'garrison'|'keepAssault', tier, budget, units, depth, elo,
  pieces: [{ type: 'K'|'Q'|'R'|'B'|'N'|'P', square: 'e8', sq: 60 /* a1 = 0 */ }] }
```
- `role` comes from the node: the player keep gives `keepAssault`, a rival-held node gives `garrison`
  (the player attacks it), and anything else gives `border` (the rival attacks a player node).
- `tier = (regionNumber-1)*10 + strength`. With `region`, the tier is at least `node.tier` for a
  garrison, or `node.tier - 1` for a border battle. A keep assault adds +1.
- `budget = 8 · 1.045^tier · mult`, the same curve as `engine.mjs` `enemyBudget`. `mult` is 1.0
  for border, 0.95 for garrison and 1.2 for keep.
- There are 5 rival formations, plus "Lord's Court" for keep assaults. They use the engine's fill
  rule: slots in order while affordable, too-expensive rooks or queens become knights, leftover slots
  become pawns, then an upgrade pass. Pieces sit on ranks 8, 7 and 6 with one king and unique squares.
  The formation is picked by hashing `(seed, region, node, role, floor(tier))`.
- `depth = min(4, 1 + floor(tier/8))`, +1 for a keep assault. `elo = eloBase + 50·(strength-1)`.
  The elo is a hint for jitter or time budget.

### Helpers
- `rivalStrength(state)` and `rivalDwellings(state)`: the closed-form growth values.
  `state.strength` and `state.dwellings` cache them.
- `rivalTier(state)`.
- `rivalHolds(state, id)`.
- `rivalFrontier(state, region)`.
- `rivalOwners(state, region, playerHeld) -> ('player'|'rival'|null)[]`: use it for map drawing and
  tap handling.
- `RIVAL_TUNE`: every number below. `RIVAL_FORMATIONS`.

## Cadence and growth

| | |
|---|---|
| First move | 90 s ± 8% |
| Gap between moves | `min(12 min, 90 s + 40 s × (nodes held − 1))` ± 8% |
| After a lost border battle | gap × 1.5, and the node is on cooldown for 5 min (keep: 10 min) |
| Keep assault | online only, needs ≥ 5 rival nodes |
| xp | 1 per 10 min of clock, 1 per mine per 15 min, 0.5 per capture, 0.25 per sortie, 1 per border win |
| strength | `1 + min(9, 1.5·log2(1 + xp/3))`, never decreases |
| dwellings | `min(12, floor(log2(1 + xp)))` |

Measured when the rival is unopposed: captures at about 1.5, 3.8, 6.5, 10, 14, 19, 24, 30 and 37 min.
Offline from the start, with the player holding only the keep:

| Offline time | Rival nodes | Strength |
|---|---|---|
| 0.5 h | 8–9 | ≈ 4 |
| 1 h | 12 | ≈ 5–6 |
| 2 h | 18 | ≈ 6.5–7.5 |
| 8 h | whole map outside the cap | 9–10 |

## Integration with game.html / world.mjs

```js
// world.mjs: create with the map
import { createRival, advanceRival, resolveBorder, nextMoveEta, rivalArmyFor, rivalOwners } from './rival.mjs';
// in newWorldMap(run, n): map.rival = createRival(generateRegion(seed, n), { seed, regionNumber: n });
// in ensureMap: if (!m.rival || m.rival.nodeCount !== reg.nodes.length || m.rival.regionNumber !== m.region)
//                  m.rival = createRival(reg, { seed: m.seed, regionNumber: m.region });

// each live tick (game.html tick(), 1 s interval, dt in ms):
export function rivalTick(run, dtMs, online) {
  const reg = worldRegion(run);
  const r = advanceRival(run.map.rival, reg, run.map.held, dtMs / 1000, Date.now(), { online });
  run.map.rival = r.state;
  return r.events;                       // capture -> toast/log; borderBattle/keepAssault -> battle prompt
}
//   tick(): if (dt > 0 && dt < 60000 && !document.hidden) handle(rivalTick(run(), dt, true));
//   Decide whether the rival clock should also stop during battles or marches. raidTick does that.
//   If so, skip the call; nothing is lost, the clock just does not run.

// on load (offline catch-up), once, before the first live tick:
//   const away = Date.now() - state.lastTs;
//   if (away > 60000) { const ev = rivalTick(state.run, Math.min(away, 8 * 3600e3), false); summarise(ev); }
//   Cap "away" at 8 h, like mine income. Offline mode never assaults the keep, stops at the player's
//   frontier edge and queues at most one border battle. Summarise sorties as one line.

// pending battle: when run.map.rival.pending is set, show it like a raid:
//   const p = run.map.rival.pending, army = rivalArmyFor(run.map.rival, p.nodeId, reg);
//   enemyArmy-compatible pieces: army.pieces.map(x => ({ sq: x.sq, t: x.type }))
//   Alternatively call engine enemyArmy(run.seed, Math.round(army.tier), { type: 'rival', key, budget: army.budget })
//   to reuse the engine formations.
// after the battle:
//   run.map.rival = resolveBorder(run.map.rival, p.nodeId, playerWon);
//   if (!playerWon && p.type === 'borderBattle') loseMine-like removal: run.map.held = run.map.held.filter(x => x !== p.nodeId)
//   if (!playerWon && p.type === 'keepAssault') -> region lost (game rule: e.g. retreat to previous region / run penalty)

// player attacking a rival node (it is on the player's frontier and rivalOwners(...)[id] === 'rival'):
//   use rivalArmyFor(rival, id, reg) (role 'garrison') instead of nodeArmy; on a win add id to run.map.held
//   as usual. The next advance removes it from rival territory. Attacking the citadel = attacking the
//   rival seat; winning it sets status 'defeated' on the next advance (region won as today).

// drawing: rivalOwners(rival, reg, held) marks rival nodes; rival-held nodes are 'known' (banners),
//   even in fog. The demo draws them on an overlay canvas using view.scale / view.offsetX.
// timer: nextMoveEta(rival) (null = "battle pending" / done).
```

Notes for `world.mjs`:
- **Raids overlap with border battles.** Both threaten held mines. Suggested rule: keep raids only
  until the rival frontier touches the player's, which you can check with
  `rivalFrontier(...).some(id => held.includes(id))`, then let border battles replace them. Never
  let both be pending at once.
- **Save size.** The state is about 400 bytes. It goes in the save as plain JSON. A JSON round-trip
  gives identical futures, which the tests check.
- **Multiple tabs or hot reload.** The state is pure. The `hot.snapshot` already carries
  `run.map.rival`.

## Known gaps
- The rival's territory need not stay connected. If the player cuts it, the rival still expands from
  any node it holds. It does not try to reconnect.
- When the rival has nothing it is allowed to do, it emits a `sortie` every gap (up to every 12 min).
  These are only flavour plus a little xp; the UI should summarise them.
- Online, when the player holds only the keep, the rival walks straight to a keep assault in about
  40 min, then waits on it. Whether an unanswered assault should auto-resolve is a game decision.
  The module waits forever.
- Strength depends on time and mines, not on the player's progress. The game may want to scale the
  region base, for example via `regionNumber`, or with `eloBase` if region 1 feels hard after 8 h away.
- `elo` is only a hint. The engine has no Elo model, so map it to jitter or time budget yourself.
- No defense memory. The rival does not get stronger at a node the player failed to take, and a
  failed player attack costs the rival nothing.
