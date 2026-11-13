# Checkmarch content pack: API and integration notes

`content.mjs` is pure data plus small pure helpers and validators. It has no imports, no DOM, no
`Math.random` and no `Date`, so it can be inlined into `game.html` the same way `engine.mjs` is.

| Export | What it is |
|---|---|
| `SHRINE_CHOICES` | 28 paired one-time choices `{id, name, minRegion, a:{label, effect}, b:{label, effect}}` |
| `RIVAL_LORDS` | 16 lords `{id, name, epithet, doctrine, favoredPieces, taunt, personalityNote}` |
| `ENEMY_FORMATION_PACK` | 27 formations `{id, name, doctrine, favored, budget, tiers:[lo,hi], citadel, pieces:[{type, square}]}` |
| `PIECE_SETS` | 8 cosmetic sets `{id, name, unlockedBy, glyphWeight, player:{hue,light}, enemy:{hue,light}, outline}` |
| `EVENT_LINES` | `{battleWin, battleLoss, raid, raidRepelled, raidLost, cache, regionWin, regionLose}`, 10-11 lines each |
| `EFFECT_KINDS` | the closed effect vocabulary (param schemas, allowed scopes, one-line meaning) |
| helpers | `toEngineFormation`, `formationsForTier`, `formationsForLord`, `lordForRegion`, `shrineChoicesFor`, `bandFor`, `refBudget`, `effectParts`, `effectValue`, `effectMinRegion`, `fillLine`, `pieceSetVars` |
| validators | `validateEffect`, `validateShrine`, `validateLord`, `validateFormation`, `validatePieceSet`, `validateLine`, `validateAll` (each returns a list of error strings; empty means valid) |

Run `node test-content.mjs` (25 checks). After editing `content.mjs` or `content-demo.src.html`, run
`node build-demo.mjs` to regenerate `content-demo.html`. The tests fail if the demo is stale.

## 1. Effect vocabulary

Every `effect` is one object `{kind, ...params}`. `kind` must be one of the 23 below; the validator
rejects unknown kinds, stray keys, values out of range and scopes a kind does not allow.

**Scopes.** `next` means the next battle the player fights, whatever kind it is. `region` lasts until
`newWorldMap` opens the next region. `run` lasts until `endRun`.

**Preconditions.** Grey out an option the player cannot take:
- any `gold` part with `v < 0` needs `run.gold >= -v`;
- `losePiece` needs `v` pieces of that type besides the King;
- `promotePawn` needs a pawn.

A `combo` needs all of its parts' preconditions to hold.

| kind | params | scopes | how world.mjs applies it (suggested) |
|---|---|---|---|
| `gold` | `v` int -2000..5000, not 0 | none | `run.gold += v` (a negative `v` is a price; see Preconditions). |
| `incomeFlat` | `v` 0.5..10 | region, run | `run.incBonus += v` for `run`. For `region`, push `{v, region}` to `run.blessings` and add it in `incomePerMin` while `run.map.region === region`. |
| `mineIncomeMult` | `v` 1.05..2 | region, run | Generalises `run.mineBless`. Store `{kind, v, scope, region}` in `run.blessings`; `mineMult(run)` returns the product of the active entries. Today's choice is `{v: TUNE.shrineMineBoost, scope: 'region'}`. |
| `lootMult` | `v` 1.05..2 | next, region, run | Multiply `sum.loot` in `finishBattle` / `applyMapResult`. Drop a `next` entry once it has been used. |
| `shopDiscount` | `v` 0.05..0.4 | region, run | In `worldRefresh`: `run.shopDisc = max(townDisc, active discounts)`. Discounts do not stack. |
| `squares` | `v` int 1..3 | none | Grant the next `v` squares in `SQUARE_ORDER` that are not yet owned. Do not increment `run.squaresBought`, so the price ladder stays put. |
| `addPiece` | `piece` P/N/B/R/Q, `v` int 1..2 | none | Push `{id: run.nextId++, t: piece}` to `run.roster` (it goes to the reserve). Do not touch `run.bought`. |
| `losePiece` | `piece`, `v` int 1..2 | none | Remove from the reserve first, then from garrisons, then from the formation (front rank first). Clear the formation and garrison slots it held. |
| `promotePawn` | `to` N/B/R/Q | none | Same as today's `chooseShrine('knight')`: the player picks a pawn (`shrinePawns`) and gets `p.t = to`. |
| `tacticianElo` | `v` int -200..200, not 0 | next, region, run | Add to the player's elo in `playerEngineCfg(lvl, orders, oppElo)`, clamped by `cleanElo`. |
| `enemyElo` | `v` int -200..200, not 0 | next, region, run | Add to `nodeElo` and the raid / rival army elo, clamped by `cleanElo`. |
| `enemyBudgetMult` | `v` 0.6..1.5 | next, region | Multiply the budget in `nodeArmy`, `raidBudget` and `rivalNodeArmy` (pass it as `opt.budget`). |
| `trait` | `piece`, `v` int 1..2 | region, run | `run`: `run.dwell[piece] = min(DWELL_MAX, dwell + v)`. `region`: a temporary bonus added on top of `run.dwell` when battle traits are built (`battle.traits`). |
| `enemyTrait` | `piece`, `v` int 1..2 | region | Add to `tierTraits(tier)[piece]` for neutral, raid and rival armies in this region, capped at `DWELL_MAX`. |
| `raidClock` | `v` int -600..900, not 0 | none | `run.map.raid.t = max(30, run.map.raid.t + v)`. |
| `rivalClock` | `v` int 60..1200 | none | Push the rival's next action back by `v * WORLD.rivalSecPerTick * 1000` ms (`rival.nextAt`, or the field `nextMoveEta` reads). |
| `rivalStrength` | `v` int -2..2, not 0 | none | Add to the rival's xp or bonus so its strength moves by `v` (capped by `RIVAL_TUNE.bonusCap`, floor 0). |
| `reveal` | `v` int 1..4 | none | Mark every node within `v` roads of the shrine as scouted: add them to `run.map.scouted`, and make `fogView` treat scouted nodes as frontier. |
| `marchMult` | `v` 0.5..1.5 | region | Multiply `marchTicks(run, id)`, keep at least 1 tick. |
| `bar` | `material` iron/steel/obsidian, `v` int 1..2 | none | `forge.bars[material] += v` (forge.mjs state). |
| `resource` | `res` tin/coal/iron/shards, `v` int 1..40 | none | `forge.stock[res] += v`, clamped to the forge stock cap. |
| `memoriesOnEnd` | `v` int 1..10 | none | `run.memBonus += v`; `endRun` adds it after the mate 25% cut, so it is never reduced. |
| `combo` | `parts`: 2-3 non-combo effects | none | Apply the parts in order. The tests require every combo to have one part that costs and one that gains. |

A minimal `chooseShrine` replacement:

```js
import { SHRINE_CHOICES, effectParts } from './content.mjs';
export function chooseShrineSide(run, forge, choiceId, side, pick) {
  const c = SHRINE_CHOICES.find(x => x.id === choiceId); if (!c || run.map.shrine == null) return false;
  const parts = effectParts(c[side].effect);
  if (!parts.every(p => canApply(run, p, pick))) return false;   // the preconditions above
  for (const p of parts) applyEffect(run, forge, p, pick);        // switch on p.kind, as in the table
  run.map.shrine = null; return true;
}
```

**Which shrine a node offers.** The pool is `shrineChoicesFor(run.map.region)`. Pick from it
deterministically, for example `pool[mapHashSeed(run.map.seed + '|shrine|' + nodeId) % pool.length]`.
Store the choice id on the node or in `run.map.shrineChoice` so it survives a reload.

**Balance helpers.** `effectValue(effect, region)` is a rough gold-equivalent. Most effects scale by
1.6^(region-1). `gold`, `incomeFlat`, `bar`, `resource` and `memoriesOnEnd` do not scale. The tests
keep both sides of each shrine positive and within 2x of each other at its `minRegion`.
`effectMinRegion(effect)` gates strong effects:
- queen promotion: region 4 or later;
- steel bars: region 3; obsidian bars: region 4;
- a free knight or bishop: region 3; a free rook: region 5;
- a run-long trait: region 2 (a queen trait: region 5);
- `enemyBudgetMult` and `memoriesOnEnd`: region 3; `rivalStrength`: region 2.

## 2. Rival lords

`doctrine` is one of `aggressive | solid | material`. Use `ENGINE_DOCTRINE[doctrine]` to get the
engine key: `material` maps to `greedy` in `engine.mjs DOCTRINES`. Integration:
- **Seat lord.** `lordForRegion(run.seed, region)` gives one lord per region. It is deterministic and
  visits all 16 before any repeats. Store `lord.id` on `run.map` when `newWorldMap` runs.
- **Taunt.** Show `lord.taunt` (80 chars max) when the region opens. `{lord}` in `EVENT_LINES` is
  `lord.name`; the epithet is for headers ("Vasha Emberline, the Cinder Wolf").
- **Armies.** Set `a.doctrine = ENGINE_DOCTRINE[lord.doctrine]` on rival armies instead of the
  hard-coded `'aggressive'` (world.mjs `raidArmy` / `rivalNodeArmy`). For rival formations, prefer
  `formationsForLord(lord)` (same doctrine and a shared favored piece; every lord has at least one)
  filtered by tier.
- **BOSSES.** The engine's `BOSSES` names stay as they are for neutral citadels. Lord names share no
  word with them (tested).

## 3. Enemy formations: merging into FORMATIONS

Pack formations use the engine's square convention: algebraic squares on black's side. Every piece is
on ranks 5-8, there is no pawn on rank 8, and `pieces[0]` is the one King. The rest of `pieces` is the
**ordered slot list**: `enemyArmy` fills slots in order until the budget runs out. `budget` is the
units of the full slot list (P1 N3 B3 R5 Q9). `tiers` is the band where
`enemyBudget(tier, garrison|citadel)` lands within 0.5x to 1.1x of `budget`, so the army keeps its shape.

`toEngineFormation(f)` returns `{name, k, s, citadel?}`, the shape of `engine.mjs FORMATIONS`.

- **Simple merge.** `FORMATIONS.push(...ENEMY_FORMATION_PACK.map(toEngineFormation))`. This changes
  which formation `hash3(seed, key, 7) % norm.length` picks on existing maps, so save it with a
  `SAVE_VERSION` bump or accept the reshuffle. It also ignores the tier bands.
- **Recommended merge (banded).** Keep `FORMATIONS` as it is. In world.mjs `nodeArmy`, take
  `pool = formationsForTier(tier, {citadel: type === 'citadel', doctrine})`. If `pool` is not empty
  and `hash3(seed, id, 11) % 3 === 0`, use `pool[hash3(seed, id, 13) % pool.length]`. That needs a
  small engine change: `enemyArmy(seed, tier, {type, key, formation})` should use `opt.formation`
  (an engine-shape object) when it is given. The tests in this pack check this path against the live
  `enemyArmy` by swapping the table in memory: every pack formation builds a legal army at the low,
  middle and high tier of its band, the engine picks it by name, and black has legal moves.
- **Budget drift.** The tags were computed against `REF_TUNE`, a copy of the engine's `enemyBudget`
  with `TUNE.enemyBudgetBase = 5`. The test compares the copy with the live engine and prints a WARN
  that lists stale formations if `TUNE` changes. At runtime you can ignore the static tags and use
  `bandFor(f.budget, f.citadel, enemyBudget)`.
- Coverage: tiers 2-45 each have at least 2 garrison formations. There are 4 citadels, and each
  doctrine has at least 6 formations.

## 4. Piece sets: CSS

The sets only change how the theme's own tokens are drawn; the base colors stay the theme's.
`pieceSetVars(set)` returns custom properties to put on the board element:

```
--pc-weight        glyphWeight (100..900)          -> .pc { font-weight: var(--pc-weight) }
--pc-player-hue    player.hue in deg (-180..180)
--pc-player-light  player.light in % (-20..20)
--pc-enemy-hue / --pc-enemy-light                   (same for the enemy)
--pc-outline       a text-shadow list for outline   -> .pc { text-shadow: var(--pc-outline), <existing drop shadow> }
```

Suggested piece color, using relative color syntax with a fallback:

```css
.pc.w { color: var(--piece-player);
        color: hsl(from var(--piece-player) calc(h + var(--pc-player-hue-n)) s calc(l + var(--pc-player-light-n))); }
```

The `-n` variants are unitless copies; set both if you use relative colors. Without relative colors,
use `filter: brightness(calc(100% + light))` and mix a hue tint, the way `content-demo.html` does with
`color-mix(in oklab, var(--piece-player) 72%, hsl(40+hue 70% 50%))`.

Outline styles: `none`, `hairline` (1px halo), `ink` (4-way 1px stroke), `double` (stroke plus accent
halo) and `glow` (6px accent glow). They use `--piece-outline` and `--piece-accent`, which the game
must define in both themes.

`unlockedBy` kinds:
- `default`;
- `memories` (lifetime Memories earned, `state.memEarned`);
- `region` (highest region reached);
- `citadels` (rival seats won, lifetime);
- `forge` (the first bar of `material` smelted).

Keep the unlocked ids and the chosen id in the save (`state.cosmetics = {unlocked: [], set: 'classic'}`).
Cosmetics never affect play.

## 5. Event lines

Placeholders come from a closed set: `{lord}`, `{place}`, `{gold}` and `{piece}`. Fill them with
`fillLine(line, vars)`. Each line is 90 characters or fewer before filling, and also after filling with
`LINE_SAMPLE` (tested). Pick lines deterministically, for example
`lines[hash3(seed, battleCount, 17) % lines.length]`. Lines with `{gold}` only make sense when there is
loot; filter them out when `gold` is 0.

## Known gaps

- Nothing in `world.mjs` reads this pack yet. The apply functions above are suggestions; `world.mjs`
  needs `run.blessings` (scoped modifiers), `run.memBonus`, `run.map.scouted` and an `opt.formation`
  hook in `enemyArmy`.
- `rivalClock` and `rivalStrength` depend on `rival.mjs` internals (its next-action time and its xp
  or bonus). They need a small exported helper in rival.mjs, for example `delayRival(state, ms)` and
  `nudgeRival(state, dBonus)`.
- `effectValue` is a heuristic for authoring, not a simulation. Run `balance-bot.mjs` after wiring
  these effects in.
- The formation tags depend on `TUNE.enemyBudgetBase` (5 today). The test warns when it drifts.
