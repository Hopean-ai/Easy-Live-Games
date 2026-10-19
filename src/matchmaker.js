import { DurableObject } from 'cloudflare:workers';
import { newRoomCode } from './codes.js';

// Once enough players for a game are waiting but the table isn't full, wait this long for more.
export const FILL_WAIT_MS = 15_000;

// Quick match: one Durable Object per game (named by the game id). Each player waiting holds a
// hibernatable WebSocket here. When the game's table is full, or the minimum has waited
// FILL_WAIT_MS for more, the oldest players are given a fresh room code and their sockets close.
// The queue lives in the sockets themselves, so nothing keeps the object awake while players wait.
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
    let queue = this.waiting().filter((ws) => ws !== gone);
    while (queue.length >= max) {
      this.match(queue.slice(0, max));
      queue = queue.slice(max);
    }
    if (queue.length >= min && waited) {
      this.match(queue);
      queue = [];
    }
    if (queue.length >= min) {
      const startsAt = (await this.ctx.storage.getAlarm()) ?? Date.now() + FILL_WAIT_MS;
      await this.ctx.storage.setAlarm(startsAt);
      this.tell(queue, { t: 'queued', waiting: queue.length, max, startsAt });
    } else {
      await this.ctx.storage.deleteAlarm();
      this.tell(queue, { t: 'queued', waiting: queue.length, max });
    }
  }

  match(players) {
    const msg = JSON.stringify({ t: 'matched', room: newRoomCode(), players: players.length });
    for (const ws of players) {
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
