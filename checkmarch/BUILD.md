# Checkmarch: build notes (settings pass)

## Full balance report on v18 (2026-11-13 ~04:00, parts 4-5, 770s)
Healthy after the overnight passes: fresh-account run payouts mean 190 / median 240 against a 1469 shop; push-or-abdicate crosses 1x at R6 (0.96x); 3.12 battles per 168-tick week; runs end "stuck in region" 17/20 vs mated 7 — deaths are traceable. Marathons: every band takes 5-7 runs to clear the whole shop and stalls in R6-R9 (600 stalls R7, 900 best reached R9, 1500 bites from R4). R1-R4 still ~100% for maxed accounts, acceptable as earned power. FLAG: the chancellor (8052 gold, unlock R7) was never bought in 12 runs that reached R7, and the archbishop only 7/16 — exotic top-end prices may be above what a run that deep can spare; revisit with Christopher before changing (bot buying policy may also just not save for them). Raw tail: scratchpad/v18_full_report_tail.txt.

## Settings pass
The design doc's Polish milestone names "settings". The Run tab already had a Settings block (a sound on/off button,
threat shading, tips, replay tips, the piece set and the two-tap "Reset save"), the top bar had the sound button and a
theme cycle button, and the CSS already guarded its dark tokens with `:root:not([data-theme="light"])` inside
`prefers-color-scheme: dark` plus `:root[data-theme="dark"]`. What was missing: volume, a visible theme choice, and
save export/import. Changes are in `game.src.html`, `world.mjs` and `test-world.mjs`. No module copy changed (the
freshness checks pass), no balance number changed, save stays **v6**, and `tick()` (with its showResult self-heal) is untouched.

- **Where:** a gear button in the top bar takes the place of the old "Auto/Day/Night" cycle button. It switches to the
  Run tab and scrolls to the Settings heading (`#setHead`). On the run-over screen, where the panel is hidden, it shows a
  toast instead. The theme choice moved into Settings. The top bar is now narrower, and at 360-400 px the "RUN n" label
  no longer collides with the buttons. Settings is grouped as Sound, Theme, Play, Save and Danger zone (`settingsHtml()`).
- **Sound:** the existing on/off button, plus a Volume slider (0-100 in steps of 5, a 44 px tall target, disabled while sound
  is off). It calls only the existing audio API, `audio.setVolume({ master })`, live on `input`, and saves on `change`.
  Boot and `toggleSound` re-apply it. The new field is `state.settings.vol` (0..1, default 0.8, which is the module's own master default).
- **Theme:** an Auto / Light / Dark segmented control. `applyTheme()` sets or removes `data-theme`, as it did before.
- **Settings in the save:** `world.mjs cleanSettings()` replaces the old `Object.assign` defaults at boot. Every field is
  optional (`theme`, `sound`, `speed`, `threat`, `vol`), so old saves load. It also repairs junk values: an unknown
  theme becomes auto, a speed outside 1/2/4 becomes 1, and the volume is clamped to 0..1 and rounded to 1%.
- **Export:** "Export save" shows the save as text in a read-only box, and "Copy" copies it (Clipboard API, with an
  `execCommand` fallback that selects the box). The string is `world.mjs exportSaveText(snapshot())`, which is exactly the JSON
  the page keeps in localStorage (`{ state, battle }`). It is about 3 KB on an early save.
- **Import:** paste into the box, then press "Import save". `world.mjs parseSaveText()` never throws. It runs a JSON
  parse in try/catch, checks the shape, and checks the version: a missing version is refused, a version above 6 is
  refused as "from a newer version", and v1 to v5 are accepted and migrate. It then runs a trial `migrateState` on a
  clone. A bad paste shows a plain reason and arms nothing. A good paste arms a **two-step confirm**, the same `ui.armed`
  pattern the reset uses: the button turns into a red "Confirm: replace my save", a status line names what will replace
  the save (run, region, Memories, best tier), and there is a Cancel. Only the second tap loads the save, and it loads it
  the way boot loads a stored save: `migrateState`, then `migrateBattleSave(battle, v)` + `deserBattle`, then a fresh coach (`initCoach`).
- **Reset everything:** the existing two-tap reset under a clearer label. Reset and import now share one
  `replaceSave(state, battle, toast)`, which holds the old reset body: it clears the UI state, keeps the device settings
  (theme, sound, volume), saves and re-renders. The reset logic is not duplicated. Reset still clears storage and calls `coach.reset()`.
- **Tests:** world 533 -> **547** (14 new: settings defaults, old-save settings, junk repair, volume clamping, settings
  persisting through save + load, export = serialized save, export -> import round trip, import keeps Memories/runs/held
  nodes/settings, whitespace in a paste, a battle in flight surviving the round trip, 12 bad inputs rejected without
  throwing, the newer-version refusal, parsing leaving the source save untouched, a v5 save accepted). Engine 20/20.
  The balance bot is unchanged: 88.7% tier 1-5 win rate, region-1 mean 1548. smoke.mjs and variety-smoke.mjs pass.
  The scratchpad `settings-smoke.mjs` passes 23 checks x light/dark at 400 px. It opens the gear, sets Dark/Light/Auto,
  toggles sound, sets the volume (spying on `audio.setVolume`), exports, copies, refuses a bad paste and a v7 paste,
  resets, imports with arm/cancel/confirm, and reloads to check persistence. It also checks for no horizontal scroll,
  44 px targets and no page errors. Screenshots: `settings-{light,dark}-{1,2}.png`.
- **Size:** 576.0 KB -> **583.3 KB** (+7.3 KB) of the 600 KB budget. minJs shrinks the UI script with the AST
  identical and gives no warning.

# Checkmarch: build notes (size pass)

## Where the bytes are (game.html, after the size pass: 576.0 KB of a 600 KB budget)
| Section | Inlined KB | Source KB | Notes |
|---|---:|---:|---|
| engine.mjs | 53.2 | 74.9 | slimJs form (locked, see below) |
| world.mjs | 105.4 | 142.3 | slimJs form (locked) |
| audio.mjs | 36.1 | 45.2 | module copy (checkmarch-music), slimJs form |
| content.mjs | 39.6 | 46.5 | module copy, namespaced CONTENT |
| fx.mjs | 31.1 | 36.0 | module copy |
| tutorial.mjs | 25.0 | 33.4 | module copy |
| discovery.mjs | 23.2 | 28.4 | module copy, namespaced DSC |
| fairy.mjs | 20.4 | 27.6 | module copy, namespaced FY |
| terrain.mjs | 19.1 | 23.2 | module copy |
| map-render.mjs | 15.8 | 18.4 | module copy |
| rival.mjs | 13.4 | 16.8 | module copy |
| map.mjs | 11.9 | 14.1 | module copy |
| skills.mjs | 11.7 | 17.0 | module copy, namespaced SK |
| forge.mjs | 7.1 | 10.5 | module copy |
| **modules total** | **413.0** | | 72% of the page |
| UI script (game.src.html) | 126.5 | ~165 | was 141.0 before this pass |
| CSS (`<style>`) | 32.8 | | already minified (minCss); 369 rules |
| markup | 3.5 | | |

How to re-measure: `moduleScripts()` from build.mjs gives each inlined module; the UI script is what follows the
module block inside `<script>`.

## Size pass
- **Before:** 590.4 KB (604,601 bytes). **After:** 576.0 KB (589,781 bytes), saving 14.4 KB.
- **What changed:** `build.mjs` has a new `minJs`, a token-level whitespace minifier, and runs it on the page's own UI
  script only. It uses acorn's parser for the tokens (acorn 8.18 from /opt/node-tools, no new dependency), so regex vs
  divide, template literals and `${}` nesting are exact. It copies every token's text as-is and only shrinks the
  whitespace and comment gaps between tokens. A newline is kept wherever ASI could depend on it. There is no renaming
  and no reordering. The build guards it: the minified script must parse to an AST identical to the line-compacted
  script (positions aside), and it must still contain the module block byte for byte. If either check fails, the
  build prints a WARNING and ships the unminified script. Without acorn, the UI script is left as it is.
  The markup and CSS are byte-identical to before.
- **Not touched:** the modules, slimJs, the tests and save v6. Tests: engine 20/20, world 533/533. The balance bot
  gives identical numbers (88.7% tier 1-5 win rate, region-1 mean 1548). smoke.mjs and variety-smoke.mjs pass.
  The light and dark map screenshots are pixel-identical. The battle screenshots differ only in piece positions,
  because the engine search runs on a time budget.
- **Flaky smoke check (already there before this pass):** the variety-smoke check "the chronicle ... quotes the lord"
  sometimes fails on the old page too. When the landmark's node is next to the rival's land, the rival's first event
  is a borderBattle, which has no quote. Runs with a fixed Math.random and Date.now give identical transcripts for
  the old and new pages over 20 seeds.
- **Why not 540 KB:** 72% of the page is module code, and the tests pin it to the `slimJs` form.
  test-engine and test-world check `html.includes(slimJs(module))`, and test-world asserts slimJs's exact output
  on a sample, with intra-line spaces kept. Under those tests the page template (178 KB) is the only free part,
  and its CSS is already minified.
  - Dead CSS: a selector scan found only `.t1` and `.t3` material rules (162 B). Those class names are probably
    built dynamically, so they were kept.
  - Duplicate code: about 3 KB of repeated lines, almost all inside the locked modules.
  - **Option for the owner:** run `minJs` over the module block too. That gives **511.7 KB**, measured, with the
    whole-script AST identical. It needs the two "inlines slimJs(module) verbatim" tests to become
    "the inline script's AST equals the AST of the slimJs'd modules plus the UI". That is a test change, so it was
    not made here.

# Checkmarch: build notes (content variety)

## Content variety
The mandate was scarcity discipline: more variety inside the clocks and budgets the game already has, with no added income, ticks or power. No balance number changed (TUNE, budgetCurve, memScale, MEM_SHOP, ELO_TABLE, weekTicks 168, bequestPer, mine rates, fairy prices and eraGrowth are all untouched). No module copy changed, so every freshness check passes. The save stays **v6** with no migration: the new data is plain extras on existing arrays (`run.map.sites` entries, an optional `q` on rival chronicle lines, `battle.wkHint`), and old saves load with none of it. The changes are in `world.mjs`, `game.src.html` and `test-world.mjs`.

1. **Named landmarks** (`world.mjs LANDMARKS`, `placeLandmarks`). There are nine Heroes 3 style one-visit places: The Hermit's Mill, Sunken Crypt, Wandering Tutor, The Old Toll Bridge, Drowned Chapel, The Old Battlefield, Hunter's Lodge, Charcoal Burners and Ferryman's Landing. Each region gets 1 or 2, seeded from the region seed. Each one sits on its own node (not the keep, the citadel or a shrine) and in its own column, beside the generic sites. They reuse discovery.mjs as it is: the archetypes are registered into `DSC.LOCATION_BY_ID` only, never `DSC.LOCATIONS`, so `placeSites` never draws them. The site card, map mark, "Not now", diary checks and save all work unchanged. Each card offers two options and "Not now", and each option is explained in plain words by `effPlain`, which gained a `skillXp` line ("+45 XP to Pawncraft, your pawns' skill, kept for good"). The options trade one slot of value:
   - **Gold:** +20 gold in region 1, scaled 1.6x per region like every site.
   - **Skill XP:** `landmarkXp(r)` = 40 x the skill tier multiplier at the region's middle tier: 45 XP in region 1, 80 in region 3. It goes to Pawncraft, Knightcraft, Bishopcraft, Rookcraft or Leadership.
   - **A one-battle buff:** enemies -40 elo, Tactician +60 elo, or loot +40%, each for the next battle only.
   - **The next raid 120 moves later.**
   - **+5 coal.**

   **How neutrality is funded:** each landmark removes one gold road pile from its own region, the smallest pile still worth at least the landmark's gold option, so every landmark is worth no more than the pile it replaced. A landmark is placed only if such a pile exists and the region keeps its treasure minimum (2 piles). Otherwise the region gets fewer landmarks, sometimes none (82 landmarks over 60 region-1 seeds). New effect kind `skillXp` in `applyEffect`, applied through `skillGains`. XP only goes up.
2. **Week variety.** There are six new weeks, as three mirrored pairs on mechanisms the game already reads:
   - Week of Bounties (loot +10%) and Lean Week (loot -10%)
   - Week of Clear Skies (Tactician +30 elo) and Week of the Raven (-30)
   - Week of the Truce (rival clock 0.9) and Week of War Drums (1.1)

   Each pair nets to no change, so the new weeks only dilute the pool: every mechanism's average week moves toward neutral, never in the player's favour. There are 18 weeks now. The **Week of Rest** has a real but small effect: the first hint in each battle is free (`mods.hint`, read by `freeHints` through `battle.wkHint`, fixed when the battle starts; the hint button's tooltip says why). The week tags pick up the new weeks by mechanism: the loot line, the Tactician row (it now shows a negative week as "-30 this week") and the rival clock.
3. **Dwelling titles and lore** (`DWELL_LORE`, `dwellLore`). Each piece type has a title and one line for each level 0-3, for example Empty Field, Hamlet, Village, Garrison Town for pawns, or Quarry, Watchtower, Bastion, Fortress of Rooks for rooks. They appear on each dwelling row and in the level-up toast.
4. **Battle intros** (`BATTLE_INTRO`, `battleIntro(node, terrain)`). There is one italic line for each of 9 battle kinds (garrison, mine, town, shrine, citadel, raid, rival border host, keep assault, ambush) on each of 3 grounds (open, rocky, wet, read from the battle's terrain). It shows on the pre-battle foe card (node preview, raid and border previews) and stays on it during the battle.
5. **The rival's voice** (`RIVAL_SAYS`, `rivalSays`). The chronicle header now names the region's lord with their epithet (`lordTitle`, for example "Kroll Underbridge, the Toll-Taker"). Chronicle lines carry a short quote in the lord's doctrine voice (aggressive, solid or material, three lines per event):
   - when the rival takes a node
   - when it assaults your keep
   - when you take a mine ("Saw you take X")
   - when you take back a node it held ("Lost X to you")

   The quote is picked by a hash and never repeats either of the last two quotes.

### Numbers (content variety)
- test-engine 20 passed, test-world **533** passed (was 508; 25 new: landmark placement, funding, determinism, one visit, every option of every landmark applies what its card says, region scaling, save round-trip; week pairs net zero, pool means only move toward neutral, Rest hint free once, Raven reaches the battle; dwelling lore, intros, rival lines and their save round-trip). The plain-words effect check now also covers every landmark option (230 choices).
- `--check`: 88.7% (was 89.9%), region-1 clear 15/36 seeds, mean 1548 ticks (was 15/36, 1588), Memories and elo guards OK. At 36 seeds the region-1 clear count is chaotic: landmarks alone moved it to 11/36, with seeds flipping both ways. A wider run (144 seeds x 3200 ticks, `--check` loop) compared the old content with the new. With landmarks only: 123/144 clears, mean 1917 vs 1911. With everything: win rate 87.9% -> 89.1%, clears 123 -> 125, mean 1917 -> 1973 ticks. A quick Part 4 (12 runs, 6000 ticks) shows road piles + landmark gold per region about equal to the old road piles: R3 171 vs 139, R4 170 vs 161, R5 431 vs 505, R6 465 vs 433.
- game.html **590.4 KB** (budget 600; it was 577.6).
- Headless (Playwright, 400 px, light and dark): the reference smoke passes 23 checks. A new variety smoke passes 14 checks: landmark card text, option taken and spent, dwelling titles, the foe-card intro, the chronicle quotes and lord title, no horizontal scroll, no page errors.
- Known and not changed: on the first visit (with the one-time site explainer), every site card, generic or landmark, scrolls inside the board card at 400 px (367-449 px of 350). After that first visit only the longest cards scroll a little: Cartographer and Smugglers' Den 357, Wandering Tutor 357. This was already true before the landmarks.

# Checkmarch: build notes (polish sweep)

## Polish sweep
No balance number changed (TUNE, budgetCurve, memScale, MEM_SHOP, ELO_TABLE, weekTicks 168, bequestPer 15 and fairy eraGrowth are all untouched). No module copy changed, so every freshness check passes. The save stays **v6** with no new save fields. The changes are in `engine.mjs` (exotic traits), `world.mjs` (`fairyTrait`, plus the `trait` field on `fairyCard`), `game.src.html` and `test-world.mjs`.
- **Debug handle off by default.** `window.__checkmarch` now exists only when the page URL carries `?debug=1` (or `#debug=1`). The shipped page exposes nothing. Headless harnesses load `wrap.html?debug=1`. No node test, including `balance-bot`, uses the handle.
- **Banners clear of the board.** A new FX host, `#fxTop` (a fixed 116 px strip at the top of the screen, `pointer-events:none`, z 62), now carries the exotic-unlock ceremony banner, skill title-level and total-level banners, ordinary level-up flares and the new week banner. The ceremony diagram and the battle board stay visible. fx.mjs itself is unchanged.
- **Exotic dwelling traits** (`engine.mjs FAIRY_TRAITS`). Each exotic piece borrows a capture trait from its family's dwelling at a smaller chance per level. There is no new dwelling and no change to `cleanDwell` or `traitLevels`:

  | Piece | Trait | Dwelling | Chance per level | What it does |
  |---|---|---|---|---|
  | Commoner | Rally | pawn | 10% | adjacent step |
  | Champion | Vault | knight | 6% | leaps 2 squares, straight or diagonal |
  | Wizard | Blink | bishop | 6% | diagonal slip |
  | Cannon | Recoil | rook | 5% | falls back toward home |
  | Nightrider | Night ride | knight | 6% | knight square |
  | Archbishop | Sanctuary | bishop | 6% | diagonal slip |
  | Chancellor | Parley | rook | 5% | the capture fails |

  Enemy exotic pieces use the enemy's trait levels the same way, so the mirror pieces from region 3 on can survive a capture too. The traits show on the ceremony card (a Trait row plus one plain note), in the Army > Pieces rows (for example "Recoil 10% (rook dwelling 2)") and on each dwelling row ("Also: Cannon Recoil 10%"). Tested: every type saves its piece the way its card says.
- **Guard pips.** The pip column now sits outside the pulsing frontier ring. It is nudged (right, higher, further out, lower) away from tier tags, scouted tags, mine tags, other badges, the selected node's name pill, and road sites and glints. Over 40 seeds, pip columns touching a mark went from 19 of 122 to 2 of 122 (those 2 have no free spot left).
- **Board cards at phone width** (at most 440 px). The overlay padding drops to 8 px and the cards use the whole board, so the shrine card fits with no side gaps and no inner scroll. It measures 316 of 352 px, including the first-shrine explainer.
- **Weekly muster.** A top-strip banner now plays as each week turns: the event's name and "Week N begins: a good / hard / quiet week", coloured by the event's tone. Small week tags now mark where the effect applies:
  - the march button (Roads, Mud)
  - the rival clock (Wolf)
  - the loot line on result cards (Spoils, stored as `sum.wk`)
  - the Tactician row (Owl, "+40 this week")
  - the mines line on the map strip (Plenty, Tithe, Hearth)
  - the pawn dwelling row (Shield)
  - keep militia (Levy)

  The Forge tab already named the Week of the Forge. The Week of Rest still has no mechanical effect: only its banner and the map strip show it.
- **Yield and capture XP.** This item needed no fix. A yielded or claimed battle ends through `endBattle('win')`, and a retreat through `endBattle('loss')`. Both call `awardBattleXp`, and `battleXp` always pays the capture tally (`battle.sx.c`). Two regression tests now pin this: a yield pays the captures made before it, and so does a retreat. One edge remains: a retreat sounded while a trait or counter roll is still being announced drops that capture, because the move never landed.
- **Stale `.sk-more`.** No headless script lives in checkmarch/. The dead `.sk-more` CSS rule is gone from game.src.html, and the stale expand check is gone from the scratchpad `headless.cjs`. Skill rows open the Skill Guide now.
- **Level-up ding.** Already present, with no module change: since P0-2, `registerDingStings` composes per-skill `lvX` / `tlX` stings into `MUSIC_STINGS` from the module's bell, lute and horn voices, and `dingJingle` plays them through `audio.sting`. Nothing was added.

### Numbers (polish sweep)
- test-engine 20 passed, test-world **508** passed (was 503), `--check` unchanged (89.9%, region-1 mean 1588 ticks, Memories and elo guards OK). All eleven module suites pass (fairy 144, terrain 658 and the rest). game.html **577.6 KB** (budget 600).
- Headless smoke (Playwright, 400 px, light and dark): 23 checks pass, including a new one that boots the page without `?debug=1` and finds no `window.__checkmarch`. The M6 `headless.cjs` passes 38 checks and the fairy headless check passes, with no page errors.

# Checkmarch: build notes (balance pass)

## Balance pass
No module copy changed (all freshness checks pass); save stays **v6** (no new fields). Tuning lives in engine.mjs `TUNE` / `ELO_TABLE` / `MEM_SHOP`, world.mjs `WORLD` / `P1` / `FAIRY_WORLD`, one number in game.src.html, and balance-bot.mjs.

### Instrumentation (balance-bot.mjs)
- **Part 4** (`DEEP`, default 24 fresh accounts at `ELO`, one run each, cap `DEEP_TICKS` 12000): per region, clear ticks and weeks, win rate by node type (garrison / mine / town / shrine / citadel / ambush / raid / border / keep), gold in by source (time = mines + keep + week pulse, loot, road piles, caches, shrines, raids, borders) and out by kind (pieces, squares, Tactician, exotics, sites), gold per attack, next N/R/Q price, army points and squares, abdication value at exit, bequests, diaries, forge bars, skill XP, exotics bought, raids / border / keep assaults, deaths by type and cause, run ends. Then exotic first-buy timing, the march + battle cycle distribution (battles per week), and a push-or-abdicate ledger.
- **Part 5** (`MARATHON`, default 40 region attempts per band, `BANDS` 600,900,1200,1500): one account per band plays run after run (Memories carried and spent cheapest first); per run payout / bequests / diaries / banked / spent / shop left, and per region clears and garrison + seat win rates.
- Parts 4-5 run in up to 4 child processes (`JOBS`), each job deterministic. `PARTS` picks parts (default all). New knobs `FAIRY_JSON`, `ELO_JSON`; `SLOW=ms` logs slow engine moves; a bot loop that passes no time for 2000 iterations ends the run as "stalled". The bot now also works the Forge (smelts the best bar, tempers its best pieces) and calls `skillStart` on every new run as the page does. Full report ~16 min on 4 cores.

### Bug found by the deep runs
- **Engine hang in late regions.** `search()` never checked its budget during iterative-deepening depth 1, so a position with ~15 heavy pieces a side and quiescence depth 40 (elo 1900+) ran depth 1 for 40+ minutes (one bot job; on the page it would freeze the tab). Fix: depth 1 now has a hard cap of `SEARCH_HARD` = 16x the time / node budget, keeping the best root move searched so far. Normal searches are unchanged (perft and mate tests pass).

### Findings (before) and fixes
1. **Late game too easy, then a cliff.** Fresh accounts at 900: garrison wins R3 99%, R4 100%, R5 100%, R6 99% (seats 53%), then R7 48% (seats 4%). Mines are held for the whole run and grew 1.06 per tier: time income was 70-95% of all gold, region 6 earned 52k against region 1's 2.6k, the formation was full (16 squares) by region 4 at 77 points against ~25-point garrisons. Enemy budget at 1.045 lagged until it hit the 16-square cap all at once.
   - `TUNE.mineGrowth` 1.06 -> **1.035**.
   - New `budgetCurve(tier)`: three legs, `enemyBudgetGrowth` 1.045 below tier 12 (region 1 unchanged), `enemyMidGrowth` **1.07** to tier 32, `enemyLateGrowth` **1.024** after (a gentle slope into the army cap instead of a cliff).
   - Elo regional drift (`ELO_TUNE.perRegion` 80) left alone: both engines follow it (the Tactician plays at the foe's elo), so it moves noise, not the balance.
2. **Memories inflation.** Payouts were (sumTiers/10)^1.3: mean run 1404 (fresh accounts), marathon runs 1500-3700, plus bequests 100-500 a run, against a 733-Memory shop. One run bought everything and every unspent Memory adds +1% gold: marathon accounts banked 10,000-13,000 Memories (+10,000% gold).
   - `TUNE.memScale` **5**: payout = (sumTiers/10)^1.3 / 5 for future runs (same shape, so the push-or-abdicate ratios are unchanged). Banked Memories, upgrades and skills are untouched; the +1% per unspent Memory stays.
   - `MEM_SHOP` bases doubled (pawns 10, squares 8, income 6, Tactician 30, gold 4): whole shop **1469** (was 733).
   - `P1.bequestPer` 3 -> **15** (same share of the run payout). Diaries untouched (they now matter more).
3. **Elo bands above 1200 dishonest.** 1500 searched the same depth as 1200 (d3): 1500 beat 1200 **69%**, 1580 beat 1200 61% (48-96 games per cell, mixed 9/14/20-point armies). New `ELO_TABLE`: 1200 d3/q3/80 ms/j60, 1350 d3/q6/110/j30, **1500 d4/q6/150/j5**, 1700 d4/q8/180, 1800 d5/q8/220, 2100 d5/q40/260. Now 900 v 600 **85%**, 1200 v 900 **88%**, 1500 v 1200 **83%** (96 games). Interior +100 steps stay weak (1300 v 1200 56%, 1600 v 1500 48%) and 1800 v 1500 is 65%: only band steps are honest. The player's +300 edge per region now falls smoothly: R1 90%, R3 82%, R4 82%, R5 75%, R6 73%, R7 69% (72 games each).
4. **`--check` swing.** Old check: 12 seeds x 1500 ticks, 178 battles. New: **36 seeds x 1800 ticks** (~550 battles, ~12 s), ambushes excluded. Under the same +/-10% nudges (loot, mine base, start gold, keep income) the old check ranged 88.0-97.7%, the new one 85.3-92.5% and moves in the expected direction. Band tightened to **70-97%**. Three new guards (exit 1 on failure): region-1 clear mean of the seeds that clear within the window in **1200-3200** ticks (at least 9 clears); Memories: a reference regions 1-3 run (sumTiers 900) pays **3-12%** of the whole shop, a regions 1-6 run at most **35%**, and the cheapest upgrade costs more than a region-1 payout; elo table: every band step adds depth or quiescence.
5. **Pure tick time.** A cautious bot that only marches and fights has a sane economy: gold in per region R1 2.6k, R2 3.6k, R3 4.9k, R4 7.8k, R5 14.9k, R6 25.6k (was 2.6k / 3.8k / 6.9k / 14.0k / 23.2k / 52.1k), gold per attack 103 -> 1280, and it spends what it earns (out 2.5k / 3.2k / 4.4k / 6.5k / 13.1k / 25.6k). **The week clock turned too often**, not too rarely: march + battle cycles are median 45 / mean 54 ticks (p10 18, p90 102), ~88 ticks a battle in region 1 with raids and border fights, so an 84-tick week turned every 1-1.5 battles (1.6 battles a week). `WORLD.weekTicks` 84 -> **168** (now **3.1** battles a week, ~2 in region 1; a region-1 clear is ~13 weeks) and `minePulseTicks` 12 -> **24** (the pulse keeps its share of mine income). Copy: "every 168 moves a week turns".
6. **Exotic pricing.** At value^1.5 / value^2 every exotic cost 1-3% of its unlock region's gold and was bought the moment it opened (archbishop 454-504 gold when region 6 earned 20-50k). New `FAIRY_WORLD.eraGrowth` **1.7** per unlock region after 2 (as if each region were one more copy): commoner 115, champion 302, wizard 274 (548 a pair), cannon 613, nightrider 1408, archbishop 4211, chancellor 8052. Measured: commoner bought 32 ticks into region 2 (23/23 runs), archbishop ~400 ticks into region 6 by 8/17 runs (about a sixth of the region's gold), chancellor 1/11 runs. **Mirror at region 5:** turning the mirror off moved region-5 garrison wins from 43% to 61% in one trial (it adds pressure but is not the cliff; the cliff was the budget meeting the army cap), so it was left as is.
7. **Economy coherence.** Loot vs time (mine + keep) per region now ~35/60% in region 1, ~33/62% in regions 3-5 (was ~25/72% by region 4 and 95% time by region 7). Road piles + caches stay ~5% of income (road 68-671 a region): no change needed. **Push or abdicate** (bank now vs. push one more region, a mate paying 25%): R1 5.97x, R2 2.57x, R3 1.95x, R4 1.72x, R5 1.43x, R6 0.98x: pushing beats banking until region 6, where the risk says stop.

### Before / after (fresh accounts at 900, Part 4; before = 24 runs on the old tuning with the engine fix and forge bot)
| | before | after |
|---|---|---|
| garrison win rate R1 / R2 / R3 / R4 / R5 / R6 / R7 | 85 / 91 / 99 / 100 / 100 / 99 / 48% | 87 / 94 / 92 / 82 / 86 / 61 / 11% |
| seat (citadel) win rate R5 / R6 / R7 | 100 / 53 / 4% | 94 / 42 / 100% (2 of 2) |
| runs reaching R5 / R7 / R8 | 20 / 16 / 6 of 24 | 17 / 11 / 2 of 24 |
| region-1 clear mean (Part 4 / Part 2) | 2042 / 2195 ticks | 2344 / 2247 ticks |
| gold in R1 / R4 / R6 | 2.6k / 14.0k / 52.1k | 2.6k / 7.8k / 25.6k |
| mean run payout (fresh) | 1404 Memories | 217 |
| marathon payouts per run (900) | 192-3140, shop maxed after run 2, 10,482 banked | 110-393, shop maxed after run 6, 135 banked |
| bequests per run (marathon 900) | 52-278 | 10-20 |
| 1500 v 1200 (equal material) | 69% | 83% |
| battles per week | 1.6 (84 ticks) | 3.1 (168 ticks) |
| `--check` | 91.0% (12 x 1500) | 89.9% (36 x 1800), + 3 guards |

Marathon accounts with the whole shop bought still clear regions 1-4 at ~100% at 600/900; the 1200 and 1500 bands bite earlier (1500: R3 87%, R4 81%, R5 63%). Full report numbers: Part 2 region 1 cleared 33/40, mean 2247 ticks, tier-5 67%; Part 1 3 runs +294 / +193 / +235.

### Not changed, known
- The forge smelts one bar per 28,800 ticks before Bellows: the bot makes 1 bar a run (region 1). That is forge.mjs pacing, a player toy, left alone.
- Raids are almost never held from region 2 (the bot garrisons one pawn); keep assaults did not occur in 24 runs (8+ held rival nodes needed).
- Per-region stats are survivorship-biased (later regions only see runs that got there) and the bot's retry rule inflates attack counts on walls; 24-run trials swing several points between neighbouring settings.

Run: `node build.mjs && node test-engine.mjs && node test-world.mjs && node balance-bot.mjs --check` (full report: `node balance-bot.mjs`; quick deep look: `PARTS=4 DEEP=12 DEEP_TICKS=9000 node balance-bot.mjs`)

### Numbers (balance pass)
- Tests: test-engine 20, test-world 503 (week, bequest, elo-band and exotic price assertions updated to the new values), checkmarch-fairy test-fairy 144, and all eleven module suites green. game.html **570.6 KB** (budget 600).
- Headless smoke (Playwright, 400 px, light + dark): 11 checks per theme, no page errors (elo card with 600/900/1200/1500, pick 1200, buy square c2, Memories note on the Run tab, no horizontal scroll, two-tap reset back to a fresh save with the elo card).

# Checkmarch: build notes (v6: exotic pieces, time only from play)

## v6 changes
Save goes to **v6**. New module copy: **`fairy.mjs`** (byte-identical to ../checkmarch-fairy, freshness-checked by test-world, inlined before world.mjs as namespace `FY`). `engine.mjs` carries `engine-patch.mjs` applied **in source** (hit counts 14/1/9/17/2/5/2 as the patch expects); ../checkmarch-fairy/test-fairy.mjs now detects the applied state (it imports `setFairyHooks` directly, checks no unpatched `<< 3` / `>> 3` / `& 7` code remains and that the 4 hooks exist) and passes 144/144 either way.
- **Encoding.** Piece codes are `color << 5 | type`; moves are 19 bits (`from | to<<6 | promo<<12 | cap<<13`), a gate move adds `GATE_BIT` (1<<19) and the gated type at bit 20. `migrateState` v5 -> v6 (`migrateBoardCodes` / `migrateMove`, keyed on the save version) rewrites battle snapshots, logs and rewind stacks; `migrateBattleSave(o, v)` does the same for the saved live battle in `boot`. Call sites in world.mjs and game.src.html (`>> 3`, `& 7`, `8 |`) were moved to `>> 5`, `& 31`, `32 |`. Perft numbers are unchanged (tested).
- **Shipped pieces (8x8 only).** Commoner (M), Champion (H), Wizard (W), Cannon (C), Nightrider (J), Archbishop (A), Chancellor (E). Gryphon, Amazon and Lion are in fairy.mjs but not wired (`FAIRY_SHIP` in world.mjs).
- **Unlocks are account-permanent** (`state.fairy = { un: {id: region}, seen, q, wiz }`; each run copies `un` into `run.fun`). Region 2 Hamlet -> Commoner; region 3 Champion, and Wizards from a shrine find (an announced roll on the result card: 50%, +25% per miss, sold as an opposite-colour pair); region 4 Foundry -> Cannon; region 5 boss gives the first Nightrider, then its dwelling; region 6 Cathedral -> Archbishop; region 7 Chancery -> Chancellor. `cleanFairy` also unlocks every region-gated type up to `state.bestRegion`, so pre-v6 saves get what they already reached.
- **Caps and prices.** Commoner uncapped, champion 2, wizard 2 (one pair), cannon 2, nightrider 1 (2 once enemies field it), archbishop 1, chancellor 1. Base price: value^2 for the compounds (A, E), value^1.5 for the rest, times g^n per copy owned (same growth as the classic pieces). Current table: commoner 115, champion 178, wizard 161 (322 a pair), cannon 212, nightrider 287, archbishop 504, chancellor 567. Losses refund like other pieces (`run.fbought` is part of `settleRoster`).
- **Seirawan-style gating.** Buying with a free owned square places normally. With a full formation the player taps the piece the newcomer waits behind (`ui.gatePick`, candidate squares glow, Cancel in the controls); the first time, a plain-words explainer (`FIRST.gate`). In battle the engine adds gate variants to the moves of that piece (`pos.g`, `pos.gs` unmake stack, `posKey` includes gates): when it leaves its home, the waiting piece drops onto the square in the same move ("Cannon enters through e1", toast + FX). A capture on the home square, or the piece leaving without gating, lapses the gate for that battle; the waiting piece is safe and waits again next battle. Forge tiers apply to gated pieces. Formation and keep battles seat gates; garrison and castellan battles do not.
- **Enemy lagged mirror.** Enemies field a type `mirrorLag` 2 regions after the player's unlock region; the rival lord previews it 1 region sooner (shown on the rival bar as a threat). Never below region 3; the lowest elo band stays frozen out (`FY.enemyFairyPool` with its per-piece lag shifted so every type follows 2). Each enemy army swaps its closest-in-weight non-pawn piece (1 per army, +1 for a boss, +1 late) so budgets hold.
- **Ceremony.** Each unlock queues a full-screen card (`.ov.cer`): a mini board where the reachable squares pulse outward ring by ring (`--d` delay, static under reduced motion; the cannon diagram shows the screen and the capture behind it), the plain-words rules, the Betza string as flavour, facts (where, copies, price, worth), fanfare sting and the region-win FX burst. Seen-flags are account-wide; a queued ceremony self-heals like other cards. Army tab > **Pieces** lists all 7 (known ones with a Moves button that replays the card; locked ones as silhouettes with their unlock region).
- **Art.** Each exotic piece is an inline SVG (`FZ` / `FZL` paths) drawn with the piece tokens (`--p-fill`/`--p-ink`, `--e-fill`/`--e-halo`) so it follows light, dark and the piece-set themes, with the usual material badges. A waiting gate piece shows as a small dashed ghost in its home square's corner.
- **Skills.** skills.mjs has six fixed skills (total 594), so exotic XP goes to **Leadership** (`skillType` / `skillVictim` map fairy letters to K). A seventh "Exotics" skill was not cheap: it changes the total-level ladder, banners and milestones. Promotion stays queen-only. Dwelling traits do not cover exotic types yet.
- **Bot.** `greedyBuy` considers fairy rows (by weight per gold) and buys with `W.buyFairy`; it fights the mirror.
- **Size.** `slimJs` now also drops trailing `//` comments and leading indentation of code lines (never inside strings or template text); the top-level clash check scans the unslimmed source. game.html is **569.9 KB** (budget 600).

## Time passes only from play (v6)
Per Christopher: "not everything is tick based yet. weeks pass, gold income, raids etc. that is all time based."
- Removed the **ambient drip** in `tick()` (was 1 tick per `TUNE.ambientMs` 2 s on the open map) and the **offline catch-up** in `boot` (was `min(300, away / 2 s)` ticks, `TUNE.offlineTicks`). Both TUNE keys are gone; `awayTicks()` returns 0. The page's 1 s timer is now cosmetic only (render, autosave, card self-heal), and the mine coin sound only plays after play moved the world.
- The "while you were away" earnings toasts are gone; a returning player sees one neutral line once: "The realm held its breath while you were away: time here passes only as you play."
- Audit: mines, the week clock (`weekTurn` boundaries), raids, the rival clock and border battles, the keep assault and the forge all advance inside `worldTick(n)` only, which is called from chess moves and march steps. Nothing reads wall time (the only `Date.now` uses are seeds, the save timestamp and the cosmetic timer). Tests: away time yields zero ticks, a 30-day absence turns no week, and quiet batches still equal n x 1 tick.
- Balance after the change: `--check` 91.0% (was 97.8% with ambient time), region-1 clear mean 2195 ticks (band 1500-3000), so no loot or mine nudge was needed. The bot no longer waits idle for gold.
- The Milestone 4 lines below about the ambient tick and the offline catch-up describe the old behaviour and are superseded.

### Numbers (v6)
- Tests: test-engine 20, test-world **503** (was 429), checkmarch-fairy test-fairy 144. Headless Playwright fairy check (400 px, light + dark): 22 checks per theme, no page errors (ceremony with animated diagram, cannon screen square, seen-flags, shop exotic rows, gate pick and ghost, fairy SVG on formation and battle boards, Pieces silhouettes, no horizontal scroll).
- `--check` **91.0%** (162/178), in band 60-98; `P1.bequestPer` and diary payouts untouched.
- Full report Part 1 (3 runs): region reached 7 / 7 / 8; bequests +142 / +130 / +166, diaries +10 / +10 / +4, against run payouts +2366 / +377 / +617.

### Known gaps (v6)
- Exotic XP goes to Leadership (no seventh skill). Dwelling traits do not cover exotic types.
- A gate's home can only be changed by placing the piece (no "move gate" control yet); garrison and castellan battles have no gates.
- fairy.mjs suggests price exponent 1.75 and per-piece lags 1-2; world.mjs uses the decided 2 / 1.5 exponents and a flat mirror lag of 2.
- Gryphon, Amazon and Lion are not wired. The ceremony's FX banner briefly overlaps the lower half of the diagram for about a second.

# Checkmarch: build notes (P1 engagement pass + tutorial)

## P1 engagement pass (report items P1-5, P1-6, P1-8, P2-10) and the tutorial
Save stays **v5**; every new field is additive and repaired on load by `world.cleanP1` (called from `migrateState`). New module copy: **`tutorial.mjs`** (byte-identical to ../checkmarch-tutorial, checked by test-world, inlined before world.mjs). No other module copy changed.
- **Tutorial wording fix (in ../checkmarch-tutorial first).** The mine-income line already matched tick time ("pays gold as the world moves"), so it was left alone. The **shrine** step still described the M2 two-way shrine ("knight a pawn or boost your mines"); it now reads "A shrine grants one blessing: pick one of the two gifts and the other is lost. Each gift says what it does and for how long." The demo was rebuilt and its 33 tests pass; the copy here is byte-identical.
- **Size.** `build.mjs` now drops full-line `//` comments from the inlined modules (`slimJs`, a small scanner that skips strings, template literals and regexes; the .mjs files are untouched). test-world checks with acorn (when present) that every slimmed module parses to the same AST, and both suites compare game.html against `slimJs(module)`. game.html is **546.8 KB** (it would have been ~617 KB without slimming); the size budget in test-world was raised from 560 to **600 KB** for headroom.
- **Tutorial integration.** `createTutorial` in `boot` (`initCoach`) with `tutObjectStorage(() => state, 'tutorial')`, so tips ride the save and the hot snapshot. Steps = the module's `CHECKMARCH_STEPS` plus one game-side step `buy-square` after `formation` (the guided open: place a piece, buy a square, pick a target, first march). `coachSnap` post-processes the module snapshot: the first shrine choice inside a win card counts as modal `shrine`; any other visible board card counts as a modal. `coachSync` runs at the end of renderAll / renderLight / renderControls / showResult and once a second; all API events are wired (`coachEv`, with `update:false`). Skippable ("No more tips" on every card; Run tab > Settings: Tips on/off, Replay tips). Fresh accounts start with tips on; **a save without a `tutorial` record predates the tutorial and starts with tips off**. Reset save calls `coach.reset()`.
  - Reconciliation with `state.seen` explainers: the coach marks own onboarding. `COACH_COVERS = { shrine, raid }`: while tips are on those two inline explainers are suppressed (the coach mark teaches the card); with tips off they come back. All other explainers (site, border, ambush, counter, trait, rewind, bar, ding, cache, week, guide, claim) are untouched: the tutorial does not cover them.
- **P1-5 trophy ladder.** `state.banners`; `bannerClaimable` (level 99, unclaimed), `claimBanner` (a symbolic **99 run gold**), `bannerTrim` (2+ skills at 99 trims every banner). The Army tab skill row shows a Claim banner button; it opens a ritual card on the board (Raise the banner / Not now). A claimed banner shows on the row and as a gold pennant (`.pc.w.ban`, green trim when trimmed) on that piece type on the board. A **Total level** headline box (n / 594, next milestone) tops the Army tab; `noteTotalLevel` toasts 100, 200 ... 500, 594 once each (`state.tlMile`; migrated saves start at their current floor).
  - **Regional diaries** (`DIARY_TIERS`, `DIARY_CHECKS`): per region number, Easy 4 / Medium 4 / Hard 4 / Elite 3 checks, all map knowledge (hold a mine, a town, every kind of mine at once, find every site, lift the fog, win back a rival place, win without losing a piece, take the seat, visit every site...). Tiers pay **1 / 2 / 3 / 5 Memories** once and a title ("Wayfarer / Pathfinder / Warden / Lord-Surveyor of Region N"). Progress is account-wide (`state.diary`), updated by `diaryUpdate` after battles (`afterBattle`), caches, shrine and site choices; counters for a region already left (the seat battle) are marked directly. Run tab "Region diaries" section with plain progress; news toasts via `state.diaryNews`.
- **P1-6 rival ledger.** `run.map.rweek` collects the week's captures / losses / drills; `weekTurn` closes a line (`ledgerClose`) into `run.map.rledger` (last 10). Tapping the rival bar (a button, Enter/Space too) opens the ledger: "Week 3: +0.4 strength, took Milltown", the open week "so far", and `rivalMath` lines (xp by source in moves, the formula, tier and elo effects, dwellings). Tested: weekly gains sum to its strength, every capture is on the ledger, worldTick(n) = n x worldTick(1) for the ledger. **Guard bands** (`guardBand`: patrol <= 60% of your formation's points, company <= 115%, host above) on node cards ("guarded by a company") and as 1-3 pips beside visible frontier and scouted nodes on the map overlay (cached per map state).
- **P1-8 Hall of the Fallen.** `battleMove` records per battle `battle.pk` (captures per piece; a fallen piece's type and material at the capture; reset on rewind; serialized). `afterBattle(state, battle, sum)` (page `endBattle` before the run can end, and all four bot paths): survivors get +1 battle survived (`run.pstat`), each fallen piece gets an entry (auto name from the content pack's lord names, type, material, battles survived, captures, place, region, run) in `state.hall` (last 80; `hallN` counts all). **Bequest** = (type value + tempering tier) / 3 Memories, only if it survived **2+ battles** (a fresh piece pays nothing: no farming); fractions bank in `state.bequest` and whole Memories are paid at once, never deducted. Army tab "Hall of the Fallen" list; the result card names the fallen; the run-over card's "Lost with the run" column lists this run's fallen with a "See them in the Hall" button that opens them inline.
- **P2-10.** Threat shading: while a piece is selected in manual play, empty or own squares the enemy attacks get a faint `--danger-soft` tint (status line explains it); Run tab > Settings "Threat shading" toggles it (`settings.threat`, default on). Visited sites draw a check mark instead of the faded glyph; held shrines whose blessing is taken get a check badge. A **Next goal** line under the map strip (`nextGoals`: unclaimed banner, affordable square with reserve pieces, affordable dwelling, a diary tier one task from done, a skill level within 25%, else the week) rotating the first three every 8 s.

Run: `node build.mjs && node test-engine.mjs && node test-world.mjs && node balance-bot.mjs --check`

### Numbers after this pass
- Tests: test-engine 20, test-world **429** (was 377), tutorial 33. Headless Playwright (400 px, light + dark): 27 checks per theme (54 total), no page errors.
- `--check`: **97.8%** (175/179; was 96.6%), in band 60-98. No battle logic changed: diary and bequest Memories add +1% gold each, which shifts the greedy bot's path (with only the shrine/cache/site diary hooks the same seeds gave 94.3%). It is near the top of the band; watch it.
- Full report, Part 1 (3 runs): bequests **+108 / +97 / +179** Memories (82 / 49 / 124 fallen), diaries **+21 / +12 / +4**, against run payouts of +1820 / +365 / +2475: about 8% on top. The bot loses far more pieces than a player, many of them tempered rooks and queens late in a run. The rate follows the brief (1 per 3 pawn-units, 2-battle gate); if Memories inflation needs trimming, `P1.bequestPer` is the knob.

### Known gaps (P1 pass)
- Diary progress is per region number (regions are generated per run), so "find every site" etc. can be completed across runs.
- The coach marks still do not pause the battle (module behaviour).
- Guard pips sit left of the badge and can touch a neighbouring road label on dense maps.

# Checkmarch: build notes (P0 engagement pass)

## P0 engagement pass (from the Heroes 3 / RuneScape engagement research)
The run should feel like Heroes 3 (dense, clocked, endable) and the account like RuneScape (permanent, never deducted). No module copy was edited; all wiring is in engine.mjs, world.mjs and game.src.html. Save stays **v5**: the new fields (`run.week`, `run.militia`, `state.skillGlow`, `battle.hope`) are additive and repaired on load.
- **Size.** game.html is **539.9 KB**; the budget in test-world was raised from 520 KB to **560 KB**.
- **P0-1 Punish the run, never the account.** Audit: nothing in the tree deducted banked Memories, upgrades or skill XP (the only `state.memories -=` is buying an upgrade; there was no "docks your biggest boosts" mechanic or copy anywhere in the tree). A mate or keep loss still pays 25% of that run's payout (`mateMemories`). `endRun` now clamps the payout to >= 0, so it can only add. The run-over card has a two-column split: **Lost with the run** (army and formation; artifacts, blessings and forge work; 75% of the would-be payout, "you got X of Y") and **Safe forever** (banked Memories, never reduced; upgrades bought; skills and total level). Abdication shows "Left behind" instead.
- **P0-2 Level ceremony and the Skill Guide.** `world.mjs`: `markSkillGlow` (called from `skillGains`, so battle, march and mine XP all glow), `skillGlows`, `viewSkill`, `skillHalfLevel()` (first level whose total XP is at least half of 99's: **91** on this curve; level 90 is 116 XP short), `perkDelta(t, a, b)` and `skillGuide(t, level)` -> `{ gave, next, ladder, half, landmark }`. Every level of every skill writes out a concrete change (tested for all 6 x 99). Page: each ding plays a per-skill sting (`lvP`... and `tlP`... registered into the module's `MUSIC_STINGS` table at boot, transposed per skill; falls back to the sfx when the audio context is not running), fires `fxPage.promoteFlare` (plus `materialGlint` on big levels) or, at title levels 10/20/.../99, `fxPage.regionWin` with the new title. The skill row glows (gold ring, static under reduced motion) and says "New level" until tapped; tapping opens the inline Skill Guide (what this level gave, coming next with levels, the title ladder, the "91 is half of 99" line) and clears the glow.
- **P0-3 End decided battles.** Engine `TUNE.resignCp 1000, resignMat 900, resignStreak 3`. `thinkMove` for BLACK feeds its own search score to `noteEnemyEval`: `battle.hope` counts enemy moves in a row with score <= -1000 while the player leads by >= 900 cp of material; it resets when the lead drops below 900 or the score recovers; it holds on a forced-mate score (the mate is left to play out so the mating piece gets its XP) and on a lone forced reply. `r.resign` = `enemyYields` (hope >= 3). `canClaim(battle)`: hope >= 1, lead >= 900, player king not in check. `yieldBattle(b, 'Yielded' | 'Victory claimed')` ends the battle as a win with no move and no tick; loot, XP, promotion rules are those of a normal win. Every battle type may yield; a boss (citadel or rival lord) yields "with a flourish" (`yieldLine`: "<Lord> lowers the banner and yields the field", a "Yields!" label and flare on his king, a longer pause). The page shows a full-width **Claim victory** button above the controls (with a first-encounter explainer) only when `canClaim`. Rewinds reset the streak. The balance bot lets the enemy yield (deterministic, same search) and never claims.
- **P0-4 The week clock.** `WORLD.weekTicks = 84` (about three region-1 battles with their marches; a region-1 clear is ~25-30 weeks). `worldTick` now applies ticks in segments that stop at each boundary (so `worldTick(n)` still equals n x `worldTick(1)`, tested across three turns, and the offline catch-up processes boundaries). At each turn (`weekTurn`): each held mine pays `WORLD.minePulseTicks` (12) ticks of its income; traits have no stock, so the keep **musters** 1 militia pawn (2 in the Week of the Levy) up to `WORLD.musterCap` 4; they stand with the keep's own 2 militia in a keep defence (`keepWhites`, rank 2 then rank 1). Then the new week's event takes hold. `WEEK_EVENTS` (12): Forge (smelts need half the ore, rounded up; forge.mjs untouched, the waived ore is lent to the stockpile for the smelt), Roads (marches 20% faster), Wolf (rival clock 10% faster), Plenty (mines +25%), Spoils (loot +15%), Owl (Tactician +40 elo), Mud (marches 10% slower), Levy (muster 2), Hearth (+10 gold per 100 moves), Shield (Stubborn +1 for pawns), Rest (no change), Tithe (mines -15%). `weekEvent(run, w)` = hash(run seed, w), never the same twice running; week 1 is always quiet. Modifiers ride on `run.week.mods` (engine `weekMod` for mine and keep income; world for march, rival, loot, elo, traits, smelt). March and battle modifiers apply to marches and battles that start in that week. UI: the map strip leads with "Week N · M moves left · <event>: <effect>, this week" and "Next week: the <event> (<effect>)" (colour by tone); a toast at each turn (with the first-encounter explainer); the offline toast says how many weeks turned; Forge rows show the halved recipe.

Run: `node build.mjs && node test-engine.mjs && node test-world.mjs && node balance-bot.mjs --check`

### Numbers after this pass
- `--check`: tier 1-5 attack win rate 170/176 = **96.6%** (band 60-98%; was 97.1%), 59 enemy yields in the 12 runs. No retune.
- Full report: region-1 mean clear **2386 ticks** (band 1500-3000; was 2816), tier-5 win rate 80%, 39/40 cleared.

### Known gaps (P0 pass)
- The muster only strengthens keep defences (rare); a visible muster pool on the Army tab or a "call up" button would make it felt more.
- A yield skips the rest of the battle, so captures that would have come in the mop-up give no capture XP (win and survival XP are paid in full).
- The ding sting only sounds once the audio context is running (after the first tap), like all sound.

# Milestone 6 notes (feel pass)

## Milestone 6 changes
Three more modules are copied in byte-identical: `skills.mjs` (../checkmarch-skills), `discovery.mjs` (../checkmarch-discovery) and `audio.mjs`, which now comes from **../checkmarch-music** (the freshness test and the build.mjs comment point there; ../checkmarch-audio is no longer the source). `test-world.mjs` checks all three against their sources.
- **Build.** `skills.mjs` and `discovery.mjs` are inlined namespaced, like content: `SK` and `DSC`. A namespaced module's named imports from another namespaced module become a destructuring line at the top of its scope (discovery imports content), and imports from flat modules (map.mjs) resolve to the inlined globals. The page template (CSS, markup, UI script; not the modules) is lightly compacted on output: leading indentation, full-line `//` comments and `/* */` comments go. The `<style>` block also drops the spaces around `{ } ;` and after `:` and `,` (UX clarity pass, to stay under the 520 KB budget). The clash check still runs on the uncompacted source.
- **Size.** game.html is **512.9 KB**; the test-world size check was raised from 450 KB to **520 KB** (the music module alone added about 26 KB).
- **Save** stays **v5**. No migration was needed: `state.skills` is additive and repaired by `cleanSkills` in `migrateState` on every load (and `run.skillMods` is always re-derived); discovery fields are repaired by `cleanDiscovery` in `ensureMap` (an old map gets `disc: 0` and no discovery content until the next region, per DISCOVERY-API decision 6); the battle serializer adds `sx`, `start`, `moves`, `rw`, `ward`, `wardMax`, `hints`. A battle saved before M6 resumes with an empty tally and cannot be rewound.

### Skills (SKILLS-API.md section 7)
- engine.mjs has no imports: world.mjs registers the module with `setSkillsModule(SK)` (like the terrain provider). `newState` adds `skills`; `skillStart(state)` (grantStart + skillMods) runs after every `newRun` in `newState`, `endRun` and `rebuildRun`.
- Prices: `pieceCost(run, t)` / `squareCost(run)` apply the skill discount to the base price, then `spend` applies the town/blessing `effPrice`. They are used by `buyPiece`/`buySquare`, every shop row, the square buy button, `refreshShopButtons` and the bot.
- Leadership: `marchNeed(run, id)` is used by `startMarch`, the March button label and the v3 march fix-up.
- Tally: `worldBattle` starts `b.sx`; every move of a world battle goes through `world.battleMove(run, b, m)` (playMove + tally). A capture undone by a trait (Bulwark hold, a victim that slipped away) **or a glanced counter** does not count; a promotion counts only when the pawn actually became a queen.
- Awards: `awardBattleXp` in `endBattle` before the mate branch (raw engine result), `awardMarchXp` in `arriveNow`, mine XP inside `worldTick` (`mineSkillXp`, gated on a held mine; so it also runs mid-battle and on the offline catch-up). `worldTick` now returns `dings`.
- UI: Army tab Skills block (K Q R B N P; level, title, headline perk, 4 px XP bar, XP to next; tap to expand the next title / next free piece); result cards show `sum.xpText`; the run-over screen says skills carry over with the total level. Dings are queued 2.8 s apart as toasts; sound is `audio.sting('ding')` when the music module has a `ding` sting (it does not), else `win` for big dings and `promote` otherwise.
- The balance bot earns XP like the page (battle, march, mines) but never rewinds.

### Discovery (DISCOVERY-API.md INTEGRATION)
- `initDiscovery` after every fresh `newWorldMap` (ensureMap on a new run, the citadel branch of `applyMapResult`); `cleanDiscovery` at the end of `ensureMap`.
- `arrive` collects the pile on the road walked (`collectOnMarch(marchFrom(...))`) before the battle or cache, applies it with `applyEffect`, and leaves `run.map.lastGains` for the page's toast.
- `applyMapResult` (same region) and `takeCache` call `afterCapture`: piles on held roads, the Spyglass reveal, and the site card at the node (`sum.site`). Shrine `reveal` now uses discovery's `revealAround`.
- `discoveryBusy` blocks `canMarch`, `raidPaused`, map taps and (through the overlay) the ambient clock.
- Cards go through the existing `showResult` gate list: an **ambush card** (Fight / Slip away) and a **site card** (a / b, disabled with the reason, plus **Not now**). `tick()`'s self-heal condition now includes `DSC.discoveryBusy(run)`, so a hidden discovery card comes back within a second (tested headless).
- Ambush battles: `ambushArmy` (enemyArmy type raid, budget x v), `startAmbush`, `finishAmbushBattle` (mate = loss, the run is never at stake, retreat allowed, raid-rate loot on a win, the prize artifact). Node type `ambush`.
- Artifacts live on `run.arts` and are listed on the Run tab with their effects. Blessings created by an artifact are tagged `art` and left out of the blessing list.
- Live kinds: **hints**: Hints now cost gold (`WORLD.hintLoot` 10% of the battle's loot, min 5) and the Tactician's Lens makes the first ones each battle free; the button shows "free" or the price. This is a new cost (hints were free before) so that the artifact means something. **traitWard**: the artifact text and the brief say *counter roll*, so the ward is in engine `playMove`'s counter roll: the player's first `wardMax` counter rolls each battle cannot fail (counted on `battle.ward`; the log says "warded"). Victim traits are not warded. **sight**: through `afterCapture`.
- Map: on the rival overlay canvas after the rival layer: scouted badges (0.75 alpha, dotted ink ring, tier tag), twinkling road glints (gold / resource / rare-red), site diamonds with glyph, a pulsing ring on ready sites, faded visited sites, a name pill for 2.6 s after a tap. `onMapTap` hit-tests sites (opens a ready one) and piles (a peek toast) before nodes.

### Music (checkmarch-music INTEGRATION.md)
`updateMood()` replaced as written (through `musicCtx()`, which headless checks can read), called on tab change and once per second in `tick()`. No `setIntensity` calls remain; threat uses the pending raid / rival attack, never `map.contact`.

### Rewind (new)
- `WORLD.rewinds` = 3 per battle. `worldBattle` stores `b.start` (board, side, kings, ids, materials, tally) and `b.moves`; engine `playMove` appends every ply. `rewindBattle` truncates to just before the player's last own move (2 plies, or 1 if the enemy has not replied), resets with engine `resetBattle` and replays through `battleMove`, so captures, the tally, traits and counter rolls are rebuilt (same seed + ply = the same rolls, by design). A rewind costs its charge even if the same move is replayed; world ticks already spent are not refunded.
- UI: a ↶ ×N button beside the battle controls, disabled at 0 charges, with no own move to unwind, while a trait announcement is pending, or once the battle is over. After a rewind the battle is in manual takeover; if it was on auto, auto resumes after the player's move (the main button reads "Resume").
- Tests: exact position/ids/losses/tally/history restore, capture undone, ply-1 rewind, double rewind to the start, 3-charge accounting, no rewind after mate, rewind after a save round-trip.

### Theme
Parchment/walnut day and slate/moonlight night through the existing tokens (plus `--rule`, `--crest*`, `--hdr`). A framed header with an inline SVG crest, the house name and "Region N · lord, epithet"; tab icons (shield/Shop, banner/Army, anvil/Forge, scroll/Run); a double rule on cards, panel, stats and the run-over section; ruled section headings. Text tokens measure 4.5:1 or better against bg, panel and panel-2 in both themes. Danger stays reserved for raids, check and bosses. Battle controls: speed and rewind are fixed-width so five buttons fit at 400 px.

Run: `node build.mjs && node test-engine.mjs && node test-world.mjs && node balance-bot.mjs --check`

### Known gaps (milestone 6)
- The --check win rate is 97.1% (band 60-98%, was 93.1% before discovery). Region-1 mean clear 2816 ticks (band 1500-3000). No retune was made; watch the top of the band.
- Discovery content starts only in the next region for maps saved before M6.
- The music module has no `ding` sting; dings use the sfx fallback.
- Hints now cost gold (see above).

# Milestone 5 notes (forge and frontier)

## Milestone 5 changes
Four finished modules are copied in byte-identical and inlined by `build.mjs`: `forge.mjs`, `terrain.mjs`, `content.mjs`, `fx.mjs`. `test-world.mjs` checks each copy against its source directory, as it does for map, audio and rival.
- `content.mjs` exports `UNITS`, `DOCTRINES` and `RESOURCES`, which clash with engine/forge names. The build therefore inlines it inside a function scope and exposes it as one namespace, `CONTENT`. world.mjs imports it with `import * as CONTENT`.
- **Terrain** (`terrain.mjs`).
  - Each node gets a biome from `biomeFor(run, id)`. Region 1 is mostly plains, region 2 leans highland, region 3 leans marsh, and the pattern repeats.
  - Every node, raid, border and seat army gets `army.terrain = generateTerrain(map seed, key, 8, biome, {tier, type, avoid: enemy piece squares})`. **`avoid` is always the enemy formation**, so no wall lands on a piece. Tiers below 3 stay clear.
  - Engine: the TERRAIN-API patch is applied verbatim (the `WALL` table, the pawn-push line with the double-step check, `setTerrainGeometry`). On top of it, world.mjs registers `setTerrainProvider(terrainGeometry)`. `useTerrain(battle.terrain)` swaps the tables only when the terrain changes. It is called by `playMove`, `thinkMove` and `battleLegal`, so the game, the bot and the tests always play on the right board. The UI restores open tables at battle end.
  - Trait landing squares also skip walls.
  - The DOM board draws `terrainSquareSVG` in each square during battle, and faint during the ghost preview. Node and battle cards say "rocky ground", "wet ground" and so on, with rock and water counts.
- **Forge** (`forge.mjs`, Forge tab).
  - **Tick-time conversion:** the forge's "now" is `run.ticks x FORGE_MS_PER_TICK`, where `FORGE_MS_PER_TICK` = `TUNE.tickSec x 1000` = **3000 ms per tick**, the same rate the gold economy uses.
    - A forge hour is 1200 ticks, so a tin mine gives 8 tin per 1200 moves.
    - A stockpile cap is 24 forge hours (28,800 ticks of output).
    - **The smelt cap resets every 28,800 ticks** (a forge "day" = `floor(now / 86.4e6)`).
    - The forge's 8 h gap cap (9600 ticks) never applies, because `worldTick` feeds it every tick. `worldTick(300)` equals 300 x `worldTick(1)` for the forge too (tested).
  - `run.ticks` counts every world tick of the run.
  - Mine resources (`mineResource`): region 1 has tin and coal, region 2 adds iron ore, region 3+ adds obsidian shards. Mines take the pool in turn from a seeded offset, so every resource of a region appears. The map labels each visible mine with its resource, and mine cards say what it yields.
  - The Forge tab shows:
    - stockpiles with a fill bar and a progress sliver to the next unit, and the rate per 100 moves;
    - smelt buttons (iron, steel, obsidian), the smelts left today and the moves until the reset;
    - a "Bellows" smelt-cap upgrade bought with gold (`smeltLevelPrice`);
    - roster chips: tap one to temper it with the next bar.
  - Materials live in `run.forge.mats[pieceId]`, keyed by the existing stable roster ids. A promoted pawn keeps its id and its bars. Badges (iron, steel, obsidian) appear on board pieces, reserve and garrison chips, Army-tab roster rows and enemy pieces.
  - Engine: an optional `pos.m` tier table moves in `makeMove`/`unmakeMove`. `pos.mv` holds the `evalBonus` sum (+15 cp per tier), which is added in `evaluate`. Move ordering scales a counter-able victim by 0.75. Search stays deterministic.
  - **Counter captures:** `counterInfo` and `playMove` call `counterCheck` and `captureFallback` (registered by world.mjs through `setCaptureRules`).
    - The roll happens only when the target is exactly one tier above the attacker. It is seeded by battle seed + ply (salt 404).
    - **No roll when the failed capture would leave the mover's king attacked** (the capture is the only way out of check, or the fallback square exposes the king).
    - On a failure, the attacker stops on the fallback square, nothing is captured and the turn is spent.
    - Each roll is announced before it resolves, like trait rolls: a toast and a battle-log line such as "Wood rook strikes an iron knight: 25% the blow glances off... roll 0.21 < 0.25: the capture fails (stops on e4)". The target shakes and gets a "Glanced off!" label.
  - A captured roster piece loses its bars (`losePiece`, through `settleForge`). The result card says how many bars were lost.
  - Enemy materials: from region 3, garrisons and rival armies put iron on their most valuable pieces, 1 piece + 1 per 6 tiers past tier 20 (max 4). From region 5 the best of them is steel.
- **Content pack** (`content.mjs`).
  - Shrines draw from `SHRINE_CHOICES`, gated by `minRegion` and picked deterministically per node. A side whose preconditions fail is greyed with the reason (no gold, no such piece, no square left, dwelling at max, no rival). A `promotePawn` side opens the pawn picker.
  - The whole effect vocabulary is implemented in world.mjs (`applyEffect`).
    - Scoped effects go to `run.blessings` as `{kind, v, scope, region}`. Region entries are active only in their region. `next` entries are consumed by the next battle the player fights (`worldBattle`) and kept on `battle.next` for its loot.
    - `memoriesOnEnd` is added by `endRun` after the mate cut.
    - `reveal` fills `run.map.scouted`. Scouted fog nodes are drawn on the overlay and get full node cards.
    - `marchMult` applies to `marchTicks`.
    - `rivalClock` pushes `rival.nextMoveAt` back (a field in its plain-JSON state).
    - `rivalStrength` is a world-side view (`rivalView`): a copy of the rival with its xp shifted, so army tier, strength and dwellings move by v. `rival.mjs` and its saved state are untouched.
    - The Run tab lists the active blessings.
  - Rival lords: each new region gets `lordForRegion` (`run.map.lord`). The lord's name replaces the boss name, the lord's doctrine drives rival armies, and rival garrisons use `formationsForLord` when one covers the tier. The taunt is shown on the region-win card and as a toast when the region opens (or a new run starts). The rival chip shows the name, epithet and doctrine.
  - Formations: banded merge through a new `enemyArmy` `opt.formation` hook. One in 3 neutral nodes uses `formationsForTier`.
  - `EVENT_LINES` are picked deterministically and filled for battle win and loss, raid, raid repelled or lost, cache, region win and region lose (run over). Lines whose placeholders can't be filled are skipped.
  - `PIECE_SETS`: a cosmetic picker under Run > Settings. Unlocks come from lifetime Memories, best region, rival seats won and the first bar of a material smelted (`state.cosmetics`, `state.bestRegion`, `state.seats`). The set is applied as CSS custom properties with `color-mix` on the theme tokens.
- **Saved maps stay stable:** migrated v4 maps keep `pack: false`, so they get no pack formations, no caches and no lord until the next region.
- **Supply caches** (world-side; map.mjs is unchanged): 1-2 per region on v5 maps, on the lowest-tier garrison nodes past the first column.
  - You march to a cache, and on arrival it is taken at once with no battle. It pays `lootFor(tier)` (`WORLD.cacheLoot` 1.0), shows a cache line and plays a coin FX.
  - The overlay marks caches with a gold chest. A rival-held cache is an ordinary rival garrison.
- **FX** (`fx.mjs`): three instances, on the board, on `.mapbox`, and a fixed page overlay. `.ov` was raised to z-index 8 so cards cover effects.
  - `commitMove`: `moveTrail`, `captureBurst` (delayed 200 ms), `traitSave` (trait saves and "Glanced off!"), `promoteFlare`, `checkPulse`.
  - `endBattle`: `regionWin` when the seat falls; otherwise a small burst on the enemy king.
  - `endRunUi`: `runOver` with `desaturate: #app`.
  - The 15 s mine coin fires `mineTick` on each held mine. Rival captures, rival attacks and raids fire `rivalCapture`.
  - `materialGlint` fires on recruit, dwelling buy and tempering.
  - Palettes refresh in `applyTheme` and on the colour-scheme listener. Reduced motion is handled by fx.mjs itself.
- **Elo fixes** (live bug reports).
  - A save that never chose a band explicitly (v3 and older, or a v4 save still on the default 900) shows the "Choose your foes" card once on load. The map and any march pause until it is answered.
  - The Run tab has an **Opposition elo** control to change the band mid-run (`setRunElo`). New opponents use it from the next battle, the rival is re-based, and the Tactician stays equal.
  - Reset now calls `showResult()`, and `tick()` self-heals any gate whose card is hidden (the coordinator's v7 hotfix).
- **Save v5** (`SAVE_VERSION = 5`). Saves migrate v1 -> v2 -> v3 -> v4 -> v5.
  - v4 -> v5 adds a fresh forge at tick 0, and `mineBless` becomes a region blessing.
  - The map keeps its formations, rival and boss name (`pack: false`, `lord: null`).
  - Cosmetics, `bestRegion` and `seats` are added.
  - The battle serializer adds `m`, `tactElo`, `next` and `lastCounter`. Terrain rides on `battle.node`. A battle in progress at migration resumes on open ground with no materials.
- **Debug handle:** `window.__checkmarch` (state, fx instances, `act`, `run(code)`) for headless checks. It has no gameplay effect.
- **balance-bot.mjs:** shrines take side a (or b when a is greyed). Caches are taken via `arrive(run, state)`. Terrain and counters apply automatically through `playMove`/`thinkMove`. No retune was needed.

Run: `node build.mjs && node test-engine.mjs && node test-world.mjs && node balance-bot.mjs --check`

### Known gaps (milestone 5)
- `../checkmarch-terrain/test-terrain.mjs` fails one check ("all 3 patch anchors found exactly once in engine.mjs (0)") because engine.mjs is now patched. It looks for the unpatched lines. test-world.mjs checks that the patch is present instead.
- The forge smelt cap (1 per 28,800 ticks before Bellows) means most runs smelt only a few bars. Shrine bars and resources matter more than mines for materials.
- `terrainSquareSVG` does not bridge water squares, so ponds read as separate tiles.
- Scouted nodes are drawn on the overlay canvas. The map module's own fog is unchanged underneath.
- The engine eval has no terrain terms beyond mobility, as TERRAIN-API.md notes.

# Milestone 4 notes (the living rival)

## Milestone 4 changes
- **Tick time** (replaces wall-clock time everywhere in the sim).
  - One chess move (either side, any battle) = 1 world tick. A march costs `5 + 12` ticks per road step in region 1 (10 in region 2, 8 from region 3, capped at 10 steps). The page plays a march out at about 3 ticks per second (`WORLD.marchTickMs` 330), so it still animates.
  - (Superseded in v6: no ambient ticks.) The open map (no battle, march, card or hidden tab) drips 1 ambient tick every 2 s (`TUNE.ambientMs`). Moves and marches are the real clock.
  - Income: one tick is worth `TUNE.tickSec` = 3 seconds of the old economy, so income per tick = gold/min x 3 / 60. The UI shows gold per 100 moves.
  - The rival counts in seconds; `WORLD.rivalSecPerTick` = 1, so 1 tick = 1 rival second. Its first move comes after about 90 ticks; the gap between moves is 90 + 60 per held node, in ticks.
  - The raid clock counts ticks: first raid after 360, then every 300 ± 90. It pauses only while a choice waits (shrine, raid, rival attack).
  - (Superseded in v6: no catch-up at all.) Offline, the world freezes. On return there is one catch-up of `min(300, away / 2 s)` ticks (`TUNE.offlineTicks`). It runs in offline mode: no raids, no keep assault, at most one border battle queued. This replaces the 8 h accrual. A march does not advance offline.
  - `world.mjs worldTick(state, n, online)` is the only clock: it pays income, then advances the raid clock and the rival. `worldTick(300)` equals 300 x `worldTick(1)`, and the tests check this.
- **The living rival** (`rival.mjs`, a byte-identical copy of `../checkmarch-rival`; test-world checks it like the map/audio copies).
  - Every region has a rival lord, named after the region's boss, who holds the citadel as his seat.
  - The map shows rival territory as a tint, roads, banners and a dashed frontier in a second colour (`--rival`), and a pulsing ring on the node he is attacking.
  - The rival chip shows his strength, dwellings, held nodes and "Rival moves in N moves".
  - **Border battles:** when the rival attacks a held node, a card offers Defend or Concede.
    - A garrisoned mine is defended by the castellan and its garrison; losing costs the mine, not the run.
    - Any other node is defended by your formation, and your King fights, so checkmate ends the run.
    - A win or draw repels him (60% loot on a win, plus a cooldown on the node). A loss or a concession hands the node over.
  - **Attacking a rival node:** you fight `rivalArmyFor` (role garrison). Taking his seat wins the region; this replaces the citadel flow, and the boss's name now belongs to the rival.
  - **Keep assault:** online only, once he holds 8+ nodes. It pauses the map until answered.
    - You defend with the formation plus 2 keep-militia pawns, which are not on the roster. There is no auto-retreat.
    - Losing, yielding or retreating ends the run (field defeat, 25% Memories).
  - Ambient raids run only until his border first touches yours (`run.map.contact`); after that the rival is the raider. A raid and a rival attack are never pending together.
  - The rival chronicle (Run tab) folds repeated sorties into one line.
  - Armies: `rivalArmyFor` supplies tier, role and elo. The pieces are filled by `enemyArmy` on the engine budget curve (with its early ramp), times the role multiplier, times `WORLD.rivalArmy` 0.85. The module's flat curve made region-1 hosts about 25% bigger than the garrisons around them.
  - `RIVAL_TUNE` overrides in `WORLD.rivalTune` are applied at load, so the module file stays verbatim: bonusCap 5, keepAssaultMinHeld 8, multKeep 1.0, perNodeMs 60 s.
- **Dwellings and traits** (Army tab).
  - Each piece type has a dwelling of level 0-3. Prices: pawn `150 x 3^lvl`; knight and bishop 250, rook 350, queen 500 base.
  - Traits roll only in `playMove`, when a capture lands on the real board; `search()` never sees them. Rolls are seeded by the battle seed + ply, so replays are stable.
  - Every roll is announced (toast + battle log) before it resolves, then its result is shown.
  - Stubborn pawn (20%/lvl): falls back one square toward home; dies if that square is taken.
  - Sidestep knight (12%/lvl): to a random empty knight square.
  - Faith bishop (12%/lvl): one square along the diagonal pointing most away from the attacker. A straight-line attack ties two rear diagonals, broken by the seeded roll; if the square is taken the slip fails. "The first empty square" is read as the adjacent one, so a bishop never jumps.
  - Bulwark rook (10%/lvl): the capture fails, the attacker stays where it was, and the turn is spent.
  - Majesty queen (15%/lvl): steps to an adjacent empty square. Once per battle means one successful save; failed rolls don't use it up.
  - **Edge rule:** a trait only takes effect when the capturing side's king is not left attacked afterwards. Examples: a Bulwark can't undo a king capture that got out of check, and a sidestep can't give check to the capturer. Otherwise the capture stands, and the log says "no safe square".
  - Enemy trait levels are handed out round-robin P N B R Q from points. Garrisons get 1 point per 4 tiers from tier 5; the rival gets his dwelling level. The levels show on node and battle cards.
- **Elo bands.**
  - A first-run card (and the run-over screen) picks the opposition: 600 / 900 / 1200 / 1500.
  - `ELO_TABLE` in engine.mjs maps elo to depth, quiescence, time budget and jitter.
  - Opponents sit at band ± 40 (per node), +80 per region, +100 at the rival's seat; the rival adds +50 per strength.
  - **The player's Tactician plays at the same elo as its current opponent.** Each Tactician level buys +100 elo (relabelled in the shop).
  - Migrated players default to 900, and the picker is not forced on them.
- **Promotion is temporary.** A promoted pawn fights as a queen for the rest of that battle and returns to the roster as a pawn. The shrine's Knighthood stays permanent, and the UI says so.
- **Easier start / balance pass** (`TUNE`): rampStart 0.15 (tier 1 is K+P), rampTiers 6, enemyBudgetBase 5 (was 8), lootBase 35 (was 10), mineBase 3, startGold 90 (two pawns at once).
- **Save v4.** v3 saves keep everything. The raid countdown is converted from ms to ticks. A march in progress restarts at its tick price. The rival starts fresh at its seat. Battles in progress resume with no traits. Elo defaults to 900; dwellings start at 0.
- **balance-bot.mjs** runs on ticks.
  - Part 0: elo calibration (`CAL`, games per cell).
  - Parts 1-2: as before, with the rival, the border policy and region-1 clear time in ticks (target 1500-3000).
  - Part 3 (`OFF`): 1200 ticks, then the away catch-up, then 2000 ticks.
  - **`node balance-bot.mjs --check`** (CI): 12 fixed seeds x 1500 ticks in about 2 s. It prints the tier 1-5 attack win rate and exits 1 outside the band **60-98%**. Without the flag the full report runs as before (exit 0).
  - Knobs: `ELO`, `RIVAL=0`, `RUN_TICKS`, `REGION_CAP` (ticks).

Run: `node build.mjs && node test-engine.mjs && node test-world.mjs && node balance-bot.mjs --check` (full report: `node balance-bot.mjs`)

### Known gaps (milestone 4)
- Elo steps above 1200 are weak: in this engine, +100 to +300 is worth only 55-65%.
- The rival clock does not run in a hidden tab, and a march freezes there (by design: the world freezes).
- The trait announcement delays only the capture itself (about 1.3 s at 1x speed).
- With equal engines a default run can still be mated at tier 1-2 by a blunder (about 1 in 60 bot runs).

# Milestone 3 notes (the long game)

## Milestone 3 changes
- **Memories shop** (`MEM_SHOP` in engine.mjs; Run tab and the run-over/abdicate screen). Five permanent upgrades: Militia (+1 starting pawn, max 5), Wider camp (+1 starting square, max 6), Keep stores (+1 gold/min base, max 10), Tutored Tactician (starting level, max 3), War chest (+30 starting gold, max 10). Cost `round(base x growth^level)`. Upgrades apply to new runs. While the current run is still untouched (no buy, march or battle), it is rebuilt at once, so buying on the run-over screen counts. Each unspent Memory still gives +1% gold (it was +5% per Memory).
- **Save v3** (`SAVE_VERSION = 3`).
  - v2 saves: old Memories become spendable 1:1, plus a one-time bonus of the same amount (capped at +50), since each one used to be worth 5x more. `settings.autoRetreat` becomes the retreat order (on -> cautious, off -> off). The raid clock and garrisons are added.
  - v1 saves still migrate, through v2.
- **Raids and garrisons** (world.mjs, `run.map.raid` and `run.map.garrison`).
  - Tap a held mine on the map, or Manage on the Army tab, to station pieces there (up to 5). Stationed pieces are not in the formation or the reserve.
  - The raid clock only runs on active map time while you hold a mine in this region. It is paused during a march, a battle, a result card, a shrine choice, a hidden tab, and offline. The first raid comes at 6 min, then every 5 ± 1.5 min.
  - The map shows the target mine with a countdown pin, plus a line under the map.
  - When a raid fires, you choose between Defend and Concede. Defend is only offered when the mine has a garrison. It starts a battle with a castellan King plus the garrison. Losing the castellan loses the mine, not the run.
  - Win or draw keeps the mine; a win also pays half loot. A loss or a retreat loses the mine (the garrison survivors come home), and the mine can be retaken from the map.
  - Raid budget = mine budget × (0.45 + 0.06 per mine held, capped at 8) × (1 + 0.08 per region after the first).
- **Doctrines** (`DOCTRINES` in engine.mjs): aggressive (king tropism, own king safety ×0.4), solid (king safety ×2.2, penalty for enemy pieces near its king), material-hungry (enemy material counts ×1.22).
  - The doctrine is applied in `search()` for the side to move at the root, relative to the root position, so retreat thresholds stay meaningful. With no doctrine the eval is unchanged, and so are perft and the mate tests.
  - Garrisons and citadels each get a deterministic doctrine, shown as a tag plus one line on the node card. A citadel shows the boss's doctrine. Raiders are aggressive.
- **Standing orders** (`run.orders`, carried across runs): doctrine (Balanced or one of the 3), "never trade the queen" (+450 cp on own queens), and auto-retreat off / cautious (-500) / stubborn (-1200).
- **Fixes**
  - The end-of-battle text now depends on the node type: towns open their gates, miners throw down picks, raiders flee, and so on.
  - Knighthood at a shrine opens a pawn picker. Tap a gold-ringed pawn on the board, or a chip for one off the board.
  - Travel time per step is 2 s in region 1, 1.5 s in region 2 and 1 s from region 3.
- **Balance pass** (all in `TUNE`). The world map gives about 25 battles per region against the road's 10, and early promotions snowballed.
  - Early ramp: tier 1 is 45% of the formula and the full formula applies from tier 4.
  - +10% enemy budget is phased in over tiers 4-8.
  - Enemy depth is at least 2 from tier 3. This deviates from the spec's `1 + floor(tier/8)`: depth-1 captains walked into mate-in-1.
  - The citadel multiplier is 1.2 (was 1.35).
  - `lossRefundsPrice`: losing a piece steps that type's price back one level, so a bad battle no longer starts a death spiral.
- **balance-bot.mjs** now plays the real map.
  - Route: the weakest frontier node, mines first; the citadel once the army reaches 90% of its points.
  - It buys greedily, waits for gold when the odds are hopeless, keeps a 1-pawn garrison when the army is big enough, defends or concedes raids, and spends Memories cheapest-first between runs.
  - It reports per-region clear times, win rates by tier band and raid stats. Part 2 runs 40 fresh default starts through region 1 and flags results outside 30-60 sim-min (mean clear time) or 60-98% (tier-5 win rate).
  - New env knobs: `REGION_CAP`, `GARRISON=0`, `WORLD_JSON`, `FIRST`, `V2`.

Run: `node build.mjs && node test-engine.mjs && node test-world.mjs && node balance-bot.mjs` (test-map.mjs lives in ../checkmarch-map)

### Known gaps (milestone 3)
- Region-1 clear times are bimodal. Runs that promote pawns early clear in about 10 sim-min, and about 15% of runs stall past 120 min at the citadel. The mean is about 30, the median about 23.
- Region 2 from tier 16 (enemy depth 3) is a wall for the bot: about 30% wins at tiers 16-20.
- The bot's 1-pawn garrisons rarely hold, so raids mostly cost it mines. Real defence needs 3 or more pieces.
- The raid pin can overlap the selected node's name pill.

# Milestone 2 notes

## Milestone 2 changes
- `map.mjs`, `map-render.mjs` are verbatim copies of `../checkmarch-map`; `audio.mjs` is a verbatim copy of `../checkmarch-audio`. `test-world.mjs` checks that the copies still match their sources.
- `world.mjs` is the glue between the map and the game: `run.map`, marches, node armies, capture effects, the shrine choice and save migration.
- `build.mjs` inlines engine, map, map-render, audio and world, in that order. It fails if two of them, or the UI, declare the same top-level name.
- The world map replaces the linear road. Tap a frontier node to see its garrison as ghosts on the board, then tap it again or press March.
  - A march takes 5 s plus 2 s per road step from the keep, capped at 10 steps. It shows a progress bar and a knight marker on the map. Halt cancels it.
  - Arrival starts the battle from the formation as it is at that moment. A march in progress is saved, and one that finishes while the page is closed starts its battle on load.
- Every node except the keep is a battle. Enemy budget by node type: mine ×0.85, town ×0.9, shrine ×0.85, citadel ×1.35.
  - Mines pay gold per minute for the rest of the run.
  - A town that is held or on the frontier gives a standing 10% shop discount.
  - A shrine offers a one-time choice: knight a pawn, or +20% mine income for the rest of the region.
  - A citadel opens region n+1, which has a new seed and starts at tier (n)*10.
- Save version 2 uses the same localStorage key. A v1 save is migrated: everything is kept, including mines, and the map starts at region `floor((tier-1)/10)+1`. Unknown versions start fresh, with a toast saying so.
- The linear road code in engine.mjs stays (`createBattle(run)` with no army), so `balance-bot.mjs` works unchanged.
- Audio uses the audio module.
  - It unlocks on any pointerup. The ♪ button and the setting both drive `setEnabled`.
  - Bed intensity is 0 on the map, 1 in battle, 2 when the side to move is in check, and 3 for the whole of a citadel battle.
  - Events: move, capture, check, promote, win, lose, buy, and coin on loot and on a mine pulse every 15 s while on the map.
- Dark theme: enemy pieces have a lighter violet-black fill and a crisp light outline. Ghost previews are outlined too.

Run: `node build.mjs && node test-engine.mjs && node test-world.mjs && node balance-bot.mjs`


## Files
- `engine.mjs`: chess engine plus all game logic (economy, road, enemy formations, battles, save serialization). Plain exported functions.
- `game.src.html`: page template (CSS + UI script) with an `/*ENGINE*/` marker.
- `build.mjs`: inlines `engine.mjs` (with `export` stripped) into the template, writes `game.html`, then runs `node --check` on the inline script.
- `game.html`: the final self-contained artifact page. Do not edit it by hand; edit the two sources and run `node build.mjs`.
- `test-engine.mjs`: perft, mate/stalemate, promotion/roster, army data, time budget, and page-contract checks. It also verifies that `game.html` contains the current `engine.mjs`, so the two cannot drift.
- `balance-bot.mjs`: headless balance sim. Env knobs: `RUNS`, `RUN_MIN`, `T5`, `SEED`, `NPMS`, `TUNE_JSON` (overrides `TUNE` values for sweeps), `V=1` (log every battle).

Run: `node build.mjs && node test-engine.mjs && node balance-bot.mjs`

## What works
- Engine: 8x8 legal move generation and mate/stalemate detection. Negamax with alpha-beta, MVV-LVA capture ordering, a killer move, a check extension and quiescence search. Iterative deepening runs under a time budget (60 ms, plus 40 ms per Tactician level) or a node budget. Root jitter makes weak levels beatable, and the engine avoids repetition at the root.
- Eval: material, piece-square terms (centrality, pawn advance, rook on the 7th rank, king placement), a pawn shield for king safety, light mobility, and a mop-up term for won endings.
- Rules: no castling and no en passant. Promotion is always to a queen, for both the engine and the player. A promoted pawn stays a Queen on the roster.
- Battle ends:
  - Checkmate.
  - Stalemate (draw).
  - A side reduced to a bare king (the garrison surrenders or the army is routed).
  - Threefold repetition or the 140-ply cap. The side 3 or more pawns ahead on material wins; otherwise it is a draw.
  - Draws and losses leave the node uncleared and keep the survivors.
- Player-mated = run over. Pays 25% of the abdication memories.
- Formation editor:
  - Owned squares on ranks 1-2. Start: e1 plus d2, e2 and f2, with K and 3 pawns.
  - Tap a piece, then a square. Tapping two placed pieces swaps them. A placed piece can be benched; the King cannot.
  - Tap a `+` square to buy it.
  - The enemy formation is previewed as ghost pieces and becomes the live army when you march.
- Road: a strip showing garrisons, mines, towns and every-10th-tier citadels with named bosses. Mines pay gold per minute for the rest of the run, including offline up to 8 hours. A town gives 30% off the next purchase.
- Battle screen:
  - 700 ms per move with 1x/2x/4x playback.
  - Take over / Auto play. In manual play, legal-move dots and capture rings appear.
  - Hint highlights the move. Retreat uses a two-tap confirm.
  - Moves slide; the last move is highlighted; a king in check pulses red; a promotion pops.
- Optional auto-retreat (on by default): the Tactician retreats when its search score falls to -700 or lower.
- Economy and prices follow the spec formulas. Abdicate (two-tap) pays `max(1, floor((sumTiers/10)^1.3))` memories, each worth +5% gold forever. It is enabled after at least one clear.
- Save: localStorage under `checkmarch.v1`, wrapped in try/catch. The battle in progress is saved and resumes on reload, so reloading cannot erase losses. Offline income is applied on load. Reset save uses a two-tap confirm. `window.claude.hot` snapshot and boot are wired as the spec asks.
- Themes: day (cream/walnut board) and night (slate/moonlight board). The header button cycles Auto/Day/Night. Sounds are synthesized with Web Audio after the first tap and can be muted. Motion is reduced under `prefers-reduced-motion`.

## Deviations and tuning (all in `TUNE` in engine.mjs)
- Enemy budget base is 8, not the spec's ~6. With 6, every run that reached tier 5 had already promoted pawns into queens, and tier 5 was a 100% walkover.
- Tiers 1-5 ramp from 25% of the formula up to 100%, so the 3-pawn start is fair. Tier 1 with no purchases is won about 88% of the time.
- Early garrisons play noisily: jitter is 90 cp at tiers 1-2, 50 cp at tier 3, then drops 20 cp per tier. Below tier 3 their quiescence search is only 1 ply deep. The enemy depth formula `1 + floor(tier/8)`, capped at 4 with +1 at citadels, is as specified.
- Added a 2 gold/min home-keep base income and 60 starting gold. Without them, a run with no mines could get stuck with no way forward.
- Added a free 2-pawn levy when the army is reduced to a lone king. This prevents a soft-lock.
- Mine rate: 2 × 1.06^tier gold/min (the spec leaves it open).
- Piece prices count copies bought this run (25 × 1.7^bought), not pieces owned, so the 3 starting pawns don't inflate the first price.

## Known gaps and rough edges
- The engine runs on the main thread (60-180 ms per move). It can be felt on slow phones, but there is no worker.
- There is no promotion picker; promotion is always to a queen, as the spec says.
- The difficulty curve is lumpy. After a promotion, the next 5-10 tiers are easy. Walls appear around tier 10 (the first citadel) and from tier 16 (enemy depth 3).
- Memories compound quickly: a full 90-minute run can pay 40-130. This needs tuning in a later milestone.
- The balance bot uses node budgets (120 nodes/ms, about a mid-range phone), so in-browser strength on fast desktops is a little higher.
