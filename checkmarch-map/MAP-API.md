# Checkmarch world map: API

Files (all dependency-free):

| File | Role |
|---|---|
| `map.mjs` | Pure generation + territory/fog logic. No DOM. No imports. |
| `map-render.mjs` | Canvas 2D renderer, pan, tap hit-testing. Imports `MAP_W, MAP_H, visibility` from `map.mjs`. |
| `build-demo.mjs` | Inlines both modules into `map-demo.src.html` and writes `map-demo.html`. Exports `moduleToScript(src)` and `inlinedMapSource()`. |
| `map-demo.html` | Built demo page that follows the artifact page contract. |
| `test-map.mjs` | `node test-map.mjs` (12 tests; also checks the demo is fresh and passes `node --check`). |

## Inlining into game.html

Paste `map.mjs` first, then `map-render.mjs`, into the game's single `<script>`, with these changes:
1. Delete the line `import { MAP_W, MAP_H, visibility } from './map.mjs';` in map-render.mjs.
2. Remove the `export ` keyword in front of `function` / `const` declarations.

`moduleToScript()` in `build-demo.mjs` does exactly this with two regexes, so you can reuse it in a
build step: `import { inlinedMapSource } from '/home/user/checkmarch-map/build-demo.mjs'`.
The output contains no `</script`.

The top-level names are: `MAP_W MAP_H TIERS_PER_REGION NODE_TYPES mapHashSeed mapMulberry32
mapSegmentsCross generateRegion mapAdjacency mapBfs neighbors roadDistances initialMapState frontier
visibility canCapture capture fogView MAP_PAD MAP_PALETTE_KEYS MAP_PALETTES mapPaletteFromCSS
drawBadge drawMap mapBadgeRadius createMapView`. Private helpers start with `map` (for example
`mapOrient`, `mapRoundRect`, `MAP_NAME_A`). If any of these clash with game names, wrap the pasted
code as `const CMMap = (() => { ...paste...; return { generateRegion, frontier, /*...*/ }; })();`.

## map.mjs

### Constants
- `MAP_W = 1000`, `MAP_H = 600`: the layout space.
- `TIERS_PER_REGION = 10`: region `r` has keep tier `(r-1)*10`.
- `NODE_TYPES = ['keep','garrison','mine','town','shrine','citadel']`

### `generateRegion(seed, regionNumber = 1) -> Region`
- The output depends only on `String(seed)` and `regionNumber`, using its own RNG (FNV-1a hash
  into mulberry32). It never calls `Math.random`. Output is plain JSON with no Sets or Maps, so it
  can go straight into a save file, or you can store only `(seed, regionNumber)` and regenerate.
- `regionNumber` is clamped to an integer of at least 1.

```
Region = {
  seed: string, regionNumber: int, width: 1000, height: 600,
  keepId: 0, citadelId: nodes.length-1,
  richBand: 'north' | 'south',          // which side holds the rich and dangerous route
  nodes: Node[],                        // index == id
  roads: [a, b][]                       // undirected, a < b, sorted, no duplicates
}
Node = {
  id: int, x: int (0..1000), y: int (0..600),
  type: 'keep'|'garrison'|'mine'|'town'|'shrine'|'citadel',
  tier: int, name: string (unique within the region),
  col: int,                             // -1 keep, 0..C-1 columns, C citadel
  band: 'rich' | 'lean' | 'mid',
  dist: int,                            // road distance from the keep
  boss?: string                         // citadel only, e.g. 'the Ivory Regent'
}
```

Guarantees (tested over 50 seeds):
- 20 to 30 nodes.
- Exactly one keep (x ≤ 100, west of everything) and one citadel (x ≥ 900, east of everything).
- Connected, with no straight-segment crossings. Average degree is about 2.5 (mean 2.50 over
  200 seeds, per-map range 2.15 to 3.14).
- Tiers: `keep = base`. Other nodes get `base + dist`, plus 1 if the node is in the rich band
  (column 1 onward). The citadel gets `max(base + 10, maxOther + 1)`, so it is strictly the highest.
  Because of this, tiers never go down along any shortest path.
- At least 2 vertex-disjoint keep-to-citadel routes: the northernmost and southernmost
  chains are never pruned.
- The rich band has more mines and shrines than the lean band, but its nodes are +1 tier. The lean
  band is mostly garrisons and towns.
- Totals per region: at least 2 mines, at least 1 town, at least 1 shrine. Column 0, next to the
  keep, has no shrine and at least one garrison.
- Dead-end pockets (spurs) appear about 0.5 times per map.

### Graph helpers
- `neighbors(region, id) -> id[]`, sorted.
- `roadDistances(region, fromId = keepId) -> number[]`, BFS hop counts.
- `mapAdjacency(nodeCount, roads) -> id[][]`, `mapBfs(adj, from) -> number[]`.
- `mapHashSeed(seed) -> uint32`, `mapMulberry32(uint32) -> () => [0,1)`. Reusable for other
  deterministic rolls, such as loot keyed per node: `mapMulberry32(mapHashSeed(seed+'|'+nodeId))`.
- `mapSegmentsCross(p1,p2,p3,p4) -> bool`.

### Territory and fog
`MapState = { region, held: id[] | Set<id> }`. Store `held` as a sorted array in saves.

- `initialMapState(region) -> { region, held: [keepId] }`
- `frontier(state) -> id[]`: unheld nodes that share a road with a held node, sorted. These are
  the attackable nodes.
- `visibility(state) -> ('held'|'frontier'|'fog')[]`, indexed by id.
- `canCapture(state, id) -> bool`: true when `id` is on the frontier.
- `capture(state, id) -> MapState`: immutable; throws if `id` is not on the frontier.
- `fogView(state) -> NodeView[]`. Held and frontier nodes are `{...node, vis}`. Fog nodes are
  `{id, x, y, vis:'fog', silhouette:true, big}`, with no type, tier or name, so UI built from
  `fogView` cannot leak hidden information. `big` is true only for the citadel, whose silhouette
  always shows.

The fog rule is: full info for held and frontier nodes, silhouettes for everything else. Roads
that touch a fog node are drawn faint and dashed.

## map-render.mjs

### `createMapView(canvas, opts) -> MapView` (use this one)
`opts = { palette?, onTap?(id|null, pointerEvent), minScale = 0.5, animate = true }`

- Give the canvas `width:100%` in CSS; the view sets the CSS height (≈ 0.6 × width plus padding)
  and handles the device pixel ratio (DPR). A `ResizeObserver` re-sizes it automatically.
- Scale is `max(cssWidth / 1068, minScale)`. When the region is wider than the canvas (at about
  560 px and narrower with the default minScale 0.5), horizontal drag pans. At 400 px viewport
  width (366 px canvas) the content is 534 px wide and pans by about 170 px. There is no zoom.
- A pointer movement of 6 px or less counts as a tap and calls `onTap(nodeAt(...))`, which is
  `null` on empty paper. Touch targets have a 24 px radius. The canvas gets `touch-action: pan-y`,
  so the page still scrolls vertically.
- `animate` runs a requestAnimationFrame (rAF) loop for the frontier pulse. It is off under
  `prefers-reduced-motion`. Call `setAnimate(false)` while the map screen is hidden.

MapView methods:
- `setRegion(region, held?)`: resets pan and selection. `held` defaults to `[keepId]`.
- `setHeld(held)`, `setSelected(id|null)`, `setPalette(palette)`, `setAnimate(bool)`.
- `centerOn(id)`: pans a node to the center, for example the newest frontier.
- `nodeAt(px, py) -> id|null`: coordinates are CSS px relative to the canvas top-left.
- `toLayout(px, py) -> {x, y}`: converts to layout units.
- `resize()`, `draw()`, `destroy()`.
- Getters `scale` and `offsetX`.

The view draws a name pill above the selected node: the node name, or 'Unscouted' or
'Citadel (unscouted)' in fog. Tier tags under badges appear for held and frontier nodes, except
the keep.

### Lower level
- `drawMap(ctx, { region, held, selected, palette, scale, offsetX, offsetY, width, height, time, marks? })`
  is a stateless draw in CSS px. The caller sets the DPR transform. `time = 0` gives a static
  pulse.
- `drawBadge(ctx, type, cx, cy, r, palette, mode='full'|'fog')`: a flat vector badge, for
  info cards, legends and battle headers.
- `mapBadgeRadius(type, vis)`: 14, or 17 for the keep and 19 for the citadel. Fog silhouettes
  are 0.8× (the citadel stays full size).
- `MAP_PAD = 34`: layout units of paper margin around the 1000×600 region.

### Palette
`MAP_PALETTE_KEYS`: `paper paperEdge paperMark road roadHeld roadFog heldTint heldRing frontier fog
fogEdge ink inkSoft glyph badgeEdge shadow danger keep garrison mine town shrine citadel labelBg`.

- `MAP_PALETTES.light` is parchment and `MAP_PALETTES.dark` is slate. They are ready-made defaults.
- `mapPaletteFromCSS(el = documentElement, fallback = MAP_PALETTES.light)` reads
  `--map-<kebab-key>` custom properties, for example `--map-held-tint` and `--map-label-bg`.
  `map-demo.src.html` has the full token block for `:root`, the dark media query and
  `[data-theme="dark"]`. Copy it into game.html's theme tokens.
- After a theme change, call `view.setPalette(mapPaletteFromCSS())`. The demo does this on the
  `matchMedia` change event and on its theme toggle.

## Integration sketch (game.html)

```js
// state.map = { seed, regionNumber, held: [ids] } is what you save
const region = generateRegion(save.map.seed, save.map.regionNumber);
const view = createMapView($('#map'), {
  palette: mapPaletteFromCSS(),
  onTap(id) {
    if (id == null) return view.setSelected(null);
    view.setSelected(id);
    const st = { region, held: save.map.held };
    if (canCapture(st, id)) openBattlePrompt(region.nodes[id]);   // fight a garrison of node.tier
  },
});
view.setRegion(region, save.map.held);
// after winning a battle on node id:
save.map.held = capture({ region, held: save.map.held }, id).held;
view.setHeld(save.map.held);
// held mines -> income:
const mines = save.map.held.map(i => region.nodes[i]).filter(n => n.type === 'mine');
// citadel beaten -> next region:
save.map = { seed: save.map.seed, regionNumber: save.map.regionNumber + 1, held: [0] };
```

## Known gaps
- Only roads that touch the frontier or held territory are meaningful to the player. Rendered
  roads curve slightly (a quadratic bend of up to 11% of length) and may graze very close
  neighbours, but the straight-segment graph is strictly planar.
- No zoom and no vertical pan. The region always fits vertically.
- No keyboard navigation of nodes. Canvas accessibility is limited to an `aria-label`.
- Node type effects (mine income, town discount, shrine blessing) are the game's job. The map
  only provides `type`, `tier` and `band`.
- The selected-node name pill can overlap a neighbouring badge when nodes sit close together
  vertically.
