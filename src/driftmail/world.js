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
  const jitter = (rand() - 0.5) * 0.7;
  const spread = 0.85 + rand() * 0.3;
  let x = from.x + Math.cos(aim) * reach + Math.cos(cur.angle + jitter) * cur.strength * spread;
  let y = from.y + Math.sin(aim) * reach + Math.sin(cur.angle + jitter) * cur.strength * spread;
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

// What the tide leaves on the sand. Weights out of 100; null is nothing.
const FLOTSAM = [
  [30, null], [15, 'bottles'], [15, 'corks'], [15, 'paper'], [10, 'ink'], [15, 'curio'],
];

export function flotsam(rand) {
  let r = rand() * 100;
  for (const [w, what] of FLOTSAM) {
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
