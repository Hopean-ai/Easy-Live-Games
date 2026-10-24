import { DurableObject } from 'cloudflare:workers';
import { newRoomCode } from './codes.js';

// Once enough players for a game are waiting but the table isn't full, wait this long for more.
export const FILL_WAIT_MS = 15_000;
// A player queueing over HTTP who hasn't asked for this long has left the queue.
export const HTTP_STALE_MS = 10_000;

// Quick match: one Durable Object per game (named by the game id). Each player waiting holds a
// hibernatable WebSocket here. When the game's table is full, or the minimum has waited
// FILL_WAIT_MS for more, the oldest players are given a fresh room code and their sockets close.
// The queue lives in the sockets themselves, so nothing keeps the object awake while players wait.
// Players from the Roblox game can't hold a socket here, so they queue over HTTP instead (httpQueue):
// their server asks every couple of seconds, and a place counts while it keeps asking.
export class Matchmaker extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Keepalive pings are answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    // The router sets X-Player to the account name, or to the guest's per-tab token, and the
    // table size from the game's entry in games.js.
    const who = request.headers.get('X-Player') || crypto.randomUUID();
    const min = Number(request.headers.get('X-Match-Min')) || 2;
    const max = Math.max(min, Number(request.headers.get('X-Match-Max')) || min);
    await this.ctx.storage.put('size', { min, max });
    const { 0: client, 1: server } = new WebSocketPair();

    // The same player queueing again (another tab, a reload) takes their old place's turn.
    for (const ws of this.waiting()) {
      if (ws.deserializeAttachment().who !== who) continue;
      // Told first: some stacks are slow to deliver the close event for a server-initiated close.
      ws.send(JSON.stringify({ t: 'replaced' }));
      ws.close(4000, 'Queued from another tab');
    }
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ who, joined: Date.now() });

    await this.update({ min, max });
    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm() {
    const size = await this.ctx.storage.get('size');
    if (size) await this.update(size, true);
  }

  // Makes every match the queue allows, then tells whoever is left how the queue stands.
  async update({ min, max }, waited = false, gone = null) {
    const now = Date.now();
    const http = (await this.ctx.storage.get('http')) ?? {};
    // A match nobody came back for is dropped after a minute.
    for (const [who, e] of Object.entries(http)) if (now - e.seen > (e.match ? 60_000 : HTTP_STALE_MS)) delete http[who];
    let queue = [
      ...this.waiting().filter((ws) => ws !== gone).map((ws) => ({ ws, joined: ws.deserializeAttachment().joined })),
      ...Object.entries(http).filter(([, e]) => !e.match).map(([who, e]) => ({ who, joined: e.joined })),
    ].sort((a, b) => a.joined - b.joined);
    while (queue.length >= max) {
      this.match(queue.slice(0, max), http);
      queue = queue.slice(max);
    }
    if (queue.length >= min && waited) {
      this.match(queue, http);
      queue = [];
    }
    await this.ctx.storage.put('http', http);
    const sockets = queue.filter((q) => q.ws).map((q) => q.ws);
    if (queue.length >= min) {
      const startsAt = (await this.ctx.storage.getAlarm()) ?? Date.now() + FILL_WAIT_MS;
      await this.ctx.storage.setAlarm(startsAt);
      this.tell(sockets, { t: 'queued', waiting: queue.length, max, startsAt });
      return { waiting: queue.length, max, startsAt };
    }
    await this.ctx.storage.deleteAlarm();
    this.tell(sockets, { t: 'queued', waiting: queue.length, max });
    return { waiting: queue.length, max };
  }

  // One request from the Roblox game server for one of its players (see src/router.js): `join` or
  // `poll` keeps their place and returns the queue, or the room once matched; `leave` gives it up.
  async httpQueue({ who, op, min, max }) {
    await this.ctx.storage.put('size', { min, max });
    const http = (await this.ctx.storage.get('http')) ?? {};
    const mine = http[who];
    if (mine?.match) {
      delete http[who];
      await this.ctx.storage.put('http', http);
      return { matched: mine.match };
    }
    if (op === 'leave') {
      delete http[who];
    } else {
      http[who] = { joined: mine?.joined ?? Date.now(), seen: Date.now() };
    }
    await this.ctx.storage.put('http', http);
    const status = await this.update({ min, max });
    const now = (await this.ctx.storage.get('http'))?.[who];
    if (now?.match) return this.httpQueue({ who, op: 'poll', min, max });
    return op === 'leave' ? { left: true } : { queued: status };
  }

  match(players, http) {
    const match = { room: newRoomCode(), players: players.length };
    const msg = JSON.stringify({ t: 'matched', ...match });
    for (const { ws, who } of players) {
      if (who) {
        http[who].match = match; // handed over on that player's next request
        continue;
      }
      try {
        ws.send(msg);
        ws.close(1000, 'Matched');
      } catch {
        // Gone already; the room starts without them once the others ask to.
      }
    }
  }

  tell(players, msg) {
    const data = JSON.stringify(msg);
    for (const ws of players) {
      try {
        ws.send(data);
      } catch {
        // Gone; its close handler updates the queue.
      }
    }
  }

  // Open sockets in the order their players joined the queue.
  waiting() {
    return this.ctx
      .getWebSockets()
      .filter((ws) => ws.readyState === WebSocket.OPEN)
      .sort((a, b) => a.deserializeAttachment().joined - b.deserializeAttachment().joined);
  }

  async webSocketMessage() {}

  async webSocketClose(ws) {
    await this.left(ws);
  }

  async webSocketError(ws) {
    await this.left(ws);
  }

  async left(ws) {
    const size = await this.ctx.storage.get('size');
    if (size) await this.update(size, false, ws);
  }
}
