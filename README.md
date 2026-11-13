# Checkmarch

A touch-first idle chess strategy game. You build one persistent army on an 8x8 board, march it across a fogged region map, and every node is a real chess battle. Your Tactician plays for you and you can take over any move. Pieces die for good, a rival lord expands from the far side of the map, and a checkmate in the field ends the run.

Checkmarch is plain JavaScript with no dependencies: no `npm install` and no dev server.

## Play it

Open `checkmarch/game.html` in a browser, by double-clicking it or dragging it into a browser window. It is one self-contained file that works offline, and it is the same page that is published as the claude.ai artifact. Progress is saved in the browser's local storage.

## Layout

```
checkmarch/            the core game
  game.src.html          page markup, styles and UI code (edit this, not game.html)
  engine.mjs             chess engine and game rules: moves, search, doctrines, economy
  world.mjs              ties the region map, rival, raids and garrisons to the run
  build.mjs              inlines the modules into game.src.html and writes game.html
  game.html              the built single-file game (generated; committed so it opens directly)
  test-engine.mjs        perft, mate/stalemate and page-contract tests
  test-world.mjs         map, economy, raids and save-migration integration tests
  balance-bot.mjs        headless bot playthroughs: win rates and pacing
  map.mjs, map-render.mjs, audio.mjs, rival.mjs, forge.mjs, terrain.mjs, fx.mjs, content.mjs,
  skills.mjs, discovery.mjs
                         copies of the module folders below
  BUILD.md               what changed in each milestone
checkmarch-map/        region map generation and drawing
checkmarch-rival/      the rival lord expanding from the east
checkmarch-music/      music and synthesized sound effects (the core's audio.mjs mirrors this)
checkmarch-audio/      the older sound-effects module, kept for reference
checkmarch-skills/     permanent per-piece-type skills that level up from play
checkmarch-discovery/  road treasure, run artifacts, named locations and scouting
checkmarch-fairy/      data-driven fairy pieces and their engine patch
checkmarch-forge/      mines, bars and the Wood/Iron/Steel/Obsidian forge
checkmarch-terrain/    impassable battle squares
checkmarch-fx/         capture bursts, move trails and other canvas effects
checkmarch-content/    shrines, lords, formations, piece sets and event lines
SPEC.md                the build spec, including the artifact page contract
```

Each module folder has API notes (`*-API.md`), a test file, and a self-contained demo page (`*-demo.html`, rebuilt with its `build-demo.mjs`). The core folder's copies of the modules must stay in step with the module folders, and `test-world.mjs` checks this. Keep the folders side by side, because the tests find each other by relative path.

## Rebuild and test

Node 22 or newer. To run every suite at once, exactly as CI does:

```bash
node test-all.mjs   # from the repository root; about 15 s, exits 1 if any suite fails
```

It rebuilds `game.html`, then runs the core suites and every `checkmarch-*/test-*.mjs` side by side, so a new module's tests are picked up on their own. GitHub Actions (`.github/workflows/tests.yml`) runs the same command on every pull request and every push to `main`, and also fails if the committed `game.html` doesn't match a fresh build. A change to Markdown files alone doesn't start it.

The suites one by one:

```bash
cd checkmarch
node build.mjs                # rebuild game.html after editing game.src.html or a module
node test-engine.mjs          # chess engine: perft, mates, page contract
node test-world.mjs           # world integration
node balance-bot.mjs --check  # fixed-seed balance check, about 15 s

cd ..
node checkmarch-map/test-map.mjs
node checkmarch-rival/test-rival.mjs
node checkmarch-forge/test-forge.mjs
node checkmarch-terrain/test-terrain.mjs   # about 7 s
node checkmarch-fx/test-fx.mjs
node checkmarch-content/test-content.mjs
node checkmarch-skills/test-skills.mjs
node checkmarch-discovery/test-discovery.mjs
node checkmarch-music/test-music.mjs
node checkmarch-fairy/test-fairy.mjs
```

Every command exits non-zero on failure. The balance check fails when the fixed-seed attack win rate falls outside its target band. `node balance-bot.mjs` without `--check` plays a full set of headless runs and prints a longer report; it takes a minute or more and always exits 0.

The design document is kept as a claude.ai artifact: https://claude.ai/artifact/DeeSfVv1nmAYb13DR1wSgU
