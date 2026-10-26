import { DurableObject } from 'cloudflare:workers';
import {
  ABILITIES, ACTIVE_MS, DIRECTIONS, EVENTS, MAX_LETTER, MAX_TRAPS, OLD_HANDS, PAGES, REDRIFT_MS, STARTER_SUPPLIES,
  SUPPLIES, TIDE_MS, canSpear, cast, castsPerTide, clock, curio, directionTo, drift, eventAt, eventOn, finder, flotsam,
  oldPage, page, pagesFor, placeIsland, shore, signAt, spear, strangeCurio, tideWords, trapCatch, uniqueCurio, upcoming,
} from './world.js';
import {
  BUILDINGS, BUILD_KINDS, CONTAINERS, CROPS, CROP_KINDS, MARKS, MATERIALS, MATERIAL_FOUND, PEN_PAL_LETTERS, PLOTS,
  RECIPES, RING_LOSS_IN_STORM, SEAL_GLYPHS, SEAL_WAX, STAMP_PATTERNS, blur, blurAmount, costWords, grow, nextBuild,
  plant, plotView, ripe, shelfRoom, sinkChance, tideOf,
} from './island.js';
import { clue, clueText, echo, futureLetter, islandDay, knowingLetter, matchesClue } from './mysteries.js';
import { CASTAWAYS, writeReply } from './castaways.js';

// A castaway answers a letter a little while after it washes up.
const REPLY_DELAY_MS = [15 * 60 * 1000, 45 * 60 * 1000];
const REPLIES_PER_ALARM = 3;
const CASTAWAY_STOCK_MAX = 10;
const NEED = 'You need a bottle, a cork (or a pot of fish glue), a sheet of paper and some ink to send a letter.';
// Sea signs see two island days (four tides) ahead.
const FORECAST_TIDES = 4;
const OLD_SENDER = 'sea:old';
// Letters nobody wrote: strange ones that know you, ones from the future, clues and echoes.
const STRANGE_SENDER = 'sea:strange';
// Where bottles go that never wash up anywhere: sunk, or swallowed by the hidden current.
const DEEP = 'sea:deep';
// The tide leaves this many things to look through, every tide, for up to two tides back.
const FLOTSAM_ROLLS = 3;
// Away this long, and the sea has saved a few extra things for you.
const WELCOME_BACK_MS = 12 * 60 * 60 * 1000;
const WELCOME_ROLLS = 4;
// What a castaway can gather inland once a tide, two at a time.
const GATHER = ['leaves', 'clay', 'sand', 'stones'];
const GATHER_AMOUNT = 2;
const MAX_LINE = 140;
const CLUE_TIDES = 12;
const NEIGHBOUR_RANGE = 25;
const STARTER_SEEDS = { berries: 2, reeds: 2, oak: 1, flowers: 1 };

// One Durable Object (named "ocean") holds the whole Driftmail ocean: every island and every
// bottle, in SQLite. Players reach it over RPC from the router as their account; it wakes on an
// alarm whenever a bottle is due to come to rest or a Claude castaway owes a reply.
export class Ocean extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.now = () => Date.now();
    this.rand = Math.random;
    this.write = (castaway, letter) => writeReply(env, castaway, letter);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS islands (
        key TEXT PRIMARY KEY, name TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL,
        created INTEGER NOT NULL, seen INTEGER NOT NULL, hand INTEGER NOT NULL, emblem INTEGER NOT NULL,
        supplies TEXT NOT NULL, curios TEXT NOT NULL, tides INTEGER NOT NULL, castaway INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS bottles (
        id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, sender_name TEXT, text TEXT NOT NULL,
        hand INTEGER NOT NULL, emblem INTEGER NOT NULL, marked INTEGER NOT NULL DEFAULT 0, reply_to INTEGER,
        from_x REAL NOT NULL, from_y REAL NOT NULL, to_x REAL NOT NULL, to_y REAL NOT NULL,
        thrown INTEGER NOT NULL, rest INTEGER NOT NULL, arrives INTEGER NOT NULL,
        finder TEXT, landed INTEGER, shore TEXT, part TEXT, tide TEXT, opened INTEGER,
        reply_due INTEGER, replied INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS drifting ON bottles (arrives) WHERE finder IS NULL;
      CREATE INDEX IF NOT EXISTS found ON bottles (finder, opened);
      CREATE INDEX IF NOT EXISTS sent ON bottles (sender, thrown);
    `);
    // Columns added as the game grew: fishing and journal pages first, then island life (the
    // island's lighthouse and beacon), and what a bottle can be and carry.
    const added = [
      ['islands', 'kit', "TEXT NOT NULL DEFAULT '{}'"],
      ['islands', 'lighthouse', 'INTEGER NOT NULL DEFAULT 0'],
      ['islands', 'beacon', 'INTEGER NOT NULL DEFAULT 0'],
      ['bottles', 'page', 'TEXT'],
      ['bottles', 'old', 'INTEGER NOT NULL DEFAULT 0'],
      ['bottles', 'kind', "TEXT NOT NULL DEFAULT 'bottle'"],
      ['bottles', 'items', "TEXT NOT NULL DEFAULT '[]'"],
      ['bottles', 'blur', 'REAL NOT NULL DEFAULT 0'],
      ['bottles', 'stained', 'INTEGER NOT NULL DEFAULT 0'],
      ['bottles', 'sealed', 'INTEGER NOT NULL DEFAULT 0'],
      ['bottles', 'stamp', 'INTEGER'],
      ['bottles', 'forged', 'INTEGER NOT NULL DEFAULT 0'],
      ['bottles', 'shimmer', 'INTEGER NOT NULL DEFAULT 0'],
      ['bottles', 'mark', 'TEXT'],
      ['bottles', 'added', 'TEXT'],
      ['bottles', 'added_hand', 'INTEGER'],
      ['bottles', 'gone', 'INTEGER NOT NULL DEFAULT 0'],
      ['bottles', 'fog', 'INTEGER NOT NULL DEFAULT 0'],
      ['bottles', 'hidden', 'INTEGER NOT NULL DEFAULT 0'],
      ['bottles', 'broken', 'INTEGER NOT NULL DEFAULT 0'],
      ['bottles', 'strange', 'TEXT'],
    ];
    for (const [table, col, type] of added) {
      const has = this.sql.exec(`PRAGMA table_info(${table})`).toArray().some((c) => c.name === col);
      if (!has) this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    }
  }

  // A player looks at their island: it's made on the first visit, then the tides that passed
  // since the last one leave flotsam (at most two tides' worth, so time away never piles up a
  // fortune, though a long absence earns a small welcome back).
  // `name` is what signed letters say, when it isn't the account name (a Roblox player's own
  // island is keyed by user id but signed with their Roblox name).
  async visit(account, name = account) {
    const now = this.now();
    await this.settle(now);
    const island = this.island(account) ?? this.newIsland(account, now, name);
    const tideNow = tideOf(now);
    const found = [];
    for (let n = Math.max(island.tides + 1, tideNow - 1); n <= tideNow; n++) {
      for (let r = 0; r < FLOTSAM_ROLLS; r++) this.washUp(island, flotsam(this.rand, eventOn(n)), now, found);
    }
    let welcome = false;
    if (now - island.seen >= WELCOME_BACK_MS) {
      welcome = true;
      for (let r = 0; r < WELCOME_ROLLS; r++) this.washUp(island, flotsam(this.rand, 'wreck'), now, found);
    }
    island.tides = tideNow;
    island.seen = now;
    this.saveIsland(island);
    return { ...this.state(island, now), found, welcome };
  }

  // Something the tide left on the beach: a supply, a material, seeds, a curio, an old bottle,
  // or something strange.
  washUp(island, what, now, found) {
    if (!what) return;
    if (what === 'old bottle') {
      const comet = eventAt(now)?.kind === 'comet';
      this.oldBottle(island, now, { comet });
      found.push(comet ? 'an old bottle, glowing faintly under the comet' : 'an old bottle, crusted with barnacles');
    } else if (what === 'curio') {
      const name = curio(this.rand);
      island.curios.push({ name });
      found.push(name);
    } else if (what === 'seeds') {
      const crop = CROP_KINDS[Math.floor(this.rand() * CROP_KINDS.length)];
      island.kit.seeds[crop]++;
      found.push(`${CROPS[crop].seed}, wrapped in a leaf`);
    } else if (what === 'strange') {
      found.push(this.strange(island, now));
    } else if (SUPPLIES.includes(what)) {
      island.supplies[what]++;
      found.push(SUPPLY_FOUND[what]);
    } else {
      island.kit.materials[what] = (island.kit.materials[what] ?? 0) + 1;
      found.push(MATERIAL_FOUND[what] ?? what);
    }
  }

  // The sea's own strangeness: a curio from nowhere, or a bottle nobody threw.
  strange(island, now) {
    const r = this.rand();
    if (r < 0.3) {
      const name = strangeCurio(this.rand);
      island.curios.push({ name, strange: true });
      return name;
    }
    const recent = this.sql.exec(
      `SELECT text FROM bottles WHERE sender = ? AND hidden = 0 ORDER BY thrown DESC LIMIT 5`, island.key,
    ).toArray();
    let text;
    let kind;
    const coming = upcoming(now, 8)[0];
    if (r < 0.45 && coming) {
      kind = 'future';
      text = futureLetter(this.rand, coming, islandDay(coming.start - island.created, TIDE_MS * 2) + 1);
    } else if (r < 0.65) {
      kind = 'clue';
      const c = clue(this.rand);
      island.kit.clues = [...island.kit.clues.filter((k) => k.until > now), { ...c, until: now + CLUE_TIDES * TIDE_MS }].slice(-3);
      text = clueText(c);
    } else if (r < 0.82 && recent.length) {
      kind = 'echo';
      text = echo(this.rand, recent[Math.floor(this.rand() * recent.length)].text);
    } else {
      kind = 'knowing';
      text = knowingLetter(this.rand, island.name, recent[0]?.text ?? null);
    }
    // An echo comes back in your own hand; the rest in a hand nobody has.
    const hand = kind === 'echo' ? island.hand : 4441;
    this.beached(island, now, { sender: STRANGE_SENDER, text, hand, emblem: 0, strange: kind });
    return 'a bottle with no seal, very cold to the touch';
  }

  // A bottle put straight onto an island's beach (old bottles, strange ones, snagged ones).
  beached(island, now, { sender, text, hand, emblem, pageId = null, old = 0, strange = null }) {
    const c = clock(now);
    const shores = ['north', 'east', 'south', 'west'];
    this.sql.exec(
      `INSERT INTO bottles (sender, text, hand, emblem, from_x, from_y, to_x, to_y, thrown, rest, arrives, finder, landed, shore, part, tide, page, old, strange)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sender, text, hand, emblem, island.x, island.y, now, now, now, island.key, now,
      shores[Math.floor(this.rand() * 4)], c.part, tideWords(c), pageId, old, strange,
    );
  }

  // Every player action except visiting and throwing, as { op, ... }.
  async act(account, body = {}) {
    const now = this.now();
    const island = this.island(account);
    if (!island) return { error: 'Visit your island first.' };
    const op = ACTIONS[body.op];
    if (!op) return { error: 'You can\'t do that here.' };
    const result = await op.call(this, island, body, now);
    if (result?.error) return result;
    this.saveIsland(island);
    return { ...this.state(island, now), ...result };
  }

  async throwBottle(account, body = {}) {
    const now = this.now();
    const island = this.island(account);
    if (!island) return { error: 'Visit your island first.' };
    const { text, signed, dir, strength, replyTo, glue, page: pageId, kind = 'bottle', items = [], wax, stamp, forge, shimmer } = body;
    const letter = typeof text === 'string' ? text.trim() : '';
    if (!letter) return { error: 'Write something first.' };
    if (letter.length > MAX_LETTER) return { error: `Letters can be at most ${MAX_LETTER} characters.` };
    if (!Number.isInteger(dir) || dir < 0 || dir >= DIRECTIONS.length) return { error: 'Pick a direction to throw.' };
    const s = Number(strength);
    if (!Number.isFinite(s)) return { error: 'Pick how hard to throw.' };
    const kit = island.kit;
    const container = CONTAINERS[kind];
    if (!container) return { error: 'You can\'t send a letter in that.' };
    if (container.ability && !kit.abilities.includes(container.ability)) return { error: `You don't know how to make a ${container.name.toLowerCase()}.` };
    if (container.needs && !kit.builds[container.needs]) return { error: `A ${container.name.toLowerCase()} is launched from a ${BUILDINGS[container.needs].name.toLowerCase()}.` };

    const cost = { ...container.cost };
    const useGlue = Boolean(glue) && kind === 'bottle';
    if (useGlue) {
      delete cost.corks;
      cost.glue = 1;
    }
    const add = (k, n = 1) => {
      cost[k] = (cost[k] ?? 0) + n;
    };
    add('paper');
    add(shimmer ? 'shimmer' : 'ink');
    let enclosed = null;
    if (pageId != null && pageId !== '') {
      if (!kit.pages.includes(pageId) || !page(pageId)) return { error: 'That page is not in your journal.' };
      enclosed = pageId;
      // Copying a page out takes another sheet and more ink.
      add('paper');
      add('ink');
    }
    const parsed = this.items(island, items, cost, container);
    if (parsed.error) return parsed;
    if ((enclosed ? 1 : 0) + parsed.items.length > container.items) {
      return { error: `A ${container.name.toLowerCase()} holds a letter and ${container.items === 1 ? 'one thing' : `up to ${container.items} things`}.` };
    }
    if (wax) {
      if (!kit.ring) return { error: 'You need a seal ring to seal with wax. Design one at a seal bench.' };
      add('wax');
    }
    if (stamp && kit.stamp == null) return { error: 'You have no stamp.' };
    let hand = island.hand;
    if (forge != null) {
      if (!kit.abilities.includes('forgery')) return { error: 'You don\'t know how to copy a hand.' };
      const target = this.sql.exec('SELECT hand FROM bottles WHERE id = ? AND finder = ? AND opened IS NOT NULL', Number(forge), island.key).toArray()[0];
      if (!target || !(this.handsOnShelf(island).get(target.hand) >= 3)) return { error: 'You need three letters in a hand before you can copy it.' };
      hand = target.hand;
    }
    if (!stockHas(island, cost)) {
      if (SUPPLIES.some((k) => (cost[k] ?? 0) > island.supplies[k])) {
        return { error: enclosed ? 'Copying out a page takes another sheet of paper and more ink.' : NEED };
      }
      return { error: `That takes ${costWords(cost)}.` };
    }

    let toward = null;
    let answers = null;
    let steady = false;
    if (replyTo != null) {
      const original = this.sql.exec('SELECT id, sender, from_x, from_y FROM bottles WHERE id = ? AND finder = ? AND opened IS NOT NULL', Number(replyTo), island.key).toArray()[0];
      if (!original) return { error: 'That letter is not on your shelf.' };
      toward = { x: original.from_x, y: original.from_y };
      answers = original.id;
      steady = this.penPals(island.key, original.sender);
    }
    stockPay(island, cost);
    for (const it of parsed.items) if (it.kind === 'curio') island.curios.splice(island.curios.findIndex((c) => c.name === it.name), 1);
    // A seal ring can slip off a wet hand in a storm, and go out with the bottle.
    const storm = eventAt(now)?.kind === 'storm';
    let lostRing = false;
    if (storm && kit.ring && this.rand() < RING_LOSS_IN_STORM) {
      kit.ring = false;
      lostRing = true;
      parsed.items.push({ kind: 'curio', name: 'a seal ring, lost off someone\'s finger in a storm', emblem: island.emblem });
    }
    // Throwing the way a clue says, at its hour and on its tide, finds the hidden current.
    const clueIndex = kit.clues.findIndex((c) => c.until > now && matchesClue(c, { dir, t: now }));
    const hidden = clueIndex >= 0;
    if (hidden) kit.clues.splice(clueIndex, 1);
    this.saveIsland(island);
    const event = eventAt(now)?.kind;
    this.launch(island, {
      text: letter, signed: Boolean(signed) && forge == null, dir, strength: Math.min(1, Math.max(0.1, s)), toward, answers, page: enclosed, now,
      kind, items: parsed.items, hand, forged: forge != null, sealed: Boolean(wax), stamp: stamp ? kit.stamp : null, shimmer: Boolean(shimmer),
      steady, stained: event === 'redtide', fog: event === 'fog' && this.rand() < 0.5, hidden,
    });
    await this.schedule();
    return { ...this.state(island, now), lostRing };
  }

  // What a player put in with their letter, checked against what they have, with the cost added.
  items(island, list, cost, container) {
    if (!Array.isArray(list)) return { error: 'Bad items.' };
    const out = [];
    const curios = [...island.curios];
    for (const it of list) {
      if (it?.kind === 'curio') {
        const i = Number.isInteger(it.index) ? it.index : -1;
        const c = curios[i];
        if (!c) return { error: 'That curio is not on your shelf.' };
        curios[i] = null;
        out.push({ kind: 'curio', name: c.name, ...(c.unique ? { unique: true } : {}), ...(c.strange ? { strange: true } : {}) });
      } else if (it?.kind === 'seeds') {
        if (!CROPS[it.crop]) return { error: 'There are no such seeds.' };
        cost[`seed:${it.crop}`] = (cost[`seed:${it.crop}`] ?? 0) + 1;
        out.push({ kind: 'seeds', crop: it.crop });
      } else if (it?.kind === 'drawing') {
        if (typeof it.data !== 'string' || !/^[0-9a-f]{96}$/.test(it.data)) return { error: 'That drawing is smudged beyond saving.' };
        cost.paper = (cost.paper ?? 0) + 1;
        out.push({ kind: 'drawing', data: it.data });
      } else if (it?.kind === 'map') {
        cost.paper = (cost.paper ?? 0) + 1;
        cost.ink = (cost.ink ?? 0) + 1;
        out.push({ kind: 'map', places: this.chart(island).slice(0, 8).map(({ name, shore: s }) => ({ name, shore: s })) });
      } else if (it?.kind === 'materials') {
        if (container.items < 8) return { error: 'Bundles of materials go in a box or a barrel.' };
        const what = {};
        for (const [k, n] of Object.entries(it.what ?? {})) {
          if (!MATERIALS.includes(k) || !Number.isInteger(n) || n < 1 || n > 50) return { error: 'Bad bundle.' };
          what[k] = n;
          cost[k] = (cost[k] ?? 0) + n;
        }
        if (!Object.keys(what).length) return { error: 'The bundle is empty.' };
        out.push({ kind: 'materials', what });
      } else {
        return { error: 'You can\'t put that in a bottle.' };
      }
    }
    return { items: out };
  }

  async openBottle(account, id) {
    const now = this.now();
    const island = this.island(account);
    if (!island) return { error: 'Visit your island first.' };
    const row = this.sql.exec('SELECT id, page, items, kind, broken FROM bottles WHERE id = ? AND finder = ? AND opened IS NULL', Number(id), island.key).toArray()[0];
    if (!row) return { error: 'That bottle is not on your beach.' };
    const held = this.sql.exec('SELECT COUNT(*) AS n FROM bottles WHERE finder = ? AND opened IS NOT NULL AND gone = 0', island.key).toArray()[0].n;
    if (held >= shelfRoom(island.kit.builds)) {
      return { error: 'There is no room left for another letter. Build somewhere to keep them, or burn or throw on a letter you have.' };
    }
    this.sql.exec('UPDATE bottles SET opened = ? WHERE id = ?', now, row.id);
    // Every bottle you open leaves you its glass and cork, so answering costs less than writing first.
    if (row.kind === 'bottle' || row.kind === 'double' || row.kind === 'weighted' || row.kind === 'sailed') {
      island.supplies.bottles++;
      island.supplies.corks++;
    } else if (row.kind === 'jar') {
      island.kit.materials.jars = (island.kit.materials.jars ?? 0) + 1;
    } else if (!row.broken) {
      island.kit.materials.driftwood = (island.kit.materials.driftwood ?? 0) + (row.kind === 'barrel' ? 4 : 2);
    }
    const learned = this.learn(island, row.page);
    const got = [];
    for (const it of JSON.parse(row.items)) {
      if (it.kind === 'curio') {
        island.curios.push({ name: it.name, ...(it.strange ? { strange: true } : {}) });
        got.push(it.name);
      } else if (it.kind === 'seeds') {
        island.kit.seeds[it.crop]++;
        got.push(CROPS[it.crop].seed);
      } else if (it.kind === 'materials') {
        for (const [k, n] of Object.entries(it.what)) island.kit.materials[k] = (island.kit.materials[k] ?? 0) + n;
        got.push(costWords(it.what));
      } else if (it.kind === 'page') {
        this.learn(island, it.id);
      }
    }
    this.saveIsland(island);
    return { ...this.state(island, now), opened: row.id, learned, got };
  }

  // Cast a line off the rocks, with a berry for bait if you like. Returns what bit, if anything.
  async fish(account, { bait = false } = {}) {
    const now = this.now();
    const island = this.island(account);
    if (!island) return { error: 'Visit your island first.' };
    const tideNow = tideOf(now);
    const kit = island.kit;
    if (kit.fishedTide !== tideNow) {
      kit.fishedTide = tideNow;
      kit.casts = 0;
    }
    if (kit.casts >= castsPerTide(kit.abilities)) return { error: 'The fish have gone quiet. Try again next tide.' };
    if (bait && !(kit.materials.berries > 0)) return { error: 'You have no berries for bait.' };
    kit.casts++;
    if (bait) kit.materials.berries--;
    const bite = cast({ t: now, rand: this.rand, hook: kit.hook, abilities: kit.abilities, bait: Boolean(bait) });
    let caught = null;
    let snagged = false;
    if (bite) {
      const n = bite.double ? 2 : 1;
      if (bite.what === 'fish') {
        this.catchFish(kit, n);
        caught = n > 1 ? 'two fish' : 'a fish';
      } else if (bite.what === 'big fish') {
        this.catchFish(kit, 2 * n);
        caught = n > 1 ? 'two big fish' : 'a big fish';
      } else if (bite.what === 'cuttlefish') {
        island.supplies.ink++;
        kit.bones++;
        caught = 'a cuttlefish (good for ink)';
      } else if (bite.what === 'crab') {
        kit.fish++;
        caught = 'a crab';
      } else if (bite.what === 'old bottle') {
        this.oldBottle(island, now, { comet: eventAt(now)?.kind === 'comet' });
        caught = 'an old bottle, snagged on your hook. It is on the beach';
      } else if (bite.what === 'snag') {
        // A bottle still out on the water, on its way to someone. Keep it, or let it go on.
        const drifting = this.sql.exec(
          `SELECT id FROM bottles WHERE finder IS NULL AND sender != ? AND fog = 0 AND hidden = 0 ORDER BY id`, island.key,
        ).toArray();
        if (drifting.length) {
          kit.snag = drifting[Math.floor(this.rand() * drifting.length)].id;
          snagged = true;
          caught = 'a bottle, tangled in your line, still on its way to someone';
        } else {
          this.oldBottle(island, now);
          caught = 'an old bottle, snagged on your hook. It is on the beach';
        }
      } else if (bite.what === 'strange') {
        const name = strangeCurio(this.rand);
        island.curios.push({ name, strange: true });
        caught = name;
      } else {
        const name = curio(this.rand);
        island.curios.push({ name });
        caught = name;
      }
    }
    this.saveIsland(island);
    return { ...this.state(island, now), caught: caught ?? 'nothing', snagged };
  }

  catchFish(kit, n) {
    kit.fish += n;
    kit.bones += n;
    kit.materials.scales = (kit.materials.scales ?? 0) + n;
  }

  // Make something: a recipe from island.js (the old 'hook' and 'glue' included).
  async craft(account, what, extra = {}) {
    return this.act(account, { ...extra, op: 'make', what });
  }

  // An old bottle washes up with a page from a journal kept here long ago.
  oldBottle(island, now, { comet = false, pageId = null } = {}) {
    const p = pageId ? page(pageId) : oldPage(this.rand, island.kit.pages, { comet });
    const hand = OLD_HANDS[p.by];
    this.beached(island, now, { sender: OLD_SENDER, text: p.text, hand: hand.hand, emblem: hand.emblem, pageId: p.id, old: 1 });
  }

  // Keep a page you've read, and learn what it teaches once you hold every page it takes.
  // Returns the ability learned (or half-learned), if new.
  learn(island, pageId) {
    const p = pageId ? page(pageId) : null;
    if (!p) return null;
    if (!island.kit.pages.includes(p.id)) island.kit.pages.push(p.id);
    const a = p.teaches;
    if (!a || island.kit.abilities.includes(a)) return null;
    const held = PAGES.filter((q) => q.teaches === a && island.kit.pages.includes(q.id)).length;
    if (held >= pagesFor(a)) {
      island.kit.abilities.push(a);
      return ABILITIES[a].name;
    }
    return `part of ${ABILITIES[a].name} (${held} of ${pagesFor(a)} pages)`;
  }

  async alarm() {
    await this.settle(this.now());
    await this.schedule();
  }

  // Bottles that have come to rest find their reader, and castaways answer what reached them.
  // On the way some sink (a writer the sea has heard is rude), some break open (boxes and
  // barrels in a storm), some come home changed out of the fog, and some find the hidden current.
  async settle(now) {
    const due = this.sql.exec('SELECT * FROM bottles WHERE finder IS NULL AND arrives <= ? ORDER BY arrives LIMIT 200', now).toArray();
    if (due.length) {
      const active = this.activeIslands(now);
      for (const b of due) {
        const sender = this.island(b.sender);
        if (b.hidden && sender) {
          this.sql.exec('UPDATE bottles SET finder = ?, landed = ? WHERE id = ?', DEEP, b.arrives, b.id);
          const has = sender.kit.pages.includes('hidden-1');
          this.oldBottle(sender, b.arrives, has ? {} : { pageId: 'hidden-1' });
          continue;
        }
        if (b.fog && sender) {
          const c = clock(b.arrives);
          this.sql.exec(
            'UPDATE bottles SET finder = ?, landed = ?, shore = ?, part = ?, tide = ?, text = ?, sender = ?, strange = ? WHERE id = ?',
            sender.key, b.arrives, 'west', c.part, tideWords(c), echo(this.rand, b.text), STRANGE_SENDER, 'fog', b.id,
          );
          continue;
        }
        if (sender && !sender.castaway && this.rand() < sinkChance(this.marksOf(sender.key))) {
          this.sql.exec('UPDATE bottles SET finder = ?, landed = ? WHERE id = ?', DEEP, b.arrives, b.id);
          continue;
        }
        const candidates = sender && !active.some((i) => i.key === sender.key) ? [...active, sender] : active;
        // Nobody in reach: it drifts on, looking a little further each hour, until someone is.
        let who = finder({ x: b.to_x, y: b.to_y }, candidates, b.sender, b.arrives - b.rest);
        while (!who && b.arrives + REDRIFT_MS <= now) {
          b.arrives += REDRIFT_MS;
          who = finder({ x: b.to_x, y: b.to_y }, candidates, b.sender, b.arrives - b.rest);
        }
        if (!who) {
          this.sql.exec('UPDATE bottles SET arrives = ? WHERE id = ?', b.arrives + REDRIFT_MS, b.id);
          continue;
        }
        const c = clock(b.arrives);
        const replyDue = who.castaway ? now + REPLY_DELAY_MS[0] + Math.floor(this.rand() * (REPLY_DELAY_MS[1] - REPLY_DELAY_MS[0])) : null;
        const stormy = eventOn(tideOf(b.thrown)) === 'storm' || eventOn(tideOf(b.arrives)) === 'storm';
        const broken = (b.kind === 'box' || b.kind === 'barrel') && stormy && this.rand() < 0.5 ? 1 : 0;
        const amount = blurAmount({ drifted: b.arrives - b.thrown, kind: b.kind, stained: Boolean(b.stained) });
        this.sql.exec(
          `UPDATE bottles SET finder = ?, landed = ?, shore = ?, part = ?, tide = ?, reply_due = ?, blur = ?, broken = ?,
             items = CASE WHEN ? = 1 THEN '[]' ELSE items END, page = CASE WHEN ? = 1 THEN NULL ELSE page END WHERE id = ?`,
          who.key, b.arrives, shore(who, { x: b.from_x, y: b.from_y }), c.part, tideWords(c), replyDue, amount, broken, broken, broken, b.id,
        );
      }
    }
    await this.castawaysReply(now);
  }

  async castawaysReply(now) {
    const owed = this.sql.exec('SELECT * FROM bottles WHERE reply_due <= ? AND replied = 0 ORDER BY reply_due LIMIT ?', now, REPLIES_PER_ALARM).toArray();
    for (const b of owed) {
      // Marked first, so a second alarm during the call can't answer the same letter twice.
      this.sql.exec('UPDATE bottles SET replied = 1, opened = ? WHERE id = ?', now, b.id);
      const castaway = CASTAWAYS.find((c) => c.key === b.finder);
      const island = this.island(b.finder);
      if (!castaway || !island) continue;
      this.restock(island, now);
      this.saveIsland(island);
      if (SUPPLIES.some((k) => island.supplies[k] < 1)) continue;
      const text = await this.write(castaway, { text: b.text, senderName: b.sender_name, shore: b.shore, part: b.part, tide: b.tide });
      if (!text) continue;
      const fresh = this.island(b.finder);
      fresh.supplies.bottles++;
      fresh.supplies.corks++;
      for (const k of SUPPLIES) fresh.supplies[k]--;
      this.saveIsland(fresh);
      const home = { x: b.from_x, y: b.from_y };
      this.launch(fresh, { text, signed: true, dir: directionTo(fresh, home), strength: 0.7, toward: home, answers: b.id, now: this.now() });
    }
  }

  // Castaways have gardens and nets: one more of each supply every tide, up to a small stock.
  restock(island, now) {
    const tideNow = tideOf(now);
    const n = tideNow - island.tides;
    if (n <= 0) return;
    for (const k of SUPPLIES) island.supplies[k] = Math.min(CASTAWAY_STOCK_MAX, island.supplies[k] + n);
    island.tides = tideNow;
  }

  launch(island, {
    text, signed, dir, strength, toward, answers, page: enclosed = null, now, kind = 'bottle', items = [], hand = island.hand,
    forged = false, sealed = false, stamp = null, shimmer = false, steady = false, stained = false, fog = false, hidden = false,
    name = null, emblem = island.emblem, added = null, addedHand = null, marked = island.castaway ? 1 : 0,
  }) {
    const to = drift({ from: island, dir, strength, t: now, rand: this.rand, toward, kind, steady });
    // A bottle in the fog vanishes for a while before it comes home.
    const arrives = fog ? to.arrives + Math.round((1 + this.rand() * 2) * TIDE_MS * 2) : hidden ? now + TIDE_MS : to.arrives;
    this.sql.exec(
      `INSERT INTO bottles (sender, sender_name, text, hand, emblem, marked, reply_to, from_x, from_y, to_x, to_y, thrown, rest, arrives, page,
         kind, items, forged, sealed, stamp, shimmer, stained, fog, hidden, added, added_hand)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      island.key, name ?? (signed ? island.name : null), text, hand, emblem, marked, answers,
      island.x, island.y, to.x, to.y, now, arrives, arrives, enclosed,
      kind, JSON.stringify(items), forged ? 1 : 0, sealed ? 1 : 0, stamp, shimmer ? 1 : 0, stained ? 1 : 0, fog ? 1 : 0, hidden ? 1 : 0,
      added, addedHand,
    );
  }

  // Wake for whichever comes first: the next bottle coming to rest or the next castaway reply.
  async schedule() {
    const next = this.sql.exec(`
      SELECT MIN(t) AS t FROM (
        SELECT MIN(arrives) AS t FROM bottles WHERE finder IS NULL
        UNION ALL SELECT MIN(reply_due) FROM bottles WHERE replied = 0 AND reply_due IS NOT NULL
      )`).toArray()[0]?.t;
    if (next == null) return;
    const current = await this.ctx.storage.getAlarm();
    if (current == null || next < current || current < this.now()) await this.ctx.storage.setAlarm(next);
  }

  // Islands bottles can wash up on: players seen in the last few days, and the castaways when
  // Claude is set up to write for them.
  activeIslands(now) {
    const castaways = this.env?.ANTHROPIC_API_KEY ? 1 : 0;
    return this.sql.exec(
      'SELECT key, x, y, castaway, lighthouse, beacon FROM islands WHERE (castaway = 0 AND seen >= ?) OR (castaway = 1 AND ? = 1)',
      now - ACTIVE_MS, castaways,
    ).toArray();
  }

  // How the sea has heard a writer's letters were taken.
  marksOf(key) {
    const out = { kind: 0, useful: 0, rude: 0 };
    for (const r of this.sql.exec('SELECT mark, COUNT(*) AS n FROM bottles WHERE sender = ? AND mark IS NOT NULL GROUP BY mark', key).toArray()) {
      out[r.mark] = r.n;
    }
    return out;
  }

  // Two islands are pen pals once each has found PEN_PAL_LETTERS of the other's letters.
  penPals(a, b) {
    if (!b || b.startsWith('sea:')) return false;
    const count = (finderKey, senderKey) => this.sql.exec(
      'SELECT COUNT(*) AS n FROM bottles WHERE finder = ? AND sender = ? AND old = 0', finderKey, senderKey,
    ).toArray()[0].n;
    return count(a, b) >= PEN_PAL_LETTERS && count(b, a) >= PEN_PAL_LETTERS;
  }

  // How many letters from others on your shelf are in each hand.
  handsOnShelf(island) {
    const out = new Map();
    for (const r of this.sql.exec(
      `SELECT hand, COUNT(*) AS n FROM bottles WHERE finder = ? AND opened IS NOT NULL AND gone = 0 AND old = 0 AND sender != ? AND sender NOT LIKE 'sea:%' GROUP BY hand`,
      island.key, island.key,
    ).toArray()) out.set(r.hand, r.n);
    return out;
  }

  // What your letters tell you about where others are: each signed writer, and the beach their
  // letters most often reach. Never coordinates.
  chart(island) {
    const rows = this.sql.exec(
      `SELECT sender_name AS name, shore, COUNT(*) AS n FROM bottles WHERE finder = ? AND opened IS NOT NULL AND sender_name IS NOT NULL
         AND sender != ? AND old = 0 GROUP BY sender_name, shore ORDER BY n DESC`,
      island.key, island.key,
    ).toArray();
    const by = new Map();
    for (const r of rows) {
      const e = by.get(r.name) ?? { name: r.name, shore: r.shore, letters: 0 };
      e.letters += r.n;
      by.set(r.name, e);
    }
    return [...by.values()].sort((a, b) => b.letters - a.letters);
  }

  island(key) {
    const row = this.sql.exec('SELECT * FROM islands WHERE key = ?', String(key).toLowerCase()).toArray()[0];
    return row ? { ...row, supplies: JSON.parse(row.supplies), curios: JSON.parse(row.curios), kit: kitOf(row.kit) } : null;
  }

  newIsland(key, now, name = key) {
    this.ensureCastaways(now);
    const n = this.sql.exec('SELECT COUNT(*) AS n FROM islands').toArray()[0].n;
    let { x, y } = placeIsland(n);
    // A veteran who lit a beacon gets new neighbours: most new islands wash up near one.
    const beacons = this.activeIslands(now).filter((i) => i.beacon && !i.castaway);
    if (beacons.length && this.rand() < 0.7) {
      const b = beacons[Math.floor(this.rand() * beacons.length)];
      const a = this.rand() * 2 * Math.PI;
      x = b.x + Math.cos(a) * 6;
      y = b.y + Math.sin(a) * 6;
    }
    // A small crate washed up beside you: a few bottles' worth, some seeds, some odds and ends,
    // and one thing nobody else has.
    const curios = [{ name: curio(this.rand) }, { name: curio(this.rand) }, { name: uniqueCurio(this.rand), unique: true }];
    const island = {
      key: String(key).toLowerCase(), name: String(name), x, y, created: now, seen: now, hand: this.randomInt(), emblem: this.randomInt(),
      supplies: { ...STARTER_SUPPLIES }, curios, tides: tideOf(now), castaway: 0, kit: kitOf(),
    };
    this.saveIsland(island);
    return island;
  }

  // The castaways take the first spots, in the middle of the ocean.
  ensureCastaways(now) {
    for (const c of CASTAWAYS) {
      if (this.island(c.key)) continue;
      const n = this.sql.exec('SELECT COUNT(*) AS n FROM islands').toArray()[0].n;
      const { x, y } = placeIsland(n);
      this.saveIsland({
        key: c.key, name: c.key.split(':')[1].replace(/^./, (l) => l.toUpperCase()), x, y, created: now, seen: now,
        hand: this.randomInt(), emblem: this.randomInt(), supplies: { bottles: 5, corks: 5, paper: 5, ink: 5 },
        curios: [], tides: tideOf(now), castaway: 1, kit: kitOf(),
      });
    }
  }

  saveIsland(i) {
    const kit = i.kit ?? kitOf();
    this.sql.exec(
      `INSERT INTO islands (key, name, x, y, created, seen, hand, emblem, supplies, curios, tides, castaway, kit, lighthouse, beacon)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET seen = excluded.seen, supplies = excluded.supplies, curios = excluded.curios,
         tides = excluded.tides, kit = excluded.kit, emblem = excluded.emblem, lighthouse = excluded.lighthouse, beacon = excluded.beacon`,
      i.key, i.name, i.x, i.y, i.created, i.seen, i.hand, i.emblem, JSON.stringify(i.supplies), JSON.stringify(i.curios), i.tides, i.castaway,
      JSON.stringify(kit), kit.builds.lighthouse ? 1 : 0, kit.builds.beacon ? 1 : 0,
    );
  }

  randomInt() {
    return Math.floor(this.rand() * 2 ** 31);
  }

  // What a player's page shows. Never coordinates or who found what: the sea keeps that.
  state(island, now) {
    const c = clock(now);
    const kit = island.kit;
    const room = shelfRoom(kit.builds);
    const knows = (a) => kit.abilities.includes(a);
    const rows = this.sql.exec(
      `SELECT b.*, o.text AS original FROM bottles b LEFT JOIN bottles o ON o.id = b.reply_to AND o.sender = b.finder
       WHERE b.finder = ? AND b.gone = 0 ORDER BY COALESCE(b.opened, b.landed) DESC LIMIT ?`,
      island.key, room + 100,
    ).toArray();
    const sent = this.sql.exec(
      'SELECT id, text, thrown, page, kind, to_x, to_y, finder IS NOT NULL AS ashore FROM bottles WHERE sender = ? AND hidden = 0 ORDER BY thrown DESC LIMIT 20',
      island.key,
    ).toArray();
    const shelf = rows.filter((r) => r.opened != null);
    // Reading hands: number each distinct hand among the letters from others on your shelf.
    const hands = new Map();
    const counts = this.handsOnShelf(island);
    if (knows('hands')) {
      for (const r of shelf) {
        if (r.sender === island.key || r.old || r.sender.startsWith('sea:')) continue;
        hands.set(r.hand, (hands.get(r.hand) ?? 0) + 1);
      }
    }
    const handIds = [...hands.keys()];
    const event = eventAt(now);
    const tideNow = tideOf(now);
    for (const p of kit.plots) grow(p, now);
    const pals = this.sql.exec(
      `SELECT sender, MAX(sender_name) AS name FROM bottles WHERE finder = ? AND old = 0 AND sender NOT LIKE 'sea:%' AND sender != ?
         GROUP BY sender HAVING COUNT(*) >= ?`,
      island.key, island.key, PEN_PAL_LETTERS,
    ).toArray().filter((r) => this.penPals(island.key, r.sender));
    const marks = this.marksOf(island.key);
    const neighbours = this.activeIslands(now).filter((i) => i.key !== island.key && Math.hypot(i.x - island.x, i.y - island.y) <= NEIGHBOUR_RANGE).length;
    const snag = kit.snag ? this.sql.exec('SELECT id, kind FROM bottles WHERE id = ? AND finder IS NULL', kit.snag).toArray()[0] : null;
    return {
      now,
      clock: { day: c.day, part: c.part, tide: c.tide, ebbing: c.ebbing, words: tideWords(c), dayMs: TIDE_MS * 2 },
      island: { name: island.name, hand: island.hand, emblem: island.emblem, supplies: island.supplies, curios: island.curios, joined: island.created },
      beach: rows.filter((r) => r.opened == null).map((r) => ({ id: r.id, shore: r.shore, old: Boolean(r.old), kind: r.kind, strange: Boolean(r.strange) })),
      shelf: shelf.map((r) => {
        const own = r.sender === island.key;
        const amount = knows('restore') ? 0 : r.blur;
        const letter = {
          id: r.id, text: blur(r.text, amount, r.id), name: r.sender_name, hand: r.hand, emblem: r.emblem, marked: Boolean(r.marked),
          own, old: Boolean(r.old), shore: r.shore, part: r.part, tide: r.tide, landed: r.landed, opened: r.opened,
          replyTo: r.original ? excerpt(r.original) : null,
          // An old bottle is the page itself; a letter may have a copied page folded in.
          page: r.page && !r.old ? pageView(r.page) : null,
          title: r.old ? page(r.page)?.title ?? null : null,
          kind: r.kind, items: JSON.parse(r.items), sealed: Boolean(r.sealed), stamp: r.stamp == null ? null : STAMP_PATTERNS[r.stamp] ?? null,
          shimmer: Boolean(r.shimmer), stained: Boolean(r.stained), broken: Boolean(r.broken),
          blurred: r.blur > 0 ? (knows('restore') ? 'restored' : 'blurred') : null,
          strange: r.strange ?? null, mark: r.mark ?? null,
          added: r.added ? { text: r.added, hand: r.added_hand } : null,
          // Only a writer's letters can be marked, copied or answered home.
          player: !own && !r.old && !r.sender.startsWith('sea:'),
        };
        if (hands.has(r.hand)) letter.handOf = { mark: handIds.indexOf(r.hand) + 1, letters: hands.get(r.hand) };
        // A careful reader feels a copied hand is off, even if they can't say how.
        if (r.forged && knows('hands')) letter.forged = true;
        if (knows('forgery') && letter.player && counts.get(r.hand) >= 3) letter.canForge = true;
        return letter;
      }),
      sent: sent.map((s) => ({
        id: s.id, text: excerpt(s.text), thrown: s.thrown, ashore: Boolean(s.ashore), page: s.page ? page(s.page)?.title ?? null : null, kind: s.kind,
        ...(knows('currents') || kit.builds.lookout ? { rest: restWords(island, { x: s.to_x, y: s.to_y }) } : {}),
      })),
      kit: {
        fish: kit.fish, bones: kit.bones, glue: kit.glue, hook: kit.hook, spear: kit.spear,
        casts: castsPerTide(kit.abilities) - (kit.fishedTide === tideNow ? kit.casts : 0),
        canSpear: kit.spear && canSpear(now) && kit.spearTide !== tideNow,
        lowTide: canSpear(now),
        traps: kit.traps.map((t) => ({ set: t.set, tides: Math.min(3, tideNow - tideOf(t.set)) })), maxTraps: MAX_TRAPS,
        snag: snag ? { id: snag.id, kind: snag.kind } : null,
        gathered: kit.gatheredTide === tideNow,
        // The published Roblox build reads these for its hook and glue buttons.
        hookCost: RECIPES.hook.cost.bones, glueCost: RECIPES.glue.cost.fish,
      },
      materials: Object.fromEntries(Object.entries(kit.materials).filter(([, n]) => n > 0)),
      seeds: kit.seeds,
      garden: kit.plots.map((p) => plotView(p, now)),
      crops: CROPS,
      builds: kit.builds,
      blueprints: BUILD_KINDS.map((k) => {
        const b = BUILDINGS[k];
        const next = nextBuild(k, kit.builds);
        return {
          id: k, name: b.name, words: b.words, stages: b.stages?.length ?? 1, built: kit.builds[k] ?? 0,
          next: next.error ? null : { name: next.name, cost: next.cost, ok: stockHas(island, next.cost) }, blocked: next.error ?? null,
        };
      }),
      recipes: Object.entries(RECIPES).map(([id, r]) => ({
        id, name: r.name, cost: r.cost, gives: r.gives ?? null,
        blocked: r.needs && !kit.builds[r.needs] ? `Needs a ${BUILDINGS[r.needs].name.toLowerCase()}.`
          : r.ability && !knows(r.ability) ? `Needs ${ABILITIES[r.ability].name}.`
            : r.once && kit[r.once] != null && kit[r.once] !== false ? 'Made.' : null,
        ok: stockHas(island, r.cost),
      })),
      containers: Object.entries(CONTAINERS).map(([id, k]) => ({
        id, name: k.name, items: k.items, cost: k.cost, words: k.words ?? null,
        blocked: k.ability && !knows(k.ability) ? `Needs ${ABILITIES[k.ability].name}.` : k.needs && !kit.builds[k.needs] ? `Needs a ${BUILDINGS[k.needs].name.toLowerCase()}.` : null,
      })),
      seal: { ring: kit.ring, glyph: island.emblem % SEAL_GLYPHS, wax: Math.floor(island.emblem / SEAL_GLYPHS) % SEAL_WAX, designed: kit.designed },
      stamp: kit.stamp == null ? null : { id: kit.stamp, name: STAMP_PATTERNS[kit.stamp] },
      stamps: STAMP_PATTERNS,
      clues: kit.clues.filter((k) => k.until > now).map((k) => ({ text: clueText(k), until: k.until })),
      pals: pals.map((p) => p.name).filter(Boolean),
      marks: { kind: marks.kind, useful: marks.useful },
      chart: this.chart(island),
      neighbours,
      room,
      held: shelf.length,
      abilities: kit.abilities.map((a) => ({ id: a, ...ABILITIES[a] })),
      journal: kit.pages.map(pageView).filter(Boolean),
      event: event ? { kind: event.kind, name: EVENTS[event.kind].name, words: EVENTS[event.kind].words, ends: event.end } : null,
      sign: event ? null : signAt(now),
      forecast: knows('signs') ? upcoming(now, FORECAST_TIDES).map((e) => ({ kind: e.kind, name: EVENTS[e.kind].name, start: e.start })) : null,
    };
  }
}

// --- Actions ----------------------------------------------------------------------------------
// Each takes (island, body, now) with `this` the Ocean, changes the island in place (the caller
// saves it) and returns extra fields for the reply, or { error }.
const ACTIONS = {
  // Pick up what's lying inland: palm leaves, clay, sand or stones, once a tide.
  gather(island, { what }) {
    if (!GATHER.includes(what)) return { error: 'You can gather palm leaves, clay, sand or stones.' };
    const kit = island.kit;
    const tide = tideOf(this.now());
    if (kit.gatheredTide === tide) return { error: 'You have gathered all you can carry this tide.' };
    kit.gatheredTide = tide;
    kit.materials[what] = (kit.materials[what] ?? 0) + GATHER_AMOUNT;
    return { gathered: what };
  },

  build(island, { what }) {
    const next = nextBuild(what, island.kit.builds);
    if (next.error) return next;
    if (!stockHas(island, next.cost)) return { error: `The ${next.name.toLowerCase()} takes ${costWords(next.cost)}.` };
    stockPay(island, next.cost);
    island.kit.builds[what] = (island.kit.builds[what] ?? 0) + 1;
    return { built: next.name };
  },

  make(island, { what, pattern }) {
    const r = RECIPES[what];
    const kit = island.kit;
    if (!r) return { error: 'There is no way to make that.' };
    if (r.needs && !kit.builds[r.needs]) return { error: `You need a ${BUILDINGS[r.needs].name.toLowerCase()} for that.` };
    if (r.ability && !kit.abilities.includes(r.ability)) return { error: `You need ${ABILITIES[r.ability].name} for that.` };
    if (r.once && kit[r.once] != null && kit[r.once] !== false) return { error: 'You already have one.' };
    if (what === 'stamp' && !(Number.isInteger(pattern) && pattern >= 0 && pattern < STAMP_PATTERNS.length)) return { error: 'Pick a pattern to carve.' };
    if (!stockHas(island, r.cost)) {
      if (what === 'hook') return { error: `A bone hook takes ${r.cost.bones} fish bones.` };
      if (what === 'glue') return { error: `A pot of glue takes ${r.cost.fish} fish.` };
      return { error: `That takes ${costWords(r.cost)}.` };
    }
    stockPay(island, r.cost);
    if (r.once) kit[r.once] = what === 'stamp' ? pattern : true;
    for (const [k, n] of Object.entries(r.gives ?? {})) stockAdd(island, k, n);
    return { made: r.name };
  },

  plant(island, { plot, crop }, now) {
    const kit = island.kit;
    if (!Number.isInteger(plot) || plot < 0 || plot >= PLOTS) return { error: 'There is no such plot.' };
    if (kit.plots[plot]?.crop) return { error: 'Something is already growing there.' };
    if (!CROPS[crop]) return { error: 'There are no such seeds.' };
    if (!(kit.seeds[crop] > 0)) return { error: `You have no ${CROPS[crop].seed}.` };
    kit.seeds[crop]--;
    kit.plots[plot] = plant(crop, now);
    return { planted: CROPS[crop].name };
  },

  // Water every plot from the stream: each crop grows for another two tides.
  water(island, _body, now) {
    const tide = tideOf(now);
    let n = 0;
    for (const p of island.kit.plots) {
      if (!p?.crop) continue;
      grow(p, now);
      p.watered = tide;
      n++;
    }
    if (!n) return { error: 'Nothing is planted yet.' };
    return { watered: n };
  },

  harvest(island, { plot }, now) {
    const kit = island.kit;
    const p = kit.plots[plot];
    if (!p?.crop) return { error: 'Nothing is growing there.' };
    grow(p, now);
    if (!ripe(p)) return { error: 'It isn\'t ready yet.' };
    const crop = CROPS[p.crop];
    for (const [k, n] of Object.entries(crop.yields)) kit.materials[k] = (kit.materials[k] ?? 0) + n;
    kit.seeds[p.crop]++;
    kit.plots[plot] = { crop: null };
    return { harvested: costWords(crop.yields) };
  },

  // Design a crest at the seal bench, cut into a ring you seal letters with.
  seal(island, { glyph, wax }) {
    if (!island.kit.builds.bench) return { error: 'You need a seal bench to design a seal.' };
    if (!Number.isInteger(glyph) || glyph < 0 || glyph >= SEAL_GLYPHS || !Number.isInteger(wax) || wax < 0 || wax >= SEAL_WAX) {
      return { error: 'Pick a mark and a wax colour.' };
    }
    island.emblem = glyph + SEAL_GLYPHS * wax;
    island.kit.ring = true;
    island.kit.designed = true;
    return { sealed: true };
  },

  async fish(island, { bait }) {
    // Through the Ocean's own method, which saves the island itself.
    const r = await this.fish(island.key, { bait });
    Object.assign(island, this.island(island.key));
    return r.error ? r : { caught: r.caught, snagged: r.snagged };
  },

  // Wade out at low tide with a spear, once a tide.
  spear(island, _body, now) {
    const kit = island.kit;
    if (!kit.spear) return { error: 'You need a spear.' };
    if (!canSpear(now)) return { error: 'The water is too deep. Wait for low tide.' };
    const tide = tideOf(now);
    if (kit.spearTide === tide) return { error: 'You have already waded out this tide.' };
    kit.spearTide = tide;
    const got = spear({ t: now, rand: this.rand });
    if (got === 'flatfish') this.catchFish(kit, 1);
    if (got === 'crab') kit.fish++;
    return { caught: got === 'flatfish' ? 'a flatfish' : got === 'crab' ? 'a crab' : 'nothing' };
  },

  // Set a trap baited with a berry; it fills over the tides you're away.
  trap(island, _body, now) {
    const kit = island.kit;
    if (!(kit.materials.traps > 0)) return { error: 'You have no trap to set. Weave one from driftwood and rope.' };
    if (kit.traps.length >= MAX_TRAPS) return { error: `You can only watch ${MAX_TRAPS} traps.` };
    if (!(kit.materials.berries > 0)) return { error: 'A trap needs a berry for bait.' };
    kit.materials.traps--;
    kit.materials.berries--;
    kit.traps.push({ set: now });
    return { set: true };
  },

  // Pull up the traps that have sat at least a tide, and keep what's in them.
  traps(island, _body, now) {
    const kit = island.kit;
    let fish = 0;
    let crabs = 0;
    const keep = [];
    for (const t of kit.traps) {
      const got = trapCatch({ set: t.set, now, rand: this.rand });
      if (got.tides < 1) {
        keep.push(t);
        continue;
      }
      fish += got.fish;
      crabs += got.crabs;
      kit.materials.traps = (kit.materials.traps ?? 0) + 1;
    }
    if (keep.length === kit.traps.length) return { error: 'Give the traps a tide first.' };
    kit.traps = keep;
    this.catchFish(kit, fish);
    kit.fish += crabs;
    const words = [fish && `${fish} fish`, crabs && `${crabs} crab${crabs > 1 ? 's' : ''}`].filter(Boolean).join(' and ');
    return { caught: words || 'nothing' };
  },

  // A bottle snagged on your line: keep it (it lands on your beach) or let it drift on.
  snag(island, { keep }, now) {
    const kit = island.kit;
    if (!kit.snag) return { error: 'Nothing is caught on your line.' };
    const id = kit.snag;
    kit.snag = null;
    if (!keep) return { released: true };
    const b = this.sql.exec('SELECT id FROM bottles WHERE id = ? AND finder IS NULL', id).toArray()[0];
    if (!b) return { error: 'It slipped off the line before you could pull it in.' };
    const c = clock(now);
    this.sql.exec('UPDATE bottles SET finder = ?, landed = ?, shore = ?, part = ?, tide = ? WHERE id = ?', island.key, now, 'west', c.part, tideWords(c), id);
    return { kept: true };
  },

  // Mark a letter kind, useful or rude. The sea remembers.
  mark(island, { id, mark }) {
    if (!MARKS.includes(mark)) return { error: 'Mark it kind, useful or rude.' };
    const r = this.sql.exec('SELECT id, sender, old, mark FROM bottles WHERE id = ? AND finder = ? AND opened IS NOT NULL', Number(id), island.key).toArray()[0];
    if (!r || r.old || r.sender === island.key || r.sender.startsWith('sea:')) return { error: 'You can only mark a letter someone wrote you.' };
    if (r.mark) return { error: 'You have already marked that letter.' };
    this.sql.exec('UPDATE bottles SET mark = ? WHERE id = ?', mark, r.id);
    return { marked: mark };
  },

  burn(island, { id }) {
    const r = this.sql.exec('SELECT id FROM bottles WHERE id = ? AND finder = ? AND opened IS NOT NULL AND gone = 0', Number(id), island.key).toArray()[0];
    if (!r) return { error: 'That letter is not on your shelf.' };
    this.sql.exec('UPDATE bottles SET gone = 1 WHERE id = ?', r.id);
    return { burned: true };
  },

  // Throw a letter back out with a line of your own added at the bottom.
  async pass(island, { id, line, dir, strength }, now) {
    const r = this.sql.exec('SELECT * FROM bottles WHERE id = ? AND finder = ? AND opened IS NOT NULL AND gone = 0', Number(id), island.key).toArray()[0];
    if (!r || r.old) return { error: 'That letter is not on your shelf.' };
    const add = typeof line === 'string' ? line.trim() : '';
    if (add.length > MAX_LINE) return { error: `Add at most ${MAX_LINE} characters.` };
    if (!Number.isInteger(dir) || dir < 0 || dir >= DIRECTIONS.length) return { error: 'Pick a direction to throw.' };
    const cost = { bottles: 1, corks: 1, ...(add ? { ink: 1 } : {}) };
    if (!stockHas(island, cost)) return { error: 'Throwing it on takes a bottle and a cork, and ink if you add a line.' };
    stockPay(island, cost);
    this.sql.exec('UPDATE bottles SET gone = 1 WHERE id = ?', r.id);
    const s = Number(strength);
    this.launch(island, {
      text: r.text, name: r.sender_name, dir, strength: Number.isFinite(s) ? Math.min(1, Math.max(0.1, s)) : 0.6, now, hand: r.hand,
      emblem: r.emblem, forged: Boolean(r.forged), sealed: Boolean(r.sealed), stamp: r.stamp, shimmer: Boolean(r.shimmer), marked: r.marked,
      added: add || null, addedHand: add ? island.hand : null, toward: null, answers: null,
    });
    await this.schedule();
    return { passed: true };
  },
};

// Supplies live on the island, the catch and tools in the kit, seeds by crop, and the rest are
// materials. Costs mix all of them.
function stockCount(island, k) {
  if (SUPPLIES.includes(k)) return island.supplies[k] ?? 0;
  if (k === 'fish' || k === 'bones' || k === 'glue') return island.kit[k] ?? 0;
  if (k.startsWith('seed:')) return island.kit.seeds[k.slice(5)] ?? 0;
  return island.kit.materials[k] ?? 0;
}

function stockAdd(island, k, n) {
  if (SUPPLIES.includes(k)) island.supplies[k] = (island.supplies[k] ?? 0) + n;
  else if (k === 'fish' || k === 'bones' || k === 'glue') island.kit[k] = (island.kit[k] ?? 0) + n;
  else if (k.startsWith('seed:')) island.kit.seeds[k.slice(5)] = (island.kit.seeds[k.slice(5)] ?? 0) + n;
  else island.kit.materials[k] = (island.kit.materials[k] ?? 0) + n;
}

function stockHas(island, cost) {
  return Object.entries(cost).every(([k, n]) => stockCount(island, k) >= n);
}

function stockPay(island, cost) {
  for (const [k, n] of Object.entries(cost)) stockAdd(island, k, -n);
}

const SUPPLY_FOUND = {
  bottles: 'an empty bottle', corks: 'a cork', paper: 'a dry sheet of paper', ink: 'a pouch of cuttlefish ink',
};

function kitOf(json = '{}') {
  const k = typeof json === 'string' ? JSON.parse(json) : json;
  const plots = k.plots ?? [];
  return {
    fish: k.fish ?? 0, bones: k.bones ?? 0, glue: k.glue ?? 0, hook: Boolean(k.hook),
    pages: k.pages ?? [], abilities: k.abilities ?? [], fishedTide: k.fishedTide ?? null, casts: k.casts ?? 0,
    materials: k.materials ?? {}, seeds: { ...Object.fromEntries(CROP_KINDS.map((c) => [c, 0])), ...(k.seeds ?? STARTER_SEEDS) },
    plots: Array.from({ length: PLOTS }, (_, i) => plots[i] ?? { crop: null }),
    builds: k.builds ?? {}, ring: Boolean(k.ring), designed: Boolean(k.designed), stamp: k.stamp ?? null,
    spear: Boolean(k.spear), spearTide: k.spearTide ?? null, traps: k.traps ?? [], snag: k.snag ?? null,
    clues: k.clues ?? [], gatheredTide: k.gatheredTide ?? null,
  };
}

function pageView(id) {
  const p = page(id);
  return p ? { id: p.id, title: p.title, text: p.text, teaches: p.teaches ? ABILITIES[p.teaches].name : null } : null;
}

// Reading the current: roughly where a bottle came to rest, from its own island.
function restWords(from, to) {
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  const far = d < 10 ? 'not far' : d < 22 ? 'a good way' : 'far';
  const words = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  return `came to rest ${far} to the ${words[directionTo(from, to)]}`;
}

function excerpt(text) {
  return text.length > 90 ? `${text.slice(0, 88).trimEnd()}…` : text;
}
