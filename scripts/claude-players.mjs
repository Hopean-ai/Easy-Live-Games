// Claude players for a CFO room. The Claude routine runs this when an admin presses "Add Claude
// players" in a lobby (see src/claude.js); it can also be run by hand:
//
//   node scripts/claude-players.mjs payload.json
//
// payload.json is what the Worker sends the routine:
//   { "game": "cfo", "base": "https://…", "room": "ABCDE", "players": [{ "name": "Claude 1", "token": "claude-…" }] }
//
// Each player joins the room over the same WebSocket the page uses and plays with src/cfo/bot.js,
// with a bookkeeper keeping its books. It keeps playing until the game ends, reconnecting if the
// line drops, and exits 0 once every player is done (game over, out, or the lobby closed).
// Behind an HTTPS proxy (a cloud session) it needs `npm install` first, for undici.
import { readFile } from 'node:fs/promises';
import { nextMove, stepKey } from '../src/cfo/bot.js';

const LOBBY_WAIT_MS = 60 * 60 * 1000; // leave a lobby nobody starts within an hour
const THINK_MS = Number(process.env.THINK_MS ?? 700); // a short pause before each move, so people can follow along
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const payload = readPayload(await readFile(process.argv[2] ?? '/dev/stdin', 'utf8'));
const WebSocketImpl = await webSocketClass();
const wsBase = payload.base.replace(/^http/, 'ws');
console.log(`Sending ${payload.players.map((p) => p.name).join(', ')} to CFO room ${payload.room} at ${payload.base}`);
const results = await Promise.all(payload.players.map(play));
console.log('All Claude players are done:', results.join('; '));

function readPayload(text) {
  let p;
  try {
    p = JSON.parse(text.trim());
  } catch {
    fail('The payload is not JSON.');
  }
  if (p?.game !== 'cfo') fail('Only CFO rooms are supported.');
  let base;
  try {
    base = new URL(p.base);
  } catch {
    fail('The payload has no valid base URL.');
  }
  if (!['https:', 'http:'].includes(base.protocol)) fail('The base URL must be http(s).');
  if (!/^[A-Za-z0-9]{4,12}$/.test(p.room ?? '')) fail('Bad room code.');
  if (!Array.isArray(p.players) || !p.players.length || p.players.length > 5) fail('Expected 1 to 5 players.');
  for (const q of p.players) {
    if (!/^Claude \d+$/.test(q?.name ?? '') || !/^[\w-]{8,64}$/.test(q?.token ?? '')) fail('Each player needs a Claude name and a token.');
  }
  return { base: base.origin, room: p.room.toUpperCase(), players: p.players };
}

function fail(why) {
  console.error(why);
  process.exit(2);
}

// Node's built-in WebSocket ignores HTTPS_PROXY; undici's takes a proxy-aware dispatcher.
async function webSocketClass() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxy) return { WS: globalThis.WebSocket, options: undefined };
  try {
    const { WebSocket, EnvHttpProxyAgent } = await import('undici');
    return { WS: WebSocket, options: { dispatcher: new EnvHttpProxyAgent() } };
  } catch {
    fail('This session uses an HTTPS proxy: run `npm install` first so undici is available.');
  }
}

// One player: connect, play every move it is shown, reconnect when the line drops.
async function play({ name, token }) {
  const url = `${wsBase}/api/rooms/cfo/${payload.room}/ws?${new URLSearchParams({ token, name })}`;
  const joinedAt = Date.now();
  let backoff = 1000;
  for (;;) {
    const outcome = await session(url, name, joinedAt);
    if (outcome.done) {
      console.log(`${name}: ${outcome.done}`);
      return `${name} ${outcome.done}`;
    }
    console.log(`${name}: connection lost (${outcome.why}); retrying in ${backoff / 1000}s`);
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 60_000);
    if (outcome.connected) backoff = 1000;
  }
}

function session(url, name, joinedAt) {
  return new Promise((resolve) => {
    const ws = new WebSocketImpl.WS(url, WebSocketImpl.options);
    let seat = null;
    let state = null;
    let connected = false;
    let finished = false;
    let busy = false;
    let tried = { key: '', set: new Set() };
    let lastLog = 0;
    const ping = setInterval(() => ws.readyState === 1 && ws.send('ping'), 30_000);
    const finish = (r) => {
      if (finished) return;
      finished = true;
      clearInterval(ping);
      try {
        ws.close();
      } catch {}
      resolve({ connected, ...r });
    };

    ws.addEventListener('open', () => (connected = true));
    ws.addEventListener('close', (e) => finish({ why: `closed ${e.code}` }));
    ws.addEventListener('error', (e) => finish({ why: e.message ?? 'error' }));
    ws.addEventListener('message', (e) => {
      if (e.data === 'pong') return;
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.t === 'welcome') {
        seat = m.seat;
        if (seat === null) return finish({ done: 'could not get a seat (the room is full or the game has started)' });
        console.log(`${name}: seated at ${seat}`);
      } else if (m.t === 'replaced') {
        finish({ done: 'was taken over by another connection' });
      } else if (m.t === 'error') {
        // The last move was refused: remember it for this step so the next one is tried instead.
        if (tried.last) tried.set.add(tried.last);
        think();
      } else if (m.t === 'state') {
        state = m;
        if (m.status === 'over' || m.game?.phase === 'over') {
          const g = m.game;
          return finish({ done: `game over${g?.winner != null ? `, ${m.seats[g.winner]?.name} won` : ''}` });
        }
        if (m.status === 'waiting' && Date.now() - joinedAt > LOBBY_WAIT_MS) return finish({ done: 'left: nobody started the game within an hour' });
        if (m.game?.players[seat]?.out) return finish({ done: 'is out of the game' });
        if (m.game && m.game.log.length !== lastLog) {
          lastLog = m.game.log.length;
          if (m.game.turn === seat) console.log(`${name}: ${m.game.log.at(-1)}`);
        }
        think();
      }
    });

    async function think() {
      if (busy || finished || !state?.game || seat === null) return;
      busy = true;
      await sleep(THINK_MS);
      busy = false;
      if (finished) return;
      const view = state.game;
      const key = stepKey(view);
      if (tried.key !== key) tried = { key, set: new Set() };
      const move = nextMove(view, seat, tried.set);
      if (!move) return;
      tried.last = JSON.stringify(move);
      // A move that changes nothing visible (or is refused) is remembered so it isn't sent twice.
      tried.set.add(tried.last);
      ws.send(JSON.stringify({ t: 'act', ...move }));
    }
  });
}
