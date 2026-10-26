// Driftmail on Roblox (roblox/README.md): the Roblox hub's game server plays the ocean for its
// players over POST /api/roblox/world/driftmail. A Roblox player's island is their linked
// account's, or one of their own keyed by Roblox user id.
//
// Roblox requires text shown in a game to come from Roblox users or go through its filter, so the
// view keeps everything players wrote (letters, signatures, excerpts) out of the view itself: it
// sits in `texts`, by keys that never change for the same text, and the Roblox server filters each
// one for the player once and remembers it. Everything else in the view is the game's own words.

// Bump this, and SUPPORTED in roblox/src/shared/games/Driftmail.luau, when a change would break a
// Roblox build already published.
export const BRIDGE_VERSION = 1;

const OPS = ['state', 'open', 'fish', 'craft', 'throw'];
// Everything else goes to Ocean.act as { op, ... }.
const ACTS = ['gather', 'build', 'make', 'plant', 'water', 'harvest', 'seal', 'spear', 'trap', 'traps', 'snag', 'mark', 'burn', 'pass'];
const SHELF = 25;
const SENT = 10;

// The island a Roblox player plays: their account's when linked.
export function robloxIsland(userId, account) {
  return account ?? `roblox:${userId}`;
}

// Runs one Roblox request against the Ocean object and returns the Roblox view.
export async function robloxWorld(ocean, { op, userId, name, account, ...body }) {
  if (!OPS.includes(op) && !ACTS.includes(op)) return { error: 'Bad request.' };
  const key = robloxIsland(userId, account);
  // Everything else needs the island to exist, and visiting first is harmless.
  let result = await ocean.visit(key, account ?? name);
  if (op === 'open') result = await ocean.openBottle(key, body.id);
  else if (op === 'fish') result = await ocean.fish(key, { bait: body.bait === true });
  else if (ACTS.includes(op)) result = await ocean.act(key, { ...body, op });
  else if (op === 'craft') result = await ocean.craft(key, body.what);
  else if (op === 'throw') {
    result = await ocean.throwBottle(key, {
      text: body.text, signed: body.signed, dir: body.dir, strength: body.strength,
      replyTo: body.replyTo ?? null, glue: body.glue, page: body.page ?? null, kind: body.kind ?? 'bottle',
      items: Array.isArray(body.items) ? body.items : [], wax: body.wax, stamp: body.stamp, shimmer: body.shimmer, forge: body.forge ?? null,
    });
  }
  if (result.error) return { bridge: BRIDGE_VERSION, error: result.error };
  return robloxView(result);
}

export function robloxView(s) {
  const texts = {};
  const say = (key, text) => {
    if (text == null || text === '') return null;
    texts[key] = text;
    return key;
  };
  // A writer's name, under a key made from the name, so the same name is filtered once.
  const writer = (name) => (name ? say(`w${hash(name)}`, name) : null);
  // What came with a letter. Drawings are players' pictures, which Roblox can't check, so only
  // the website shows them.
  const items = (list) => list.map((it) => (it.kind === 'drawing' ? { kind: 'drawing' }
    : it.kind === 'map' ? { kind: 'map', places: it.places.map((p) => ({ name: writer(p.name), shore: p.shore })) } : it));
  const shelf = s.shelf.slice(0, SHELF).map((l) => ({
    id: l.id,
    // The old journals are the game's own words; letters are players'.
    text: l.old ? null : say(`l${l.id}`, l.text),
    body: l.old ? l.text : null,
    name: l.old ? null : say(`n${l.id}`, l.name),
    replyTo: say(`r${l.id}`, l.replyTo),
    title: l.title, page: l.page, own: l.own, old: l.old, marked: l.marked, hand: l.hand, emblem: l.emblem,
    shore: l.shore, part: l.part, tide: l.tide, landed: l.landed, handOf: l.handOf ?? null,
    kind: l.kind, items: items(l.items ?? []), sealed: l.sealed, stamp: l.stamp, shimmer: l.shimmer, stained: l.stained, broken: l.broken,
    blurred: l.blurred, strange: l.strange, mark: l.mark, player: l.player, forged: l.forged ?? false, canForge: l.canForge ?? false,
    added: l.added ? { text: say(`a${l.id}`, l.added.text), hand: l.added.hand } : null,
  }));
  const sent = s.sent.slice(0, SENT).map((b) => ({
    text: say(`s${b.id}`, b.text), thrown: b.thrown, ashore: b.ashore, page: b.page, rest: b.rest ?? null, kind: b.kind,
  }));
  return {
    bridge: BRIDGE_VERSION,
    now: s.now,
    clock: s.clock,
    event: s.event,
    sign: s.sign,
    forecast: s.forecast,
    supplies: s.island.supplies,
    curios: s.island.curios,
    hand: s.island.hand,
    kit: s.kit,
    abilities: s.abilities,
    journal: s.journal,
    beach: s.beach,
    shelf,
    shelfCount: s.shelf.length,
    sent,
    found: s.found ?? [],
    opened: s.opened ?? null,
    learned: s.learned ?? null,
    caught: s.caught ?? null,
    welcome: s.welcome ?? false,
    got: s.got ?? [],
    lostRing: s.lostRing ?? false,
    done: s.gathered ?? s.built ?? s.made ?? s.planted ?? s.harvested ?? s.watered ?? null,
    materials: s.materials,
    seeds: s.seeds,
    garden: s.garden,
    crops: Object.fromEntries(Object.entries(s.crops).map(([k, c]) => [k, { name: c.name, seed: c.seed, words: c.words }])),
    blueprints: s.blueprints,
    recipes: s.recipes,
    containers: s.containers,
    builds: s.builds,
    seal: s.seal,
    stamp: s.stamp,
    stamps: s.stamps,
    clues: s.clues,
    marks: s.marks,
    pals: s.pals.map(writer),
    chart: s.chart.map((c) => ({ name: writer(c.name), shore: c.shore, letters: c.letters })),
    neighbours: s.neighbours,
    room: s.room,
    held: s.held,
    texts,
  };
}

function hash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
