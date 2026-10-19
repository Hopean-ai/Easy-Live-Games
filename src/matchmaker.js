import { DurableObject } from 'cloudflare:workers';
import { newRoomCode } from './codes.js';

// Quick match: one Durable Object per game (named by the game id). Each player waiting for an
// opponent holds a hibernatable WebSocket here; the moment a second player arrives the two oldest
// are given a fresh room code and both sockets close. The queue lives in the sockets themselves,
// so there are no timers, no storage, and nothing keeps the object awake while players wait.
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
    // The router sets X-Player to the account name, or to the guest's per-tab token.
    const who = request.headers.get('X-Player') || crypto.randomUUID();
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

    const [first, second] = this.waiting();
    if (first && second) {
      const msg = JSON.stringify({ t: 'matched', room: newRoomCode() });
      for (const ws of [first, second]) {
        try {
          ws.send(msg);
          ws.close(1000, 'Matched');
        } catch {
          // Gone already; its partner will find nobody in the room and can queue again.
        }
      }
    } else {
      server.send(JSON.stringify({ t: 'queued' }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  // Open sockets in the order their players joined the queue.
  waiting() {
    return this.ctx
      .getWebSockets()
      .filter((ws) => ws.readyState === WebSocket.OPEN)
      .sort((a, b) => a.deserializeAttachment().joined - b.deserializeAttachment().joined);
  }

  async webSocketMessage() {}

  async webSocketClose() {}
}
