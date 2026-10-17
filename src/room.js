import { DurableObject } from 'cloudflare:workers';
import {
  createGame, setInput, step, snapshot, buy, sideStats, SIDES, FIELD, PADDLE, BALL, WIN_SCORE, SERVE_DELAY,
} from './game.js';
import { SKILLS } from './skills.js';
import { sanitizeName } from './names.js';

export const TICK_MS = 1000 / 60;
export const BROADCAST_EVERY = 2; // physics at 60 Hz, state to clients at 30 Hz
export const RECONNECT_GRACE_MS = 15_000;
const MAX_MESSAGE_BYTES = 512;
const MAX_DT = 0.05;

// One Durable Object per room code. It is the only place the game is simulated: clients send
// paddle input and render the snapshots it broadcasts, so the two players can never disagree
// about where the ball is or what the score is.
export class PongRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.status = 'waiting'; // waiting | playing | paused | over
    this.game = null;
    this.seats = { left: null, right: null }; // { token, name }
    this.graceTimers = { left: null, right: null };
    this.rematch = new Set();
    this.loop = null;
    this.lastTick = 0;
    this.tick = 0;
    this.seq = 0;
    this.acks = { left: 0, right: 0 }; // last input seq applied per side, for client reconciliation
    this.overReason = null;

    // Sockets survive hibernation but memory does not, so rebuild the seats from them.
    for (const ws of ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a?.side) this.seats[a.side] = { token: a.token, name: a.name };
    }
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

    const { 0: client, 1: server } = new WebSocketPair();
    const side = this.claimSeat(token, name);

    // A player reconnecting (new tab, flaky network) replaces their old socket. The message comes
    // first because some stacks are slow to deliver the close event for a server-initiated close.
    if (side) {
      for (const ws of this.socketsFor(side)) {
        send(ws, { t: 'replaced' });
        ws.close(4000, 'Replaced by a newer connection');
      }
    }

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ side, token, name });
    send(server, {
      t: 'welcome', side, token, field: FIELD, paddle: PADDLE, ball: BALL, winScore: WIN_SCORE, skills: SKILLS,
    });
    if (this.game) send(server, this.stateMessage());
    if (this.game) send(server, this.skillsMessage());
    if (this.status === 'over') send(server, { t: 'over', winner: this.game.winner, reason: this.overReason });

    this.seatsChanged();
    return new Response(null, { status: 101, webSocket: client });
  }

  claimSeat(token, name) {
    for (const side of SIDES) {
      if (this.seats[side]?.token === token) {
        this.seats[side].name = name;
        clearTimeout(this.graceTimers[side]);
        this.graceTimers[side] = null;
        return side;
      }
    }
    for (const side of SIDES) {
      if (!this.seats[side]) {
        this.seats[side] = { token, name };
        if (this.status === 'over') this.status = 'waiting'; // new opponent: start a fresh game
        return side;
      }
    }
    return null; // room full: spectate
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const side = ws.deserializeAttachment()?.side;

    switch (msg?.t) {
      case 'ping':
        send(ws, { t: 'pong', id: msg.id, now: Date.now() });
        break;
      case 'input':
        if (side && this.game && this.status === 'playing') {
          setInput(this.game, side, msg.dir);
          if (Number.isSafeInteger(msg.seq)) this.acks[side] = msg.seq;
        }
        break;
      case 'skill':
        // Upgrades are validated and applied here; the client only names the one it wants.
        if (side && this.game && this.status === 'playing' && typeof msg.id === 'string' && buy(this.game, side, msg.id)) {
          this.broadcast(this.skillsMessage());
          this.broadcast(this.stateMessage());
        }
        break;
      case 'rematch':
        // After hibernation the room wakes as 'waiting'; seatsChanged then simply starts a game.
        if (side && (this.status === 'over' || this.status === 'waiting')) {
          if (this.status === 'over') this.rematch.add(side);
          this.seatsChanged();
        }
        break;
    }
  }

  async webSocketClose(ws) {
    this.socketClosed(ws);
  }

  async webSocketError(ws) {
    this.socketClosed(ws);
  }

  socketClosed(ws) {
    const side = ws.deserializeAttachment()?.side;
    if (!side || this.socketsFor(side, ws).length > 0) return; // spectator, or a replaced socket

    if (this.status === 'playing' || this.status === 'paused') {
      // Hold the seat so the player can come back; the game waits for them.
      this.pause();
      clearTimeout(this.graceTimers[side]);
      this.graceTimers[side] = setTimeout(() => this.forfeit(side), RECONNECT_GRACE_MS);
    } else {
      this.seats[side] = null;
      this.rematch.delete(side);
      if (this.status === 'over') this.status = 'waiting';
    }
    this.seatsChanged();
  }

  // Open sockets currently holding `side`, optionally ignoring one that is closing.
  socketsFor(side, except) {
    return this.ctx.getWebSockets().filter(
      (ws) => ws !== except && ws.readyState === WebSocket.OPEN && ws.deserializeAttachment()?.side === side,
    );
  }

  connected(side) {
    return Boolean(this.seats[side]) && this.socketsFor(side).length > 0;
  }

  seatsChanged() {
    const bothHere = SIDES.every((s) => this.connected(s));
    if (bothHere && this.status === 'waiting') this.start();
    else if (bothHere && this.status === 'paused') this.resume();
    else if (bothHere && this.status === 'over' && this.rematch.size === 2) this.start();
    this.broadcast(this.lobbyMessage());
  }

  start() {
    this.game = createGame();
    this.rematch.clear();
    this.status = 'playing';
    this.broadcast(this.skillsMessage());
    this.startLoop();
  }

  pause() {
    this.status = 'paused';
    this.stopLoop();
    if (this.game) for (const s of SIDES) setInput(this.game, s, 0);
    if (this.game) this.broadcast(this.stateMessage());
  }

  resume() {
    this.status = 'playing';
    this.game.serveIn = Math.max(this.game.serveIn, SERVE_DELAY); // a beat before play restarts
    this.startLoop();
  }

  forfeit(side) {
    this.graceTimers[side] = null;
    this.seats[side] = null;
    const other = side === 'left' ? 'right' : 'left';
    if (this.game && this.connected(other)) {
      this.game.winner = other;
      this.finish('forfeit');
    } else {
      this.game = null;
      this.status = 'waiting';
    }
    this.seatsChanged();
  }

  finish(reason) {
    this.status = 'over';
    this.overReason = reason;
    this.stopLoop();
    this.broadcast(this.stateMessage());
    this.broadcast({ t: 'over', winner: this.game.winner, reason });
  }

  startLoop() {
    this.stopLoop();
    this.lastTick = Date.now();
    this.loop = setInterval(() => this.update(), TICK_MS);
  }

  stopLoop() {
    clearInterval(this.loop);
    this.loop = null;
  }

  update() {
    const now = Date.now();
    const dt = Math.min((now - this.lastTick) / 1000, MAX_DT);
    this.lastTick = now;
    const scorer = step(this.game, dt);
    if (this.game.winner) {
      this.finish('score');
      return;
    }
    this.tick += 1;
    if (scorer) this.broadcast(this.skillsMessage());
    if (scorer || this.tick % BROADCAST_EVERY === 0) this.broadcast(this.stateMessage());
  }

  stateMessage() {
    this.seq += 1;
    return {
      t: 'state', seq: this.seq, now: Date.now(), status: this.status,
      al: this.acks.left, ar: this.acks.right, ...snapshot(this.game),
    };
  }

  skillsMessage() {
    const side = (s) => ({ ...this.game.skills[s], stats: sideStats(this.game, s) });
    return { t: 'skills', left: side('left'), right: side('right') };
  }

  lobbyMessage() {
    const player = (side) =>
      this.seats[side] ? { name: this.seats[side].name, connected: this.connected(side) } : null;
    return {
      t: 'lobby',
      status: this.status,
      players: { left: player('left'), right: player('right') },
      rematch: [...this.rematch],
      spectators: this.ctx.getWebSockets().filter((ws) => !ws.deserializeAttachment()?.side).length,
    };
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(data);
        } catch {
          // The close handler will clean up.
        }
      }
    }
  }
}

function send(ws, msg) {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Socket already gone.
  }
}
