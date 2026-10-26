import { DurableObject } from 'cloudflare:workers';
import {
  ACTIVE_MS, DIRECTIONS, MAX_LETTER, REDRIFT_MS, STARTER_SUPPLIES, SUPPLIES, TIDE_MS,
  clock, curio, directionTo, drift, finder, flotsam, placeIsland, shore, tideWords, uniqueCurio,
} from './world.js';
import { CASTAWAYS, writeReply } from './castaways.js';

// A castaway answers a letter a little while after it washes up.
const REPLY_DELAY_MS = [15 * 60 * 1000, 45 * 60 * 1000];
const REPLIES_PER_ALARM = 3;
const SHELF_LIMIT = 300;
const CASTAWAY_STOCK_MAX = 10;
const NEED = 'You need a bottle, a cork, a sheet of paper and some ink to send a letter.';

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
    for (let i = 0; i < Math.min(2, tideNow - island.tides); i++) {
      const what = flotsam(this.rand);
      if (what === 'curio') {
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

  async throwBottle(account, { text, signed, dir, strength, replyTo } = {}) {
    const now = this.now();
    const island = this.island(account);
    if (!island) return { error: 'Visit your island first.' };
    const letter = typeof text === 'string' ? text.trim() : '';
    if (!letter) return { error: 'Write something first.' };
    if (letter.length > MAX_LETTER) return { error: `Letters can be at most ${MAX_LETTER} characters.` };
    if (!Number.isInteger(dir) || dir < 0 || dir >= DIRECTIONS.length) return { error: 'Pick a direction to throw.' };
    const s = Number(strength);
    if (!Number.isFinite(s)) return { error: 'Pick how hard to throw.' };
    if (SUPPLIES.some((k) => island.supplies[k] < 1)) return { error: NEED };

    let toward = null;
    let answers = null;
    if (replyTo != null) {
      const original = this.sql.exec('SELECT id, from_x, from_y FROM bottles WHERE id = ? AND finder = ? AND opened IS NOT NULL', Number(replyTo), island.key).toArray()[0];
      if (!original) return { error: 'That letter is not on your shelf.' };
      toward = { x: original.from_x, y: original.from_y };
      answers = original.id;
    }
    for (const k of SUPPLIES) island.supplies[k]--;
    this.saveIsland(island);
    this.launch(island, { text: letter, signed: Boolean(signed), dir, strength: Math.min(1, Math.max(0.1, s)), toward, answers, now });
    await this.schedule();
    return this.state(island, now);
  }

  async openBottle(account, id) {
    const now = this.now();
    const island = this.island(account);
    if (!island) return { error: 'Visit your island first.' };
    const row = this.sql.exec('SELECT id FROM bottles WHERE id = ? AND finder = ? AND opened IS NULL', Number(id), island.key).toArray()[0];
    if (!row) return { error: 'That bottle is not on your beach.' };
    this.sql.exec('UPDATE bottles SET opened = ? WHERE id = ?', now, row.id);
    // Every bottle you open leaves you its glass and cork, so answering costs less than writing first.
    island.supplies.bottles++;
    island.supplies.corks++;
    this.saveIsland(island);
    return { ...this.state(island, now), opened: row.id };
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

  launch(island, { text, signed, dir, strength, toward, answers, now }) {
    const to = drift({ from: island, dir, strength, t: now, rand: this.rand, toward });
    this.sql.exec(
      `INSERT INTO bottles (sender, sender_name, text, hand, emblem, marked, reply_to, from_x, from_y, to_x, to_y, thrown, rest, arrives)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      island.key, signed ? island.name : null, text, island.hand, island.emblem, island.castaway ? 1 : 0, answers,
      island.x, island.y, to.x, to.y, now, to.arrives, to.arrives,
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
    return row ? { ...row, supplies: JSON.parse(row.supplies), curios: JSON.parse(row.curios) } : null;
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
      supplies: { ...STARTER_SUPPLIES }, curios, tides: Math.floor(now / TIDE_MS), castaway: 0,
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
        curios: [], tides: Math.floor(now / TIDE_MS), castaway: 1,
      });
    }
  }

  saveIsland(i) {
    this.sql.exec(
      `INSERT INTO islands (key, name, x, y, created, seen, hand, emblem, supplies, curios, tides, castaway)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET seen = excluded.seen, supplies = excluded.supplies, curios = excluded.curios, tides = excluded.tides`,
      i.key, i.name, i.x, i.y, i.created, i.seen, i.hand, i.emblem, JSON.stringify(i.supplies), JSON.stringify(i.curios), i.tides, i.castaway,
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
    const sent = this.sql.exec('SELECT text, thrown, finder IS NOT NULL AS ashore FROM bottles WHERE sender = ? ORDER BY thrown DESC LIMIT 20', island.key).toArray();
    return {
      now,
      clock: { day: c.day, part: c.part, tide: c.tide, ebbing: c.ebbing, words: tideWords(c), dayMs: TIDE_MS * 2 },
      island: { name: island.name, hand: island.hand, emblem: island.emblem, supplies: island.supplies, curios: island.curios, joined: island.created },
      beach: rows.filter((r) => r.opened == null).map((r) => ({ id: r.id, shore: r.shore })),
      shelf: rows.filter((r) => r.opened != null).map((r) => ({
        id: r.id, text: r.text, name: r.sender_name, hand: r.hand, emblem: r.emblem, marked: Boolean(r.marked),
        own: r.sender === island.key, shore: r.shore, part: r.part, tide: r.tide, landed: r.landed, opened: r.opened,
        replyTo: r.original ? excerpt(r.original) : null,
      })),
      sent: sent.map((s) => ({ text: excerpt(s.text), thrown: s.thrown, ashore: Boolean(s.ashore) })),
    };
  }
}

const SUPPLY_FOUND = {
  bottles: 'an empty bottle', corks: 'a cork', paper: 'a dry sheet of paper', ink: 'a pouch of cuttlefish ink',
};

function excerpt(text) {
  return text.length > 90 ? `${text.slice(0, 88).trimEnd()}…` : text;
}
