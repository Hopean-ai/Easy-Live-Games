// Admin accounts are named in the ADMIN_USERS var in wrangler.jsonc (comma-separated, any case),
// so granting or revoking admin is a config change, not a database edit. Only ever check this on
// the server: the router for HTTP endpoints, a game's Durable Object for its own messages.
//
// In a room, pass the X-Player-Account header the router sets for signed-in players:
//   if (!isAdmin(this.env, request.headers.get('X-Player-Account'))) return;
export function isAdmin(env, account) {
  if (!account) return false;
  return adminUsers(env).has(String(account).toLowerCase());
}

function adminUsers(env) {
  return new Set(
    String(env?.ADMIN_USERS ?? '')
      .split(',')
      .map((n) => n.trim().toLowerCase())
      .filter(Boolean),
  );
}
