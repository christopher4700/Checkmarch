# Checkmarch battle terrain: API and engine integration

`terrain.mjs` is a pure ES module with no DOM access and no imports. Every top-level name is prefixed (`terr*`, `TERRAIN_*`, `terrain*`), apart from `generateTerrain`, `isBlocked` and `drawTerrain`. None of these names clash with engine.mjs, map.mjs, map-render.mjs, audio.mjs or world.mjs. You can add it to `MODULES` in `checkmarch/build.mjs` and its `toScript()` transform works on it unchanged.

Squares use the engine's indexing: `sq = rank * N + file`, where rank 0 is white's back rank.

## Rules

- A blocked square (rock or water) is a **wall**. No piece can stand on it, land on it or capture onto it.
- **Sliders** (bishop, rook and queen) stop *before* a wall: the ray ends at the wall.
- **Kings** cannot step onto a wall.
- **Pawns** cannot push onto a wall. A double step needs both squares to be open. A pawn capture can never target a wall, because no piece can stand there.
- **Knights leap over terrain.** A knight jump is not a path, so nothing between the start and the landing square blocks it. A wall only removes a landing square. This matches how chess treats knights: they ignore pieces in between, and they ignore terrain in between too.
- Attacks use the same wall-truncated rays, so a wall between a slider and the king also blocks a check. Knight checks pass over walls.
- Rock and water behave the same way in the rules. The kind only changes how the square looks. It is a hook for future rules, such as "water slows" or "rock gives cover".

## Generation

```js
generateTerrain(seed, nodeId, boardN = 8, biome = 'plains', opts = {})
// opts: { tier = 1, type = 'garrison', avoid = [sq...] }
// -> { v: 1, n, biome, tier, type, blocked: [sorted sq], kind: { [sq]: 'rock' | 'water' } }
```

- The result is **deterministic**: FNV-1a hash of `seed|nodeId|boardN|biome`, fed into mulberry32. The output is plain JSON and can be saved as-is. `terrainBlockedSet(t)` gives a `Set` view of the blocked squares.
- **Biomes** (`TERRAIN_BIOME_KEYS`):

  | Biome | Water share | Clusters | Count bias |
  |---|---|---|---|
  | `plains` | about 35% water | small clusters | count bias -0.35 |
  | `highland` | about 10% water | rock outcrops up to 3, which can grow diagonally | +0.45 |
  | `marsh` | about 80% water | ponds and streams up to 3, which grow orthogonally | +0.15 |

  An unknown biome falls back to `plains`.
- **Count** (`terrainCount`):
  - Below tier 3 there is no terrain.
  - From tier 3 the count follows `floor(2 + (tier-3)/6.5 + bias + noise[-0.3, 0.6))`, clamped to 2–6.
  - Citadel and keep nodes (`TERRAIN_FORT_TYPES`) are capped at 3.
  - The measured mean over 500 seeds and 3 biomes is: tier 3: 2.02, tier 8: 2.49, tier 12: 3.10, tier 18: 4.03, tier 25: 5.10, tier 28: 5.59.
- **Guarantees.** These are enforced during placement: every candidate square is checked before it is placed, and a fallback sweep tops up the minimum. `test-terrain.mjs` verifies all of them.
  1. 0 blocked squares below tier 3, 2–6 from tier 3, and at most 3 at citadels and keeps.
  2. Never on the two ranks nearest either side (ranks 1, 2, 7 and 8 on an 8×8 board).
  3. Never all four central squares. On an odd board, never the single centre square.
  4. The open squares stay connected under king-move adjacency (BFS check after each placement).
  5. Never on any square in `opts.avoid`.
- **Pass the enemy formation as `avoid`.** Several of the presets in `engine.mjs` `FORMATIONS` place pieces on black's 6th rank, and *Skirmishers* uses c5 (`Pc5`). Those ranks are outside the guaranteed-clear zone. Suggested call in `world.mjs`:

  ```js
  const army = nodeArmy(run, id);   // existing, in world.mjs
  army.terrain = generateTerrain(run.map.seed, id, 8, biomeFor(run.map.region, n), {   // inside nodeArmy, after `a` is built
    tier, type: n.type, avoid: army.pieces.map(p => p.sq) });
  ```

  The player's formation squares are all on ranks 1–2, so they are always clear. A raid at a mine passes `type: 'raid'`, which follows the normal 2–6 curve. Pass `'keep'` if raids should be capped.
- `terrainProblems(t, {avoid})` lists every guarantee a terrain breaks, or returns `[]`. Use it to validate a loaded save.

## Adapters

| Function | Purpose |
|---|---|
| `isBlocked(t, sq)` | Boolean. A `null` terrain means an open board. |
| `terrainKind(t, sq)` | `'rock'`, `'water'` or `null`. |
| `terrainMask(t, N?)` | `Uint8Array(N*N)`: 0 = open, 1 = rock, 2 = water. Cached per terrain object. |
| `terrainConnected(mask, N)` | King-adjacency connectivity of the open squares. |
| `terrainGeometry(t, N=8)` | `{ WALL, KN, KG, RAYS, PAWN_FROM }` in **exactly the engine's table format and direction order**. With `null` it reproduces the stock tables. |
| `terrainProbe(t, sq, type, color, occ?)` | Single-piece pseudo-legal moves `{moves, captures, pawnAttacks}`. Used by the demo and the tests. |

## Engine integration (engine.mjs)

The engine already gets all of its piece geometry from four precomputed tables (`KN`, `KG`, `RAYS`, `PAWN_FROM`), so terrain only needs those tables swapped. `genMoves`, `isAttacked`, `evaluate`'s mobility terms and `search` then respect walls with no extra cost per node. Pawn pushes are the only moves that use square arithmetic, which gives the one-line movegen change. The full patch is three small edits plus one new function. The test applies exactly these edits to an in-memory copy of `engine.mjs` and runs it.

1. Add a wall table next to the geometry tables:
   ```js
   const KN = [], KG = [], RAYS = [], PAWN_FROM = [[], []], WALL = new Uint8Array(64);
   ```
2. **The movegen line.** In the pawn branch of `genMoves`:
   ```js
   if (!b[to] && !WALL[to]) {                                   // was: if (!b[to]) {
     if (!capturesOnly || promo) out.push(sq | to << 6 | promo);
     if (!capturesOnly && r === startR && !b[to + dir] && !WALL[to + dir]) out.push(sq | (to + dir) << 6);
   ```
   Strictly, `!WALL[to + dir]` is a second condition on the existing double-push line. Without it, a pawn on its start rank could double-step onto a wall on rank 4/5.
3. Add a setter. It copies the tables **in place**, because the engine holds `const` arrays:
   ```js
   export function setTerrainGeometry(g) {
     for (let sq = 0; sq < 64; sq++) { KN[sq] = g.KN[sq]; KG[sq] = g.KG[sq]; RAYS[sq] = g.RAYS[sq];
       PAWN_FROM[0][sq] = g.PAWN_FROM[0][sq]; PAWN_FROM[1][sq] = g.PAWN_FROM[1][sq]; }
     WALL.set(g.WALL);
   }
   ```
4. Battle lifecycle, in the game UI and in balance-bot:
   - Before the first move: `setTerrainGeometry(terrainGeometry(battle.terrain))`.
   - After the battle ends or the player retreats: `setTerrainGeometry(terrainGeometry(null))`.

   The tables are module-global, so only one battle can be active at a time. That is already how the game and the bot work.

What you do **not** need to change:

- `makeMove`/`unmakeMove`: walls never hold a piece.
- `posKey`: terrain is constant within a battle.
- `kingTerm`/pawn shield: a wall square just has no pawn.
- Mate and stalemate detection: these go through `legalMoves`.
- The formation code: deployment ranks are always clear.

**Verified by tests:**

- The patched engine still gives perft 20, 400 and 8902 with empty terrain.
- With terrain, a rook stops before rock and a bishop cannot cross or check through water.
- A knight leaps over a full ring of walls and still gives check across terrain.
- Pawns are blocked by walls.
- `genMoves` matches `terrainProbe` for lone N, B, R and Q on 30 terrains.
- 40 self-play games (3,200 plies, random moves plus `search`) never put a piece on a wall.
- Tables are restored correctly afterwards (perft 3 = 8902 again).

## Rendering

```js
drawTerrain(ctx, terrain, cellPx, palette, theme = 'light', opts = { x0: 0, y0: 0, flip: false })
```

Flat vector glyphs drawn on a canvas, in the same style as the map renderer:

- **Rock:** a faceted boulder with a lit facet, a crack and a pebble, on a soft ground tint with a contact shadow.
- **Water:** rounded tiles with a darker rim and two wave strokes. Water squares that touch orthogonally are bridged, so ponds and streams read as one body.

Each square's shape is seeded by its square index, so every square looks slightly different but stays the same between redraws. Draw terrain after the squares and before highlights and pieces.

**Palette** keys (`TERRAIN_PALETTE_KEYS`): `rock rockHi rockLo rockEdge water waterHi waterLo shadow bed`.

- `TERRAIN_PALETTES.light` and `TERRAIN_PALETTES.dark` are the built-in defaults.
- `terrainPalette(partial, theme)` fills in any missing keys.
- `terrainPaletteFromStyle(getComputedStyle(root), theme)` reads `--terr-<kebab-key>` tokens. For example, `rockHi` is read from `--terr-rock-hi`.

**The game's board is DOM squares (`.sq` divs), not a canvas.** For that board, `terrainSquareSVG(terrain, sq, palette, theme)` returns an SVG string for one square, with the same shapes but no water bridging. Put it inside the `.sq` with `position:absolute; inset:0; pointer-events:none`.

## Files

| File | Contents |
|---|---|
| `terrain.mjs` | The module. |
| `test-terrain.mjs` | `node test-terrain.mjs`. Reads `../checkmarch/engine.mjs` but never writes it. |
| `terrain-demo.src.html` → `node build-demo.mjs` → `terrain-demo.html` | Self-contained artifact page with terrain.mjs inlined. The test fails if the page goes stale. |

## Known gaps

- **There is no biome data in the world yet.** Nodes have no biome. A simple mapping is something like region-based or `mapHashSeed(seed + '|biome|' + id) % 3`. This is left to world.mjs.
- **Terrain is not mirrored or balanced between the sides.** It only avoids both deployment zones and the centre. One side can end up with a more blocked flank.
- **The engine does not yet know about terrain:** the eval has no terrain-specific terms (for example, a pawn permanently stuck behind rock is still valued as a normal pawn). Mobility already reflects walls.
- **`terrainSquareSVG` does not bridge adjacent water squares**, so water on the DOM board shows as separate tiles.
- The `boardN` parameter is honoured by generation, the probe and drawing, but the engine is fixed at 8×8.
