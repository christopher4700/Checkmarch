# skills.mjs — permanent piece-type skills (RuneScape-style)

Each piece **type** (P N B R Q K) has a skill that earns XP from real play and keeps its level
**forever**. Skills live on `state.skills`, never on `state.run`, so `endRun` (which only replaces
`state.run`) leaves them untouched. Losing a run still costs pieces, gold and the map; skills are the
slow, ever-growing layer underneath.

| Type | Skill | Perks |
|---|---|---|
| P | Pawncraft | pawn shop price -0.25%/lvl (full 25% at 99) · +1 free reserve pawn per 10 levels · titles |
| N | Knightcraft | knight price -0.25%/lvl · free starting knight at 30/60/90 · titles |
| B | Bishopcraft | bishop price -0.25%/lvl · free starting bishop at 30/60/90 · titles |
| R | Rookcraft | rook price -0.25%/lvl · free starting rook at 45/90 · titles |
| Q | Queencraft | queen price -0.25%/lvl · free starting queen at 99 · titles |
| K | Leadership | formation-square price -0.25%/lvl · march ticks -0.15%/lvl (99: -14.85%) · titles |

`skills.mjs` is standalone: no imports, no DOM, no storage, no clock, no randomness (~17 KB).
Tests: `node test-skills.mjs` (exit 0, 83 checks).

---

## 1. Save sub-schema

```js
state.skills = { P: { xp }, N: { xp }, B: { xp }, R: { xp }, Q: { xp }, K: { xp }, mg }
```
- `xp` is an integer, 0..`XP_CAP` (50,000,000). Levels are never stored; they're derived.
- `mg` is mine gold banked toward the next mine milestone (0..250).
- A maxed-out save is 133 bytes of JSON.

| Function | Purpose |
|---|---|
| `newSkills()` | all-zero sub-schema |
| `cleanSkills(s)` | repairs anything into a valid sub-schema: `undefined`, `null`, strings, arrays, NaN, negative, `Infinity`, bare numbers (`{P: 123}`), extra keys (dropped), `__proto__` keys. Huge finite xp clamps to the cap. A valid save round-trips unchanged. |
| `skillXp(skills, t)`, `skillLevel(skills, t)`, `totalLevel(skills)` | read helpers (tolerate a broken `skills`) |

No save-version bump is needed. The field is additive, and `migrateState` copies unknown top-level
keys with `Object.assign`. Run it through `cleanSkills` on every load (see Integration).

## 2. Level curve

The RuneScape formula, with a gentler doubling period (`CURVE.div` 9 instead of RS's 7):
`xp(L) = floor( Σ_{l=1}^{L-1} floor(l + 300·2^(l/9)) / 4 )`.

| Level | 2 | 5 | 10 | 20 | 30 | 40 | 50 | 60 | 70 | 80 | 90 | 99 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Total XP | 81 | 367 | 1,022 | 3,404 | 8,535 | 19,575 | 43,347 | 94,596 | 205,169 | 443,857 | 959,262 | 1,918,756 |

Pacing from the tests: a tier-3 win with 3 pawns gives about 56 Pawncraft XP, so **Pawncraft 10 takes
about 19 early wins** (a session or two). A tier-40 win with 8 pawns gives about 328, so **Pawncraft 99 takes about
5,850 late wins**. That's aspirational.

| Function | Returns |
|---|---|
| `xpForLevel(l)` | total XP for level `l` (clamped 1..99; garbage gives 0) |
| `levelForXp(xp)` | level 1..99 (binary search over a precomputed table; garbage gives 1) |
| `levelProgress(xp)` | `{ level, frac, into, need, next }`: `frac` is 0..1 toward the next level (1 at 99), `next` is null at 99 |
| `progressFrac(xp)` | just `frac`, for bars |
| `CURVE`, `MAX_LEVEL`, `XP_CAP` | constants |

## 3. XP award table (`XP_TABLE`, the one tuning knob)

Every battle award is multiplied by `tierMult(tier) = min(4, 1 + 0.04·(tier-1))`. Tier 26 doubles it,
and the cap is reached at tier 76.

| Event | XP | To |
|---|---|---|
| Capture (stood, not undone by a trait) | `capture` 10 × victim pawn-units (`victim`: P1 N3 B3 R5 Q9 K0) | the capturing type |
| Survived the battle (any result except your own King mated) | `survive` 4 per surviving fielded piece | each type |
| Battle won | `win` 8 per fielded piece | each type |
| Battle won, Leadership | `lead` 2 per non-King piece fielded | K (if a King fought) |
| Checkmate delivered | `mate` 150 | the type that gave mate |
| Pawn promoted (any result) | `promote` 30 | P |
| March completed | `march` 6 | K |
| Mine income milestone | `mine` 4 per 250 gold (`mineEvery`), not tier-scaled, at most 40 milestones per call | each type garrisoned at mines (P if none; never K) |

**Flagged for the balance pass:** XP goes by piece type, so in raid and keep defences the castellan King
(id 0) and the militia pawns (ids 1e6+) earn Leadership and Pawncraft too. That's accepted by design. If raids
turn out to be frequent this could be farmed, so the balance pass should check raid frequency against XP per raid.

Losing is still worth something: in a lost or drawn battle you keep the capture, survival and promotion XP.
If your King is mated, only the capture and promotion XP is paid.

## 4. Perks (`PERK_TABLE`, `TITLES`, `TITLE_LEVELS`)

```js
perksFor('N', 12) ->
{ type: 'N', level: 12, skill: 'Knightcraft', title: 'Rider', nextTitle: { level: 20, title: 'Squire' },
  discount: 0.03, discountOn: 'piece',    // 'square' for K
  start: 0,                               // free pieces of this type at run start (reserve)
  marchCut: 0 }                           // K only: fraction off march ticks
```
- `discount = level × 0.0025` (0.25% per level, float-clean: 12 × 0.0025 is exactly 0.03), so every level from 2 to 99 pays something. Level 98 gives 24.5%. Level 99 snaps to the full 25% cap (`PERK_TABLE.discFullAt`), because 99 × 0.25% would only be 24.75%.
- Title rungs are at 1, 10, 20, …, 90 and 99, e.g. Pawncraft: Recruit, Militiaman, **Yeoman (20)**, Footman,
  Sergeant, Veteran, Pikemaster, Warden, Old Guard, Iron Line, Pawn Eternal. Every type has its own 11-rung ladder.
- An unknown type returns `null`, and the level is clamped to 1..99.

**Flagged for the balance bot:** the free starting pieces are kept as designed (at 99: 9 pawns, 3 knights,
3 bishops, 2 rooks and a queen), and the balance pass after integration will retune them if region 1 steamrolls.

How the perks fit the other permanent and per-run systems:
- **Dwellings** (traits per run) and **forge materials** (tiers): skills don't touch traits or materials.
- **Memories**: Militia gives placed starting pawns and Wider camp gives squares. Skill pawns go to the **reserve**
  and are free, so they don't increase `bought`.
- **Shop discounts**: town and blessing `run.shopDisc` is "max wins". The skill discount is per type and
  **multiplies** on top of it.

Helpers:

| Function | Purpose |
|---|---|
| `allPerks(skills)` | `{P: perks, …, K: perks}` |
| `skillMods(skills)` | flat cache for engine code: `{P,N,B,R,Q: fraction off, sq, march}` |
| `skillPrice(skills, t, price)` / `squarePriceSkill(skills, price)` | the price after the skill discount (rounded) |
| `marchTicksSkill(skills, ticks)` | march ticks after Leadership (never below 1) |
| `startBonus(skills)` | `{P,N,B,R,Q}` free pieces for a new run |
| `grantStart(run, skills)` | pushes those pieces onto `run.roster` (reserve), advances `run.nextId`, sets `run.skillStart`, and runs once per run. Returns the counts, or null. |
| `startCount(t, level)` | per-type start bonus at a level |

## 5. Level-up "dings"

```js
levelUps(oldXp, newXp, type) -> [{ type, skill, level, text, title, start, big }]   // one per level crossed, lowest first
// "Knightcraft 12 — knights now 3% cheaper"
// "Pawncraft 20 — pawns now 5% cheaper, runs start with 2 extra pawns, title: Yeoman"
// "Rookcraft 86 — rooks now 21.5% cheaper"     "Rookcraft 99 — rooks now 25% cheaper (max), title: Unbreached"
// "Leadership 12 — squares now 3% cheaper, marches 1.8% faster"
```
- `title` is the new title, or null. `start` is the number of free pieces gained at that level.
- `big` is true on a title change, a start bonus, every 10th level, and 99. Play the bigger fanfare for those.
- If `newXp <= oldXp`, the result is `[]`. Without a valid type the entries are generic (`"Level 12"`).
- `dingToasts(dings)` gives **one toast per skill**: a jump from 9 to 12 folds into
  `"Pawncraft 12 — pawns now 3% cheaper, runs start with 1 extra pawn, title: Militiaman"`
  (the deltas over the whole jump). Big toasts come first, and each has `from` and `level`.

## 6. Award API

```js
newTally(types)                 // types fielded at battle start, e.g. ['K','P','P','N']
noteCapture(tally, by, victim)  // a player capture that stood
noteLoss(tally, type)           // a player piece lost (that stood)
notePromotion(tally)            // a player pawn promoted
noteMate(tally, type)           // the player's piece that delivered mate
cleanTally(t)                   // repair after JSON / a corrupt save
battleXp(tally, result, tier)   // result 'win' | 'draw' | 'loss' | 'mate' -> gains {type: xp}
captureXp(by, victim, tier)     // a single capture (for a floating "+30"); battleXp already counts these
marchXp(tier)                   // {K: xp}
mineXp(skills, gold, types)     // banks gold in skills.mg (mutates); gains per milestone
mergeGains(...gains)
applyGains(skills, gains)       // MUTATES skills -> { gained: {type: added}, dings: [...] }
gainText(gained)                // "+56 Pawncraft · +19 Leadership"
```
The tally is tiny plain JSON: `{ f: fielded, l: lost, c: capture units by type, p: promotions, m: mater }`.

---

## 7. INTEGRATION

The function names below are from the green tree (`game.src.html`, `engine.mjs`, `world.mjs`). Line numbers
move, so search by name. Import everything as `import * as SK from './skills.mjs'` and inline it with the
other modules in `build.mjs`.

### 7.1 State lifecycle
- **`newState()`** (engine) or `freshState()` (page): add `skills: SK.newSkills()`.
- **Load** (boot, after `migrateState(data.state)`): `st.skills = SK.cleanSkills(st.skills)`. This also fixes
  saves from before skills existed. No `SAVE_VERSION` bump is needed. (The green tree is at v5; the brief's v4 is
  out of date, and this doesn't change either way.)
- **`endRun(state, …)`** only does `state.run = newRun(…)`, so `state.skills` persists automatically.
  `test-skills.mjs` checks this against a mock `endRun`. Right after **every** `newRun` (in `endRun`, in
  `rebuildRun` from the Memories shop's pristine rebuild, and in `newState`), call
  `SK.grantStart(state.run, state.skills)` and then `state.run.skillMods = SK.skillMods(state.skills)`.
  On the page, the two call sites are `endRunUi()` and the Abdicate handler (both call `endRun` and then
  `ensureMap`), plus `freshState()`. `grantStart` is idempotent per run (`run.skillStart`), so an extra call is harmless.
- On load, also refresh `run.skillMods = SK.skillMods(state.skills)`. It's derived, so always recompute it rather than trusting the stored copy.

### 7.2 Prices (engine, small change)
In `buyPiece(run, t)` and `buySquare(run, sq)`, apply the skill discount to the **base** price before `spend`
(which then applies the town/blessing `effPrice`):
```js
const sm = run.skillMods || {};
const base = Math.round(piecePrice(t, run.bought[t]) * (1 - (sm[t] || 0)));      // buyPiece
const base = Math.round(squarePrice(run.squaresBought) * (1 - (sm.sq || 0)));    // buySquare
```
Use the same expression wherever a price is **shown**: `renderPanel` shop rows (`priceBtn('buy:'+t, …)`), the
formation-square row, and `refreshShopButtons`. Otherwise the button and the charge will disagree. Dwellings,
Tactician and forge prices are **not** discounted.

### 7.3 Marches (world)
In `startMarch`, apply Leadership:
`need: Math.max(1, Math.round(marchTicks(run, id) * (1 - ((run.skillMods || {}).march || 0))))`. Also use it in
the "March to X · N ticks" label in the map card (`mv(marchTicks(r, ui.node))`).

### 7.4 Battle tally: battle start → every move
- **`startBattle(b)`**: build `b.sx = SK.newTally(types)`, where `types` lists every WHITE piece on `b.pos.b`, typed
  `(pieceById(run(), b.ids[sq]) || {}).t || TYPE_CH[p & 7]` (castellan id 0 and militia ids 1e6+ fall back to the board type).
- **`commitMove(m)`**: capture these *before* `playMove(battle, m)`:
  `side = battle.pos.side, from = mFrom(m), to = mTo(m), cap = mCap(m), aId = battle.ids[from], vId = battle.ids[to], aPc = battle.pos.b[from]`.
  After `playMove`: `lt = battle.lastTrait; stood = !(lt && lt.ok && !lt.blocked)` (a Bulwark hold, or a victim that
  sidestepped or fell back, did **not** capture).
  - `side === WHITE && cap && stood` → `SK.noteCapture(battle.sx, typeOf(aId, aPc), TYPE_CH[cap & 7])`
    (a promoted pawn capturing as a queen is credited to **Pawncraft** through its roster type)
  - `side === BLACK && cap && stood && vId >= 0` → `SK.noteLoss(battle.sx, typeOf(vId, cap))`
  - `side === WHITE && mPromo(m)` → `SK.notePromotion(battle.sx)`
  - `battle.over && battle.over.result === 'win' && battle.over.reason === 'Checkmate'` → `SK.noteMate(battle.sx, typeOf(aId, aPc))`
- **Save/hot-reload**: `serBattle` lists its fields explicitly, so add `sx: b.sx`. In `deserBattle`, add
  `sx: o.sx`, and run `SK.cleanTally` on it in the page after deserializing. A battle restored without `sx` just
  starts an empty tally (`SK.newTally([])`), which loses only that battle's XP.

### 7.5 Battle resolution: `endBattle(result, reason)`
Right after `sum` is computed by any of the three paths (`finishDefence`, `finishBorder`, or
`finishBattle` + `applyMapResult`), and **before** the `mate || sum.runOver` branch that returns into `endRunUi`, add:
```js
const r = SK.applyGains(state.skills, SK.battleXp(b.sx, result, b.tier));
sum.xp = r.gained; sum.xpText = SK.gainText(r.gained);        // show on the result overlay (showResult)
run().skillMods = SK.skillMods(state.skills);
queueDings(r.dings);
```
`result` here is the raw engine result. Raids and borders map a castellan "mate" to a loss in `sum`, but
passing the raw `result` is intended: a castellan defeat pays no survival XP.

### 7.6 March arrival: `arriveNow()`
When `arrive(run())` returns a battle (the march completed), add
`queueDings(SK.applyGains(state.skills, SK.marchXp(b.tier)).dings)`.

### 7.7 Mine income: `applyTicks(n)`
After `worldTick`:
```js
if (res.gold > 0 && heldMines(run()).length) {
  const types = Object.values(run().map.garrison || {}).flat().map(id => (pieceById(run(), id) || {}).t);
  queueDings(SK.applyGains(state.skills, SK.mineXp(state.skills, res.gold, types)).dings);
}
```
`res.gold` includes the keep's base income. That's fine, since the milestone is tiny. The gate on held mines
keeps a mine-less region from paying anything. Offline catch-up goes through the same path and is capped.

### 7.8 Dings: toast + sound
```js
function queueDings(d) { for (const t of SK.dingToasts(d)) { toast(t.text); t.big ? sfx.win() : sfx.promote(); } }
```
`toast()` replaces the previous message. With several skills dinging at once, show the first (big-first
order) and append ` (+2 more)`, or queue them about 1.2 s apart. Respect `settings.sound`. Under
`prefers-reduced-motion`, skip any bar-fill animation, but keep the toast.

### 7.9 Suggested compact UI (Army tab)
At the top of `ui.tab === 'army'`, above the Roster, add a **Skills** block: one 44px-tall row per type, in the order K Q R B N P:
```
♘  Knightcraft 12 · Rider                           3% off
   ▓▓▓▓▓▓▓▓░░░░░░░░░░  (4px bar, SK.progressFrac(xp))   812 to 13
```
- Glyph (`whiteGlyph(t)`), then `${skill} ${level}` in tabular numbers and the title in muted text. Right-aligned:
  the headline perk (`discount`, or `start` if it's above 0). Under that, a thin bar (`height:4px; background:var(--line)`
  with an inner `var(--accent)` fill at `frac*100%`) and `need` XP to the next level.
- Tapping a row expands one line: `nextTitle` ("Squire at 20") and the next start bonus.
- Header line: `Total level ${SK.totalLevel(state.skills)}`.
- Result overlay (`showResult`): one muted line, `sum.xpText`.
- Run-over screen: "Your skills carry over" plus the total level. It's the consolation for a harsh loss.

## 8. Balance decisions (recorded)
- Discount: 0.25% per level, with the full 25% landing exactly at 99, so every level pays.
- Free starting pieces: kept as designed; the balance bot checks region 1 after integration.
- Leadership march speed: wanted. Fewer ticks per march means leveling is felt.
- Mine XP from `worldTick` gold (which includes base income) is an accepted approximation.
- XP from defensive fights is accepted; the balance pass checks raid frequency.
- XP scales by tier (not by region or elo band).
- Pieces bought later (knights, queens) level more slowly at first. That's accepted, and RuneScape-like.
