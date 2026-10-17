const ROOM_CODE = /^[A-Za-z0-9]{4,12}$/;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alikes (0/O, 1/I)

export function newRoomCode(length = 5) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

// Static files in public/ are served by Workers Assets before this runs;
// the Worker only sees requests that match no file, which is everything under /api/.
export async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (url.pathname === '/api/new-room') {
    return Response.json({ code: newRoomCode() });
  }

  const match = url.pathname.match(/^\/api\/rooms\/([^/]+)\/ws$/);
  if (match) {
    const code = match[1];
    if (!ROOM_CODE.test(code)) return new Response('Bad room code', { status: 400 });
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    const stub = env.ROOMS.get(env.ROOMS.idFromName(code.toUpperCase()));
    return stub.fetch(request);
  }

  if (env.ASSETS) return env.ASSETS.fetch(request);
  return new Response('Not found', { status: 404 });
}
