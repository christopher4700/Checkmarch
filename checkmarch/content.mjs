// Checkmarch content pack: pure data + validators. No DOM, no imports, no Math.random, no Date.
// Every export is plain JSON-able data except the small helper functions at the bottom.
//
//   SHRINE_CHOICES        paired one-time shrine choices, effects from EFFECT_KINDS (closed vocabulary)
//   RIVAL_LORDS           named rival lords (doctrine, favored pieces, taunt)
//   ENEMY_FORMATION_PACK  preset enemy formations, budget-tagged and tier-banded
//   PIECE_SETS            cosmetic piece-set styling tokens (no images)
//   EVENT_LINES           flavor lines for battle results, raids, caches, region win/lose
//
// See CONTENT-API.md for how world.mjs / engine.mjs apply each piece of content.

export const CONTENT_VERSION = 1;

// ---------------------------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------------------------
export const PIECES = ['P', 'N', 'B', 'R', 'Q'];               // roster piece letters (no King)
export const UNITS = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 };      // same as engine.mjs UNITS
export const SCOPES = ['next', 'region', 'run'];                 // next battle / rest of region / rest of run
export const DOCTRINES = ['aggressive', 'solid', 'material'];
// content doctrine -> engine.mjs DOCTRINES key (engine calls the material-hungry doctrine 'greedy')
export const ENGINE_DOCTRINE = { aggressive: 'aggressive', solid: 'solid', material: 'greedy' };
export const BARS = ['iron', 'steel', 'obsidian'];               // forge.mjs MATERIALS minus 'wood' (the base)
export const RESOURCES = ['tin', 'coal', 'iron', 'shards'];      // forge.mjs RESOURCES
export const MAX_REGION = 10;

// ---------------------------------------------------------------------------------------------
// Effect vocabulary (closed). params: name -> [type, ...]; types:
//   ['int', min, max] / ['num', min, max] / ['enum', values] ; nonzero: v may not be 0.
// `scopes` lists the scopes a kind accepts (absent = the kind takes no scope).
// ---------------------------------------------------------------------------------------------
export const EFFECT_KINDS = {
  gold:            { params: { v: ['int', -2000, 5000] }, nonzero: true, text: 'Gold now (negative = a price; option disabled if the player cannot pay).' },
  incomeFlat:      { params: { v: ['num', 0.5, 10] }, scopes: ['region', 'run'], text: '+v gold/min base income.' },
  mineIncomeMult:  { params: { v: ['num', 1.05, 2] }, scopes: ['region', 'run'], text: 'Mine income x v.' },
  lootMult:        { params: { v: ['num', 1.05, 2] }, scopes: ['next', 'region', 'run'], text: 'Battle loot x v.' },
  shopDiscount:    { params: { v: ['num', 0.05, 0.4] }, scopes: ['region', 'run'], text: 'Shop prices x (1 - v); does not stack with a town coupon (max wins).' },
  squares:         { params: { v: ['int', 1, 3] }, text: 'v free formation squares (next in SQUARE_ORDER); the square price ladder does not advance.' },
  addPiece:        { params: { piece: ['enum', PIECES], v: ['int', 1, 2] }, text: 'v free pieces join the roster (reserve); the shop price ladder does not advance.' },
  losePiece:       { params: { piece: ['enum', PIECES], v: ['int', 1, 2] }, text: 'v pieces leave the roster for good (reserve first, then formation); option disabled if not owned.' },
  promotePawn:     { params: { to: ['enum', ['N', 'B', 'R', 'Q']] }, text: 'One pawn (the player picks) becomes this piece for good; option disabled with no pawn.' },
  tacticianElo:    { params: { v: ['int', -200, 200] }, nonzero: true, scopes: ['next', 'region', 'run'], text: "Player Tactician elo +v (clamped by cleanElo)." },
  enemyElo:        { params: { v: ['int', -200, 200] }, nonzero: true, scopes: ['next', 'region', 'run'], text: 'Opposition elo +v (negative = easier enemies).' },
  enemyBudgetMult: { params: { v: ['num', 0.6, 1.5] }, scopes: ['next', 'region'], text: 'Enemy army budget x v (raids, garrisons, rival armies).' },
  trait:           { params: { piece: ['enum', PIECES], v: ['int', 1, 2] }, scopes: ['region', 'run'], text: 'Player dwelling level for this piece +v (capped at DWELL_MAX).' },
  enemyTrait:      { params: { piece: ['enum', PIECES], v: ['int', 1, 2] }, scopes: ['region'], text: 'Enemy trait level for this piece +v (curse).' },
  raidClock:       { params: { v: ['int', -600, 900] }, nonzero: true, text: 'Raid timer +v ticks (positive = later, negative = sooner).' },
  rivalClock:      { params: { v: ['int', 60, 1200] }, text: "The rival's next action is delayed by v ticks (rival seconds)." },
  rivalStrength:   { params: { v: ['int', -2, 2] }, nonzero: true, text: "Rival strength bonus +v (negative weakens the rival)." },
  reveal:          { params: { v: ['int', 1, 4] }, text: 'Lift fog on every node within v roads of the shrine.' },
  marchMult:       { params: { v: ['num', 0.5, 1.5] }, scopes: ['region'], text: 'March ticks x v (below 1 = faster).' },
  bar:             { params: { material: ['enum', BARS], v: ['int', 1, 2] }, text: 'v forge bars of this material.' },
  resource:        { params: { res: ['enum', RESOURCES], v: ['int', 1, 40] }, text: 'v forge resource units (stock cap still applies).' },
  memoriesOnEnd:   { params: { v: ['int', 1, 10] }, text: '+v Memories when this run ends (abdicate or mate, never reduced by the mate penalty).' },
  combo:           { params: {}, text: '2-3 non-combo effects applied in order (all preconditions must hold).' },
};
export const EFFECT_KIND_LIST = Object.keys(EFFECT_KINDS);

// ---------------------------------------------------------------------------------------------
// Shrine choices. minRegion: the first region where the shrine may appear.
// The first entry mirrors the two choices world.mjs ships today (knight / mines).
// ---------------------------------------------------------------------------------------------
const C = (...parts) => ({ kind: 'combo', parts });
export const SHRINE_CHOICES = [
  { id: 'mossy-altar', name: 'The Mossy Altar', minRegion: 1,
    a: { label: 'Knight one pawn for good', effect: { kind: 'promotePawn', to: 'N' } },
    b: { label: '+20% mine income for the rest of this region', effect: { kind: 'mineIncomeMult', v: 1.2, scope: 'region' } } },
  { id: 'tithe-box', name: 'The Tithe Box', minRegion: 1,
    a: { label: 'Empty the box: +60 gold', effect: { kind: 'gold', v: 60 } },
    b: { label: 'Leave it full: +2 gold/min this region', effect: { kind: 'incomeFlat', v: 2, scope: 'region' } } },
  { id: 'drill-yard', name: 'The Old Drill Yard', minRegion: 1,
    a: { label: 'Clear the ground: +1 formation square', effect: { kind: 'squares', v: 1 } },
    b: { label: 'Drill the pawns: Stubborn +2 this region', effect: { kind: 'trait', piece: 'P', v: 2, scope: 'region' } } },
  { id: 'beggar-oracle', name: 'The Beggar Oracle', minRegion: 1,
    a: { label: 'Pay 50 gold: lift the fog 2 roads around', effect: C({ kind: 'gold', v: -50 }, { kind: 'reveal', v: 2 }) },
    b: { label: 'Share your bread: next raid 120 ticks later', effect: { kind: 'raidClock', v: 120 } } },
  { id: 'twin-wells', name: 'The Twin Wells', minRegion: 1,
    a: { label: 'Drink the clear well: +60 Tactician elo next battle', effect: { kind: 'tacticianElo', v: 60, scope: 'next' } },
    b: { label: 'Drink the dark well: +25% loot next battle', effect: { kind: 'lootMult', v: 1.25, scope: 'next' } } },
  { id: 'hermit-smith', name: 'The Hermit Smith', minRegion: 1,
    a: { label: 'Take his spare iron bar', effect: { kind: 'bar', material: 'iron', v: 1 } },
    b: { label: 'Take a sack of coal (8)', effect: { kind: 'resource', res: 'coal', v: 8 } } },
  { id: 'pilgrim-band', name: 'Pilgrims on the Road', minRegion: 1,
    a: { label: 'Recruit a pilgrim: +1 pawn', effect: { kind: 'addPiece', piece: 'P', v: 1 } },
    b: { label: 'Ask for alms: +40 gold', effect: { kind: 'gold', v: 40 } } },
  { id: 'cracked-bell', name: 'The Cracked Bell', minRegion: 2,
    a: { label: 'Ring it: rival stalls 480 ticks, raids 120 sooner', effect: C({ kind: 'rivalClock', v: 480 }, { kind: 'raidClock', v: -120 }) },
    b: { label: 'Muffle it: next raid 180 ticks later', effect: { kind: 'raidClock', v: 180 } } },
  { id: 'bone-dice', name: 'The Bone Dice', minRegion: 2,
    a: { label: 'Wager 100 gold: +40% loot this region', effect: C({ kind: 'gold', v: -100 }, { kind: 'lootMult', v: 1.4, scope: 'region' }) },
    b: { label: 'Pocket the dice: +150 gold', effect: { kind: 'gold', v: 150 } } },
  { id: 'grey-mentor', name: 'The Grey Mentor', minRegion: 2,
    a: { label: 'Study the old games: +50 Tactician elo this run', effect: { kind: 'tacticianElo', v: 50, scope: 'run' } },
    b: { label: 'Spar in the yard: Sidestep +1 knights this run', effect: { kind: 'trait', piece: 'N', v: 1, scope: 'run' } } },
  { id: 'salt-merchant', name: 'The Salt Merchant', minRegion: 2,
    a: { label: 'Trade fairly: 15% off the shop this region', effect: { kind: 'shopDiscount', v: 0.15, scope: 'region' } },
    b: { label: 'Rob him: +300 gold, enemies +20 elo this region', effect: C({ kind: 'gold', v: 300 }, { kind: 'enemyElo', v: 20, scope: 'region' }) } },
  { id: 'sunken-chapel', name: 'The Sunken Chapel', minRegion: 2,
    a: { label: 'Anoint a pawn: it becomes a bishop', effect: { kind: 'promotePawn', to: 'B' } },
    b: { label: 'Pray in the flood: Faith +1 bishops this region', effect: { kind: 'trait', piece: 'B', v: 1, scope: 'region' } } },
  { id: 'crossroads-gibbet', name: 'The Crossroads Gibbet', minRegion: 2,
    a: { label: "Cut down the rival's spy: rival strength -1", effect: { kind: 'rivalStrength', v: -1 } },
    b: { label: 'Search his pockets: +200 gold', effect: { kind: 'gold', v: 200 } } },
  { id: 'war-drum', name: 'The Buried War Drum', minRegion: 3,
    a: { label: 'Beat it: enemy armies -10% this region', effect: { kind: 'enemyBudgetMult', v: 0.9, scope: 'region' } },
    b: { label: 'Sell the skin and frame: +350 gold', effect: { kind: 'gold', v: 350 } } },
  { id: 'molten-spring', name: 'The Molten Spring', minRegion: 3,
    a: { label: 'Quench a blade here: +1 steel bar', effect: { kind: 'bar', material: 'steel', v: 1 } },
    b: { label: 'Pick the cooled glass: +10 obsidian shards', effect: { kind: 'resource', res: 'shards', v: 10 } } },
  { id: 'knights-barrow', name: "The Knight's Barrow", minRegion: 3,
    a: { label: 'Wake the sleeper: +1 knight', effect: { kind: 'addPiece', piece: 'N', v: 1 } },
    b: { label: 'Leave a pawn: Sidestep +2 knights this region', effect: C({ kind: 'losePiece', piece: 'P', v: 1 }, { kind: 'trait', piece: 'N', v: 2, scope: 'region' }) } },
  { id: 'mirror-pool', name: 'The Mirror Pool', minRegion: 3,
    a: { label: 'Gaze in: lift the fog 3 roads, raids 90 sooner', effect: C({ kind: 'reveal', v: 3 }, { kind: 'raidClock', v: -90 }) },
    b: { label: 'Look away: +30 Tactician elo this region', effect: { kind: 'tacticianElo', v: 30, scope: 'region' } } },
  { id: 'iron-oath', name: 'The Iron Oath', minRegion: 3,
    a: { label: 'Swear it: Bulwark +1 rooks this run', effect: { kind: 'trait', piece: 'R', v: 1, scope: 'run' } },
    b: { label: 'Refuse and dig in: +2 formation squares', effect: { kind: 'squares', v: 2 } } },
  { id: 'quiet-abbey', name: 'The Quiet Abbey', minRegion: 3,
    a: { label: 'Take vows: +2 Memories when this run ends', effect: { kind: 'memoriesOnEnd', v: 2 } },
    b: { label: 'Fill the larder: +5 gold/min this run', effect: { kind: 'incomeFlat', v: 5, scope: 'run' } } },
  { id: 'red-banner', name: 'The Red Banner', minRegion: 4,
    a: { label: 'Raise it: march 35% faster this region', effect: { kind: 'marchMult', v: 0.65, scope: 'region' } },
    b: { label: "Burn it: the rival's scouts stall 300 ticks", effect: { kind: 'rivalClock', v: 300 } } },
  { id: 'queens-cradle', name: "The Queen's Cradle", minRegion: 4,
    a: { label: 'Crown a pawn queen; a knight stays as warden', effect: C({ kind: 'promotePawn', to: 'Q' }, { kind: 'losePiece', piece: 'N', v: 1 }) },
    b: { label: 'Rest the army: +60% mine income this region', effect: { kind: 'mineIncomeMult', v: 1.6, scope: 'region' } } },
  { id: 'gravekeeper', name: 'The Gravekeeper', minRegion: 4,
    a: { label: 'Pay 300 gold: +3 Memories when this run ends', effect: C({ kind: 'gold', v: -300 }, { kind: 'memoriesOnEnd', v: 3 }) },
    b: { label: 'Take his lantern: +40 Tactician elo this region', effect: { kind: 'tacticianElo', v: 40, scope: 'region' } } },
  { id: 'ember-forge', name: 'The Ember Forge', minRegion: 4,
    a: { label: 'Stoke it: +1 obsidian bar, but the rival grows', effect: C({ kind: 'bar', material: 'obsidian', v: 1 }, { kind: 'rivalStrength', v: 1 }) },
    b: { label: 'Rake the slag: +12 iron ore', effect: { kind: 'resource', res: 'iron', v: 12 } } },
  { id: 'masked-envoy', name: 'The Masked Envoy', minRegion: 5,
    a: { label: 'Parley: the rival stalls 300 ticks', effect: { kind: 'rivalClock', v: 300 } },
    b: { label: 'Unmask him: enemies -50 elo this region', effect: { kind: 'enemyElo', v: -50, scope: 'region' } } },
  { id: 'cursed-hoard', name: 'The Cursed Hoard', minRegion: 5,
    a: { label: 'Take it: +900 gold, enemy pawns Stubborn +1', effect: C({ kind: 'gold', v: 900 }, { kind: 'enemyTrait', piece: 'P', v: 1, scope: 'region' }) },
    b: { label: 'Seal it: +10% loot this region', effect: { kind: 'lootMult', v: 1.1, scope: 'region' } } },
  { id: 'star-chart', name: 'The Star Chart', minRegion: 5,
    a: { label: 'Read it: +80 Tactician elo next battle', effect: { kind: 'tacticianElo', v: 80, scope: 'next' } },
    b: { label: 'Sell it: 10% off the shop this region', effect: { kind: 'shopDiscount', v: 0.1, scope: 'region' } } },
  { id: 'warden-statue', name: "The Warden's Statue", minRegion: 6,
    a: { label: 'Kneel: Majesty +1 queens this run', effect: { kind: 'trait', piece: 'Q', v: 1, scope: 'run' } },
    b: { label: 'Topple it: enemy armies -15% this region', effect: { kind: 'enemyBudgetMult', v: 0.85, scope: 'region' } } },
  { id: 'last-ferry', name: 'The Last Ferry', minRegion: 6,
    a: { label: 'Pay the ferryman 2 pawns: a rook comes ashore', effect: C({ kind: 'losePiece', piece: 'P', v: 2 }, { kind: 'addPiece', piece: 'R', v: 1 }) },
    b: { label: 'Burn the ferry: next raid 200 ticks later', effect: { kind: 'raidClock', v: 200 } } },
];

// ---------------------------------------------------------------------------------------------
// Rival lords. doctrine: content doctrine (map to the engine with ENGINE_DOCTRINE).
// favoredPieces: the piece letters its formations lean on (formationsForLord picks by these).
// ---------------------------------------------------------------------------------------------
export const RIVAL_LORDS = [
  { id: 'vasha', name: 'Vasha Emberline', epithet: 'the Cinder Wolf', doctrine: 'aggressive', favoredPieces: ['N', 'Q'],
    taunt: 'Your fences are kindling. I brought the spark.', personalityNote: 'Opens with knight raids; spends its own king safety for tempo.' },
  { id: 'oldric', name: 'Oldric Fenhallow', epithet: 'Warden of the Reeds', doctrine: 'solid', favoredPieces: ['P', 'R'],
    taunt: 'Forty winters I have held this marsh. Knock, if you like.', personalityNote: 'Pawn chains and doubled rooks; waits for you to overreach.' },
  { id: 'mirelle', name: 'Mirelle Quillsworth', epithet: 'the Ledger Queen', doctrine: 'material', favoredPieces: ['B', 'Q'],
    taunt: 'Every piece you own has a price. I keep the receipts.', personalityNote: 'Counts every trade; will take a loose pawn over a mating net.' },
  { id: 'tadd', name: 'Tadd Brakemoor', epithet: 'the Gristle Baron', doctrine: 'aggressive', favoredPieces: ['R', 'P'],
    taunt: 'I do not knock on gates. I eat them.', personalityNote: 'Rolls a pawn storm behind rook files; crude but relentless.' },
  { id: 'seravine', name: 'Seravine Ashgrove', epithet: 'the Pale Bell', doctrine: 'solid', favoredPieces: ['B', 'P'],
    taunt: 'When the bell tolls twice, you will already be walking home.', personalityNote: 'Long bishops behind a closed centre; strikes late.' },
  { id: 'kroll', name: 'Kroll Underbridge', epithet: 'the Toll-Taker', doctrine: 'material', favoredPieces: ['N', 'P'],
    taunt: 'Crossing costs a pawn. Arguing costs two.', personalityNote: 'Forks for profit; trades down the moment it is ahead.' },
  { id: 'ilsabet', name: 'Ilsabet Thornquay', epithet: 'Mistress of Hooks', doctrine: 'aggressive', favoredPieces: ['B', 'N'],
    taunt: 'Every square near your king has a hook in it. Mind your step.', personalityNote: 'Minor-piece swarms aimed at one flank; hates slow games.' },
  { id: 'gorran', name: 'Gorran Stillwater', epithet: 'the Unhurried', doctrine: 'solid', favoredPieces: ['R', 'Q'],
    taunt: 'Take your time. I have more of it than you.', personalityNote: 'Heavy pieces held back; punishes any loose king.' },
  { id: 'pellam', name: 'Pellam Rookhollow', epithet: 'the Counting Crow', doctrine: 'material', favoredPieces: ['R', 'B'],
    taunt: 'Caw. That is one. Caw. That is two. Shall I keep counting?', personalityNote: 'Open files and long diagonals; collects stragglers.' },
  { id: 'yvaine', name: 'Yvaine of the Ninth Ford', epithet: 'the Lance That Sings', doctrine: 'aggressive', favoredPieces: ['Q', 'N'],
    taunt: 'Sing with me. The song is short and ends at your keep.', personalityNote: 'Early queen sorties with knight support; overextends gladly.' },
  { id: 'brannoch', name: 'Brannoch Hearthstone', epithet: 'the Iron Hearth', doctrine: 'solid', favoredPieces: ['P', 'N'],
    taunt: 'My hearth has never gone cold. Come warm your hands, briefly.', personalityNote: 'Hedgehog pawns with knights tucked behind; counterpunches.' },
  { id: 'oskeline', name: 'Oskeline Marrowgate', epithet: 'the Bone Broker', doctrine: 'material', favoredPieces: ['Q', 'R'],
    taunt: 'I buy bones. Yours look sturdy. I will pay well.', personalityNote: 'Fields extra heavy pieces; grabs material even under attack.' },
  { id: 'dace', name: 'Dace Wyrmwood', epithet: 'the Grinning Fuse', doctrine: 'aggressive', favoredPieces: ['P', 'B'],
    taunt: 'Hear that hiss? That is the fuse. Run, or do not.', personalityNote: 'Advanced pawns lit by bishops; burns out if the storm stalls.' },
  { id: 'hollis', name: 'Abbess Hollis Greyveil', epithet: 'Keeper of the Quiet Walls', doctrine: 'solid', favoredPieces: ['B', 'R'],
    taunt: 'Silence, please. You may shout once you are inside. You will not be.', personalityNote: 'Fianchettoed bishops and castled rooks; patient to a fault.' },
  { id: 'fenwick', name: 'Fenwick Saltmarrow', epithet: 'the Hoarder of Tides', doctrine: 'material', favoredPieces: ['P', 'B'],
    taunt: 'The tide takes everything eventually. I simply arrive first.', personalityNote: 'A wide pawn tide that swallows loose pieces; slow to finish.' },
  { id: 'aurelan', name: 'Aurelan Duskmere', epithet: 'Crown of the Eastern March', doctrine: 'aggressive', favoredPieces: ['Q', 'R'],
    taunt: 'The east was mine before your grandsire learned to stand.', personalityNote: 'The old lord of the march: doubled queens and rooks, all in.' },
];

// ---------------------------------------------------------------------------------------------
// Enemy formation pack. Same squares convention as engine.mjs FORMATIONS (black side, algebraic).
// pieces[0] is the King; the rest is the ORDERED slot list (engine fills slots until the budget runs out).
// budget = total units of the full slot list (K = 0). tiers = [lo, hi]: the garrison (or citadel)
// tiers where enemyBudget() lands within [0.5 x budget, 1.1 x budget], i.e. the shape reads as itself.
// ---------------------------------------------------------------------------------------------
const pcs = spec => spec.split(' ').map(x => ({ type: x[0], square: x.slice(1) }));
const F = (id, name, doctrine, favored, budget, tiers, spec, extra) =>
  Object.assign({ id, name, doctrine, favored, budget, tiers, citadel: false, pieces: pcs(spec) }, extra || {});
export const ENEMY_FORMATION_PACK = [
  // --- aggressive ---
  F('first-sparks', 'First Sparks', 'aggressive', ['P'], 3, [2, 3], 'Ke8 Pd6 Pe6 Pf6'),
  F('cinder-hounds', 'Cinder Hounds', 'aggressive', ['N', 'P'], 8, [4, 10], 'Ke8 Nc6 Nf6 Pd6 Pe6'),
  F('ember-raid', 'Ember Raid', 'aggressive', ['N'], 5, [3, 5], 'Ke8 Nf6 Pe7 Pd7'),
  F('wolf-pack', 'Wolf Pack', 'aggressive', ['N', 'Q'], 19, [13, 30], 'Ke8 Nc6 Nf6 Qd8 Pe6 Pd6 Pf7 Pc7'),
  F('spiked-column', 'Spiked Column', 'aggressive', ['R', 'P'], 16, [9, 26], 'Kg8 Pe5 Pd5 Re8 Rd8 Pf6 Pg7 Ph7 Pc6'),
  F('hook-and-fang', 'Hook and Fang', 'aggressive', ['B', 'N'], 16, [9, 26], 'Ke8 Bc5 Bf5 Nc6 Ng6 Pe6 Pd6 Pf7 Pb7'),
  F('singing-lances', 'Singing Lances', 'aggressive', ['Q', 'N'], 29, [23, 39], 'Kd8 Qe6 Nc5 Nf5 Nb6 Pd6 Pe7 Pc7 Pf7 Ra8 Pg7 Pb7'),
  F('powder-trail', 'Powder Trail', 'aggressive', ['P', 'B'], 14, [7, 23], 'Ke8 Bd6 Be6 Pa5 Pb5 Pc5 Pf5 Pg5 Ph5 Pd7 Pe7'),
  F('siege-ladder', 'Siege Ladder', 'aggressive', ['R', 'P'], 37, [28, 45], 'Kg8 Re5 Rd5 Pe6 Pd6 Qe7 Rf8 Pc5 Pf5 Nc6 Bb7 Pg7 Ph7 Pf7'),
  F('eastern-crown', 'Eastern Crown', 'aggressive', ['Q', 'R'], 39, [25, 42], 'Kg8 Qd8 Qe7 Ra8 Rf8 Nd7 Be6 Pf7 Pg7 Ph7 Pd6 Pc7', { citadel: true }),
  // --- solid ---
  F('reed-palisade', 'Reed Palisade', 'solid', ['P'], 4, [3, 4], 'Ke8 Pd7 Pe7 Pf7 Pc7'),
  F('shepherds-line', "Shepherd's Line", 'solid', ['P'], 3, [2, 3], 'Ke8 Pc6 Pd6 Pe6'),
  F('marsh-gate', 'Marsh Gate', 'solid', ['P', 'R'], 16, [9, 26], 'Kg8 Pf7 Pg7 Ph7 Re8 Rd8 Pe6 Pd6 Pc6'),
  F('bell-tower', 'Bell Tower', 'solid', ['B', 'P'], 12, [6, 19], 'Ke8 Pd6 Pe6 Bd7 Be7 Pc7 Pf7 Pb7 Pg7'),
  F('still-water', 'Still Water', 'solid', ['R', 'Q'], 28, [22, 39], 'Kg8 Pf7 Pg7 Ph7 Rd8 Re8 Qc7 Pe6 Pd6 Pc6 Bb7'),
  F('hearthwall', 'Hearthwall', 'solid', ['P', 'N'], 14, [7, 23], 'Ke8 Pd6 Pe6 Pf6 Pc6 Nd7 Ne7 Pb7 Pg7 Pa7 Ph7'),
  F('cloister', 'Cloister', 'solid', ['B', 'R'], 22, [16, 33], 'Kg8 Pf7 Pg6 Ph7 Bg7 Re8 Rd8 Bb7 Pc6 Pd6 Pe7'),
  F('abbey-choir', 'Abbey Choir', 'solid', ['B', 'N'], 22, [12, 29], 'Ke8 Pd7 Pe7 Pf7 Bd6 Be6 Nc6 Nf6 Pc7 Pg7 Rh8', { citadel: true }),
  F('greyveil-keep', 'Greyveil Keep', 'solid', ['B', 'R'], 39, [25, 42], 'Kg8 Pf7 Pg6 Ph7 Bg7 Rf8 Re8 Bb7 Qd8 Nd7 Nc7 Pc6 Pd6 Pe6 Pb6 Pa7', { citadel: true }),
  // --- material ---
  F('toll-booth', 'Toll Booth', 'material', ['N', 'P'], 6, [4, 5], 'Ke8 Nc6 Pd7 Pe7 Pf7'),
  F('scouts-tithe', "Scout's Tithe", 'material', ['N', 'P'], 7, [4, 7], 'Ke8 Nd6 Pc7 Pd7 Pe7 Pf7'),
  F('ledger-lines', 'Ledger Lines', 'material', ['B', 'Q'], 19, [13, 30], 'Ke8 Qd7 Bc6 Bf6 Pc7 Pe7 Pf7 Pb7'),
  F('counting-house', 'Counting House', 'material', ['R', 'B'], 22, [16, 33], 'Ke8 Ra8 Rh8 Bc8 Bf8 Pb7 Pc7 Pd7 Pe7 Pf7 Pg7'),
  F('bone-market', 'Bone Market', 'material', ['Q', 'R'], 37, [28, 45], 'Ke8 Qd8 Qc7 Ra8 Rf8 Nc6 Pd7 Pe7 Pf7 Pg7 Ph7 Pb7'),
  F('tidepool-hoard', 'Tidepool Hoard', 'material', ['P', 'B'], 14, [7, 23], 'Kf8 Bd7 Be7 Pa6 Pb6 Pc6 Pd6 Pe6 Pf6 Pg6 Ph6'),
  F('crows-tally', "Crow's Tally", 'material', ['R', 'B'], 21, [15, 32], 'Kh8 Rf8 Re8 Bb7 Bd6 Pg7 Ph7 Pc6 Pe6 Pf7'),
  F('grand-bazaar', 'Grand Bazaar', 'material', ['Q', 'N'], 50, [31, 48], 'Ke8 Qd8 Qe7 Ra8 Rh8 Nb8 Ng8 Nd6 Bc8 Bf8 Pa7 Pb7 Pc7 Pd7 Pf7 Pg7 Ph7', { citadel: true }),
];

// ---------------------------------------------------------------------------------------------
// Piece sets (cosmetic). unlockedBy: { kind: 'default' } | { kind: 'memories', v } (lifetime Memories
// earned) | { kind: 'region', v } (reach region v) | { kind: 'citadels', v } (seats won, lifetime) |
// { kind: 'forge', material } (first bar of that material). Hue/light shifts apply to the theme's
// piece colors; outline is one of OUTLINES. glyphWeight: CSS font-weight 100-900.
// ---------------------------------------------------------------------------------------------
export const OUTLINES = ['none', 'hairline', 'ink', 'double', 'glow'];
export const UNLOCK_KINDS = ['default', 'memories', 'region', 'citadels', 'forge'];
export const PIECE_SETS = [
  { id: 'classic', name: 'Classic', unlockedBy: { kind: 'default' }, glyphWeight: 400,
    player: { hue: 0, light: 0 }, enemy: { hue: 0, light: 0 }, outline: 'none' },
  { id: 'walnut-court', name: 'Walnut Court', unlockedBy: { kind: 'region', v: 2 }, glyphWeight: 600,
    player: { hue: 18, light: -6 }, enemy: { hue: -10, light: -4 }, outline: 'hairline' },
  { id: 'moonlit-vigil', name: 'Moonlit Vigil', unlockedBy: { kind: 'memories', v: 25 }, glyphWeight: 300,
    player: { hue: -150, light: 8 }, enemy: { hue: 40, light: -8 }, outline: 'glow' },
  { id: 'ember-guard', name: 'Ember Guard', unlockedBy: { kind: 'region', v: 3 }, glyphWeight: 700,
    player: { hue: 25, light: 4 }, enemy: { hue: -30, light: -10 }, outline: 'ink' },
  { id: 'verdigris', name: 'Verdigris', unlockedBy: { kind: 'forge', material: 'steel' }, glyphWeight: 500,
    player: { hue: 120, light: -2 }, enemy: { hue: 160, light: -12 }, outline: 'hairline' },
  { id: 'obsidian-order', name: 'Obsidian Order', unlockedBy: { kind: 'forge', material: 'obsidian' }, glyphWeight: 800,
    player: { hue: -60, light: -14 }, enemy: { hue: 170, light: -18 }, outline: 'ink' },
  { id: 'heraldic', name: 'Heraldic', unlockedBy: { kind: 'citadels', v: 5 }, glyphWeight: 900,
    player: { hue: 45, light: 6 }, enemy: { hue: -90, light: 0 }, outline: 'double' },
  { id: 'ghostlight', name: 'Ghostlight', unlockedBy: { kind: 'memories', v: 100 }, glyphWeight: 200,
    player: { hue: 180, light: 18 }, enemy: { hue: -120, light: 14 }, outline: 'glow' },
];

// ---------------------------------------------------------------------------------------------
// Event lines. Placeholders (closed set): {lord} rival name, {place} node name, {gold} amount,
// {piece} piece noun. Raw template length <= 90 chars; see LINE_SAMPLE for the substitution check.
// ---------------------------------------------------------------------------------------------
export const PLACEHOLDERS = ['lord', 'place', 'gold', 'piece'];
export const LINE_SAMPLE = { lord: 'Vasha Emberline', place: 'Saltmarrow Ford', gold: '1,250', piece: 'knight' };
export const EVENT_LINES = {
  battleWin: [
    'The garrison breaks and runs. {place} flies your banner by dusk.',
    'Their king lies tipped in the mud. The ledger smiles: +{gold} gold.',
    'A clean win. Even the crows seem impressed.',
    'The last defender kneels. Your pawns pretend they were never worried.',
    'Steel meets steel and yours holds. {place} is yours.',
    'They had the numbers. You had the plan.',
    'The drums go quiet on their side of the field.',
    'Victory, and a chest of +{gold} gold under the commander\'s cot.',
    'Your {piece} stands on their king\'s square, looking smug.',
    'A hard morning, a better afternoon. The field is held.',
    'Songs tonight. Short ones; there is marching tomorrow.',
  ],
  battleLoss: [
    'The line folds. Survivors limp back toward the keep.',
    'You lost the field at {place}. The dead are not coming back.',
    'Their trap closed a move too early for you to see it.',
    'A bitter day. Your {piece} fell holding the gap.',
    'Retreat sounded. Not everyone heard it in time.',
    'The enemy cheers. You count what is left.',
    'Mud, smoke and one fewer banner. Regroup and rethink.',
    'They read you like a ledger. Change the page.',
    'The garrison holds. Your scouts will not meet your eye.',
    'A rout. The road home feels longer than the road out.',
  ],
  raid: [
    'Raiders on the ridge! The mine at {place} is under attack.',
    'Torches in the night. Someone wants your ore.',
    'A horn from {place}: raiders, and they brought ladders.',
    'The mine bell rings three times. That means trouble.',
    'Dust on the eastern road. Too much dust for traders.',
    'Raiders under {lord}\'s colors are burning the pit-props.',
    'The miners drop their picks and grab their spears.',
    'A thin column of smoke rises over {place}. Ride hard.',
    'Hooded riders circle the mine. They are not here to buy.',
    'The night watch saw them first. Small comfort.',
  ],
  raidRepelled: [
    'Raiders driven off. The miners return to work, grumbling.',
    'The mine at {place} holds. The raiders leave their ladders behind.',
    'Repelled! Their loot sacks go home empty; yours gain +{gold} gold.',
    'The garrison stood firm. Tonight they drink on your coin.',
    'Raiders scattered into the hills. They will think twice.',
    'Your {piece} held the gate alone for a while. Long enough.',
    'Smoke clears. The ore carts are still full.',
    'They came for silver and left with bruises.',
    'The pit bell rings once: all clear.',
    'A short, sharp fight. The mine never stopped smelting.',
  ],
  raidLost: [
    'The mine at {place} has fallen. Its income is gone.',
    'Raiders carry off the ore and the pit-ponies.',
    'The garrison is gone. {place} answers to someone else now.',
    'You hear of it too late: the mine is lost.',
    'They burned the hoist. It will take an army to take it back.',
    '{lord} adds your mine to the ledger. In red ink.',
    'The miners fled west. The tunnels are quiet.',
    'Lost. The road to {place} is closed to your carts.',
    'A blackened shaft and an empty strongbox.',
    'Raiders hold the mine. Retake it, or learn to live poorer.',
  ],
  cache: [
    'A buried strongbox under the old milestone: +{gold} gold.',
    'Your scouts find a deserter\'s stash. Nobody asks whose.',
    'A cart abandoned in a ditch, its axle broken, its chest intact.',
    'Under the floorboards of a burnt mill: coin, and a little luck.',
    'A hollow oak full of tarnished crowns. +{gold} gold.',
    'An old quartermaster\'s cache, still sealed with wax.',
    'Someone hid supplies here and never came back for them.',
    'The cellar of a ruined inn still has its barrels. And its till.',
    'A pilgrim\'s purse, dropped and forgotten. Spend it kindly.',
    'Your {piece} trips on a loose stone. Under it: gold.',
    'A smuggler\'s cache wrapped in oilcloth: +{gold} gold.',
  ],
  regionWin: [
    'The rival\'s seat falls. {lord} flees east with what they can carry.',
    'The region is yours. The roads east open before you.',
    '{lord} yields the keep. The banners come down without a fight.',
    'Bells ring in every village you hold. The march goes on.',
    'Their citadel is taken; their name will be a song soon.',
    'The seat is won. Somewhere further east, another lord is listening.',
    'Your king rides through the broken gate at dawn.',
    'The last of {lord}\'s court kneels. Region won.',
    'The map turns a page. Fresh fog, fresh roads.',
    'Victory. The region\'s mines now ring for you alone.',
  ],
  regionLose: [
    '{lord} takes your keep. The region is lost.',
    'Your king is cornered. The march ends here.',
    'The keep burns. Memories are all you carry west.',
    'The rival\'s banners rise over your walls.',
    'Checkmate. The region forgets your name by spring.',
    'Your court scatters into the fog.',
    '{lord} sends a single line: "Better luck, next life."',
    'The last of your army lays down its arms.',
    'The road you marched is the road you flee.',
    'The region falls. Only the Memories remain.',
  ],
};

// ---------------------------------------------------------------------------------------------
// Reference copy of engine.mjs enemyBudget (TUNE snapshot of 2026-11-12: enemyBudgetBase 5), so the
// band check works standalone. The tags in ENEMY_FORMATION_PACK were computed against this copy.
// test-content.mjs compares it against the live engine.mjs when that file is present and warns on drift;
// at runtime prefer bandFor(units, citadel, enemyBudget) over the static tags if TUNE keeps moving.
// ---------------------------------------------------------------------------------------------
export const REF_TUNE = { base: 5, growth: 1.045, citadelMult: 1.2, rampStart: 0.15, rampTiers: 6, midBoost: 0.1, midFrom: 3, midSpan: 5 };
export function refBudget(tier, type) {
  const T = REF_TUNE;
  const mult = type === 'citadel' ? T.citadelMult : type === 'mine' ? 0.85 : type === 'town' ? 0.9 : type === 'shrine' ? 0.85 : 1;
  const ramp = tier < T.rampTiers ? T.rampStart + (1 - T.rampStart) * (tier - 1) / (T.rampTiers - 1) : 1;
  const mid = 1 + T.midBoost * Math.max(0, Math.min(1, (tier - T.midFrom) / T.midSpan));
  return T.base * Math.pow(T.growth, tier) * mult * ramp * mid;
}
export const BAND = { lo: 0.5, hi: 1.1 };
// the widest [lo, hi] tier band where budgetFn(tier) stays within [BAND.lo, BAND.hi] x units (null if none)
export function bandFor(units, citadel, budgetFn = refBudget, maxTier = 100) {
  let lo = null, hi = null;
  for (let t = 1; t <= maxTier; t++) {
    const r = budgetFn(t, citadel ? 'citadel' : 'garrison');
    if (r >= BAND.lo * units - 1e-9 && r <= BAND.hi * units + 1e-9) { if (lo == null) lo = t; hi = t; } else if (lo != null) break;
  }
  return lo == null ? null : [lo, hi];
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------
// engine.mjs FORMATIONS shape: { name, k, s, citadel? }
export function toEngineFormation(f) {
  const out = { name: f.name, k: f.pieces[0].square, s: f.pieces.slice(1).map(p => p.type + p.square).join(' ') };
  if (f.citadel) out.citadel = true;
  return out;
}
export function formationUnits(f) { let s = 0; for (const p of f.pieces) s += UNITS[p.type] || 0; return s; }
// pack formations whose band covers this tier (optionally filtered by citadel flag / doctrine)
export function formationsForTier(tier, opt = {}) {
  return ENEMY_FORMATION_PACK.filter(f => tier >= f.tiers[0] && tier <= f.tiers[1] &&
    (opt.citadel == null || f.citadel === !!opt.citadel) && (!opt.doctrine || f.doctrine === opt.doctrine));
}
// formations that suit a lord: same doctrine and at least one shared favored piece
export function formationsForLord(lord) {
  return ENEMY_FORMATION_PACK.filter(f => f.doctrine === lord.doctrine && f.favored.some(p => lord.favoredPieces.includes(p)));
}
// deterministic lord for a region of a run (seedHash: any uint32 from the run seed)
export function lordForRegion(seedHash, region) {
  const i = ((seedHash >>> 0) + (Math.max(1, region | 0) - 1) * 7) % RIVAL_LORDS.length;
  return RIVAL_LORDS[i];
}
export function shrineChoicesFor(region) { return SHRINE_CHOICES.filter(c => c.minRegion <= region); }
export function fillLine(line, vars) { return line.replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : m)); }
export function effectParts(e) { return e.kind === 'combo' ? e.parts : [e]; }

// Rough gold-equivalent value of an effect at a region (balance heuristic, used by the tests to keep
// both sides of a shrine within 2x of each other). s = 1.6^(region-1) scales region-sized effects.
const TRAIT_W = { P: 0.8, N: 1, B: 1, R: 1.2, Q: 1.5 };
const RES_W = { tin: 12, coal: 12, iron: 18, shards: 35 };
const BAR_W = { iron: 150, steel: 400, obsidian: 900 };
const SC = (scope, t) => t[scope] || 0;
export function effectValue(e, region) {
  const s = Math.pow(1.6, Math.max(1, region) - 1);
  switch (e.kind) {
    case 'gold': return e.v;
    case 'incomeFlat': return e.v * SC(e.scope, { region: 30, run: 90 });
    case 'mineIncomeMult': return (e.v - 1) * SC(e.scope, { region: 400, run: 1200 }) * s;
    case 'lootMult': return (e.v - 1) * SC(e.scope, { next: 200, region: 500, run: 1500 }) * s;
    case 'shopDiscount': return e.v * SC(e.scope, { region: 800, run: 2500 }) * s;
    case 'squares': return e.v * 120 * s;
    case 'addPiece': return e.v * UNITS[e.piece] * 40 * s;
    case 'losePiece': return -e.v * UNITS[e.piece] * 40 * s;
    case 'promotePawn': return (UNITS[e.to] - 1) * 40 * s;
    case 'tacticianElo': return e.v * SC(e.scope, { next: 1, region: 3, run: 4 }) * s;
    case 'enemyElo': return -e.v * SC(e.scope, { next: 1, region: 3, run: 4 }) * s;
    case 'enemyBudgetMult': return -(e.v - 1) * SC(e.scope, { next: 150, region: 1500 }) * s;
    case 'trait': return e.v * SC(e.scope, { region: 80, run: 200 }) * TRAIT_W[e.piece] * s;
    case 'enemyTrait': return -e.v * 80 * 0.8 * TRAIT_W[e.piece] * s;
    case 'raidClock': return e.v * 0.8 * s;
    case 'rivalClock': return e.v * 0.5 * s;
    case 'rivalStrength': return -e.v * 150 * s;
    case 'reveal': return e.v * 60 * s;
    case 'marchMult': return -(e.v - 1) * 600 * s;
    case 'bar': return e.v * BAR_W[e.material];
    case 'resource': return e.v * RES_W[e.res];
    case 'memoriesOnEnd': return e.v * 250;
    case 'combo': return e.parts.reduce((a, p) => a + effectValue(p, region), 0);
    default: return NaN;
  }
}
// region gates for strong effects: an effect may only appear at or after this region
export function effectMinRegion(e) {
  switch (e.kind) {
    case 'promotePawn': return { N: 1, B: 2, R: 3, Q: 4 }[e.to] || 1;
    case 'bar': return { iron: 1, steel: 3, obsidian: 4 }[e.material] || 1;
    case 'addPiece': return { P: 1, N: 3, B: 3, R: 5, Q: 7 }[e.piece] || 1;
    case 'trait': return e.scope === 'run' ? (e.piece === 'Q' ? 5 : 2) : 1;
    case 'enemyBudgetMult': return 3;
    case 'memoriesOnEnd': return 3;
    case 'rivalStrength': return 2;
    case 'combo': return Math.max(...e.parts.map(effectMinRegion));
    default: return 1;
  }
}

// ---------------------------------------------------------------------------------------------
// Validators: each returns an array of error strings ([] = valid).
// ---------------------------------------------------------------------------------------------
const isStr = (x, max) => typeof x === 'string' && x.trim().length > 0 && x.length <= max;
const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
export const SQUARE_RE = /^[a-h][1-8]$/;
export const LIMITS = { label: 60, taunt: 80, line: 90, name: 40, note: 120 };

export function validateEffect(e, path = 'effect', inCombo = false) {
  const err = [];
  if (!e || typeof e !== 'object') return [path + ': not an object'];
  const k = EFFECT_KINDS[e.kind];
  if (!k) return [path + ': unknown kind ' + JSON.stringify(e.kind)];
  if (e.kind === 'combo') {
    if (inCombo) err.push(path + ': nested combo');
    if (!Array.isArray(e.parts) || e.parts.length < 2 || e.parts.length > 3) err.push(path + ': combo needs 2-3 parts');
    else e.parts.forEach((p, i) => err.push(...validateEffect(p, path + '.parts[' + i + ']', true)));
    for (const key of Object.keys(e)) if (key !== 'kind' && key !== 'parts') err.push(path + ': stray key ' + key);
    return err;
  }
  const allowed = new Set(['kind', ...Object.keys(k.params), ...(k.scopes ? ['scope'] : [])]);
  for (const key of Object.keys(e)) if (!allowed.has(key)) err.push(path + ': stray key ' + key);
  for (const [name, spec] of Object.entries(k.params)) {
    const v = e[name];
    if (spec[0] === 'enum') { if (!spec[1].includes(v)) err.push(`${path}.${name}: ${JSON.stringify(v)} not in [${spec[1]}]`); }
    else {
      if (typeof v !== 'number' || !Number.isFinite(v)) { err.push(`${path}.${name}: not a number`); continue; }
      if (spec[0] === 'int' && !Number.isInteger(v)) err.push(`${path}.${name}: not an integer`);
      if (v < spec[1] || v > spec[2]) err.push(`${path}.${name}: ${v} outside [${spec[1]}, ${spec[2]}]`);
    }
  }
  if (k.nonzero && e.v === 0) err.push(path + '.v: zero');
  if (k.scopes) { if (!k.scopes.includes(e.scope)) err.push(`${path}.scope: ${JSON.stringify(e.scope)} not in [${k.scopes}]`); }
  return err;
}

export function validateShrine(c) {
  const err = [], p = 'shrine ' + (c && c.id);
  if (!c || typeof c !== 'object') return ['shrine: not an object'];
  if (!ID_RE.test(c.id || '')) err.push(p + ': bad id');
  if (!isStr(c.name, LIMITS.name)) err.push(p + ': bad name');
  if (!Number.isInteger(c.minRegion) || c.minRegion < 1 || c.minRegion > MAX_REGION) err.push(p + ': minRegion not in 1..' + MAX_REGION);
  for (const side of ['a', 'b']) {
    const o = c[side];
    if (!o || typeof o !== 'object') { err.push(p + '.' + side + ': missing'); continue; }
    if (!isStr(o.label, LIMITS.label)) err.push(`${p}.${side}.label: empty or over ${LIMITS.label} chars`);
    const ee = validateEffect(o.effect, p + '.' + side + '.effect');
    err.push(...ee);
    if (!ee.length && effectMinRegion(o.effect) > c.minRegion) err.push(`${p}.${side}: effect needs minRegion >= ${effectMinRegion(o.effect)}`);
  }
  if (c.a && c.b && c.a.label === c.b.label) err.push(p + ': identical labels');
  if (c.a && c.b && JSON.stringify(c.a.effect) === JSON.stringify(c.b.effect)) err.push(p + ': identical effects');
  return err;
}

export function validateLord(l) {
  const err = [], p = 'lord ' + (l && l.id);
  if (!l || typeof l !== 'object') return ['lord: not an object'];
  if (!ID_RE.test(l.id || '')) err.push(p + ': bad id');
  if (!isStr(l.name, LIMITS.name)) err.push(p + ': bad name');
  if (!isStr(l.epithet, LIMITS.name)) err.push(p + ': bad epithet');
  if (!DOCTRINES.includes(l.doctrine)) err.push(p + ': bad doctrine');
  if (!isStr(l.taunt, LIMITS.taunt)) err.push(`${p}: taunt empty or over ${LIMITS.taunt} chars`);
  if (!isStr(l.personalityNote, LIMITS.note)) err.push(p + ': bad personalityNote');
  if (!Array.isArray(l.favoredPieces) || l.favoredPieces.length < 1 || l.favoredPieces.length > 3 ||
      !l.favoredPieces.every(x => PIECES.includes(x)) || new Set(l.favoredPieces).size !== l.favoredPieces.length) err.push(p + ': bad favoredPieces');
  return err;
}

export function validateFormation(f, budgetFn = refBudget) {
  const err = [], p = 'formation ' + (f && f.id);
  if (!f || typeof f !== 'object') return ['formation: not an object'];
  if (!ID_RE.test(f.id || '')) err.push(p + ': bad id');
  if (!isStr(f.name, LIMITS.name)) err.push(p + ': bad name');
  if (!DOCTRINES.includes(f.doctrine)) err.push(p + ': bad doctrine');
  if (typeof f.citadel !== 'boolean') err.push(p + ': citadel not boolean');
  if (!Array.isArray(f.favored) || !f.favored.length || !f.favored.every(x => PIECES.includes(x))) err.push(p + ': bad favored');
  if (!Array.isArray(f.pieces) || f.pieces.length < 2) return err.concat(p + ': needs a king and at least one piece');
  const seen = new Set(); let kings = 0;
  f.pieces.forEach((pc, i) => {
    if (!pc || !['P', 'N', 'B', 'R', 'Q', 'K'].includes(pc.type)) err.push(`${p}.pieces[${i}]: bad type`);
    if (!pc || !SQUARE_RE.test(pc.square || '')) { err.push(`${p}.pieces[${i}]: bad square`); return; }
    const rank = +pc.square[1];
    if (rank < 5) err.push(`${p}: ${pc.type}${pc.square} below rank 5`);
    if (pc.type === 'P' && rank === 8) err.push(`${p}: pawn on rank 8 (${pc.square})`);
    if (seen.has(pc.square)) err.push(`${p}: duplicate square ${pc.square}`);
    seen.add(pc.square);
    if (pc.type === 'K') kings++;
    if (pc.type === 'K' && i !== 0) err.push(p + ': king must be pieces[0]');
  });
  if (kings !== 1) err.push(`${p}: ${kings} kings`);
  for (const x of f.favored || []) if (!f.pieces.some(pc => pc.type === x)) err.push(`${p}: favored ${x} not in the formation`);
  const units = formationUnits(f);
  if (f.budget !== units) err.push(`${p}: budget tag ${f.budget} != units ${units}`);
  if (!Array.isArray(f.tiers) || f.tiers.length !== 2 || !f.tiers.every(Number.isInteger) || f.tiers[0] < 1 || f.tiers[0] > f.tiers[1]) err.push(p + ': bad tiers');
  else {
    const type = f.citadel ? 'citadel' : 'garrison';
    const lo = budgetFn(f.tiers[0], type), hi = budgetFn(f.tiers[1], type);
    if (lo < BAND.lo * units - 1e-9) err.push(`${p}: tier ${f.tiers[0]} budget ${lo.toFixed(1)} < ${BAND.lo} x ${units}`);
    if (hi > BAND.hi * units + 1e-9) err.push(`${p}: tier ${f.tiers[1]} budget ${hi.toFixed(1)} > ${BAND.hi} x ${units}`);
  }
  return err;
}

export function validatePieceSet(s) {
  const err = [], p = 'pieceSet ' + (s && s.id);
  if (!s || typeof s !== 'object') return ['pieceSet: not an object'];
  if (!ID_RE.test(s.id || '')) err.push(p + ': bad id');
  if (!isStr(s.name, LIMITS.name)) err.push(p + ': bad name');
  const u = s.unlockedBy;
  if (!u || !UNLOCK_KINDS.includes(u.kind)) err.push(p + ': bad unlockedBy.kind');
  else if (u.kind === 'forge') { if (!BARS.includes(u.material)) err.push(p + ': bad unlockedBy.material'); }
  else if (u.kind !== 'default' && !(Number.isInteger(u.v) && u.v >= 1 && u.v <= 1000)) err.push(p + ': bad unlockedBy.v');
  if (u && u.kind === 'region' && u.v > MAX_REGION) err.push(p + ': region unlock beyond MAX_REGION');
  if (!Number.isInteger(s.glyphWeight) || s.glyphWeight < 100 || s.glyphWeight > 900 || s.glyphWeight % 100) err.push(p + ': bad glyphWeight');
  for (const side of ['player', 'enemy']) {
    const t = s[side];
    if (!t || !Number.isInteger(t.hue) || t.hue < -180 || t.hue > 180) err.push(`${p}.${side}.hue: int in [-180,180]`);
    if (!t || !Number.isInteger(t.light) || t.light < -20 || t.light > 20) err.push(`${p}.${side}.light: int in [-20,20]`);
  }
  if (!OUTLINES.includes(s.outline)) err.push(p + ': bad outline');
  return err;
}

export function validateLine(line, path) {
  const err = [];
  if (!isStr(line, LIMITS.line)) err.push(`${path}: empty or over ${LIMITS.line} chars`);
  else {
    for (const m of line.matchAll(/\{(\w+)\}/g)) if (!PLACEHOLDERS.includes(m[1])) err.push(`${path}: unknown placeholder {${m[1]}}`);
    if (/[{}]/.test(line.replace(/\{\w+\}/g, ''))) err.push(path + ': stray brace');
  }
  return err;
}

function uniq(list, key, what) {
  const seen = new Set(), err = [];
  for (const x of list) { const k = x && x[key]; if (seen.has(k)) err.push(`${what}: duplicate ${key} ${k}`); seen.add(k); }
  return err;
}

export function validateAll(budgetFn = refBudget) {
  const err = [];
  SHRINE_CHOICES.forEach(c => err.push(...validateShrine(c)));
  err.push(...uniq(SHRINE_CHOICES, 'id', 'SHRINE_CHOICES'), ...uniq(SHRINE_CHOICES, 'name', 'SHRINE_CHOICES'));
  RIVAL_LORDS.forEach(l => err.push(...validateLord(l)));
  err.push(...uniq(RIVAL_LORDS, 'id', 'RIVAL_LORDS'), ...uniq(RIVAL_LORDS, 'name', 'RIVAL_LORDS'));
  ENEMY_FORMATION_PACK.forEach(f => err.push(...validateFormation(f, budgetFn)));
  err.push(...uniq(ENEMY_FORMATION_PACK, 'id', 'ENEMY_FORMATION_PACK'), ...uniq(ENEMY_FORMATION_PACK, 'name', 'ENEMY_FORMATION_PACK'));
  PIECE_SETS.forEach(s => err.push(...validatePieceSet(s)));
  err.push(...uniq(PIECE_SETS, 'id', 'PIECE_SETS'), ...uniq(PIECE_SETS, 'name', 'PIECE_SETS'));
  for (const [k, lines] of Object.entries(EVENT_LINES)) {
    if (!Array.isArray(lines) || lines.length < 10) err.push(`EVENT_LINES.${k}: fewer than 10 lines`);
    else lines.forEach((l, i) => err.push(...validateLine(l, `EVENT_LINES.${k}[${i}]`)));
    if (Array.isArray(lines) && new Set(lines).size !== lines.length) err.push(`EVENT_LINES.${k}: duplicate line`);
  }
  return err;
}

// Piece set -> CSS custom properties (see CONTENT-API.md). Base colors stay the theme's tokens.
const OUTLINE_CSS = {
  none: 'none',
  hairline: '0 0 1px var(--piece-outline)',
  ink: '1px 0 0 var(--piece-outline), -1px 0 0 var(--piece-outline), 0 1px 0 var(--piece-outline), 0 -1px 0 var(--piece-outline)',
  double: '0 0 0 var(--piece-outline), 0 0 2px var(--piece-outline), 0 0 4px var(--piece-accent)',
  glow: '0 0 6px var(--piece-accent)',
};
export function pieceSetVars(set) {
  return {
    '--pc-weight': String(set.glyphWeight),
    '--pc-player-hue': set.player.hue + 'deg', '--pc-player-light': set.player.light + '%',
    '--pc-enemy-hue': set.enemy.hue + 'deg', '--pc-enemy-light': set.enemy.light + '%',
    '--pc-outline': OUTLINE_CSS[set.outline],
  };
}
