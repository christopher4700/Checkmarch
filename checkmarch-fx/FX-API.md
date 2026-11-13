# Checkmarch FX: API and integration

`fx.mjs` is a pure ES module with no dependencies. It lays one transparent canvas over a host element and draws flat-vector effects on it: capture bursts, move trails, check pulses, labels, confetti and the run-over veil. It inlines into `game.html` the same way the other modules do. `checkmarch/build.mjs` drops `import` lines and strips `export`, and every top-level name in the module is prefixed (`FX_`, `fx`, `createFX`), so it does not clash with the game's names. A test checks this.

Files:

| File | What it is |
|---|---|
| `fx.mjs` | The module (source of truth). |
| `fx-demo.src.html` | Demo template, with an `/*@FX*/` marker. |
| `build-demo.mjs` | `node build-demo.mjs` writes `fx-demo.html`; `--check` exits 1 if the file is stale. |
| `fx-demo.html` | The built demo (artifact page contract, no external resources). |
| `test-fx.mjs` | `node test-fx.mjs` runs the headless tests: mock 2d context, rAF, clock and timers. |

## API

```js
import { createFX, fxPaletteFromCSS, FX_PALETTES, FX_MAX_PARTICLES, FX_MAX_EFFECTS } from './fx.mjs';
const fx = createFX(hostElement, options);
```

### `createFX(host, options)`

This appends `<canvas aria-hidden="true">` to `host`. The canvas is styled `position:absolute; inset:0; pointer-events:none; z-index:6`. If the host's computed position is `static`, it is switched to `relative` and restored by `destroy()`.

| option | default | meaning |
|---|---|---|
| `palette` | `FX_PALETTES.light` | `{ ink, paper, muted, accent, good, danger, gold, rival, glint, veil, veilInk, bronze, silver }`. Any CSS color strings. Missing keys fall back to the light palette. |
| `cells` | `8` | Board dimension, used for cell coordinates. |
| `flipped` | `false` | Board seen from black. Can be changed later with `setFlipped`. |
| `fixed` | `false` | Page-level overlay: `position:fixed`, sized to the viewport, appended to `host` or `document.body`. Use it for `regionWin` and `runOver` moments. |
| `bleed` | `0` | Extends the canvas N px beyond the host on each side so sparks can fly past the board edge. Coordinates stay host-relative. Do not use it on a host with `overflow:hidden`. |
| `reducedMotion` | auto | `true` or `false` forces the setting. If omitted, the module follows `prefers-reduced-motion` live. |
| `maxParticles` / `maxEffects` | 320 / 48 | Pool sizes. The pools are fixed and never grow. |
| `zIndex`, `maxDpr` (2), `font`, `displayFont` | | Cosmetic settings. |
| `window`, `document`, `now`, `raf`, `caf`, `setTimeout`, `clearTimeout`, `random`, `canvas` | globals | Injection points used by the tests. |

### Cell coordinates

Every board effect accepts any of these forms:

- **Engine square index** `0..63`: `0` is a1, `63` is h8, white at the bottom unless `flipped`. This is the same convention as `sqXY` in game.src.html.
- **Algebraic** `'e4'`.
- **Screen grid** `[col, row]`, where row 0 is the top.
- **Pixel** `{ x, y, size? }`, in host CSS px.

Map effects take host CSS pixel coordinates `(x, y)` directly.

Invalid input (out of range, `NaN`, `undefined`) returns `false`. It never throws.

### Effects

Each effect returns `true` if it was accepted and `false` if the input was bad, the host is zero-size or the instance has been destroyed.

| call | look | duration | reduced-motion still |
|---|---|---|---|
| `captureBurst(cell, color?)` | Shockwave ring, flash, ~14 rotating shards, 6 gold sparks, dust. `color` should be the captured piece's color (default `ink`). | ~0.8 s | Faint ring, 260 ms |
| `moveTrail(fromCell, toCell, color?)` | Tapered streak whose head leads and tail chases (matches a ~260 ms slide), plus motes. | 460 ms | None (decorative) |
| `checkPulse(kingCell)` | Two staggered red rings, red flash, radial sparks. | ~0.95 s | Red ring, 700 ms |
| `promoteFlare(cell)` | Gold light pillar, rotating rays, accent ring, rising stars. | ~0.9 s | Gold ring, 500 ms |
| `traitSave(cell, label?, color?)` | Floating pill label (pops, rises, fades; clamped inside the overlay) with a sparkle ring. Default label `'Saved!'`, color `good`. | 1.45 s | Label, 1.3 s |
| `materialGlint(cell, tier)` | Diagonal shine across the cell, tier-colored frame (1 bronze, 2 silver, 3 gold, 4+ accent), tier+1 stars. | 640 ms | None |
| `regionWin({ title?, subtitle?, color? })` | Center banner (ease-out-back pop, gold stars) and up to 110 confetti pieces from both bottom corners. | 2.7 s | Banner, 1.8 s |
| `runOver({ title?, subtitle?, duration?, desaturate? })` | Dark veil, vector king that wobbles, tips over and falls, then the title on a backing band. `desaturate` is an element that gets `filter: grayscale(.85) brightness(.92)` with a 700 ms transition, restored at the end. It defaults to the host, or to none when `fixed`. Pass `false` to skip it. | 3.4 s | Veil and title, 2.4 s |
| `mineTick(x, y, scale?)` | Spinning coin rises with a glint and 3 gold sparks. Capped at 10 concurrent coins, so tick spam stays cheap. | 820 ms | None |
| `rivalCapture(x, y, scale?)` | Three staggered rival-colored ripples, danger flash, an X that snaps in. | ~1.2 s | Ring, 600 ms |

### Control

- `setPalette(partial)`: merges colors. Call it on theme change.
- `setFlipped(bool)`
- `setReducedMotion(true | false | null)`: `null` means follow the OS setting.
- `resize()`: forces a re-measure. A ResizeObserver already does this automatically.
- `cellCenter(cell)`: returns `{ x, y, size }` or `null`. Useful for positioning DOM next to an effect.
- `clear()`: drops everything now and restores any filter.
- `destroy()`: cancels rAF and timers, disconnects the observer and media listener, removes the canvas, restores the host. It is idempotent. Later effect calls return `false`.
- `stats()`: returns `{ particles, effects, awake, frames, fps, quality, reduced, poolSize, effectPoolSize, maxParticles, maxEffects, width, height, dpr, destroyed }`.
- `fxPaletteFromCSS(el?, fallback?)`: reads the palette from CSS custom properties:
  - `ink` from `--fg`, `paper` from `--panel`, `muted` from `--muted`, `accent` from `--accent`.
  - `good` from `--good`, then `--accent`. `danger` from `--danger`. `gold` from `--gold`. `rival` from `--rival`, then `--danger`.
  - Optional `--fx-*` overrides: `--fx-veil`, `--fx-veil-ink`, `--fx-glint`, `--fx-bronze`, `--fx-silver`, and `--fx-<key>` for any key.
  - The base palette is light or dark, chosen from the computed `color-scheme`.

## Runtime behavior and performance

- **Auto-sleep.** There is one rAF loop per instance, and it runs only while particles or effects are alive. When the last one dies, the canvas is cleared and no frame is requested until the next effect call. While idle there are zero draw calls; a test checks this.
- **Pools.** Particles and effects use preallocated object pools: 320 and 48 by default. Dead particles are swap-removed, so nothing is allocated per frame. When a pool is full, new spawns recycle slots in place (oldest first), so a 20-burst stress or 1000 bursts in a loop stays bounded. A test checks this.
- **Adaptive quality.** An EMA of frame time drives a quality factor from 0.35 to 1. Above 26 ms per frame, new effects spawn fewer particles. Below 19 ms, quality recovers.
- **Cheap drawing.** Rotated shards and confetti use `setTransform` directly (no save/restore). Dots use `arc`; there are no gradients, shadows or per-frame `measureText` (text is measured once at spawn). `save`/`restore` appear only in the glint clip and the falling king.
- **DPR and time step.** devicePixelRatio is capped at 2 and dt is clamped to 50 ms, so a backgrounded tab does not explode the physics.
- **Measured.** Headless Chrome at 400x1100 and DPR 2 held about 60 fps through the stress (20 bursts, 320 particles at the cap) and went back to "asleep" about 1 s later.
- **Reduced motion.** There are no particles and no rAF at all. Informative effects (labels, banners, check, run-over) are painted once as stills and cleared by a single timer. Decorative ones (trail, glint, coin) do nothing. A test asserts zero rAF calls and zero frames.

## Integration with game.src.html

Integration has not been done; nobody has touched `checkmarch/`. The suggested wiring:

1. **Build.** Copy `fx.mjs` into `checkmarch/` verbatim and add `'fx.mjs'` to `MODULES` in `build.mjs`, after `audio.mjs`. It uses the same `toScript` transform. The clash test in `test-fx.mjs` already scans `engine/map/map-render/audio/rival/world.mjs` and `game.src.html` for name collisions (read-only).

2. **Instances** (in boot, after the DOM exists):

   ```js
   const fxPal = () => fxPaletteFromCSS(document.documentElement);
   const fxBoard = createFX($('board'), { palette: fxPal() });               // .board is position:relative + overflow:hidden (clips cleanly)
   const fxMap   = createFX($('map').parentNode, { palette: fxPal() });      // .mapbox; sits above #map and #rivalMap (z-index 6)
   const fxPage  = createFX(null, { fixed: true, palette: fxPal() });        // regionWin / runOver moments
   ```

   In `applyTheme()` and the `prefers-color-scheme` change listener, call `[fxBoard, fxMap, fxPage].forEach(f => f.setPalette(fxPal()))`. Note that `.board` has an `.ov` overlay child. The fx canvas has z-index 6, so if `.ov` should cover the effects, give `.ov` a higher z-index.

3. **`commitMove(m)`.** Read the victim color before `playMove`, then fire the effects after it:

   | game moment | call |
   |---|---|
   | every move (next to `sfx.move()`) | `fxBoard.moveTrail(mFrom(m), mTo(m), mover === WHITE ? css('--accent') : css('--danger'))` |
   | `mCap(m)` and not held by a Rook trait (next to `sfx.capture()`) | `fxBoard.captureBurst(mTo(m), victimWhite ? css('--p-ink') : css('--e-fill'))`, delayed about 200 ms so it lands as the slide ends |
   | `lt && lt.ok && !lt.blocked` (where `sfx.promote()` fires for traits) | `fxBoard.traitSave(lt.sq >= 0 ? lt.sq : mTo(m), `${lt.label}: saved!`)`. `lt.sq` is where the saved piece went. A Rook "hold" has `sq = -1`, so use `mTo(m)` or the attacker's origin. |
   | `mPromo(m)` | `fxBoard.promoteFlare(mTo(m))` |
   | `!battle.over && inCheck(battle.pos)` (next to `setTimeout(sfx.check, 120)`) | `fxBoard.checkPulse(battle.pos.k[battle.pos.side])` |

   The engine square index is the cell format directly. If the board is ever flipped, call `fxBoard.setFlipped(true)`.

4. **`materialGlint`.** Fire it in the shop when a piece is recruited or a dwelling is upgraded (`buyPiece` / `buyDwelling`, next to `sfx.buy()`), and on the trait-tier "lvl" pip changes. Target the piece's formation square, with tier set to the dwelling level. It can also fire when the formation editor places a piece (`placePiece`), with tier 1.

5. **`endBattle`.** When `sum.nextRegion` is set (the region's seat was taken; see `applyMapResult` in world.mjs), call `fxPage.regionWin({ title: 'Region cleared', subtitle: `+${gold} gold` })` next to `sfx.win()`. For an ordinary win, a single `fxBoard.captureBurst` on the enemy king square or nothing is enough. Keep `regionWin` rare.

6. **`endRunUi(kind, …)`.** When `kind === 'mate'` or `'keep'`, call `fxPage.runOver({ title: kind === 'mate' ? 'Checkmate' : 'The keep has fallen', subtitle: `+${memories} Memories`, desaturate: $('app') })`. Pass `#app`, not body: a filter on an ancestor of a `position:fixed` canvas would re-anchor it. The veil lifts by itself after 3.4 s, revealing the run-over screen.

7. **Map.**
   - `tick()` where `sfx.coin()` fires for held mines: for each held mine node, call `fxMap.mineTick(mapView.offsetX + (n.x + MAP_PAD) * mapView.scale, (n.y + MAP_PAD) * mapView.scale - 6)`. This is the same projection `placeRaidPin` uses. Skip it when `$('mapSec').hidden`.
   - Rival takes a node or raiders strike (the `sfx.check()` toasts "attacks …" and "Raiders strike …", and `sfx.lose()` "… is lost to …"): call `fxMap.rivalCapture(x, y, mapView.scale)` at that node.

8. **Reduced motion** is automatic. The game's own `REDUCED` constant and `fx` both read the same media query.

## Gaps and notes

- The desaturation is a CSS `filter` on a chosen element. A canvas cannot desaturate the DOM beneath it, so on very old WebKit the veil alone carries the mood.
- Confetti and the banner use the fixed page overlay. If the game prefers them clipped to the board, pass `fxBoard` instead; both work.
- No screen shake and no sound. Audio stays in `audio.mjs`; fire both side by side.
- Pixel-scale map effects take an optional `scale` (for example `mapView.scale`); board effects size themselves from the cell size.
