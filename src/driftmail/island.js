// Island life in Driftmail: what washes up and grows, what you can build from it, and how the
// island makes better bottles. Pure rules and tables, shared by the Ocean object (ocean.js) and
// the tests. Everything here feeds back into writing: the garden grows ink, paper and corks, the
// buildings fire bottles, press ink and hold your letters.

import { TIDE_MS } from './world.js';

export const MATERIALS = ['driftwood', 'rope', 'clay', 'sand', 'stones', 'leaves', 'reeds', 'berries', 'bark', 'wax', 'oil', 'scales'];
export const MATERIAL_NAMES = {
  driftwood: 'Driftwood', rope: 'Rope', clay: 'Clay', sand: 'Sand', stones: 'Stones', leaves: 'Palm leaves', reeds: 'Reeds',
  berries: 'Berries', bark: 'Bark', wax: 'Wax', oil: 'Fish oil', scales: 'Fish scales',
};
// How each one reads when the tide leaves it.
export const MATERIAL_FOUND = {
  driftwood: 'a length of driftwood', rope: 'a coil of rope', clay: 'a lump of clay', sand: 'a pile of fine sand',
  stones: 'some flat stones', leaves: 'a heap of palm leaves', reeds: 'a bundle of reeds',
};

// --- The garden -----------------------------------------------------------------------------
// Two wild plots by the stream from the start; garden beds make it four, keep the soil damp a
// tide longer and add one to every harvest. A crop grows one step for every tide it has been watered within the last two
// tides, so it pauses (never withers) while you're away. Harvesting gives its yield and one seed
// back. The first seeds come in your starter crate; the rest come from strangers' bottles.

export const PLOTS = 4;
export const WILD_PLOTS = 2;
export const CROPS = {
  berries: { name: 'Berry bush', seed: 'berry seeds', tides: 3, yields: { berries: 3 }, words: 'Berries press into ink, and make good bait.' },
  reeds: { name: 'Reeds', seed: 'reed shoots', tides: 2, yields: { reeds: 3 }, words: 'Reeds dry into paper on a drying rack.' },
  oak: { name: 'Cork oak', seed: 'an acorn', tides: 6, yields: { bark: 3 }, words: 'Bark cuts into corks.' },
  flowers: { name: 'Bee flowers', seed: 'flower seeds', tides: 4, yields: { wax: 2 }, words: 'The bees that visit leave wax for seals.' },
};
export const CROP_KINDS = Object.keys(CROPS);
const DRY_AFTER = 2; // tides without water before a crop stops growing
const BEDS_DRY_AFTER = 3;

// What garden beds change: how many plots there are, how long they stay damp, and the bonus yield.
export function gardenOf(builds = {}) {
  return builds.garden ? { plots: PLOTS, dryAfter: BEDS_DRY_AFTER, bonus: 1 } : { plots: WILD_PLOTS, dryAfter: DRY_AFTER, bonus: 0 };
}

export function tideOf(t) {
  return Math.floor(t / TIDE_MS);
}

// Brings a plot up to the tide `now`: one step of growth for each watered tide.
export function grow(plot, now, dryAfter = DRY_AFTER) {
  if (!plot?.crop) return plot;
  const tide = tideOf(now);
  for (let n = plot.lastTide + 1; n <= tide; n++) {
    if (n - plot.watered <= dryAfter && plot.growth < CROPS[plot.crop].tides) plot.growth++;
  }
  plot.lastTide = Math.max(plot.lastTide, tide);
  return plot;
}

export function plant(crop, now) {
  const tide = tideOf(now);
  return { crop, growth: 0, lastTide: tide, watered: tide };
}

export function ripe(plot) {
  return Boolean(plot?.crop) && plot.growth >= CROPS[plot.crop].tides;
}

// A plot as the page shows it.
export function plotView(plot, now, dryAfter = DRY_AFTER) {
  if (!plot?.crop) return { crop: null };
  const c = CROPS[plot.crop];
  return {
    crop: plot.crop, name: c.name, growth: plot.growth, needs: c.tides, ripe: ripe(plot),
    dry: tideOf(now) - plot.watered > dryAfter, watered: plot.watered === tideOf(now),
  };
}

// --- Buildings ------------------------------------------------------------------------------
// Fixed blueprints, not free building. The shack goes up in three stages; storage adds room for
// letters; the rest each unlock something. Costs are paid in materials (and supplies, for bottles).

export const BUILDINGS = {
  shack: {
    name: 'Shack', stages: [
      { name: 'frame', cost: { driftwood: 4 } },
      { name: 'walls', cost: { driftwood: 4, leaves: 3 } },
      { name: 'roof', cost: { leaves: 6, rope: 2 } },
    ],
    words: 'Somewhere dry to keep your letters: room for 300 once the roof is on.',
  },
  garden: {
    name: 'Garden beds', cost: { driftwood: 2, stones: 3 },
    words: 'Raised beds by the stream: four plots instead of two, soil that stays damp a tide longer, and one more of everything you pick.',
  },
  workshop: {
    name: 'Workshop', cost: { driftwood: 4, rope: 2 },
    words: 'A work table out of the wind: carve hooks, spears and traps, cut corks, boil glue and oil, and double-cork bottles.',
  },
  desk: {
    name: 'Writing desk', cost: { driftwood: 3, leaves: 1 }, needs: 'shack',
    words: 'Somewhere to copy out journal pages, draw pictures and keep a chart of who writes to you.',
  },
  shelves: { name: 'Shelves', cost: { driftwood: 3 }, needs: 'shack', room: 200, words: 'Room for 200 more letters.' },
  chest: { name: 'Sea chest', cost: { driftwood: 4, rope: 2 }, needs: 'shack', room: 200, words: 'Room for 200 more letters.' },
  backroom: { name: 'Back room', cost: { driftwood: 8, stones: 4 }, needs: 'shack', room: 400, words: 'Room for 400 more letters.' },
  cave: { name: 'Dry cave', cost: { stones: 10, rope: 3 }, needs: 'shack', room: 800, words: 'Room for 800 more letters, behind the waterfall.' },
  kiln: { name: 'Bottle kiln', cost: { clay: 4, stones: 4, sand: 2 }, words: 'Fire your own bottles from clay and sand.' },
  rack: { name: 'Drying rack', cost: { reeds: 2, rope: 2 }, words: 'Dry reeds into paper.' },
  press: { name: 'Ink press', cost: { stones: 3, driftwood: 2 }, words: 'Press berries into ink, and fish scales into shimmering ink.' },
  bench: { name: 'Seal bench', cost: { driftwood: 3, stones: 2 }, words: 'Design your own wax seal.' },
  lookout: { name: 'Lookout', cost: { driftwood: 6, rope: 2 }, words: 'From up here you can see roughly which way your bottles went.' },
  lighthouse: {
    name: 'Lighthouse', cost: { stones: 20, driftwood: 10, oil: 5 }, words: 'Draws bottles drifting near your island to your beach.',
  },
  dock: { name: 'Dock', cost: { driftwood: 10, rope: 4, stones: 4 }, words: 'Launch boxes and barrels, which you can\'t throw.' },
  beacon: {
    name: 'Beacon', cost: { driftwood: 3, oil: 1 }, words: 'Tells the sea you welcome new neighbours: new castaways wash up near you.',
  },
};
export const BUILD_KINDS = Object.keys(BUILDINGS);

// Letters you can keep before you build anywhere to keep them.
export const BASE_ROOM = 40;
export const SHACK_ROOM = 300;

export function shelfRoom(builds = {}) {
  let room = builds.shack >= 3 ? SHACK_ROOM : BASE_ROOM;
  for (const k of BUILD_KINDS) if (BUILDINGS[k].room && builds[k]) room += BUILDINGS[k].room;
  return room;
}

// What building `kind` costs next, or an error. The shack's stages go one at a time.
export function nextBuild(kind, builds = {}) {
  const b = BUILDINGS[kind];
  if (!b) return { error: 'There is no blueprint for that.' };
  if (b.stages) {
    const stage = builds[kind] ?? 0;
    if (stage >= b.stages.length) return { error: `Your ${b.name.toLowerCase()} is finished.` };
    return { cost: b.stages[stage].cost, name: `${b.name} ${b.stages[stage].name}` };
  }
  if (builds[kind]) return { error: `You already have a ${b.name.toLowerCase()}.` };
  if (b.needs && !(builds[b.needs] >= (BUILDINGS[b.needs].stages?.length ?? 1))) {
    return { error: `Finish your ${BUILDINGS[b.needs].name.toLowerCase()} first.` };
  }
  return { cost: b.cost, name: b.name };
}

export function has(stock, cost) {
  return Object.entries(cost).every(([k, n]) => (stock[k] ?? 0) >= n);
}

export function pay(stock, cost) {
  for (const [k, n] of Object.entries(cost)) stock[k] = (stock[k] ?? 0) - n;
}

export function costWords(cost) {
  return Object.entries(cost).map(([k, n]) => `${n} ${(MATERIAL_NAMES[k] ?? k).toLowerCase()}`).join(', ');
}

// --- Making things --------------------------------------------------------------------------
// Each recipe takes materials (and sometimes supplies or catch) and gives something. `needs` is a
// building, `ability` an ability. Supplies (bottles, corks, paper, ink) and the catch (fish,
// bones) are counted together with materials here.

export const RECIPES = {
  bottle: { name: 'Fire a bottle', needs: 'kiln', cost: { clay: 1, sand: 2, driftwood: 1 }, gives: { bottles: 1 } },
  jar: { name: 'Fire a jar', needs: 'kiln', ability: 'kiln', cost: { clay: 2, driftwood: 1 }, gives: { jars: 1 } },
  paper: { name: 'Dry paper', needs: 'rack', cost: { reeds: 2 }, gives: { paper: 1 } },
  ink: { name: 'Press ink', needs: 'press', cost: { berries: 2 }, gives: { ink: 1 } },
  shimmer: { name: 'Press shimmering ink', needs: 'press', cost: { berries: 1, scales: 2 }, gives: { shimmer: 1 } },
  cork: { needs: 'workshop', name: 'Cut corks', cost: { bark: 1 }, gives: { corks: 2 } },
  hook: { needs: 'workshop', name: 'Carve a bone hook', cost: { bones: 5 }, once: 'hook' },
  glue: { needs: 'workshop', name: 'Boil down fish glue', cost: { fish: 2 }, gives: { glue: 1 } },
  oil: { needs: 'workshop', name: 'Render fish oil', cost: { fish: 2 }, gives: { oil: 1 } },
  spear: { needs: 'workshop', name: 'Make a spear', cost: { driftwood: 1, bones: 2 }, once: 'spear' },
  trap: { needs: 'workshop', name: 'Weave a trap', cost: { driftwood: 2, rope: 1 }, gives: { traps: 1 } },
  stamp: { name: 'Carve a stamp', needs: 'bench', ability: 'carving', cost: { driftwood: 1, bones: 1 }, once: 'stamp' },
};

// --- Containers and bottles that travel differently ------------------------------------------
// A bottle carries one letter and one thing. Bigger containers carry more but cost more and
// need a kiln or a dock. Special bottles change how far and how a bottle travels.

export const CONTAINERS = {
  bottle: { name: 'Bottle', items: 1, cost: { bottles: 1, corks: 1 } },
  double: { name: 'Double-corked bottle', items: 1, needs: 'workshop', cost: { bottles: 1, corks: 2, wax: 1 }, words: 'Keeps the water out on a long drift, and rides the outer currents.' },
  weighted: { name: 'Weighted bottle', items: 1, ability: 'deep', needs: 'workshop', cost: { bottles: 1, corks: 1, stones: 2 }, words: 'Sinks into the deep current and surfaces far away, much later.' },
  sailed: { name: 'Sailed float', items: 1, ability: 'deep', needs: 'workshop', cost: { bottles: 1, corks: 1, driftwood: 1, rope: 1 }, words: 'Follows the wind instead of the current.' },
  jar: { name: 'Jar', items: 3, cost: { jars: 1, wax: 1 }, words: 'A few things at once; shorter and slower than a bottle.' },
  box: { name: 'Box', items: 8, needs: 'dock', cost: { driftwood: 4, rope: 2, glue: 1 }, words: 'Pushed off the dock on the tide: slow, close to the surface, and it can break in a storm.' },
  barrel: { name: 'Barrel', items: 20, needs: 'dock', cost: { driftwood: 8, rope: 2, glue: 1 }, words: 'Launched from the dock onto the outer currents. Travels far; storms can break it open.' },
};
// Glue can stand in for the cork of an ordinary bottle.
export const GLUE_FOR_CORK = true;

// What you can put in with a letter: a curio, seeds, a copied journal page, a drawing, a map,
// or (in a box or barrel) a bundle of materials.
export const ITEM_KINDS = ['curio', 'seeds', 'page', 'drawing', 'map', 'materials'];

// --- Seals and stamps -----------------------------------------------------------------------
// Every castaway starts with a mark chosen by the sea. At a seal bench you can design your own
// crest: a glyph and a wax colour, from the same set the page draws.
export const SEAL_GLYPHS = 16;
export const SEAL_WAX = 7;
export const STAMP_PATTERNS = ['waves', 'a gull', 'a fish', 'a star', 'a shell', 'a key', 'an anchor', 'a wheel', 'a moon', 'a spiral'];

// A seal ring can slip off with a bottle thrown in a storm.
export const RING_LOSS_IN_STORM = 0.1;

// --- Water damage ---------------------------------------------------------------------------
// Long drifts let water in: some letters blur to dots. Double-corked bottles keep it out, a red
// tide stains the paper, and Ink restoration reads through it.

export function blurAmount({ drifted, kind, stained }) {
  if (kind === 'double') return stained ? 0.15 : 0;
  const hours = drifted / (60 * 60 * 1000);
  let amount = hours > 3 ? Math.min(0.35, (hours - 3) * 0.05) : 0;
  if (stained) amount += 0.25;
  return Math.min(0.5, amount);
}

// The text with about `amount` of its words worn away, the same way every time for the same seed.
export function blur(text, amount, seed) {
  if (!amount) return text;
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return text.replace(/[^\s]+/g, (word) => (rand() < amount ? word.replace(/[^\s.,!?'"-]/g, '·') : word));
}

// --- Pen pals -------------------------------------------------------------------------------
// Two islands that have each found three or more of the other's letters have a steady current
// between them: replies bend home from further off and land closer.
export const PEN_PAL_LETTERS = 3;

// --- Reputation -----------------------------------------------------------------------------
// A finder can mark a letter kind, useful or rude. Rude marks make a writer's bottles more likely
// to sink on the way; kind and useful ones are passed back to the writer as a quiet note.
export const MARKS = ['kind', 'useful', 'rude'];

export function sinkChance({ rude = 0, kind = 0, useful = 0 }) {
  return Math.min(0.5, rude / (rude + kind + useful + 3));
}
