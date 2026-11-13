# Checkmarch — Milestone 1 spec ("Board first")

An incremental chess strategy game. Single self-contained HTML page (artifact), phone-first.
Full design: the player keeps ONE army roster and ONE preset formation on their own 8x8 board,
fights preset enemy garrisons of rising tiers, buys pieces/squares/engine-depth with gold,
captured pieces are permanently lost, checkmate of the player's King ends the run (harsh),
voluntary "Abdicate" between battles pays full prestige. Good clean graphics from the start.

## Milestone 1 scope (playable vertical slice)
1. **Chess engine** (from scratch, no libraries):
   - 8x8, standard moves. NO castling, NO en passant (document this). Promotion: auto-queen in
     engine; when the PLAYER promotes manually, same (keep simple). A promoted pawn keeps its new
     rank on the roster after the battle (big skill payoff).
   - Legal move gen (no moving into check), mate/stalemate detection.
   - Negamax + alpha-beta, move ordering (captures first by victim value), iterative deepening with
     a per-move time budget (~60ms base; +40ms per Tactician level). Add small eval: material,
     piece-square centrality, king safety (pawn shield), mobility light. Small random jitter at low
     Tactician levels so it's beatable.
2. **Formation editor**: player owns squares on ranks 1-2 (white side). Start: King on e1 owned +
   3 more owned squares + roster of 3 pawns. Buy more squares with gold (price grows per square).
   Tap a roster piece, tap an owned square to place; tap placed piece to pick up. King must always
   be placed. Formation persists; battles start exactly from it (enemy = black, its preset).
3. **The road (map-lite)**: a horizontal strip of upcoming nodes, tier 1,2,3,... Mix: garrison,
   mine, town(discount flag), every 10th = citadel (named boss, bigger army, +1 depth).
   Beating a garrison/citadel advances; beating a mine node = you hold it: pays gold/min forever
   this run (and offline, capped 8h). Show held mines and income rate.
4. **Enemy formations**: data table of ~12 preset formations (tier-scaled material: tier t budget
   ≈ 6*1.045^t pawn-units but hand-shape them: pawn walls, knight rushes, rook lines, queen+court
   for citadels). Enemy depth = 1 + floor(tier/8), cap 4.
5. **Battle screen**: board rendered big and clean; Tactician autoplays both... player side by
   player's Tactician, enemy by enemy engine, one move ~700ms. Buttons: Take over / Auto, Hint,
   Retreat (forfeit node, keep survivors). Captures = piece gone from roster at battle end
   (survivors = pieces still on board + unplaced roster). Win = node cleared + gold loot
   (10*1.04^tier * (1+memories*0.05)).
6. **Economy**: gold from loot + held mines. Shop: pawn 25*1.7^copies, knight 80*1.7^, bishop 90*1.7^,
   rook 220*1.7^, queen 600*1.7^; formation square 40*1.5^extra; Tactician level 60*4^lvl (max +3).
7. **Prestige**: Abdicate button (between battles) = Memories = floor((nodesCleared_weighted/ )
   use M = max(1, floor((sum of tiers cleared)/10)^1.3). Mate = run over screen, pays 25% of that.
   Memories: +5% gold each, permanent across runs. Reset run: tier 1, fresh starting army.
8. **Save**: localStorage (try/catch everywhere), offline mine income on load (cap 8h), reset-save
   control. Also register window.claude?.hot?.snapshot(()=>state) and boot via
   window.claude?.hot?.ready ? ready(boot) : boot(window.claude?.hot?.data ?? null).

## Visual direction (good from minute one)
Flat modern 2D, code-drawn. Board: soft two-tone (cream/walnut light theme, slate/moonlight dark).
Pieces: Unicode chess glyphs (♔♕♖♗♘♙ / filled set for enemy) with distinct colors + soft drop
shadow, sized for thumbs (board width = min(92vw, 420px)). Smooth slide animation on moves
(CSS transform or canvas lerp), brief highlight of last move, red pulse on check. One accent color
reserved for danger. Clean panels, tabular numbers. Respect prefers-reduced-motion.

## Artifact page contract (MUST follow — the page is published as a claude.ai artifact)
- File: /home/user/checkmarch/game.html . NO <!doctype>, <html>, <head>, <body> tags. Start with
  <title>Checkmarch</title> then <meta name="claude:viewport-fit-sides" content="cover"> then <style>.
- No external resources AT ALL (no CDN, no fonts, no images); everything inline. System font stack.
- Theme tokens: define every color as a CSS custom property on bare :root (light values);
  redefine under @media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){ ... color-scheme:dark } }
  and again under :root[data-theme="dark"]{ ... }. body { background:var(--bg); color:var(--fg) }.
- Side gutter: body { padding-left:max(16px,env(safe-area-inset-left,0px));
  padding-right:max(16px,env(safe-area-inset-right,0px)); padding-block:12px }. Max content width
  ~560px centered. No horizontal page scroll at 400px width. Buttons min-height 44px.
- No alert/confirm/prompt; no downloads; touch via pointer events; touch-action:manipulation on the board.
- Web Audio only, started after first user interaction; all sounds synthesized.

## Required tests (write and RUN them, in /home/user/checkmarch/)
- test-engine.mjs: perft on the standard chess start position with your movegen
  (castling/ep disabled): depth 1 = 20, depth 2 = 400, depth 3 = 8902 — these counts hold without
  castling/ep. Plus: a known mate-in-1 position is found at depth>=2; stalemate detected.
- balance-bot.mjs: headless sim of 3 runs with a greedy buy strategy and auto-battles; report
  tiers reached, run time in sim-minutes, and battle win rate per tier band. Flag if tier-5 win
  rate under default start is <60% or >98%.
- Keep game logic in plain functions so the .mjs tests can import from a shared file
  (e.g. build game.html by inlining engine.js — simplest: write engine code once in engine.mjs and
  paste/inline it into game.html with a build step or by hand, your choice; they must not drift).
- node --check on the inline script. All tests must pass before you finish.

## Deliverables + report
- /home/user/checkmarch/game.html (final, self-contained)
- engine.mjs, test-engine.mjs, balance-bot.mjs + a short BUILD.md (what works, known gaps)
- Final report: test output summary, balance bot numbers, anything cut.
Do not publish anything; the parent session publishes. Do not use git.
