import { DurableObject } from 'cloudflare:workers';
import { CONFIG, ISLAND_START, ISLAND_SIZE, LANDMARKS, SQUARES, SETS, MODES, ZONES, RETAIL, WIDGET_TIERS, RARITIES, FRAUD_CARDS, MARKET_CARDS, PERSONAL_CARDS, BOARD_SIZE } from './data.js';
import { createGame, act, timeout, viewFor, winOptions, ACCOUNTS, INCOME_FIELDS, BALANCE_FIELDS } from './rules.js';
import { sanitizeName } from '../names.js';

const MAX_MESSAGE_BYTES = 4096; // a full set of statements with decimals is about 600 bytes
// An absent player's turn is played for them after this long, so one closed tab can't stall a
// game. A separate, optional turn timer (CONFIG.turnSeconds) applies to everyone when set.
export const ABSENT_TURN_MS = 30_000;

// One Durable Object per CFO room. Turn-based, so unlike Pong there is no loop: each action is
// applied, the state is saved, and every player is sent their own view of it. The state lives in
// storage so a hibernated or restarted room picks up exactly where it was.
export class CfoRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = { status: 'waiting', seats: [], expect: 0, game: null, options: { autoStatements: false, valueTarget: CONFIG.valueTarget, maxYears: CONFIG.maxYears } };
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get('room')) ?? this.room;
    });
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    const url = new URL(request.url);
    const token = /^[\w-]{8,64}$/.test(url.searchParams.get('token') ?? '')
      ? url.searchParams.get('token')
      : crypto.randomUUID();
    const name = sanitizeName(url.searchParams.get('name'));
    const guest = !request.headers.get('X-Player-Account');
    // Quick match says how many players it sent here; the game starts once they have all arrived.
    const expect = Number(url.searchParams.get('expect'));
    if (this.room.status === 'waiting' && !this.room.seats.length && expect >= CONFIG.minPlayers && expect <= CONFIG.maxPlayers) {
      this.room.expect = expect;
    }

    const { 0: client, 1: server } = new WebSocketPair();
    const seat = this.claimSeat(token, name, guest);
    if (seat !== null) {
      for (const ws of this.socketsFor(seat)) {
        send(ws, { t: 'replaced' });
        ws.close(4000, 'Replaced by a newer connection');
      }
    }
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ seat, token });
    send(server, { t: 'welcome', seat, token, rules: RULES });

    if (this.room.status === 'waiting' && this.room.expect && this.room.seats.length >= this.room.expect) this.start();
    await this.changed();
    return new Response(null, { status: 101, webSocket: client });
  }

  claimSeat(token, name, guest) {
    const seats = this.room.seats;
    const mine = seats.findIndex((s) => s.token === token);
    if (mine >= 0) {
      Object.assign(seats[mine], this.room.status === 'waiting' ? { name, guest } : {});
      return mine;
    }
    if (this.room.status !== 'waiting' || seats.length >= CONFIG.maxPlayers) return null; // spectate
    seats.push({ token, name, guest });
    return seats.length - 1;
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const seat = ws.deserializeAttachment()?.seat;
    if (seat === null || seat === undefined) return;

    if (msg?.t === 'start') {
      // The first player in a private room decides when to start.
      if (this.room.status !== 'waiting' || seat !== 0) return;
      if (this.room.seats.length < CONFIG.minPlayers) return send(ws, { t: 'error', text: `At least ${CONFIG.minPlayers} players are needed.` });
      this.start();
    } else if (msg?.t === 'again') {
      if (this.room.status !== 'over') return;
      this.room = { status: 'waiting', seats: this.connectedSeats(), expect: 0, game: null, options: this.room.options };
      this.reseat();
    } else if (msg?.t === 'option') {
      // The host chooses the room's options before the game starts.
      if (this.room.status !== 'waiting' || seat !== 0) return;
      const o = { ...this.room.options };
      if ('autoStatements' in msg) o.autoStatements = Boolean(msg.autoStatements);
      for (const k of ['valueTarget', 'maxYears']) if (k in msg) o[k] = msg[k];
      const w = winOptions(o);
      this.room.options = { autoStatements: Boolean(o.autoStatements), valueTarget: w.valueTarget, maxYears: w.maxYears };
    } else if (msg?.t === 'act') {
      if (this.room.status !== 'playing') return;
      // If a rule ever throws, put the game back as it was rather than saving half an action.
      const before = structuredClone(this.room.game);
      let err;
      try {
        err = act(this.room.game, seat, msg);
      } catch (e) {
        console.error('CFO action failed', msg?.a, e);
        this.room.game = before;
        return send(ws, { t: 'error', text: 'That move could not be made.' });
      }
      if (err) return send(ws, { t: 'error', text: String(err) });
      if (this.room.game.phase === 'over') this.room.status = 'over';
    } else {
      return;
    }
    await this.changed();
  }

  async webSocketClose(ws) {
    await this.socketClosed(ws);
  }

  async webSocketError(ws) {
    await this.socketClosed(ws);
  }

  async socketClosed(ws) {
    const seat = ws.deserializeAttachment()?.seat;
    if (seat === null || seat === undefined || this.socketsFor(seat, ws).length) return;
    // Before the game, leaving gives up the seat; during it, the seat is kept for a reconnect.
    if (this.room.status === 'waiting') {
      this.room.seats.splice(seat, 1);
      this.reseat();
    }
    await this.changed();
  }

  // Seat numbers are stored on each socket; after seats shift, renumber the sockets to match.
  reseat() {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      const seat = this.room.seats.findIndex((s) => s.token === a?.token);
      ws.serializeAttachment({ ...a, seat: seat >= 0 ? seat : null });
      send(ws, { t: 'welcome', seat: seat >= 0 ? seat : null, token: a?.token, rules: RULES });
    }
  }

  connectedSeats() {
    return this.room.seats.filter((_, i) => this.socketsFor(i).length);
  }

  start() {
    this.room.status = 'playing';
    this.room.game = createGame(this.room.seats.map((s) => s.name), undefined, this.room.options ?? {});
  }

  async alarm() {
    const g = this.room.game;
    if (this.room.status !== 'playing' || !g) return;
    if (Date.now() < (this.room.deadline ?? 0) - 50) return this.schedule();
    timeout(g);
    if (g.phase === 'over') this.room.status = 'over';
    await this.changed();
  }

  // Sets the alarm for the current turn: the turn timer if one is configured, otherwise only
  // when the player whose turn it is has gone.
  async schedule() {
    const g = this.room.game;
    let ms = 0;
    if (this.room.status === 'playing' && g) {
      if (CONFIG.turnSeconds > 0) ms = CONFIG.turnSeconds * 1000;
      if (!this.socketsFor(g.turn).length) ms = ms ? Math.min(ms, ABSENT_TURN_MS) : ABSENT_TURN_MS;
    }
    const key = g ? `${g.turn}:${g.phase}:${g.log.length}:${g.log.at(-1)}` : '';
    if (!ms) {
      this.room.deadline = null;
      this.room.turnKey = null;
      await this.ctx.storage.deleteAlarm();
      return;
    }
    // Keep the existing deadline while the same turn step is waiting.
    if (this.room.turnKey !== key || !this.room.deadline) {
      this.room.turnKey = key;
      this.room.deadline = Date.now() + ms;
    }
    await this.ctx.storage.setAlarm(this.room.deadline);
  }

  async changed() {
    await this.schedule();
    await this.ctx.storage.put('room', this.room);
    this.broadcast();
  }

  socketsFor(seat, except) {
    return this.ctx.getWebSockets().filter(
      (ws) => ws !== except && ws.readyState === WebSocket.OPEN && ws.deserializeAttachment()?.seat === seat,
    );
  }

  broadcast() {
    const seats = this.room.seats.map((s, i) => ({ name: s.name, guest: s.guest, connected: this.socketsFor(i).length > 0 }));
    const base = { t: 'state', status: this.room.status, seats, expect: this.room.expect, options: this.room.options ?? {}, deadline: this.room.deadline ?? null };
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const seat = ws.deserializeAttachment()?.seat ?? null;
      send(ws, { ...base, game: this.room.game ? viewFor(this.room.game, seat ?? -1) : null });
    }
  }
}

// The fixed parts of the game the browser needs to draw it, sent once per connection.
const RULES = {
  config: CONFIG, size: BOARD_SIZE, retail: RETAIL, widgetTiers: WIDGET_TIERS, squares: SQUARES, sets: SETS, modes: MODES, zones: ZONES, rarities: RARITIES,
  fraud: FRAUD_CARDS, market: MARKET_CARDS, personal: PERSONAL_CARDS, accounts: ACCOUNTS,
  incomeFields: INCOME_FIELDS, balanceFields: BALANCE_FIELDS,
  islandStart: ISLAND_START, islandSize: ISLAND_SIZE, landmarks: LANDMARKS,
};

function send(ws, msg) {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Socket already gone.
  }
}
