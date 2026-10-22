// Claude players: an admin presses a button in a CFO lobby, and this asks Miles's Claude Code
// routine (a cloud scheduled task with an API trigger) to send players into that room. The
// routine runs scripts/claude-players.mjs, which joins the room over its normal WebSocket.
//
// The routine's fire URL and bearer token are Worker secrets, so they never reach a browser:
//   npx wrangler secret put CLAUDE_ROUTINE_URL    (https://api.anthropic.com/v1/claude_code/routines/trig_.../fire)
//   npx wrangler secret put CLAUDE_ROUTINE_TOKEN  (sk-ant-oat01-...)
export const MAX_CLAUDE_PLAYERS = 5;
const ROUTINE_BETA = 'experimental-cc-routine-2026-04-01';

// The router has already checked the caller is an admin and the room code is well formed.
export async function callClaudePlayers(env, { origin, code, count }) {
  const missing = ['CLAUDE_ROUTINE_URL', 'CLAUDE_ROUTINE_TOKEN'].filter((k) => !env[k]);
  if (missing.length) {
    return { status: 503, error: `Claude players are not set up yet: this Worker has no ${missing.join(' or ')} secret.` };
  }
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1 || n > MAX_CLAUDE_PLAYERS) return { status: 400, error: `Ask for 1 to ${MAX_CLAUDE_PLAYERS} players.` };

  const rooms = env.CFO_ROOMS;
  const room = rooms.get(rooms.idFromName(code));
  const seats = await room.claudePlayers(n);
  if (seats.error) return { status: 409, error: seats.error };

  // Each Claude player's seat token is derived from the room and name with the secret token, so a
  // later run (after a dropped connection) gets the same seats back and nobody else can guess them.
  const players = await Promise.all(seats.names.map(async (name) => ({ name, token: await seatToken(env.CLAUDE_ROUTINE_TOKEN, code, name) })));
  // The routine receives this as text; its saved prompt tells it to hand the JSON to the script.
  const payload = { game: 'cfo', base: origin, room: code, players };

  let res;
  try {
    res = await fetch(env.CLAUDE_ROUTINE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CLAUDE_ROUTINE_TOKEN}`,
        'anthropic-beta': ROUTINE_BETA,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: JSON.stringify(payload) }),
    });
  } catch (e) {
    console.error('Claude routine call failed', e);
    return { status: 502, error: 'Could not reach the Claude routine.' };
  }
  if (!res.ok) {
    console.error('Claude routine refused', res.status, (await res.text()).slice(0, 500));
    return { status: 502, error: `The Claude routine refused the call (${res.status}).` };
  }
  const fired = await res.json().catch(() => ({}));
  return { status: 200, players: seats.names, session: fired.claude_code_session_url ?? null };
}

export async function seatToken(secret, code, name) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`cfo:${code}:${name}`)));
  return `claude-${[...sig.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
