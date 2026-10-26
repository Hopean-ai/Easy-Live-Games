import { DurableObject } from 'cloudflare:workers';
import {
  ABILITIES, ACTIVE_MS, BONE_HOOK_COST, DIRECTIONS, EVENTS, GLUE_COST, MAX_LETTER, OLD_HANDS, REDRIFT_MS,
  STARTER_SUPPLIES, SUPPLIES, TIDE_MS, cast, castsPerTide, clock, curio, directionTo, drift, eventAt, eventOn,
  finder, flotsam, oldPage, page, placeIsland, shore, signAt, tideWords, uniqueCurio, upcoming,
} from './world.js';
import { CASTAWAYS, writeReply } from './castaways.js';

// A castaway answers a letter a little while after it washes up.
const REPLY_DELAY_MS = [15 * 60 * 1000, 45 * 60 * 1000];
const REPLIES_PER_ALARM = 3;
const SHELF_LIMIT = 300;
const CASTAWAY_STOCK_MAX = 10;
const NEED = 'You need a bottle, a cork (or a pot of fish glue), a sheet of paper and some ink to send a letter.';
// Sea signs see two island days (four tides) ahead.
const FORECAST_TIDES = 4;
const OLD_SENDER = 'sea:old';

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
    // Added with fishing and journal pages: the island's catch, tools, pages and abilities, and
    // a page folded into a bottle.
    const has = (table, col) => this.sql.exec(`PRAGMA table_info(${table})`).toArray().some((c) => c.name === col);
    if (!has('islands', 'kit')) this.sql.exec("ALTER TABLE islands ADD COLUMN kit TEXT NOT NULL DEFAULT '{}'");
    if (!has('bottles', 'page')) this.sql.exec('ALTER TABLE bottles ADD COLUMN page TEXT');
    if (!has('bottles', 'old')) this.sql.exec('ALTER TABLE bottles ADD COLUMN old INTEGER NOT NULL DEFAULT 0');
  }

  // A player looks at their island: it's made on the first visit, then the tides that passed
  // since the last one leave a little flotsam (at most two tides' worth, so time away never
  // piles up a fortune).
  async visit(account) {
    const now = this.now();
    await this.settle(now);
    const island = this.island(account) ?? this.newIsland(account, now);
    const tideNow = Math.floor(now / TIDE_MS);
    const found = [];
    for (let n = Math.max(island.tides + 1, tideNow - 1); n <= tideNow; n++) {
      const what = flotsam(this.rand, eventOn(n));
      if (what === 'old bottle') {
        this.oldBottle(island, now);
        found.push('an old bottle, crusted with barnacles');
      } else if (what === 'curio') {
        const name = curio(this.rand);
        island.curios.push({ name });
        found.push(name);
      } else if (what) {
        island.supplies[what]++;
        found.push(SUPPLY_FOUND[what]);
      }
    }
    island.tides = tideNow;
    island.seen = now;
    this.saveIsland(island);
    return { ...this.state(island, now), found };
  }

  async throwBottle(account, { text, signed, dir, strength, replyTo, glue, page: pageId } = {}) {
    const now = this.now();
    const island = this.island(account);
    if (!island) return { error: 'Visit your island first.' };
    const letter = typeof text === 'string' ? text.trim() : '';
    if (!letter) return { error: 'Write something first.' };
    if (letter.length > MAX_LETTER) return { error: `Letters can be at most ${MAX_LETTER} characters.` };
    if (!Number.isInteger(dir) || dir < 0 || dir >= DIRECTIONS.length) return { error: 'Pick a direction to throw.' };
    const s = Number(strength);
    if (!Number.isFinite(s)) return { error: 'Pick how hard to throw.' };
    const useGlue = Boolean(glue);
    if (useGlue && !(island.kit.glue > 0)) return { error: 'You have no fish glue.' };
    const need = { bottles: 1, corks: useGlue ? 0 : 1, paper: 1, ink: 1 };
    let enclosed = null;
    if (pageId != null && pageId !== '') {
      if (!island.kit.pages.includes(pageId) || !page(pageId)) return { error: 'That page is not in your journal.' };
      enclosed = pageId;
      // Copying a page out takes another sheet and more ink.
      need.paper++;
      need.ink++;
    }
    if (SUPPLIES.some((k) => island.supplies[k] < need[k])) {
      return { error: enclosed ? 'Copying out a page takes another sheet of paper and more ink.' : NEED };
    }

    let toward = null;
    let answers = null;
    if (replyTo != null) {
      const original = this.sql.exec('SELECT id, from_x, from_y FROM bottles WHERE id = ? AND finder = ? AND opened IS NOT NULL', Number(replyTo), island.key).toArray()[0];
      if (!original) return { error: 'That letter is not on your shelf.' };
      toward = { x: original.from_x, y: original.from_y };
      answers = original.id;
    }
    for (const k of SUPPLIES) island.supplies[k] -= need[k];
    if (useGlue) island.kit.glue--;
    this.saveIsland(island);
    this.launch(island, { text: letter, signed: Boolean(signed), dir, strength: Math.min(1, Math.max(0.1, s)), toward, answers, page: enclosed, now });
    await this.schedule();
    return this.state(island, now);
  }

  async openBottle(account, id) {
    const now = this.now();
    const island = this.island(account);
    if (!island) return { error: 'Visit your island first.' };
    const row = this.sql.exec('SELECT id, page FROM bottles WHERE id = ? AND finder = ? AND opened IS NULL', Number(id), island.key).toArray()[0];
    if (!row) return { error: 'That bottle is not on your beach.' };
    this.sql.exec('UPDATE bottles SET opened = ? WHERE id = ?', now, row.id);
    // Every bottle you open leaves you its glass and cork, so answering costs less than writing first.
    island.supplies.bottles++;
    island.supplies.corks++;
    const learned = this.learn(island, row.page);
    this.saveIsland(island);
    return { ...this.state(island, now), opened: row.id, learned };
  }

  // Cast a line off the rocks. Returns what bit, if anything.
  async fish(account) {
    const now = this.now();
    const island = this.island(account);
    if (!island) return { error: 'Visit your island first.' };
    const tideNow = Math.floor(now / TIDE_MS);
    const kit = island.kit;
    if (kit.fishedTide !== tideNow) {
      kit.fishedTide = tideNow;
      kit.casts = 0;
    }
    if (kit.casts >= castsPerTide(kit.abilities)) return { error: 'The fish have gone quiet. Try again next tide.' };
    kit.casts++;
    const bite = cast({ t: now, rand: this.rand, hook: kit.hook, abilities: kit.abilities });
    let caught = null;
    if (bite) {
      const n = bite.double ? 2 : 1;
      if (bite.what === 'fish') {
        kit.fish += n;
        kit.bones += n;
        caught = n > 1 ? 'two fish' : 'a fish';
      } else if (bite.what === 'big fish') {
        kit.fish += 2 * n;
        kit.bones += 2 * n;
        caught = n > 1 ? 'two big fish' : 'a big fish';
      } else if (bite.what === 'cuttlefish') {
        island.supplies.ink++;
        kit.bones++;
        caught = 'a cuttlefish (good for ink)';
      } else if (bite.what === 'crab') {
        kit.fish++;
        caught = 'a crab';
      } else if (bite.what === 'old bottle') {
        this.oldBottle(island, now);
        caught = 'an old bottle, snagged on your hook. It is on the beach';
      } else {
        const name = curio(this.rand);
        island.curios.push({ name });
        caught = name;
      }
    }
    this.saveIsland(island);
    return { ...this.state(island, now), caught: caught ?? 'nothing' };
  }

  // Make something from the catch: a bone hook, or a pot of fish glue that seals a bottle.
  async craft(account, what) {
    const now = this.now();
    const island = this.island(account);
    if (!island) return { error: 'Visit your island first.' };
    const kit = island.kit;
    if (what === 'hook') {
      if (kit.hook) return { error: 'You already have a bone hook.' };
      if (kit.bones < BONE_HOOK_COST) return { error: `A bone hook takes ${BONE_HOOK_COST} fish bones.` };
      kit.bones -= BONE_HOOK_COST;
      kit.hook = true;
    } else if (what === 'glue') {
      if (kit.fish < GLUE_COST) return { error: `A pot of glue takes ${GLUE_COST} fish.` };
      kit.fish -= GLUE_COST;
      kit.glue++;
    } else {
      return { error: 'You can make a bone hook or fish glue.' };
    }
    this.saveIsland(island);
    return this.state(island, now);
  }

  // An old bottle washes up with a page from a journal kept here long ago.
  oldBottle(island, now) {
    const p = oldPage(this.rand, island.kit.pages);
    const hand = OLD_HANDS[p.by];
    const c = clock(now);
    const shores = ['north', 'east', 'south', 'west'];
    this.sql.exec(
      `INSERT INTO bottles (sender, text, hand, emblem, from_x, from_y, to_x, to_y, thrown, rest, arrives, finder, landed, shore, part, tide, page, old)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      OLD_SENDER, p.text, hand.hand, hand.emblem, island.x, island.y, now, now, now, island.key, now,
      shores[Math.floor(this.rand() * 4)], c.part, tideWords(c), p.id,
    );
  }

  // Keep a page you've read, and learn what it teaches. Returns the ability learned, if new.
  learn(island, pageId) {
    const p = pageId ? page(pageId) : null;
    if (!p) return null;
    if (!island.kit.pages.includes(p.id)) island.kit.pages.push(p.id);
    if (p.teaches && !island.kit.abilities.includes(p.teaches)) {
      island.kit.abilities.push(p.teaches);
      return ABILITIES[p.teaches].name;
    }
    return null;
  }

  async alarm() {
    await this.settle(this.now());
    await this.schedule();
  }

  // Bottles that have come to rest find their reader, and castaways answer what reached them.
  async settle(now) {
    const due = this.sql.exec('SELECT * FROM bottles WHERE finder IS NULL AND arrives <= ? ORDER BY arrives LIMIT 200', now).toArray();
    if (due.length) {
      const active = this.activeIslands(now);
      for (const b of due) {
        const sender = this.island(b.sender);
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
        this.sql.exec(
          'UPDATE bottles SET finder = ?, landed = ?, shore = ?, part = ?, tide = ?, reply_due = ? WHERE id = ?',
          who.key, b.arrives, shore(who, { x: b.from_x, y: b.from_y }), c.part, tideWords(c), replyDue, b.id,
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
    const tideNow = Math.floor(now / TIDE_MS);
    const n = tideNow - island.tides;
    if (n <= 0) return;
    for (const k of SUPPLIES) island.supplies[k] = Math.min(CASTAWAY_STOCK_MAX, island.supplies[k] + n);
    island.tides = tideNow;
  }

  launch(island, { text, signed, dir, strength, toward, answers, page: enclosed = null, now }) {
    const to = drift({ from: island, dir, strength, t: now, rand: this.rand, toward });
    this.sql.exec(
      `INSERT INTO bottles (sender, sender_name, text, hand, emblem, marked, reply_to, from_x, from_y, to_x, to_y, thrown, rest, arrives, page)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      island.key, signed ? island.name : null, text, island.hand, island.emblem, island.castaway ? 1 : 0, answers,
      island.x, island.y, to.x, to.y, now, to.arrives, to.arrives, enclosed,
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
    return this.sql.exec('SELECT key, x, y, castaway FROM islands WHERE (castaway = 0 AND seen >= ?) OR (castaway = 1 AND ? = 1)', now - ACTIVE_MS, castaways).toArray();
  }

  island(key) {
    const row = this.sql.exec('SELECT * FROM islands WHERE key = ?', String(key).toLowerCase()).toArray()[0];
    return row ? { ...row, supplies: JSON.parse(row.supplies), curios: JSON.parse(row.curios), kit: kitOf(row.kit) } : null;
  }

  newIsland(name, now) {
    this.ensureCastaways(now);
    const n = this.sql.exec('SELECT COUNT(*) AS n FROM islands').toArray()[0].n;
    const { x, y } = placeIsland(n);
    // A small crate washed up beside you: a few bottles' worth, some odds and ends, and one
    // thing nobody else has.
    const curios = [{ name: curio(this.rand) }, { name: curio(this.rand) }, { name: uniqueCurio(this.rand), unique: true }];
    const island = {
      key: name.toLowerCase(), name, x, y, created: now, seen: now, hand: this.randomInt(), emblem: this.randomInt(),
      supplies: { ...STARTER_SUPPLIES }, curios, tides: Math.floor(now / TIDE_MS), castaway: 0, kit: kitOf(),
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
        curios: [], tides: Math.floor(now / TIDE_MS), castaway: 1, kit: kitOf(),
      });
    }
  }

  saveIsland(i) {
    this.sql.exec(
      `INSERT INTO islands (key, name, x, y, created, seen, hand, emblem, supplies, curios, tides, castaway, kit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET seen = excluded.seen, supplies = excluded.supplies, curios = excluded.curios,
         tides = excluded.tides, kit = excluded.kit`,
      i.key, i.name, i.x, i.y, i.created, i.seen, i.hand, i.emblem, JSON.stringify(i.supplies), JSON.stringify(i.curios), i.tides, i.castaway,
      JSON.stringify(i.kit ?? kitOf()),
    );
  }

  randomInt() {
    return Math.floor(this.rand() * 2 ** 31);
  }

  // What a player's page shows. Never coordinates or who found what: the sea keeps that.
  state(island, now) {
    const c = clock(now);
    const rows = this.sql.exec(
      `SELECT b.*, o.text AS original FROM bottles b LEFT JOIN bottles o ON o.id = b.reply_to AND o.sender = b.finder
       WHERE b.finder = ? ORDER BY COALESCE(b.opened, b.landed) DESC LIMIT ?`,
      island.key, SHELF_LIMIT,
    ).toArray();
    const sent = this.sql.exec(
      'SELECT text, thrown, page, to_x, to_y, finder IS NOT NULL AS ashore FROM bottles WHERE sender = ? ORDER BY thrown DESC LIMIT 20',
      island.key,
    ).toArray();
    const kit = island.kit;
    const knows = (a) => kit.abilities.includes(a);
    const shelf = rows.filter((r) => r.opened != null);
    // Reading hands: number each distinct hand among the letters from others on your shelf.
    const hands = new Map();
    if (knows('hands')) {
      for (const r of shelf) {
        if (r.sender === island.key || r.old) continue;
        hands.set(r.hand, (hands.get(r.hand) ?? 0) + 1);
      }
    }
    const handIds = [...hands.keys()];
    const event = eventAt(now);
    const tideNow = Math.floor(now / TIDE_MS);
    return {
      now,
      clock: { day: c.day, part: c.part, tide: c.tide, ebbing: c.ebbing, words: tideWords(c), dayMs: TIDE_MS * 2 },
      island: { name: island.name, hand: island.hand, emblem: island.emblem, supplies: island.supplies, curios: island.curios, joined: island.created },
      beach: rows.filter((r) => r.opened == null).map((r) => ({ id: r.id, shore: r.shore, old: Boolean(r.old) })),
      shelf: shelf.map((r) => {
        const letter = {
          id: r.id, text: r.text, name: r.sender_name, hand: r.hand, emblem: r.emblem, marked: Boolean(r.marked),
          own: r.sender === island.key, old: Boolean(r.old), shore: r.shore, part: r.part, tide: r.tide, landed: r.landed, opened: r.opened,
          replyTo: r.original ? excerpt(r.original) : null,
          // An old bottle is the page itself; a letter may have a copied page folded in.
          page: r.page && !r.old ? pageView(r.page) : null,
          title: r.old ? page(r.page)?.title ?? null : null,
        };
        if (hands.has(r.hand)) letter.handOf = { mark: handIds.indexOf(r.hand) + 1, letters: hands.get(r.hand) };
        return letter;
      }),
      sent: sent.map((s) => ({
        text: excerpt(s.text), thrown: s.thrown, ashore: Boolean(s.ashore), page: s.page ? page(s.page)?.title ?? null : null,
        ...(knows('currents') ? { rest: restWords(island, { x: s.to_x, y: s.to_y }) } : {}),
      })),
      kit: {
        fish: kit.fish, bones: kit.bones, glue: kit.glue, hook: kit.hook,
        casts: castsPerTide(kit.abilities) - (kit.fishedTide === tideNow ? kit.casts : 0),
        hookCost: BONE_HOOK_COST, glueCost: GLUE_COST,
      },
      abilities: kit.abilities.map((a) => ({ id: a, ...ABILITIES[a] })),
      journal: kit.pages.map(pageView).filter(Boolean),
      event: event ? { kind: event.kind, name: EVENTS[event.kind].name, words: EVENTS[event.kind].words, ends: event.end } : null,
      sign: event ? null : signAt(now),
      forecast: knows('signs') ? upcoming(now, FORECAST_TIDES).map((e) => ({ kind: e.kind, name: EVENTS[e.kind].name, start: e.start })) : null,
    };
  }
}

const SUPPLY_FOUND = {
  bottles: 'an empty bottle', corks: 'a cork', paper: 'a dry sheet of paper', ink: 'a pouch of cuttlefish ink',
};

function kitOf(json = '{}') {
  const k = typeof json === 'string' ? JSON.parse(json) : json;
  return {
    fish: k.fish ?? 0, bones: k.bones ?? 0, glue: k.glue ?? 0, hook: Boolean(k.hook),
    pages: k.pages ?? [], abilities: k.abilities ?? [], fishedTide: k.fishedTide ?? null, casts: k.casts ?? 0,
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
