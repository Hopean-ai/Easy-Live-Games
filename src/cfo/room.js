import { DurableObject } from 'cloudflare:workers';
import { CONFIG, MONEY_SCALE, ISLAND_START, ISLAND_SIZE, LANDMARKS, SQUARES, SETS, MODES, ZONES, RETAIL, SUPPLY, CREDIT, WIDGET_TIERS, RARITIES, FRAUD_CARDS, MARKET_CARDS, PERSONAL_CARDS, BOARD_SIZE, BOARD, PLANNED_MOVE, HEDGES, HEDGE_RATES, PROFILES, MODULES } from './data.js';
import { createGame, act, timeout, viewFor, winOptions, moduleOptions, ACCOUNTS, INCOME_FIELDS, BALANCE_FIELDS, SCORECARD } from './rules.js';
import { sanitizeName } from '../names.js';
import { isAdmin, hostSeat } from '../admin.js';
import { robloxBoard, robloxState, cleanRobloxRequest, STALE_MS, BRIDGE_VERSION } from './roblox.js';

const MAX_MESSAGE_BYTES = 4096; // a full set of statements with decimals is about 600 bytes
const CLAUDE_NAME = /^Claude \d+$/; // the names Claude players join under
const CLAUDE_COOLDOWN_MS = 60_000; // one call for Claude players a minute, so a double tap starts one run
// Miles: no turn time limits. A player can take as long as they like, even with the tab closed.
// An optional turn timer (CONFIG.turnSeconds) can be switched back on; it is off.

// One Durable Object per CFO room. Turn-based, so unlike Pong there is no loop: each action is
// applied, the state is saved, and every player is sent their own view of it. The state lives in
// storage so a hibernated or restarted room picks up exactly where it was.
export class CfoRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = { status: 'waiting', seats: [], expect: 0, game: null, options: defaultOptions() };
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
    const account = request.headers.get('X-Player-Account')?.toLowerCase() ?? null;
    const guest = !account;
    this.room.code ??= request.headers.get('X-Room-Code');
    // Quick match says how many players it sent here; the game starts once they have all arrived.
    const expect = Number(url.searchParams.get('expect'));
    if (this.room.status === 'waiting' && !this.room.seats.length && expect >= CONFIG.minPlayers && expect <= CONFIG.maxPlayers) {
      this.room.expect = expect;
    }

    this.pruneRoblox();
    const { 0: client, 1: server } = new WebSocketPair();
    const seat = this.claimSeat(token, name, account);
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
    if (seat !== null && account) this.refreshList = true; // keeps the game fresh in their list
    await this.changed();
    return new Response(null, { status: 101, webSocket: client });
  }

  // Called by the router when an admin asks for Claude players (see src/claude.js). In a lobby it
  // names new players for the free seats; mid-game it names the Claude players already seated, so
  // a new run can reconnect them. Returns the names, or an error to show the admin.
  async claudePlayers(count) {
    const r = this.room;
    const now = Date.now();
    if (now - (r.claudeAt ?? 0) < CLAUDE_COOLDOWN_MS) return { error: 'Claude players were just called. Give them a minute to arrive.' };
    const isClaude = (s) => s.guest && CLAUDE_NAME.test(s.name);
    let names;
    if (r.status === 'waiting') {
      const free = CONFIG.maxPlayers - r.seats.length;
      if (free <= 0) return { error: 'The room is full.' };
      const taken = new Set(r.seats.map((s) => s.name.toLowerCase()));
      names = [];
      for (let i = 1; names.length < Math.min(count, free) && i <= CONFIG.maxPlayers * 2; i++) {
        if (!taken.has(`claude ${i}`)) names.push(`Claude ${i}`);
      }
    } else if (r.status === 'playing') {
      names = r.seats.filter((s, i) => isClaude(s) && !r.game?.players[i]?.out && !this.socketsFor(i).length).map((s) => s.name);
      if (!names.length) return { error: 'No Claude players are waiting to reconnect.' };
    } else {
      return { error: 'This game is over.' };
    }
    r.claudeAt = now;
    await this.ctx.storage.put('room', r);
    return { names, status: r.status };
  }

  // A player gets their seat back by the same tab's token or, when signed in, by their account,
  // so they can rejoin from another tab or device. The newest connection takes the seat over.
  claimSeat(token, name, account) {
    const seats = this.room.seats;
    const guest = !account;
    const admin = isAdmin(this.env, account);
    let mine = seats.findIndex((s) => s.token === token);
    if (mine < 0 && account) mine = seats.findIndex((s) => s.account === account);
    if (mine >= 0) {
      seats[mine].token = token;
      if (account && !seats[mine].account && seats[mine].name.toLowerCase() === account) seats[mine].account = account;
      Object.assign(seats[mine], this.room.status === 'waiting' ? { name, guest, account, admin } : {});
      return mine;
    }
    if (this.room.status !== 'waiting' || seats.length >= CONFIG.maxPlayers) return null; // spectate
    seats.push({ token, name, guest, account, admin });
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

    const { error, changed } = this.apply(seat, msg);
    if (error) send(ws, { t: 'error', text: error });
    if (changed) await this.changed();
  }

  // One message from a seated player, from a WebSocket or the Roblox game. Returns an error to show
  // that player, and whether the room changed.
  apply(seat, msg) {
    if (msg?.t === 'start') {
      // The host (the first admin to join, else the first player) decides when to start.
      this.pruneRoblox();
      if (this.room.status !== 'waiting' || seat !== hostSeat(this.room.seats)) return {};
      if (this.room.seats.length < CONFIG.minPlayers) return { error: `At least ${CONFIG.minPlayers} players are needed.` };
      this.start();
    } else if (msg?.t === 'again') {
      if (this.room.status !== 'over') return {};
      this.room = { status: 'waiting', seats: this.connectedSeats(), expect: 0, game: null, options: this.room.options, code: this.room.code, listed: this.room.listed, version: this.room.version };
      this.reseat();
    } else if (msg?.t === 'option') {
      // Only an admin host can change the room's options; everyone else plays with the defaults.
      if (this.room.status !== 'waiting' || seat !== hostSeat(this.room.seats) || !this.room.seats[seat]?.admin) return {};
      const o = { ...this.room.options };
      if ('autoStatements' in msg) o.autoStatements = Boolean(msg.autoStatements);
      for (const k of ['valueTarget', 'maxYears']) if (k in msg) o[k] = msg[k];
      if (msg.modules && typeof msg.modules === 'object') o.modules = { ...o.modules, ...msg.modules };
      const w = winOptions(o);
      this.room.options = { autoStatements: Boolean(o.autoStatements), valueTarget: w.valueTarget, maxYears: w.maxYears, modules: moduleOptions(o.modules) };
    } else if (msg?.t === 'act') {
      if (this.room.status !== 'playing') return {};
      // If a rule ever throws, put the game back as it was rather than saving half an action.
      const before = structuredClone(this.room.game);
      let err;
      try {
        err = act(this.room.game, seat, msg);
      } catch (e) {
        console.error('CFO action failed', msg?.a, e);
        this.room.game = before;
        return { error: 'That move could not be made.' };
      }
      if (err) return { error: String(err) };
      if (this.room.game.phase === 'over') this.room.status = 'over';
    } else {
      return {};
    }
    return { changed: true };
  }

  // Called by the router for the Roblox game server (see src/cfo/roblox.js). Roblox players hold a
  // seat by their Roblox user id and show as connected while their server keeps polling.
  async roblox(body) {
    const req = cleanRobloxRequest(body);
    if (typeof req === 'string') return { error: req };
    const r = this.room;
    r.code ??= body.code; // set by the router from the URL
    const now = Date.now();
    let changed = false;
    const seatOf = (userId) => r.seats.findIndex((s) => s.roblox === userId);
    const see = (i) => {
      if (i < 0) return;
      if (now - (r.seats[i].seen ?? 0) > STALE_MS) changed = true; // they show as back
      r.seats[i].seen = now;
    };
    // The players this request is for are here, whoever else has gone quiet.
    for (const id of req.userIds ?? [req.userId]) see(seatOf(id));
    if (this.pruneRoblox(now)) changed = true;
    let reply = {};
    if (req.op === 'join') {
      let seat = seatOf(req.userId);
      if (seat < 0 && r.status === 'waiting' && r.seats.length < CONFIG.maxPlayers) {
        r.seats.push({ token: crypto.randomUUID(), name: req.name, guest: true, account: null, admin: false, roblox: req.userId, seen: now });
        seat = r.seats.length - 1;
        changed = true;
        if (r.expect && r.seats.length >= r.expect) this.start();
      }
      reply = { seat: seat >= 0 ? seat : null, board: robloxBoard() };
    } else if (req.op === 'leave') {
      const seat = seatOf(req.userId);
      if (seat >= 0 && r.status === 'waiting') {
        r.seats.splice(seat, 1);
        this.reseat();
        changed = true;
      }
    } else if (req.op === 'act') {
      const seat = seatOf(req.userId);
      if (seat < 0) return { error: 'You are watching this game.' };
      const res = this.apply(seat, req.msg);
      if (res.changed) changed = true;
      reply = { error: res.error ?? null };
    }
    if (changed) await this.changed();
    const version = this.room.version ?? 0;
    if (req.op === 'poll') {
      if (req.since === version) return { version, same: true };
      const host = hostSeat(this.room.seats);
      const views = Object.fromEntries(req.userIds.map((id) => {
        const seat = this.room.seats.findIndex((s) => s.roblox === id);
        return [id, robloxState(this.room, seat >= 0 ? seat : null, host)];
      }));
      return { version, bridge: BRIDGE_VERSION, views };
    }
    return { ...reply, version, bridge: BRIDGE_VERSION };
  }

  // In the lobby, a Roblox player whose server stopped polling gives up their seat, as a closed
  // tab does. Returns whether anyone was removed.
  pruneRoblox(now = Date.now()) {
    if (this.room.status !== 'waiting') return false;
    const before = this.room.seats.length;
    this.room.seats = this.room.seats.filter((s) => !s.roblox || now - (s.seen ?? 0) <= STALE_MS);
    if (this.room.seats.length === before) return false;
    this.reseat();
    return true;
  }

  // A seat counts as here while a socket is open on it or, for Roblox players, while polled.
  isConnected(seat) {
    const s = this.room.seats[seat];
    if (s?.roblox) return Date.now() - (s.seen ?? 0) <= STALE_MS;
    return this.socketsFor(seat).length > 0;
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
    return this.room.seats.filter((_, i) => this.isConnected(i));
  }

  start() {
    this.room.status = 'playing';
    // An admin may have set options and then left the lobby; without one, the defaults apply.
    if (!this.room.seats.some((s) => s.admin)) this.room.options = defaultOptions();
    this.room.game = createGame(this.room.seats.map((s) => s.name), undefined, this.room.options ?? {});
    // Roblox has no bookkeeping screens yet, so Roblox players start with a bookkeeper.
    this.room.seats.forEach((s, i) => {
      if (s.roblox) act(this.room.game, i, { a: 'outsource', on: true });
    });
  }

  async alarm() {
    const g = this.room.game;
    if (this.room.status !== 'playing' || !g) return;
    if (Date.now() < (this.room.deadline ?? 0) - 50) return this.schedule();
    timeout(g);
    if (g.phase === 'over') this.room.status = 'over';
    await this.changed();
  }

  // Sets the alarm for the current turn when a turn timer is configured.
  async schedule() {
    const g = this.room.game;
    let ms = 0;
    if (this.room.status === 'playing' && g) {
      if (CONFIG.turnSeconds > 0) ms = CONFIG.turnSeconds * 1000;
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
    this.room.version = (this.room.version ?? 0) + 1; // Roblox servers poll for this changing
    await this.schedule();
    await this.listGames();
    await this.ctx.storage.put('room', this.room);
    this.broadcast();
  }

  // Keeps each signed-in player's list of games in progress up to date: a game is listed while
  // it is being played and the player is still in it.
  async listGames() {
    const r = this.room;
    if (!r.code || !this.env.ACCOUNTS) return;
    const want = r.status === 'playing'
      ? [...new Set(r.seats.filter((s, i) => s.account && !r.game?.players[i]?.out).map((s) => s.account))]
      : [];
    const prev = r.listed ?? [];
    const add = this.refreshList ? want : want.filter((a) => !prev.includes(a));
    const drop = prev.filter((a) => !want.includes(a));
    if (!add.length && !drop.length) return;
    const players = r.seats.map((s) => s.name).join(', ');
    const accounts = this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName('accounts'));
    try {
      await Promise.all([
        ...add.map((a) => accounts.setGame(a, 'cfo', r.code, players, true)),
        ...drop.map((a) => accounts.setGame(a, 'cfo', r.code, players, false)),
      ]);
      r.listed = want;
      this.refreshList = false;
    } catch (e) {
      console.error('Could not update the game list', e); // the game itself carries on
    }
  }

  socketsFor(seat, except) {
    return this.ctx.getWebSockets().filter(
      (ws) => ws !== except && ws.readyState === WebSocket.OPEN && ws.deserializeAttachment()?.seat === seat,
    );
  }

  broadcast() {
    const seats = this.room.seats.map((s, i) => ({ name: s.name, guest: s.guest, admin: Boolean(s.admin), connected: this.isConnected(i), platform: s.roblox ? 'roblox' : 'web' }));
    const base = { t: 'state', status: this.room.status, seats, host: hostSeat(this.room.seats), expect: this.room.expect, options: this.room.options ?? {}, deadline: this.room.deadline ?? null };
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const seat = ws.deserializeAttachment()?.seat ?? null;
      send(ws, { ...base, game: this.room.game ? viewFor(this.room.game, seat ?? -1) : null });
    }
  }
}

// The fixed parts of the game the browser needs to draw it, sent once per connection.
const RULES = {
  config: CONFIG, size: BOARD_SIZE, retail: RETAIL, supply: SUPPLY, credit: CREDIT, widgetTiers: WIDGET_TIERS, squares: SQUARES, sets: SETS, modes: MODES, zones: ZONES, rarities: RARITIES,
  fraud: FRAUD_CARDS, market: MARKET_CARDS, personal: PERSONAL_CARDS, accounts: ACCOUNTS,
  incomeFields: INCOME_FIELDS, balanceFields: BALANCE_FIELDS, scorecard: SCORECARD, board: BOARD, plannedMove: PLANNED_MOVE, hedges: HEDGES, hedgeRates: HEDGE_RATES, profiles: PROFILES, modules: MODULES,
  islandStart: ISLAND_START, islandSize: ISLAND_SIZE, landmarks: LANDMARKS, moneyScale: MONEY_SCALE,
};

function send(ws, msg) {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Socket already gone.
  }
}

function defaultOptions() {
  return { autoStatements: false, valueTarget: CONFIG.valueTarget, maxYears: CONFIG.maxYears, modules: moduleOptions() };
}
