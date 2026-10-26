// Driftmail's ocean rules: the island clock, tides, where a thrown bottle drifts, where new
// islands go, and what washes up. Pure functions of time and a random source, so the Ocean
// object (ocean.js) and the tests share them.
//
// Coordinates are abstract ocean units, x east and y north. Players never see them: a bottle
// tells its finder only which beach it washed up on and when.

// An island day lasts an hour (Miles asked for much shorter days), with two half-hour tides, so
// one sitting sees dawn, dusk and both tides.
export const DAY_MS = 60 * 60 * 1000;
export const TIDE_MS = DAY_MS / 2;
// An island whose player hasn't visited for this long goes quiet: nothing lands there.
export const ACTIVE_MS = 3 * 24 * 60 * 60 * 1000;
// A bottle nobody can reach keeps drifting, looking further each hour, for up to a day.
export const REDRIFT_MS = 60 * 60 * 1000;
export const MAX_DRIFT_MS = 24 * 60 * 60 * 1000;
export const MAX_LETTER = 600;
export const STARTER_SUPPLIES = { bottles: 3, corks: 3, paper: 3, ink: 3 };
export const SUPPLIES = ['bottles', 'corks', 'paper', 'ink'];
// Compass points a bottle can be thrown toward, clockwise from north.
export const DIRECTIONS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

const PARTS = [
  [0.2, 'night'], [0.3, 'dawn'], [0.45, 'morning'], [0.6, 'midday'], [0.7, 'afternoon'], [0.8, 'dusk'], [1, 'night'],
];

// Where the island day and the tide stand at time t. `day` runs 0..1 from midnight; `tide` is
// the water level from -1 (low) to 1 (high); `ebbing` means it's going out.
export function clock(t) {
  const day = (t % DAY_MS) / DAY_MS;
  const phase = ((t % TIDE_MS) / TIDE_MS) * 2 * Math.PI;
  const tide = Math.cos(phase);
  return { day, part: PARTS.find(([end]) => day < end)[1], tide, ebbing: Math.sin(phase) > 0 };
}

export function tideWords(c) {
  if (c.tide > 0.8) return 'high tide';
  if (c.tide < -0.8) return 'low tide';
  return c.ebbing ? 'tide going out' : 'tide coming in';
}

// The surface current turns with the day: north at dawn, east at midday, south at dusk, west
// at midnight. An outgoing tide carries bottles twice as far as an incoming one.
export function current(t) {
  const c = clock(t);
  // A tide anomaly turns every current round for its tide.
  const reversed = eventAt(t)?.kind === 'reversal' ? Math.PI : 0;
  const angle = Math.PI / 2 - 2 * Math.PI * (c.day - 0.25) + reversed;
  const strength = c.ebbing ? 16 : 8;
  return { angle, strength };
}

// How each kind of container or bottle travels: `reach` scales the throw, `current` how much the
// current carries it, `time` how long it takes. A weighted bottle sinks into the deep current
// and surfaces far away much later; a sailed float follows the wind across the currents.
export const TRAVEL = {
  bottle: { reach: 1, current: 1, time: 1 },
  jar: { reach: 0.7, current: 0.8, time: 1.4 },
  box: { reach: 0.4, current: 0.9, time: 2 },
  barrel: { reach: 1.2, current: 1.6, time: 1.6 },
  double: { reach: 1, current: 1.5, time: 1.3 },
  weighted: { reach: 1, current: 3, time: 4 },
  sailed: { reach: 2.5, current: 0, time: 1.2 },
};

// Where a bottle thrown at time t comes to rest, and when. `dir` indexes DIRECTIONS and
// `strength` runs 0..1. A reply passes `toward` (where the letter it answers was thrown from):
// aimed within about 45° of it, the bottle bends that way, more the better the aim; between pen
// pals (`steady`) a steady current runs, so it bends from further off and lands closer.
export function drift({ from, dir, strength, t, rand, toward = null, kind = 'bottle', steady = false }) {
  const travel = TRAVEL[kind] ?? TRAVEL.bottle;
  const aim = Math.PI / 2 - (dir * Math.PI) / 4;
  const reach = (3 + 5 * strength) * travel.reach;
  const cur = current(t);
  const event = eventAt(t)?.kind;
  // A storm or a spring tide carries a bottle much further, and a storm throws it off course
  // too; in a great ebb the tides go weak.
  const push = (event === 'storm' || event === 'spring' ? 1.8 : event === 'ebb' ? 0.5 : 1) * travel.current;
  const jitter = (rand() - 0.5) * (event === 'storm' ? 2.4 : 0.7);
  const spread = 0.85 + rand() * 0.3;
  // A sailed float goes with the wind, which blows its own way each tide.
  const wind = kind === 'sailed' ? windAt(t) : 0;
  let x = from.x + Math.cos(aim + wind * 0.3) * reach + Math.cos(cur.angle + jitter) * cur.strength * spread * push;
  let y = from.y + Math.sin(aim + wind * 0.3) * reach + Math.sin(cur.angle + jitter) * cur.strength * spread * push;
  if (toward) {
    const bearing = Math.atan2(toward.y - from.y, toward.x - from.x);
    const match = Math.cos(bearing - aim);
    const [from0, most] = steady ? [0.4, 0.95] : [0.7, 0.8];
    if (match > from0) {
      const pull = ((match - from0) / (1 - from0)) * most;
      x += (toward.x - x) * pull;
      y += (toward.y - y) * pull;
    }
  }
  const distance = Math.hypot(x - from.x, y - from.y);
  return { x, y, arrives: t + Math.round((5 + distance * 1.5) * travel.time * 60 * 1000) };
}

// The wind's turn from the throw for a sailed float, -1..1, fixed for each tide.
export function windAt(t) {
  return tideRand(Math.floor(t / TIDE_MS), 0x3d17)() * 2 - 1;
}

// Which compass point is closest to the bearing from a to b.
export function directionTo(a, b) {
  const bearing = Math.atan2(b.y - a.y, b.x - a.x);
  return ((Math.round((Math.PI / 2 - bearing) / (Math.PI / 4)) % 8) + 8) % 8;
}

// A bottle washes up on the beach facing where it came from.
export function shore(island, origin) {
  const bearing = Math.atan2(origin.y - island.y, origin.x - island.x);
  const quarter = ((Math.round((Math.PI / 2 - bearing) / (Math.PI / 2)) % 4) + 4) % 4;
  return ['north', 'east', 'south', 'west'][quarter];
}

// Who finds a bottle that has come to rest at `point`: the nearest active island other than the
// sender, within a search radius that widens the longer it has drifted. After a day, anyone;
// and if there's nobody else at all, it washes back to the sender. A lighthouse draws in the
// bottles drifting near its island, as if they were LIGHTHOUSE_PULL closer.
export const LIGHTHOUSE_PULL = 8;
export function finder(point, islands, sender, drifted) {
  const others = islands.filter((i) => i.key !== sender);
  const radius = drifted >= MAX_DRIFT_MS ? Infinity : 15 + 10 * (drifted / REDRIFT_MS);
  let best = null;
  let bestD = Infinity;
  for (const i of others) {
    const d = Math.max(0, Math.hypot(i.x - point.x, i.y - point.y) - (i.lighthouse ? LIGHTHOUSE_PULL : 0));
    if (d <= radius && d < bestD) {
      best = i;
      bestD = d;
    }
  }
  if (best) return best;
  if (drifted >= MAX_DRIFT_MS) return islands.find((i) => i.key === sender) ?? null;
  return null;
}

// New islands spiral outward, so people who join around the same time are neighbours, and the
// first ones (the Claude castaways) sit in the middle.
export function placeIsland(n) {
  const angle = n * 2.399963; // the golden angle, so no two land on top of each other
  const radius = 6 * Math.sqrt(n);
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

// What the tide leaves on the sand: mostly building materials, sometimes writing supplies, now and
// then something strange. Weights out of 100; null is nothing. Wreckage and storms bring far more,
// a comet brings old bottles, and a great ebb uncovers what the sea floor was hiding.
const FLOTSAM = {
  calm: [
    [18, null], [13, 'driftwood'], [7, 'rope'], [5, 'clay'], [6, 'sand'], [7, 'stones'], [8, 'leaves'], [3, 'reeds'],
    [8, 'bottles'], [6, 'corks'], [5, 'paper'], [3, 'ink'], [5, 'curio'], [3, 'seeds'], [2, 'old bottle'], [1, 'strange'],
  ],
  wreck: [
    [4, null], [20, 'driftwood'], [12, 'rope'], [12, 'bottles'], [10, 'corks'], [8, 'paper'], [6, 'ink'], [10, 'curio'],
    [4, 'seeds'], [12, 'old bottle'], [2, 'strange'],
  ],
  comet: [
    [20, null], [10, 'driftwood'], [5, 'stones'], [10, 'bottles'], [10, 'curio'], [30, 'old bottle'], [15, 'strange'],
  ],
  ebb: [
    [10, null], [15, 'stones'], [10, 'clay'], [10, 'sand'], [25, 'curio'], [15, 'old bottle'], [10, 'driftwood'], [5, 'strange'],
  ],
};

export function flotsam(rand, event = null) {
  const table = event === 'wreck' || event === 'storm' ? FLOTSAM.wreck : FLOTSAM[event] ?? FLOTSAM.calm;
  let r = rand() * 100;
  for (const [w, what] of table) {
    if ((r -= w) < 0) return what;
  }
  return null;
}

const CURIOS = [
  'a spiral shell', 'a piece of green sea glass', 'a piece of blue sea glass', 'a smooth black stone',
  'a bone button', 'a cork float', 'a crab claw', 'a sand dollar', 'a tangle of fishing line',
  'a worn wooden peg', 'a gull feather', 'a starfish, dried', 'a strip of sailcloth', 'a bent nail',
  'a whelk shell, pink inside', 'a clay pipe stem', 'a green glass float', 'a tin button with an anchor on it',
];
// What only a strange tide, the deep water or the fog leaves behind.
export const STRANGE_CURIOS = [
  'a pale fish scale as big as your palm', 'a compass that points out to sea', 'a key with no teeth',
  'a pocket watch, stopped at twenty past four', 'a smooth stone, warm even at night', 'a glass float with something moving inside',
  'a feather from no bird you know', 'a brass button stamped with your own island\'s shape', 'a coin with a hole bored through it',
];

export function strangeCurio(rand) {
  return STRANGE_CURIOS[Math.floor(rand() * STRANGE_CURIOS.length)];
}

export function curio(rand) {
  return CURIOS[Math.floor(rand() * CURIOS.length)];
}

const MATERIALS = ['brass', 'tin', 'bone', 'driftwood', 'copper', 'blue glass', 'whalebone', 'iron', 'jade', 'clay'];
const THINGS = ['key', 'thimble', 'ring', 'whistle', 'coin', 'button', 'compass needle', 'fish hook', 'bead', 'locket'];
const MARKS = [
  'with a chip in the rim', 'with a hole bored through it', 'scratched with three lines', 'worn smooth on one side',
  'with a tiny star stamped in it', 'stained green at one end', 'with a crack that catches the light',
  'with a letter "M" cut into it', 'bent slightly crooked', 'with a knot of red thread tied on',
];

// The one-of-a-kind thing every castaway starts with, before they have a seal of their own.
export function uniqueCurio(rand) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  return `a ${pick(MATERIALS)} ${pick(THINGS)} ${pick(MARKS)}`;
}

// A small seeded random source (mulberry32), so tests can replay a throw exactly.
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Ocean events ---------------------------------------------------------------------------
// Large, rare and the same for everyone. Time is cut into slots of eight tides (four island days);
// each slot may hold one event, fixed by the slot's number, starting at some tide inside it and
// lasting a tide or several. Events never overlap, the server and anyone with the Sea signs
// ability agree on what's coming, and slight signs show up the tide before one starts.

export const EVENTS = {
  storm: {
    name: 'a storm', tides: 1, weight: 3,
    words: 'A storm is tearing across the sea. Bottles thrown now fly far and wild, and the waves throw up more than usual.',
    signs: ['The gulls have all gone quiet.', 'A long, slow swell is rolling in from nowhere.'],
  },
  spring: {
    name: 'a spring tide', tides: 1, weight: 3,
    words: 'A spring tide: the water runs higher and faster than any normal day. Bottles thrown now travel much further.',
    signs: ['The moon looked very large last night.', 'The high-water line is creeping up the sand.'],
  },
  shoal: {
    name: 'a great shoal', tides: 2, weight: 3,
    words: 'A great shoal is passing close to shore. The water is thick with fish.',
    signs: ['Birds are diving far out to sea.', 'There is a silver shimmer under the waves.'],
  },
  wreck: {
    name: 'wreckage', tides: 1, weight: 3,
    words: 'Wreckage is washing in from some far-off ship: planks, rope, and the odd old bottle.',
    signs: ['There is a smell of tar on the wind.', 'Splinters of painted wood are turning up in the surf.'],
  },
  redtide: {
    name: 'a red tide', tides: 4, weight: 1,
    words: 'A red tide has come in. Nothing will bite, and bottles thrown into it come out stained and hard to read.',
    signs: ['A few dead fish lie on the sand.', 'There is a rusty tint along the waterline.'],
  },
  comet: {
    name: 'a comet', tides: 6, weight: 1,
    words: 'A comet hangs over the sea. Old bottles are surfacing everywhere, carrying pages nobody has seen.',
    signs: ['A faint new star sits low in the east.', 'The new star is brighter than it was.'],
  },
  ebb: {
    name: 'a great ebb', tides: 2, weight: 1,
    words: 'A great ebb: the sea has pulled far back, uncovering a sandbar and things that have lain under it for years. The tides are weak.',
    signs: ['The tides have been oddly weak.', 'The waterline barely reached the wet sand today.'],
  },
  fog: {
    name: 'a fog tide', tides: 2, weight: 1,
    words: 'The fog bank has spread over the water. Bottles thrown into it vanish, and some come back changed.',
    signs: ['There was mist on the horizon at dawn.', 'The gulls are quiet, and the air tastes of salt and cold.'],
  },
  reversal: {
    name: 'a tide anomaly', tides: 1, weight: 1,
    words: 'Something is wrong with the currents: they are running backwards. Bottles thrown now will go somewhere new.',
    signs: ['The surf is breaking the wrong way.', 'Your last bottle bobbed back toward the beach before it caught.'],
  },
};
const EVENT_KINDS = Object.keys(EVENTS);
const EVENT_WEIGHT = EVENT_KINDS.reduce((sum, k) => sum + EVENTS[k].weight, 0);
export const SLOT_TIDES = 8;
const EVENT_CHANCE = 0.3;

function tideRand(n, salt) {
  return seeded(Math.imul(n, 2654435761) ^ salt);
}

// The event in slot m, as { kind, start (a tide number), tides }, or null.
export function slotEvent(m) {
  const r = tideRand(m, 0x5eaf00d);
  if (r() >= EVENT_CHANCE) return null;
  let w = r() * EVENT_WEIGHT;
  let kind = EVENT_KINDS[0];
  for (const k of EVENT_KINDS) {
    if ((w -= EVENTS[k].weight) < 0) {
      kind = k;
      break;
    }
  }
  const tides = EVENTS[kind].tides;
  // Never in a slot's first tide, so the tide before it, when its signs show, is in the same slot.
  const start = m * SLOT_TIDES + 1 + Math.floor(r() * (SLOT_TIDES - tides));
  return { kind, start, tides };
}

// The event during tide number n (counting TIDE_MS from the epoch), or null.
export function eventOn(n) {
  const e = slotEvent(Math.floor(n / SLOT_TIDES));
  return e && n >= e.start && n < e.start + e.tides ? e.kind : null;
}

export function eventAt(t) {
  const n = Math.floor(t / TIDE_MS);
  const e = slotEvent(Math.floor(n / SLOT_TIDES));
  if (!e || n < e.start || n >= e.start + e.tides) return null;
  return { kind: e.kind, start: e.start * TIDE_MS, end: (e.start + e.tides) * TIDE_MS };
}

// Every event starting in the next `tides` tides after the current one.
export function upcoming(t, tides) {
  const n = Math.floor(t / TIDE_MS);
  const out = [];
  for (let m = Math.floor((n + 1) / SLOT_TIDES); m <= Math.floor((n + tides) / SLOT_TIDES); m++) {
    const e = slotEvent(m);
    if (e && e.start > n && e.start <= n + tides) out.push({ kind: e.kind, start: e.start * TIDE_MS, end: (e.start + e.tides) * TIDE_MS });
  }
  return out;
}

// The slight sign anyone might notice: during the tide before an event, and not always.
export function signAt(t) {
  const n = Math.floor(t / TIDE_MS);
  const e = slotEvent(Math.floor((n + 1) / SLOT_TIDES));
  if (!e || e.start !== n + 1) return null;
  const r = tideRand(n, 0x516e);
  if (r() > 0.65) return null;
  const signs = EVENTS[e.kind].signs;
  return signs[Math.floor(r() * signs.length)];
}

// --- Fishing --------------------------------------------------------------------------------
// A hand line off the rocks, once a tide (twice with Fisher's knots). Dawn, dusk and a rising
// tide are best; a bone hook, bait from the garden and the knots help; a shoal fills the water
// and a red tide empties it. At low tide you can wade out with a spear, and traps set with bait
// fill up while you're away.

export const BONE_HOOK_COST = 5; // bones
export const GLUE_COST = 2; // fish per pot of glue
export const OIL_COST = 2; // fish per flask of oil
export const SPEAR_COST = { driftwood: 1, bones: 2 };
export const TRAP_COST = { driftwood: 2, rope: 1 };
export const MAX_TRAPS = 3;
const CATCHES = [
  [42, 'fish'], [13, 'big fish'], [14, 'cuttlefish'], [12, 'crab'], [6, 'old bottle'], [4, 'curio'], [5, 'snag'], [4, 'strange'],
];

// Where you can cast from the rocks. Each spot bites differently and favours its own catch; one
// of them is lively each tide (fish are feeding there), and the water shows it if you look.
export const SPOTS = {
  shallows: {
    name: 'The shallows', bite: 0.1, plain: 'Clear water over sand. Small fish dart about.',
    lively: 'Little fish are jumping clear of the water.',
    catches: [[60, 'fish'], [4, 'big fish'], [8, 'cuttlefish'], [18, 'crab'], [4, 'old bottle'], [4, 'curio'], [2, 'snag']],
  },
  reef: {
    name: 'The reef', bite: 0, plain: 'Dark rock just under the surface.',
    lively: 'Something is snapping at the weed on the rocks.',
    catches: [[30, 'fish'], [10, 'big fish'], [10, 'cuttlefish'], [35, 'crab'], [5, 'curio'], [5, 'snag'], [5, 'strange']],
  },
  weed: {
    name: 'The kelp bed', bite: 0, plain: 'A slow raft of kelp, swaying.',
    lively: 'A cloud of ink is drifting out of the kelp.',
    catches: [[30, 'fish'], [8, 'big fish'], [35, 'cuttlefish'], [6, 'crab'], [8, 'old bottle'], [6, 'curio'], [7, 'snag']],
  },
  deep: {
    name: 'The deep water', bite: -0.15, plain: 'The bottom falls away here. The water is nearly black.',
    lively: 'Gulls are diving, far out over the drop.',
    catches: [[35, 'fish'], [35, 'big fish'], [6, 'cuttlefish'], [6, 'old bottle'], [6, 'snag'], [12, 'strange']],
  },
};
export const SPOT_KINDS = Object.keys(SPOTS);

// Which spot is lively during the tide at time t: the same for everyone, and new each tide.
export function livelySpot(t) {
  return SPOT_KINDS[Math.floor(tideRand(Math.floor(t / TIDE_MS), 0x5907)() * SPOT_KINDS.length)];
}

// What the water looks like at each spot right now.
export function spotsAt(t) {
  const lively = livelySpot(t);
  return SPOT_KINDS.map((id) => ({ id, name: SPOTS[id].name, sign: id === lively ? SPOTS[id].lively : SPOTS[id].plain }));
}

// Once something bites, it fights: a run of pulls the player answers one at a time. Left wants you
// to lean right, right wants you to lean left, and a dive away wants you to give it line. Bigger
// things fight longer.
export const PULLS = ['left', 'right', 'away'];
export const ANSWERS = { left: 'right', right: 'left', away: 'give' };
const FIGHT = { fish: 3, 'big fish': 5, cuttlefish: 3, crab: 2, 'old bottle': 2, curio: 1, snag: 2, strange: 4 };

export function fight(what, rand) {
  const n = FIGHT[what] ?? 3;
  const runs = [];
  for (let i = 0; i < n; i++) runs.push(PULLS[Math.floor(rand() * PULLS.length)]);
  // Before the real bite, a few nibbles: small dips that pull nothing in if you strike at them.
  return { runs, nibbles: Math.floor(rand() * 4) };
}

// Mistakes a fight forgives: one, and one more with Fisher's knots.
export function slack(abilities = []) {
  return abilities.includes('knots') ? 2 : 1;
}

// Casts a tide: four, and two more with Fisher's knots.
export const CASTS = 4;
export function castsPerTide(abilities = []) {
  return CASTS + (abilities.includes('knots') ? 2 : 0);
}

export function cast({ t, rand, hook = false, abilities = [], bait = false, spot = null }) {
  const c = clock(t);
  const event = eventAt(t)?.kind;
  if (event === 'redtide') return null;
  let chance = 0.45;
  if (spot && SPOTS[spot]) chance += SPOTS[spot].bite + (livelySpot(t) === spot ? 0.25 : 0);
  if (c.part === 'dawn' || c.part === 'dusk') chance += 0.2;
  if (!c.ebbing) chance += 0.1;
  if (hook) chance += 0.15;
  if (bait) chance += 0.15;
  if (abilities.includes('knots')) chance += 0.1;
  if (event === 'shoal') chance += 0.35;
  if (event === 'storm') chance -= 0.25;
  if (rand() >= Math.min(0.95, chance)) return null;
  let r = rand() * 100;
  let what = 'fish';
  for (const [w, k] of (spot && SPOTS[spot] ? SPOTS[spot].catches : CATCHES)) {
    if ((r -= w) < 0) {
      what = k;
      break;
    }
  }
  return { what, double: event === 'shoal' && (what === 'fish' || what === 'big fish') };
}

// The spear only works wading in the shallows at low tide.
export function canSpear(t) {
  return clock(t).tide < -0.4;
}

export function spear({ t, rand }) {
  if (eventAt(t)?.kind === 'redtide') return null;
  const r = rand();
  if (r < 0.4) return null;
  return r < 0.75 ? 'flatfish' : 'crab';
}

// A trap set with bait catches something in about half the tides it's left, up to three.
export function trapCatch({ set, now, rand }) {
  const tides = Math.min(3, Math.floor(now / TIDE_MS) - Math.floor(set / TIDE_MS));
  let fish = 0;
  let crabs = 0;
  for (let i = 0; i < tides; i++) {
    const r = rand();
    if (r < 0.3) fish++;
    else if (r < 0.5) crabs++;
  }
  return { tides, fish, crabs };
}

// --- Journal pages and abilities ------------------------------------------------------------
// Old bottles hold pages torn from the journals of people who were here long before. A few of
// them teach something; a page you hold can be copied out and sent on with a letter.

export const ABILITIES = {
  hands: { name: 'Reading hands', words: 'You can tell when two letters on your shelf were written by the same hand.' },
  signs: { name: 'Sea signs', words: 'You can read what the sea is about to do, two island days ahead.' },
  currents: { name: 'Reading the current', words: 'You can judge where each of your bottles came to rest.' },
  knots: { name: "Fisher's knots", words: 'Your line holds better: more bites, and two more casts a tide.' },
  kiln: { name: 'Kiln craft', words: 'With a kiln you can fire jars, and weight a bottle to ride the deep current.' },
  carving: { name: 'Seal carving', words: 'At the seal bench you can carve a stamp of your own, and copy one you have seen often.' },
  restore: { name: 'Ink restoration', words: 'You can read the words water has blurred.' },
  forgery: { name: 'Forgery', pages: 2, words: 'Given three letters in someone\'s hand, you can write in a close copy of it. Never a perfect one.' },
  deep: { name: 'Deep current lore', pages: 2, words: 'You can send weighted bottles and sailed floats far beyond the usual reach.' },
};

// How many pages an ability takes to learn.
export function pagesFor(ability) {
  return ABILITIES[ability]?.pages ?? 1;
}

// Three old writers, each with their own hand and mark.
export const OLD_HANDS = { keeper: { hand: 913, emblem: 4 }, salt: { hand: 2207, emblem: 11 }, chart: { hand: 5113, emblem: 7 } };

export const PAGES = [
  {
    id: 'keeper-1', by: 'keeper', title: 'The first page',
    text: 'Day one, or near enough. The boat is gone and the water is very wide. I have counted my things: one knife, one tin cup, this book, a stub of pencil. I will write down what I learn so the next one need not learn it the hard way.',
  },
  {
    id: 'keeper-hands', by: 'keeper', title: 'On hands', teaches: 'hands',
    text: 'Three letters now from the same stranger, though only one was signed. You learn to see it: the way the tail of a y hooks back, how hard they press at the start of a line. Nobody writes the same as anyone else. Lay the letters side by side and look at the small strokes, not the big ones.',
  },
  {
    id: 'keeper-signs', by: 'keeper', title: 'What the sea says first', teaches: 'signs',
    text: 'The sea never does anything big without warning, it just warns quietly. Gulls going silent means weather. A swell with no wind behind it means a storm is coming from far off. Silver under the water means fish. Tar on the wind means a ship has broken up somewhere. Watch the edges of things and you will know a day or two ahead.',
  },
  {
    id: 'keeper-tide', by: 'keeper', title: 'Tides',
    text: 'Two tides each day here, and the days are short and strange. A bottle thrown on the ebb goes out far; thrown on the flood, it barely clears the reef. I have started throwing only when the water is leaving.',
  },
  {
    id: 'salt-currents', by: 'salt', title: 'Where they go', teaches: 'currents',
    text: 'I mark every bottle I throw: time, tide, which way. Then I wait to hear back. North at first light, east by noon, round and round like a clock hand. Once you know the clock, you can feel where a bottle will end up, near enough.',
  },
  {
    id: 'salt-knots', by: 'salt', title: 'Knots', teaches: 'knots',
    text: 'The old knot slips when a big one pulls. Loop it twice through the eye, wrap five turns back on itself, and pass the end through the first loop. Wet it before you pull it tight. With this I have not lost a hook all season.',
  },
  {
    id: 'salt-hook', by: 'salt', title: 'Bone',
    text: 'Fish bones dry hard in the sun. Save them. Five good ones, bound and shaped with the knife, make a hook that bites better than any bent nail. Two fish boiled down make a glue that seals a bottle as well as a cork does.',
  },
  {
    id: 'keeper-island', by: 'keeper', title: 'Someone else',
    text: 'A bottle came back today that was not mine. Different glass. The letter inside was in a hand I did not know, asking if anyone was out here. So there are others. I have read it eleven times.',
  },
  {
    id: 'salt-storm', by: 'salt', title: 'After the storm',
    text: 'The storm took the roof of my lean-to but the beach this morning was covered in gifts. Rope, a barrel stave, two bottles still corked. I suppose the sea gives back what it takes, only never to the same person.',
  },
  {
    id: 'keeper-last', by: 'keeper', title: 'A page near the end',
    text: 'I do not know how many years now. I have written to more people than I ever spoke to before the boat. If this reaches you, write to someone. It does not matter who. That is the whole trick of this place.',
  },
];

PAGES.push(
  {
    id: 'keeper-kiln', by: 'keeper', title: 'Fire and clay', teaches: 'kiln',
    text: 'The clay at the stream bank takes the heat if you let it dry first. Stack the stones high, feed the fire all night and do not open it until it is cold. A jar comes out the colour of old bread. Press a stone into the base of a bottle while it is soft and it will sink like it means it.',
  },
  {
    id: 'salt-seal', by: 'salt', title: 'A mark of your own', teaches: 'carving',
    text: 'Anyone can sign a name. I carved a gull into a scrap of whalebone and pressed it into every letter after. Someone wrote back that they had seen my gull before, on a letter I never sent. So now I watch the marks as closely as the words.',
  },
  {
    id: 'chart-ink', by: 'chart', title: 'Reading the wet ones', teaches: 'restore',
    text: 'Water lifts the ink but leaves the dent of the pen. Hold the page low against the fire, so the light runs along it, and the lost words stand up out of the paper like footprints after the tide.',
  },
  {
    id: 'chart-forgery-1', by: 'chart', title: 'Borrowed hands (I)', teaches: 'forgery',
    text: 'I am not proud of this page. If you have three letters from one person you can learn their hand: the lean, the loops, where they lift the pen. Copy the alphabet out of their own words, letter by letter, until your fingers stop arguing.',
  },
  {
    id: 'chart-forgery-2', by: 'chart', title: 'Borrowed hands (II)', teaches: 'forgery',
    text: 'It is never perfect. A careful reader will feel something is off before they can say what. Slow down on the capitals; that is where everyone gives themselves away, me included.',
  },
  {
    id: 'salt-deep-1', by: 'salt', title: 'Under the current (I)', teaches: 'deep',
    text: 'There is a second sea under this one. A weighted bottle drops through the warm water into a cold river that runs the other way, and comes up a long way off, days later. Weight it with two stones, no more.',
  },
  {
    id: 'keeper-deep-2', by: 'keeper', title: 'Under the current (II)', teaches: 'deep',
    text: 'Salt was right about the deep water. And a float with a scrap of sail does not care for the currents at all: it goes where the wind sends it. Between the two you can write to the far side of the world.',
  },
  {
    id: 'chart-why', by: 'chart', title: 'Nobody remembers arriving',
    text: 'I have asked everyone who writes back. Nobody remembers the boat, or the storm, or the first night. We all woke on a beach beside a crate. Whoever packed the crates knew our handwriting already.',
  },
  {
    id: 'keeper-light', by: 'keeper', title: 'The light',
    text: 'There is a light to the south-west at night, steady, like a lighthouse. Salt sees it to the north. The cartographer sees it to the east. There is no island under it on anybody\'s chart.',
  },
  {
    id: 'salt-fog', by: 'salt', title: 'The fog bank',
    text: 'I threw a bottle into the fog on purpose. It came back to my own beach eleven days later with my letter inside and one line added at the bottom, in my own hand, that I did not write.',
  },
  {
    id: 'chart-dates', by: 'chart', title: 'Dates',
    text: 'The keeper dates every page. Some of the keeper\'s pages are dated after mine, though the keeper was here first. Either the keeper is lying, or the days here do not run in a straight line.',
  },
  {
    id: 'keeper-garden', by: 'keeper', title: 'Seeds',
    text: 'Seeds came in a bottle today with no letter at all, just a pinch of them wrapped in a leaf. I planted them by the stream and watered them every tide. The berries make a dark ink, nearly purple.',
  },
  {
    id: 'salt-pals', by: 'salt', title: 'A steady current',
    text: 'Write to the same person long enough and the sea seems to learn the way between you. My replies to the woman with the anchor seal reach her nearly every time now. I cannot explain it and I have stopped trying.',
  },
  {
    id: 'comet-1', by: 'chart', title: 'Under the comet', comet: true,
    text: 'The comet came back. Last time it came the bottles came up out of the deep by the hundred, and one of them had my name on it in a hand I knew was mine, from a year I have not lived yet.',
  },
  {
    id: 'hidden-1', by: 'keeper', title: 'Where the current hides', hidden: true,
    text: 'You found it. There is a current that only runs for those who know the hour and the tide. It carried me to a reef with no island, only a ring of stones and an empty crate. On the lid, in fresh paint: NOT YET.',
  },
);

export function page(id) {
  return PAGES.find((p) => p.id === id) ?? null;
}

// An old bottle holds a page you haven't read yet, while there are any. Some pages only surface
// under the comet; hidden ones only come from following a clue.
export function oldPage(rand, read = [], { comet = false } = {}) {
  const findable = PAGES.filter((p) => !p.hidden && (comet || !p.comet));
  const unread = findable.filter((p) => !read.includes(p.id));
  const pool = unread.length ? unread : findable;
  return pool[Math.floor(rand() * pool.length)];
}
