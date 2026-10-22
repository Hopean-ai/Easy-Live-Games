import { readCookie, sessionCookie, SESSION_COOKIE } from './auth.js';
import { newRoomCode } from './codes.js';
import { findGame, publicGames, tableSize } from './games.js';
import { isAdmin } from './admin.js';
import { callClaudePlayers } from './claude.js';

export { newRoomCode };

const ROOM_CODE = /^[A-Za-z0-9]{4,12}$/;
const TOKEN = /^[\w-]{8,64}$/;
const MAX_BODY_BYTES = 1024;

// Static files in public/ are served by Workers Assets before this runs;
// the Worker only sees requests that match no file, which is everything under /api/.
export async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path.startsWith('/api/') && !sameOrigin(request, url)) {
    return new Response('Cross-origin request refused', { status: 403 });
  }

  if (path === '/api/games') return Response.json({ games: publicGames() });

  if (path === '/api/new-room') {
    return Response.json({ code: newRoomCode() });
  }

  if (path === '/api/me') {
    const name = await accountName(request, env);
    return Response.json({ name, admin: isAdmin(env, name) });
  }

  // A signed-in player's games still in progress, so they can rejoin from any device.
  if (path === '/api/my-games') {
    const name = await accountName(request, env);
    return Response.json({ games: name ? await accountsStub(env).games(name) : [] });
  }

  if (path === '/api/register' || path === '/api/login') {
    if (request.method !== 'POST') return new Response('Use POST', { status: 405 });
    const body = await readJson(request);
    if (!body) return Response.json({ error: 'Bad request.' }, { status: 400 });
    const accounts = accountsStub(env);
    const result = path === '/api/register'
      ? await accounts.register(body.username, body.password)
      : await accounts.login(body.username, body.password);
    if (result.error) return Response.json({ error: result.error }, { status: path === '/api/login' ? 401 : 400 });
    return Response.json({ name: result.name }, { headers: { 'Set-Cookie': sessionCookie(result.token, request) } });
  }

  if (path === '/api/logout') {
    if (request.method !== 'POST') return new Response('Use POST', { status: 405 });
    const token = readCookie(request, SESSION_COOKIE);
    if (token) await accountsStub(env).logout(token);
    return Response.json({ ok: true }, { headers: { 'Set-Cookie': sessionCookie(null, request) } });
  }

  // Admins only: ask the Claude routine to send players into this CFO room (src/claude.js).
  const claude = path.match(/^\/api\/rooms\/cfo\/([^/]+)\/claude$/);
  if (claude) {
    if (request.method !== 'POST') return new Response('Use POST', { status: 405 });
    if (!isAdmin(env, await accountName(request, env))) return Response.json({ error: 'Only admins can call Claude players.' }, { status: 403 });
    if (!ROOM_CODE.test(claude[1])) return Response.json({ error: 'Bad room code.' }, { status: 400 });
    const body = await readJson(request);
    const { status, ...result } = await callClaudePlayers(env, { origin: url.origin, code: claude[1].toUpperCase(), count: body?.count });
    return Response.json(result, { status });
  }

  const match = path.match(/^\/api\/match\/([^/]+)\/ws$/);
  if (match) {
    const game = findGame(match[1]);
    if (!game) return new Response('Unknown game', { status: 404 });
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    // Signed-in players are queued by account, guests by their per-tab token, so the same
    // person can't be matched against themselves.
    const account = await accountName(request, env);
    const token = url.searchParams.get('token');
    const who = account ? `account:${account.toLowerCase()}` : TOKEN.test(token ?? '') ? `guest:${token}` : '';
    const stub = env.MATCHMAKER.get(env.MATCHMAKER.idFromName(game.id));
    const { min, max } = tableSize(game);
    return stub.fetch(forward(request, url, { 'X-Player': who, 'X-Match-Min': String(min), 'X-Match-Max': String(max) }));
  }

  // /api/rooms/CODE/ws is Pong's, from before there were other games; others name their game.
  const room = path.match(/^\/api\/rooms\/([^/]+)\/ws$/) ?? path.match(/^\/api\/rooms\/([^/]+)\/([^/]+)\/ws$/);
  if (room) {
    const game = findGame(room.length === 3 ? room[1] : 'pong');
    if (!game) return new Response('Unknown game', { status: 404 });
    const code = room.at(-1);
    if (!ROOM_CODE.test(code)) return new Response('Bad room code', { status: 400 });
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    // A signed-in player always plays under their account name; anyone else is marked a guest.
    const account = await accountName(request, env);
    if (account) url.searchParams.set('name', account);
    const rooms = env[game.rooms];
    const stub = rooms.get(rooms.idFromName(code.toUpperCase()));
    const identity = { 'X-Room-Code': code.toUpperCase() };
    if (account) identity['X-Player-Account'] = account;
    return stub.fetch(forward(request, url, identity));
  }

  if (env.ASSETS) return env.ASSETS.fetch(request);
  return new Response('Not found', { status: 404 });
}

function accountsStub(env) {
  return env.ACCOUNTS.get(env.ACCOUNTS.idFromName('accounts'));
}

async function accountName(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null; // guests never wake the accounts object
  return (await accountsStub(env).session(token)) ?? null;
}

// Copies the request for a Durable Object, dropping any identity headers the browser sent
// so only the ones set here reach the object.
function forward(request, url, identity) {
  const headers = new Headers(request.headers);
  headers.delete('X-Player');
  headers.delete('X-Player-Account');
  headers.delete('X-Room-Code');
  headers.delete('Cookie');
  for (const [k, v] of Object.entries(identity)) headers.set(k, v);
  return new Request(url, { method: request.method, headers });
}

// Browsers always send Origin on POSTs and WebSocket handshakes; refuse other sites so a page
// elsewhere can't use a visitor's session cookie.
function sameOrigin(request, url) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === url.host;
  } catch {
    return false;
  }
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const body = JSON.parse(text);
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}
