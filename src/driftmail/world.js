// Driftmail's ocean rules: the island clock, tides, where a thrown bottle drifts, where new
// islands go, and what washes up. Pure functions of time and a random source, so the Ocean
// object (ocean.js) and the tests share them.
//
// Coordinates are abstract ocean units, x east and y north. Players never see them: a bottle
// tells its finder only which beach it washed up on and when.

// A few island days per real day (Miles's pick). Five hours doesn't divide a day, so someone who
// always plays at the same hour still meets dawn, dusk and both tides over the week.
export const DAY_MS = 5 * 60 * 60 * 1000;
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
  const angle = Math.PI / 2 - 2 * Math.PI * (c.day - 0.25);
  const strength = c.ebbing ? 16 : 8;
  return { angle, strength };
}

// Where a bottle thrown at time t comes to rest, and when. `dir` indexes DIRECTIONS and
// `strength` runs 0..1. A reply passes `toward` (where the letter it answers was thrown from):
// aimed within about 45° of it, the bottle bends that way, more the better the aim.
export function drift({ from, dir, strength, t, rand, toward = null }) {
  const aim = Math.PI / 2 - (dir * Math.PI) / 4;
  const reach = 3 + 5 * strength;
  const cur = current(t);
  // A storm or a spring tide carries a bottle much further; a storm throws it off course too.
  const event = eventAt(t)?.kind;
  const push = event === 'storm' || event === 'spring' ? 1.8 : 1;
  const jitter = (rand() - 0.5) * (event === 'storm' ? 2.4 : 0.7);
  const spread = 0.85 + rand() * 0.3;
  let x = from.x + Math.cos(aim) * reach + Math.cos(cur.angle + jitter) * cur.strength * spread * push;
  let y = from.y + Math.sin(aim) * reach + Math.sin(cur.angle + jitter) * cur.strength * spread * push;
  if (toward) {
    const bearing = Math.atan2(toward.y - from.y, toward.x - from.x);
    const match = Math.cos(bearing - aim);
    if (match > 0.7) {
      const pull = ((match - 0.7) / 0.3) * 0.8;
      x += (toward.x - x) * pull;
      y += (toward.y - y) * pull;
    }
  }
  const distance = Math.hypot(x - from.x, y - from.y);
  return { x, y, arrives: t + Math.round((10 + distance * 3) * 60 * 1000) };
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
// and if there's nobody else at all, it washes back to the sender.
export function finder(point, islands, sender, drifted) {
  const others = islands.filter((i) => i.key !== sender);
  const radius = drifted >= MAX_DRIFT_MS ? Infinity : 15 + 10 * (drifted / REDRIFT_MS);
  let best = null;
  let bestD = Infinity;
  for (const i of others) {
    const d = Math.hypot(i.x - point.x, i.y - point.y);
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

// What the tide leaves on the sand. Weights out of 100; null is nothing. Wreckage brings far
// more, old bottles among it.
const FLOTSAM = [
  [28, null], [15, 'bottles'], [15, 'corks'], [15, 'paper'], [10, 'ink'], [14, 'curio'], [3, 'old bottle'],
];
const WRECKAGE = [
  [5, null], [20, 'bottles'], [20, 'corks'], [15, 'paper'], [10, 'ink'], [15, 'curio'], [15, 'old bottle'],
];

export function flotsam(rand, event = null) {
  let r = rand() * 100;
  for (const [w, what] of event === 'wreck' || event === 'storm' ? WRECKAGE : FLOTSAM) {
    if ((r -= w) < 0) return what;
  }
  return null;
}

const CURIOS = [
  'a spiral shell', 'a piece of green sea glass', 'a piece of blue sea glass', 'a smooth black stone',
  'a bone button', 'a cork float', 'a crab claw', 'a sand dollar', 'a tangle of fishing line',
  'a worn wooden peg', 'a gull feather', 'a starfish, dried', 'a strip of sailcloth', 'a bent nail',
];

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
// Large, rare and the same for everyone: roughly one tide in fourteen brings something. Each
// tide either has an event or doesn't, fixed by the tide's number, so the server and anyone
// with the Sea signs ability agree on what's coming. Slight signs show up the tide before.

export const EVENTS = {
  storm: {
    name: 'a storm', words: 'A storm is tearing across the sea. Bottles thrown now fly far and wild, and the waves throw up more than usual.',
    signs: ['The gulls have all gone quiet.', 'A long, slow swell is rolling in from nowhere.'],
  },
  spring: {
    name: 'a spring tide', words: 'A spring tide: the water runs higher and faster than any normal day. Bottles thrown now travel much further.',
    signs: ['The moon looked very large last night.', 'The high-water line is creeping up the sand.'],
  },
  shoal: {
    name: 'a great shoal', words: 'A great shoal is passing close to shore. The water is thick with fish.',
    signs: ['Birds are diving far out to sea.', 'There is a silver shimmer under the waves.'],
  },
  wreck: {
    name: 'wreckage', words: 'Wreckage is washing in from some far-off ship: planks, rope, and the odd old bottle.',
    signs: ['There is a smell of tar on the wind.', 'Splinters of painted wood are turning up in the surf.'],
  },
};
const EVENT_KINDS = Object.keys(EVENTS);
const EVENT_CHANCE = 1 / 14;

function tideRand(n, salt) {
  return seeded(Math.imul(n, 2654435761) ^ salt);
}

// The event during tide number n (counting TIDE_MS from the epoch), or null.
export function eventOn(n) {
  const r = tideRand(n, 0x5eaf00d);
  if (r() >= EVENT_CHANCE) return null;
  return EVENT_KINDS[Math.floor(r() * EVENT_KINDS.length)];
}

export function eventAt(t) {
  const n = Math.floor(t / TIDE_MS);
  const kind = eventOn(n);
  return kind ? { kind, start: n * TIDE_MS, end: (n + 1) * TIDE_MS } : null;
}

// Every event in the next `tides` tides after the current one.
export function upcoming(t, tides) {
  const n = Math.floor(t / TIDE_MS);
  const out = [];
  for (let k = n + 1; k <= n + tides; k++) {
    const kind = eventOn(k);
    if (kind) out.push({ kind, start: k * TIDE_MS });
  }
  return out;
}

// The slight sign anyone might notice: during the tide before an event, and not always.
export function signAt(t) {
  const n = Math.floor(t / TIDE_MS);
  const kind = eventOn(n + 1);
  if (!kind) return null;
  const r = tideRand(n, 0x516e);
  if (r() > 0.65) return null;
  const signs = EVENTS[kind].signs;
  return signs[Math.floor(r() * signs.length)];
}

// --- Fishing --------------------------------------------------------------------------------
// A hand line off the rocks, once a tide (twice with Fisher's knots). Dawn, dusk and a rising
// tide are best; a bone hook and the knots help; a shoal fills the water.

export const BONE_HOOK_COST = 5; // bones
export const GLUE_COST = 2; // fish per pot of glue
const CATCHES = [[46, 'fish'], [14, 'big fish'], [16, 'cuttlefish'], [14, 'crab'], [6, 'old bottle'], [4, 'curio']];

export function castsPerTide(abilities = []) {
  return abilities.includes('knots') ? 2 : 1;
}

export function cast({ t, rand, hook = false, abilities = [] }) {
  const c = clock(t);
  const event = eventAt(t)?.kind;
  let chance = 0.45;
  if (c.part === 'dawn' || c.part === 'dusk') chance += 0.2;
  if (!c.ebbing) chance += 0.1;
  if (hook) chance += 0.15;
  if (abilities.includes('knots')) chance += 0.1;
  if (event === 'shoal') chance += 0.35;
  if (event === 'storm') chance -= 0.25;
  if (rand() >= Math.min(0.95, chance)) return null;
  let r = rand() * 100;
  let what = 'fish';
  for (const [w, k] of CATCHES) {
    if ((r -= w) < 0) {
      what = k;
      break;
    }
  }
  return { what, double: event === 'shoal' && (what === 'fish' || what === 'big fish') };
}

// --- Journal pages and abilities ------------------------------------------------------------
// Old bottles hold pages torn from the journals of people who were here long before. A few of
// them teach something; a page you hold can be copied out and sent on with a letter.

export const ABILITIES = {
  hands: { name: 'Reading hands', words: 'You can tell when two letters on your shelf were written by the same hand.' },
  signs: { name: 'Sea signs', words: 'You can read what the sea is about to do, two island days ahead.' },
  currents: { name: 'Reading the current', words: 'You can judge where each of your bottles came to rest.' },
  knots: { name: "Fisher's knots", words: 'Your line holds better: more bites, and two casts a tide.' },
};

// Two old writers, each with their own hand and mark.
export const OLD_HANDS = { keeper: { hand: 913, emblem: 4 }, salt: { hand: 2207, emblem: 11 } };

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

export function page(id) {
  return PAGES.find((p) => p.id === id) ?? null;
}

// An old bottle holds a page you haven't read yet, while there are any.
export function oldPage(rand, read = []) {
  const unread = PAGES.filter((p) => !read.includes(p.id));
  const pool = unread.length ? unread : PAGES;
  return pool[Math.floor(rand() * pool.length)];
}
