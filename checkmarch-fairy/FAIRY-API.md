# Checkmarch fairy pieces: API and engine integration

`fairy.mjs` is a pure ES module with no imports and no DOM access. It makes new piece types data-driven:

- Each piece is one row in `FAIRY_ROSTER`, with a Betza string.
- `parseBetza` turns the string into components.
- `compileFairy` turns the components into per-square tables for an N×N board.
- Four hooks plug into `engine.mjs`: `gen`, `attacked`, `evalPiece` and `evalAdjust`.

`engine-patch.mjs` holds the engine patch as code: `patchEngineSource(src)`. `test-fairy.mjs` and `calibrate-fairy.mjs` load a copy of `../checkmarch/engine.mjs` patched in memory. The original file is never written.

## The roster

| type | ch | id | Betza | value (cp) | kind | cap | lag | notes |
|---|---|---|---|---|---|---|---|---|
| 8 | M | commoner | `WF` | 300 | leaper | none | 1 | |
| 9 | H | champion | `WAD` | 400 | leaper | 2 | 1 | |
| 10 | W | wizard | `FC` | 375 | leaper | 2 | 1 | Bought as an opposite-colour pair. The pair bonus is +40. |
| 11 | C | cannon | `mRcpR` | 450 | hopper | 2 | 1 | 450 on a full board, falling linearly to 350 at 8 men (`cannonValue(men)`). |
| 12 | J | nightrider | `NN` | 550 | rider | 1 | 1 | |
| 13 | A | archbishop | `BN` | 825 | compound | 1 | 2 | Gated entry. |
| 14 | E | chancellor | `RN` | 875 | compound | 1 | 2 | Gated entry. |
| 15 | G | gryphon | `t[FR]` | 650 | bent | 1 | 2 | `flag`: value not measured. Ship it weak (see calibration). |
| 16 | Z | amazon | `QN` | 1150 | compound | 1 | 0 | Leveling damping applies. `enemyFirst`: bosses field it before the player can own one. |

- Type 7 is reserved.
- Type 17 is reserved for the Lion, which is out of scope: it needs a two-sub-move search.
- Each row also carries `name`, `region` (relative unlock region), `via` (delivery channel) and `plainWords`.
- Lookups: `FAIRY_BY_ID`, `FAIRY_BY_TYPE` and `FAIRY_BY_CH`.
- Most functions that take a piece accept an id, a type number, a letter or a roster row.

### Movement text (`plainWords(id)`, also shown in the diagram)

The rule is that the game explains everything: each text says what blocks the piece, what it jumps, and how it captures.

- **Commoner:** Steps one square in any direction, like a king. It is not royal, so it can be captured and can walk into danger.
- **Champion:** Steps one square straight (up, down, left or right), or jumps exactly two squares straight or diagonally. The jump passes over anything in between.
- **Wizard:** Steps one square diagonally, or makes a long knight jump: three squares one way and one square to the side. It jumps over pieces and always stays on its own square colour, so wizards come as a pair, one for each colour.
- **Cannon:** Moves like a rook when it is not capturing. To capture, it must jump: along a straight line it leaps over exactly one piece (of either side, called the screen) and takes the first enemy piece behind it.
  - With no screen it cannot capture, and it cannot check along an empty line.
  - Rocks and water stop it and never count as a screen.
- **Nightrider:** Makes knight jumps over and over in one straight line, like a rook made of knight moves. It stops at the first piece it lands on, and captures it if it is an enemy.
  - Pieces it jumps over between landings do not block it.
  - A piece, rock or water on a landing square does block it.
- **Archbishop:** Moves as a bishop or as a knight, its choice each turn.
- **Chancellor:** Moves as a rook or as a knight, its choice each turn.
- **Gryphon:** Steps one square diagonally, then may keep going in a straight line away from where it started: up or down, or sideways, whichever points outward. The diagonal square must be empty for it to keep going.
- **Amazon:** Moves as a queen or as a knight, its choice each turn. The strongest piece you can own.

## The Betza subset (`parseBetza`)

**Atoms:**
- W (1,0), F (1,1), D (2,0), N (2,1), A (2,2), H (3,0), C (3,1), Z (3,2), G (3,3).
- Shorthands: `K`=WF, `R`=WW, `B`=FF, `Q`=RB.

**Modifiers:**
- Doubling an atom makes it a rider: `NN`, `WW`.
- A trailing number caps the range: `R2`, `NN3`.
- Prefixes:
  - `m`: move only.
  - `c`: capture only.
  - `p`: hop over exactly one screen. Riders only.
- `t[XY]`: bent rider. One `X` step, then `Y` rides in the directions whose dot product with the step is above 0. For `t[FR]`, those are the two rook directions that point outward.

**Rejected with an error:** direction limits (f b s l r v), `n` (lame), `g` (grasshopper), `j`, `a` (multi-leg), and igui. None of these is needed for the shipping roster.

A component is `{ atom, vecs, range (1 = leap, 0 = unlimited, k = capped), mode (1 move | 2 capture | 3 both), hop, bent }`.

## The three kernels (plus the bent leg)

| Kernel | Used by | Walls (the engine's `WALL`, read live) | Pieces |
|---|---|---|---|
| Leap table, `leapTo[sq]` with per-target mode flags | Leap atoms | A wall only removes a landing square. Leaps pass over walls, like the knight rule in TERRAIN-API. | Any piece is jumped. |
| Ray walk with range cap | W, F and N riders: rook, bishop and nightrider vectors | Stops before a wall. For a nightrider, a wall on a *landing* point stops the ray. Squares between landings are jumped. | Stops at the first piece, and captures it if it is an enemy. |
| Hopper walk (hurdle state) | `p` components (the cannon's `cpR`) | Stops before a wall. A wall is never a screen. A wall between screen and target blocks. | Exactly one screen (any colour), then captures the first piece beyond it if that piece is an enemy. Quiet hops beyond the screen happen only if the component has `m`. |
| Bent: one step, then outward rides | `t[..]` | A wall on the step square kills the branch. The legs stop before walls. | An occupied step square is a capture (enemy) or a block, and the branch stops there. |

- Divergence (`m`/`c`) is applied per component, so the cannon's `mR` never captures and its `cpR` never makes a quiet move.
- If two components can reach the same square on an empty board, the piece is flagged `overlap`, and `gen` removes duplicate moves. No roster piece has overlapping components.
- Moves come out in the engine's format: `from | to << 6 | captured << 13`.

## Attack detection: `attacked(b, sq, by)` / `attacks(pos, sq, by)`

`attacked` answers whether a **fairy** piece of side `by` could capture an enemy piece standing on `sq`. The engine's own scan still covers P, N, B, R, Q and K. `setFairyPieces` builds a reverse plan from **capture components only**, keyed per vector, with a type bitmask:

- **Leaps:** `STEP[-v][sq]` holds a `by` piece whose type is in the mask.
- **Rides:** walk `-v` from `sq` to the first piece. It counts if it is a `by` piece and that type's range is at least the distance. Walls stop the walk.
- **Hops:** walk `-v` to the first piece, which is the screen. That square must not be a wall, and a wall stops the walk. Continue to the next piece; it counts if it is a `by` hopper.

  So a third piece moving **onto** the line gives check, a king **capturing** an adjacent screen (`Kxe2`) removes the check, and a check along an **empty** line never happens.

  Capturing the screen with any piece other than the king does *not* help, because the capturer becomes the new screen. The tests check this: `Nxe5` stays illegal.
- **Bent:** for each pair (step `a`, leg `w`), the attacker is at `sq - a` (the bare step), or at `f - a` for every `f = sq - k·w` reached through empty, open squares.

The cost is zero when no fairy piece is active (`setFairyPieces([])`). Otherwise the cost depends only on the vectors of the *active* types.

## Encoding change (needed: types 8 and up do not fit in 3 bits)

The engine encodes a piece as `color << 3 | type`, so type is 3 bits and colour is bit 3. Type codes 8 and up need a wider field. The patch widens the encoding to:

```
piece code = color << 5 | type          type = p & 31, color = p >> 5   (max code 63, fits Int8Array)
move       = from | to << 6 | promo << 12 | captured << 13   captured = (m >> 13) & 63   (19 bits)
```

`engine-patch.mjs` applies this to `engine.mjs` as seven regex rules. They touch piece codes only: `p`, `q`, `pc` and `cap`, `.b[..]` reads, `<< 3`, and `(m >> 13) & 7|15`. Square arithmetic is not touched. On the current file they hit 14 + 1 + 9 + 17 + 2 + 5 + 2 places.

For a hand integration, add helpers and change the call sites to use them:

```js
export const CSH = 5, TMASK = 31;
export const pcColor = p => p >> 5, pcType = p => p & 31;
```

**Call sites outside engine.mjs that must change** (found by grep):

- `world.mjs`:
  - `:867` uses `pc & 7` and `pc >> 3`, and `'PNBRQK'[(pc & 7) - 1]`. Use `TYPE_CH[pcType(pc)]` instead.
  - `:1059`, `:1062`, `:1073` use `TYPE_CH[pc & 7]` and `pc >> 3`.
- `game.src.html`:
  - `:674` and `:675` use `p >> 3` and `TYPE_CH[p & 7]`.
  - `:1524` uses `p >> 3`.
  - Piece glyphs: fairy letters need glyphs, for example an SVG per piece, because there is no Unicode chess glyph for them.

**Saves:** `serBattle` stores raw board codes. Bump `SAVE_VERSION` to 6, and in `deserBattle` for older saves run `b = migrateBoardCodes(o.b)` and `last = migrateMove(o.last)`, plus `moves.map(migrateMove)` and `start.b`. Old and new codes overlap (an old black pawn, 9, is a new white champion), so the migration must be keyed on the save version, never guessed.

## Engine patch points (engine-patch.mjs `HOOK_EDITS`)

```js
// 1. next to setSkillsModule
let FX = null;
export function setFairyHooks(h) { FX = h || null; if (h) h.bind({ WALL, VAL, TYPE_CH, CH_TYPE, UNITS, PIECE_NOUN }); }

// 2. isAttacked, last line before `return false`
if (FX && FX.attacked(b, sq, by)) return true;

// 3. genMoves, before the slider branch
} else if (t > 7) {
  if (FX) FX.gen(b, sq, t, side, out, capturesOnly);
} else { /* B R Q rays */ }

// 4. evaluate, in the per-piece switch
default: if (t > 7 && FX) v += FX.evalPiece(b, sq, c, t, endgame);

// 5. evaluate, after `let s = sc[0] - sc[1];`
if (FX) s += FX.evalAdjust(b);       // white perspective
```

`bind` writes into the engine's own tables in place:

- `VAL[8..16]`: values, re-banded for N=10.
- `TYPE_CH` and `CH_TYPE`: the letters `M H W C J A E G Z`, so `createBattle`'s `CH_TYPE[pc.t]` takes fairy roster letters unchanged.
- `UNITS`: pawn units, for enemy budgets.
- `PIECE_NOUN`.

`bind` also keeps a live reference to `WALL`. Because `setTerrainGeometry` updates `WALL` in place, no terrain change is needed.

These need no change:

- `makeMove` and `unmakeMove`: they carry the full code.
- `posKey`: codes stay at 63 or below.
- `legalMoves`, `perft`, mate and stalemate detection, `search` ordering (`VAL[cap]`) and `material`.

**Battle lifecycle** (game UI and balance-bot), following the terrain pattern:

1. Once at load: `setFairyHooks(fairyHooks)`.
2. At battle start: `setFairyPieces(fairyTypesOn(pos.b).concat(gatedTypes))`, the types present plus any gated types.
3. After the battle: `setFairyPieces([])`.

If a fairy piece is on the board but not active, it generates no moves and gives no checks, so always include the gated types. Promotion stays queen-only, so no new type can appear mid-battle.

## Board-size awareness (N)

- `setFairyPieces(list, N)`, `makeGeometry(N)` and `compileFairy(def, G)` all take N, and every table is built for N×N.
- `moveDiagram(id, { N })` works today for N=10. The centre is e5, and the tests check counts there: amazon 43, cannon 18, commoner 8.
- `fairyValue(id, N)` and `fairyValueTable(N)` re-band values on 10x10 per `FAIRY_TUNE.board10`:

  | kind | factor |
  |---|---|
  | leaper | ×0.92 |
  | hopper, rider, compound | ×1.0 |
  | bent | ×1.02 |

The engine is fixed at 64 squares. When the integrator moves it to 10×10:

1. Change the move layout to `from | to << 7 | promo << 14 | cap << 15`. fairy.mjs switches its own shifts for N > 8 (`MSH`/`CAPSH`).
2. Make `WALL` sized N·N.
3. Rebuild the KN, KG, RAYS and PAWN_FROM tables.
4. Call `setFairyPieces(list, 10)`.

Gate bits (19 to 24) also move up on 10x10. Use 21 to 26.

## Evaluation (`FAIRY_TUNE`)

- **Base value:** `VAL[type]`, from the roster.
- **`evalPiece`:** mobility for every piece, plus centrality for leapers (`CENT·4 − 10`) and for knighted compounds (`CENT·2`). A commoner in the endgame centralises like a king (`CENT·5`).
- **`evalAdjust`** (board-wide, white perspective):
  - **Wizard pair:** +40 when one side has wizards on both colours.
  - **Cannon:** −0 to −100 per cannon as the number of men on the board falls from 32 to 8.
  - **Amazon leveling:** −12 cp per enemy "lesser point" above 6, capped at −150. Minors, rooks and fairy pieces under 600 count 1 each; pawns count 0.5. Against a full army that is −48; against a bare king it is 0.

Every constant is in `FAIRY_TUNE`, ready for calibration.

## Movement diagram for the unlock ceremony

```js
moveDiagram(id, { N = 8, sq = centre }) -> { id, name, betza, N, sq, moves:[sq], captures:[sq], plainWords, grid:[row strings], example? }
```

- The piece stands on an empty board: d4 on 8×8, e5 on 10×10.
- `captures` lists the squares where it could capture if an enemy stood there.
- **Cannon:** its `captures` list is empty, and `example` places one screen two squares ahead (d6) and lists the hits beyond it (d7, d8).
- `grid` rows run from the top rank down. Symbols:
  - `@`: the piece.
  - `o`: move and capture.
  - `m`: move only.
  - `x`: capture only.
  - `#`: the screen.

Animate from these sets. The Betza string is shown as flavour text.

## Delivery: dwellings and Seirawan-style gating

The report's rule: a bought piece waits off-board behind its nominated home square on the formation's back rank, and enters when that square is vacated. The pure helpers:

```js
gate = { color, sq: homeSquare, t: fairyType }
expandGates(legalMoves, gates, side)  // + one variant per move leaving a home square: m | GATE_FLAG | t << GATE_SHIFT
gateDrop(b, m, side) / gateLift(b, m) // after makeMove / before unmakeMove (strip bits 19+ before calling them)
gatesAfter(gates, m, side)            // new list: a gate move consumes; leaving the square without gating lapses;
                                      // a capture on an enemy home square (its occupant dies) lapses that gate
```

To wire gating into the engine:

1. Add `pos.g`, the gates per side, kept as a small stack for unmake.
2. Make `makeMove` mask `m & 0x7ffff` for the normal part, then call `gateDrop`.
3. Have `genMoves` append the variants.
4. Make `posKey` include `pos.g`, otherwise repetition detection and any transposition table will miscount.
5. Pass the gated types to `setFairyPieces`.

`search` then handles gate-with-check and gate timing natively.

The UI shows the waiting piece as a small ghost behind its home square, with a "lapses if this piece dies" hint.

On the 10×10 transition, new pieces start on the added files instead (Omega-style), and no gating is needed.

## Caps, prices and the enemy mirror

- **Copy caps:** `fairyCanBuy(id, owned)` reads `cap`. Wizards are bought as a pair (+2). Commoners are uncapped.
- **Prices:** `fairyBasePrice(id) = 600·(value/900)^1.75`, anchored on the queen. The exponent 1.75 fits the existing R and Q bases. `fairyPrice(id, n) = base·1.7^n`.

  | piece | base price |
  |---|---|
  | commoner | 88 |
  | champion | 145 |
  | wizard | 130 |
  | cannon | 178 |
  | nightrider | 253 |
  | archbishop | 515 |
  | chancellor | 571 |
  | gryphon | 339 |
  | amazon | 921 |

  The report wants the archbishop's first copy to "cost an era". If so, raise the exponent toward 2, or gate the piece behind the Cathedral level.
- **Enemy lagged mirror:** `enemyFairyPool(unlocks, region, { band, minBand, rival, boss })`.
  - The enemy band fields a piece `lag` regions after the player unlocked it: 1 for the cheap pieces, 2 for the compounds and the gryphon.
  - Bands below `minBand` stay frozen with no fairy pieces, so dropping down a band shows objective growth.
  - `rival: true` previews the player's next locked piece.
  - `enemyFirst` pieces (the amazon) appear for `boss` from their roster region.

## Calibration (`node calibrate-fairy.mjs [games=40] [depth=2] [nodes=2500]`)

Each piece X takes the place of a reference piece S in one side's standard array. Every seeded opening (4 random plies) is played twice with colours swapped. Score is converted to centipawns using a two-pawn-odds baseline measured at the same search strength.

Games are adjudicated on *neutral* material, which counts X at S's value, so adjudication never assumes the value being measured. Run 2026-11-12, with 40 games per piece at depth 2 and about 5 s per piece:

| piece | vs | score | implied cp (±1σ) | table |
|---|---|---|---|---|
| baseline: two pawns down | — | 32.5% | 8.8% score per pawn | |
| commoner | N | 53.8% | 363 ±90 | 300 |
| champion | N | 63.7% | 477 ±87 | 400 |
| wizard (pair) | B+B | 87.5% | 544 ±30 each | 395 incl. half the pair bonus |
| cannon | B | 52.5% | 359 ±90 | 450 |
| nightrider | R | 47.5% | 471 ±90 | 550 |
| gryphon | R | 47.5% | 471 ±90 | 650 |
| archbishop | Q | 47.5% | 871 ±90 | 825 |
| chancellor | Q | 32.5% | 700 ±85 | 875 |
| amazon | Q | 80.0% | 1243 ±72 | 1150 |

How to read the results:

- Depth-2 self-play is a weak player, and both sides evaluate with the table values, so these numbers are directional only.
- They agree with the report on three points:
  - The archbishop is close to the queen.
  - The amazon is above 1150.
  - The gryphon should ship weak.
- They suggest the wizard pair is underpriced, at about 540 each against 395, which is the CwDA direction.
- The cannon is overpriced at this depth. A shallow search plays screens badly, so re-measure at depth 3 or 4.
- Before changing any value, run at least 400 games per piece at the shipping elo, for example `node calibrate-fairy.mjs 400 3 8000`.

## Files

| File | Contents |
|---|---|
| `fairy.mjs` | The module (about 28 KB). |
| `engine-patch.mjs` | `patchEngineSource`, `loadPatchedEngine`, `ENCODING_RULES` and `HOOK_EDITS`. Node only. |
| `test-fairy.mjs` | Run with `node test-fairy.mjs`, which takes about 1.5 s. Exits 0 when all checks pass. Reads `../checkmarch/engine.mjs` and `../checkmarch-terrain/terrain.mjs`. |
| `calibrate-fairy.mjs` | The self-play harness. |

## Known gaps

- **Lion:** out of scope. It needs a double-move generator and the anti-trade rules as legality.
- **Gating:** only pure helpers ship. The engine part, `pos.g` in makeMove and posKey, is specified above but not patched in.
- **Eval:** no hopper-specific terms beyond decay and mobility. For example, the search does not value "screen available on the king file". Depth-2 play with the cannon is weak.
- **Validation:** not yet checked against Fairy-Stockfish. Perft is validated against an independent naive oracle in the tests (3 positions, depth 3: 32613, 21362 and 17214 nodes).
- **Betza:** no direction modifiers, so no forward-only pieces such as a Berolina or shogi-style piece without new kernel flags.
