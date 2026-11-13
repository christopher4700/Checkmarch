# Checkmarch discovery: API

More to find in the fog: **road treasure**, **run artifacts**, **named one-off locations** and
**scouting**. `discovery.mjs` is pure logic (no DOM, no `Math.random`, no `Date`). Everything is
seeded from `run.map.seed` and saved on `run.map`.

| File | Role |
|---|---|
| `discovery.mjs` | The module. It imports `map.mjs` and `content.mjs`. |
| `map.mjs`, `content.mjs` | Verbatim copies of `checkmarch-map/map.mjs` and `checkmarch-content/content.mjs`. The tests check that they still match. |
| `test-discovery.mjs` | `node test-discovery.mjs` runs 62 checks and exits 0 when all pass. |

**Inlining.** Paste `discovery.mjs` after `content.mjs` and `map.mjs`. Delete its two `import` lines and
the `export ` keywords (`moduleToScript` does this). Top-level helpers have a `d`/`disc` prefix
or are long names, so they don't clash with the engine, world, map or content names.

## Effect vocabulary

Every effect is a content-pack effect `{kind, ...params, scope?}`, validated by content `validateEffect`.
At load, `registerDiscoveryKinds()` adds **5 new kinds** to `EFFECT_KINDS`, using the same schema. It is
idempotent and follows the `applyRivalTune` pattern. Nothing else in the vocabulary changes.

| kind | params | scopes | who applies it |
|---|---|---|---|
| `hints` | `v` int 1..3 | run | The game reads `artifactTotal(run,'hints')`: the first v Hint presses each battle are free. |
| `traitWard` | `v` int 1..2 | run | The game reads `artifactTotal(run,'traitWard')`. In `playMove`, the player's first v captures each battle skip the victim's trait roll (`tr.ok = false`). Count them on `battle.ward`. |
| `sight` | `v` int 1..2 | run | discovery: `revealOnCapture` scouts within 1+v roads of each captured node. |
| `artifact` | `id` (an ARTIFACTS id) | none | discovery: `resolveSite` awards it. |
| `ambush` | `v` num 0.4..1.2 | none | discovery sets `run.map.ambush`. The game fights it (see Integration). |

`hints`, `traitWard` and `sight` (`PASSIVE_KINDS`) are **read live** from held artifacts. The game's
`applyEffect` never receives them. All other effects returned in `apply` arrays are ordinary content
kinds, and the game applies them with its own `applyEffect` (CONTENT-API.md section 1). Gold, squares,
pieces, traits, blessings and `memoriesOnEnd` all work this way.

`discMinRegion(e)` extends content `effectMinRegion` with the artifact gate.

## Road treasure

- `placeTreasure(seed, region, excludeArtIds=[]) -> Treasure[]` places about one pile per 4.5 roads
  (at least 2), at most one per road, at `t` 0.35..0.65 along the road.
  `Treasure = {a, b, t, k, e, art?, got}`. `k` is the kind:
  - `gold` (62%): `U(15,30) x 1.6^(r-1)` gold, x1.25 on rich-band roads.
  - `res` (30%): tin, coal, iron or shards. `U(3,7) x (1 + 0.25(r-1))`; shards get half.
  - `memory` (4%, from region 3): `memoriesOnEnd v1`.
  - `art` (4%): a rolled artifact. `e` is its gold fallback (x2).
- `collectOnMarch(run, fromId, toId) -> Gain[]` picks up the unclaimed pile on that road, in either
  direction. It is **idempotent**: `got` is set to 1 and a pile never pays twice. The return value is
  `Gain = {id, k, apply: effect[], art: def|null, text, short}`. `text` is an `EVENT_LINES.cache`
  line, or a resource or artifact line. `short` is a chip like `+21 gold`. If the player already owns
  an artifact pile's artifact, the pile pays its gold fallback instead.
- `marchFrom(run, toId) -> id|null`: the held end of the road a march to `toId` takes (lowest `dist`,
  then lowest id).
- `sweepHeld(run) -> Gain[]`: roads with both ends held are yours. It collects their piles, once each.

## Artifacts (run-scoped; lost when the run ends)

| id | name | rarity | min region | effect |
|---|---|---|---|---|
| vanguard-banner | Banner of the Vanguard | common | 1 | `squares 1`: +1 starting square |
| tacticians-lens | Tactician's Lens | common | 1 | `hints 1 run`: 1 free hint per battle (NEW kind) |
| obsidian-chip | Obsidian Chip | rare | 2 | `traitWard 1 run`: the first capture each battle cannot fail its counter roll (NEW kind) |
| toll-ledger | Toll-Keeper's Ledger | common | 1 | `incomeFlat 2 run` |
| lodestone | Prospector's Lodestone | common | 1 | `mineIncomeMult 1.15 run` |
| scout-spyglass | Scout's Spyglass | common | 1 | `sight 1 run`: capturing a node scouts 2 roads around it (NEW kind) |
| gilded-purse | Gilded Purse | common | 1 | `lootMult 1.1 run` |
| war-drum | War Drum | rare | 2 | `tacticianElo 50 run` |
| quartermaster-seal | Quartermaster's Seal | rare | 2 | `shopDiscount 0.1 run` (a town coupon doesn't stack: max wins) |
| drill-whistle | Drillmaster's Whistle | rare | 2 | `trait P 1 run` |
| dread-standard | Standard of Dread | rare | 3 | `enemyElo -40 run` |
| pilgrim-reliquary | Pilgrim Reliquary | rare | 3 | `memoriesOnEnd 2` |

- `rollArtifact(seed, regionNumber, exclude=[]) -> id|null`: a seeded weighted pick (common 3 : rare 1)
  over artifacts whose `minRegion` is at most `regionNumber` and that are not excluded. Returns null
  when the pool is empty.
- `awardArtifact(run, id) -> {def, apply}|null` pushes `{id, r}` to **`run.arts`** (on the run, not the map, so
  artifacts survive `newWorldMap` with no extra hook; a new run starts without them). It returns null
  for an unknown id or one already owned. `apply` holds the non-passive parts, which the game applies
  once. Run scope then lasts until `endRun`.
- `artifactTotal(run, kind)`, `heldArtifacts(run)`, `ownsArtifact(run, id)`.
- Sources:
  - road treasure (rare);
  - the Sunken Vault site (pay for it, or win its ambush).
  Placement never repeats an owned or already-placed artifact.

## Named locations (shrine-card pattern)

`LOCATIONS` holds archetypes with this shape:

`{id, name, glyph, minRegion, blurb, variants: [{minRegion, a: {label, effect}, b?}]}`

- `{gold}` in a label is filled with the option's gold amount, which `siteCard` scales by `1.6^(r-1)`.
- An `artifact` with `id: null` in a variant stands for the site's prize.
- A card with no `b` has a single choice. The UI always adds **Not now**.

| id | name | glyph | min region | choices |
|---|---|---|---|---|
| witch-hut | Witch Hut | ⌂ | 1 | Learn a dwelling level. The variant depends on the region: P region-scoped (r1), N/B run (r2), R run (r3). |
| obelisk | Obelisk | ▲ | 1 | a: reveal 1 around a **far focus node** (a fog patch) / b: +5 shards |
| abandoned-camp | Abandoned Camp | ✦ | 1 | "Search the camp (even odds: 2 pawns or an ambush)". The odds are shown on the card; a seeded 50/50 variant decides +2 pawns or an x0.6 ambush. |
| cartographer | Cartographer's Tent | ✎ | 1 | a: 40g, reveal 3 / b: 80g, reveal 4 |
| sunken-vault | Sunken Vault | ◆ | 2 | a: 120g, take the prize artifact / b: force the door (an x0.9 ambush; a win pays the prize) |
| mercenary-camp | Mercenary Camp | ⚔ | 1 | r1: 35g for 2 pawns, or +60 elo next battle; r3: 70g for a knight, or 35g for 2 pawns |
| windmill | Windmill | ✢ | 1 | 10 coal, 10 tin or 7 iron (r2), or about 45g |
| watchtower | Watchtower | ⌖ | 1 | a: reveal 2 / b: next raid 150 ticks later |
| standing-stones | Standing Stones | ◎ | 1 | +40 elo this region, or enemies -30 elo this region; r3: 150g for +1 Memory |
| smugglers-den | Smugglers' Den | ☾ | 2 | 80g for shop -15% this region, or the rival stalls 300 ticks |

Gold prices are the region-1 base. Reveals centre on the site's anchor node, or on its `focus` node
when it has one.

- `placeSites(seed, region, excludeArtIds=[]) -> Site[]` places 3 sites, plus 1 from region 3, plus a
  0-1 coin flip (at most 5). Each region uses distinct archetypes and distinct anchor nodes, spread
  one per column first. Anchors have `dist >= 2`, so they all start **in fog**. The keep and citadel
  never get a site. A site is `{at, arch, v, dx, dy, focus, prize, done, later}`. `(dx, dy)` is a
  layout-unit offset from the anchor, chosen clear of nodes and roads.
- `siteCard(run, i) -> {i, id, name, glyph, blurb, place, done, a: {label, effect, ok}, b?}`. `ok` is
  false when the player can't pay, the prize is already owned, or the site has been visited.
- `openSite(run, i)` needs the anchor held, the site unvisited and no ambush pending. It sets
  `run.map.site = i`. `dismissSite(run)` handles **Not now**: it sets `later` and the card won't pop up
  by itself again.
- `resolveSite(run, 'a'|'b') -> {apply, art, revealed, ambush, label}|null`. It applies the artifact,
  reveal and ambush parts itself and returns the rest in `apply`. The site is then done for good.
- `ambushSpec(run) -> {mapId, tier, budgetMult, place, key, prize}` and
  `finishAmbush(run, won) -> {won, art, apply}`.
- `discoveryBusy(run)`: true while a card or an ambush is waiting.

## Fog and scouting

`run.map.scouted` holds node ids whose fog is lifted without holding them. They show full info but
**cannot be attacked**: `canCapture` and `frontier` still use `held` only. This is the field that
CONTENT-API's shrine `reveal` already names.

- `discVisibility(region, held, scouted)`: like `visibility`, plus `'scouted'`.
- `discFogView(region, held, scouted)`: like `fogView`. Scouted nodes come back as full nodes with
  `vis: 'scouted'`, and fog nodes leak nothing.
- `nodesWithin(region, center, v)` returns ids within v roads.
- `revealAround(run, center, v) -> newlyVisibleIds` covers shrine reveals, the cartographer and the
  watchtower. An obelisk passes its focus node as `center`.
- `revealOnCapture(run, nodeId)`: the sight bump (Spyglass).
- `visibleTreasure(run)`: unclaimed piles where neither road end is in fog. Scouted counts as visible.
- `visibleSites(run) -> [{i, at, x, y, glyph, name, done, ready}]`: sites whose anchor isn't in fog.
- `roadPoint(A, B, ctrl, t)` gives the point on the quadratic road. Pass `mapRoadCurve(A, B)` as `ctrl`.

## Save

New `run.map` fields: `disc`, `treasure`, `sites`, `scouted`, `site`, `ambush`, plus **`run.arts`** on the run
(schema at the top of `discovery.mjs`).

- `initDiscovery(run)`: call it right after `newWorldMap`. It places this region's content and leaves
  `run.arts` alone (owned artifacts are never placed again).
- `cleanDiscovery(run)` (alias `migrateDiscovery`) is tolerant. An old map without `disc: 1` gets
  `disc: 0` and empty lists, so there is **no discovery content until the next region**. Broken entries
  are dropped. Known artifacts and valid scouted ids are kept; artifacts found on the old `run.map.arts` move to `run.arts`. A JSON round-trip followed by `clean` is
  the identity.

No `SAVE_VERSION` bump is needed, because absent fields are the migration.

## INTEGRATION

### world.mjs
1. **Region generation.** Call `initDiscovery(run)` after `ensureMap` creates a fresh map (a new run). In
   `applyMapResult`'s citadel branch, call `initDiscovery(run)` right after `run.map = newWorldMap(...)`.
   Artifacts are on `run.arts`, so they carry across by themselves and end with the run.
2. **Load.** At the end of `ensureMap`, call `cleanDiscovery(run, worldRegion(run))`. Pass
   `worldRegion(run)` everywhere the optional `region` argument is accepted, so the cache is shared.
3. **March.** At arrival, call `collectOnMarch(run, marchFrom(run, m.id), m.id)` before `createBattle`.
   Do it at arrival, not at march start, so a cancelled march picks nothing up. Apply `gain.apply`
   with `applyEffect` and queue the toasts.
4. **Capture.** After `applyMapResult` succeeds in the same region, call `afterCapture(run, nodeId)`. It
   sweeps piles on held roads, applies the sight reveal and opens the site card at that node
   (`site != null`).
5. **Gating.** Add `!discoveryBusy(run)` to `canMarch`, and to `raidPaused` so the raid clock stops
   while a card waits, as it does for the shrine.
6. **Ambush.** Build the army with
   `enemyArmy(run.seed, spec.tier, {type: 'raid', key: spec.key, budget: enemyBudget(spec.tier, 'garrison') * spec.budgetMult})`.
   Use the formation, allow retreat, and don't put the run at stake (treat a mate as a loss, like
   `castellan`). On a win, call `finishAmbush(run, true)` and pay `raidLootMult` loot. On a loss or
   retreat, call `finishAmbush(run, false)`: the site stays done.
7. **Artifacts live.** In `playerEngineCfg` and the battle UI, read hints and `traitWard` with
   `artifactTotal`. Shrine `reveal` should call `revealAround(run, shrineId, v)`.

### Cards (existing ov/card system)
Render `siteCard(run, run.map.site)` exactly like the shrine card:
- the title is `name` with `glyph`;
- the subtitle is `place`, then `blurb`;
- one button for each of `a` and `b`, disabled when `!ok`;
- a **Not now** button that calls `dismissSite`.

On a choice, call `resolveSite`. Then apply `apply`, toast the artifact (`art.name`, `art.text`),
re-sync the map after `revealed`, and start the ambush battle if `ambush` is set. A tap on a `ready`
site calls `openSite`. Treasure toasts show `gain.text`, with `gain.short` as the chip. Batch several
gains into one toast.

### Map renderer
Draw on the overlay canvas the game already stacks over `#map` for the rival (`drawRivalOverlay`).
Use the same `sx`/`sy` transform: `ox + (x + MAP_PAD) * scale`. Draw in this order, after the rival
layer:
1. **Scouted nodes.** For each id in `run.map.scouted` that is still fog, call
   `drawBadge(g, n.type, sx, sy, mapBadgeRadius(n.type, 'frontier'), pal, 'full')` at alpha 0.75, then
   add a 1.5 px `pal.inkSoft` dotted ring. Draw the tier tag the same way the map does.
2. **Treasure glints.** For each item of `visibleTreasure(run)`, find
   `p = roadPoint(A, B, mapRoadCurve(A, B), t)` and draw a 4-point star, 5 px across at
   `max(scale, 0.6)`. Use `pal.mine` for gold, `pal.shrine` for resources and memories, and
   `pal.citadel` for an art pile (a rare red glint). Give it a `pal.paper` halo. Twinkle it with
   `0.6 + 0.4 sin(t / 300 + i)`, or keep it static under `REDUCED`.
3. **Sites.** For each item of `visibleSites(run)`, draw at `(x, y)`:
   - a 9 px rounded diamond in `pal.labelBg`, outlined with a 1.5 px `pal.ink` stroke;
   - `glyph` at 11 px in `pal.ink`;
   - for `ready` sites, a pulsing `pal.frontier` ring;
   - for `done` sites, the glyph at 0.35 alpha and no name.
   On hover or tap, show the name pill with the map's label style (`labelBg`, `paperEdge`, `ink`):
   `name`, plus " (visited)" when done.
4. **Hit-testing.** `createMapView`'s `onTap` only knows nodes. In the game's `onMapTap`, first test
   `visibleSites` within 16 px using `mapView.toLayout(px, py)` and the site's `x`/`y`, then fall back
   to the node id. Tapping a pile shows a peek: "Gold on the road (unclaimed)".

## Decisions (coordinator review)
1. **Done.** Artifacts live on `run.arts`, and `cleanDiscovery` migrates the old `run.map.arts`.
2. Memories in treasure stay gated to region 3 and later.
3. **Deferred to the balance pass:** should the rival loot road piles on roads it holds? It doesn't today.
4. **Done.** Randomness is small and visible: the Abandoned Camp label states its even odds.
5. The `hints`, `traitWard` and `sight` weights wait for `balance-bot.mjs` after wiring. A region-1 pile
   of about 25 gold is roughly 2 battles' loot.
6. Old saves get no mid-region fill. Discovery content starts at the next region.
