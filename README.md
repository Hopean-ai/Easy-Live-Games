# Easy-Live-Games

Real-time multiplayer games on Cloudflare Workers and Durable Objects. Pong is the first one.

Sign in with a username and password, or play as a guest, then pick a game. In Pong, **Quick match** pairs you with the next player who is looking, or you can create a private room and share its link. Anyone else who opens a room's link watches as a spectator. First to 7 wins.

## How it works

- **`src/index.js` / `src/router.js`**: the Worker. Static files in `public/` are served by Workers Assets; `/api/new-room` hands out a room code, `/api/rooms/:code/ws` forwards the WebSocket to that room's Durable Object, `/api/match/:game/ws` joins the quick-match queue, and `/api/register`, `/api/login`, `/api/logout` and `/api/me` handle accounts. Requests from other sites are refused.
- **`src/accounts.js` / `src/auth.js`**: accounts. One `Accounts` Durable Object keeps users and sessions in its SQLite storage, so there is nothing to set up in the dashboard. Passwords are hashed with PBKDF2-SHA256 (100,000 iterations, the most Workers allows, with a random salt per user); five wrong passwords lock an account for 15 minutes. A session is a random token in an `HttpOnly`, `SameSite=Lax` cookie that lasts 30 days, and only its SHA-256 is stored. Signed-in players always play under their account name; guests are labelled "(guest)".
- **`src/matchmaker.js`**: quick match, one `Matchmaker` Durable Object per game. Each waiting player holds a hibernatable WebSocket, and as soon as two are waiting they get a fresh room code and are sent to it. It keeps no timers or storage, and keepalive pings are answered without waking it, so a quiet queue costs nothing.
- **`src/games.js`**: the list of games on the selection page. To add a game, give it a page in `public/`, a Durable Object for its rooms, and an entry here.
- **`src/room.js`**: the `PongRoom` Durable Object, one per room code. It is the only place the game is simulated (60 Hz physics, 30 Hz snapshots to every socket), so players can't drift apart. Clients only send paddle direction.
  - Seats are tied to a per-tab token, so a reconnecting player gets their side back. A second tab with the same token replaces the first.
  - If a player drops mid-game the game pauses and their seat is held for 15 seconds; after that they forfeit.
  - Uses the WebSocket Hibernation API, so an idle room costs nothing.
- **`src/game.js`**: the pure simulation (paddles, ball, scoring), shared by the room and the tests.
- **`src/skills.js`**: the skill tree. You earn a skill point each time the other player scores and spend it on one of three branches (paddle size, paddle speed, ball spin), each three nodes deep. The client only asks to buy a node; the room validates the purchase and `game.js` applies every effect. The tree resets with each new game.
- **`src/names.js`**: player-name cleanup. Names are also only ever rendered with `textContent` in the client.
- **`public/`**: the browser client. `index.html` / `home.js` is sign-in and game selection; `pong.html` / `client.js` is Pong. `public/netcode.js` hides lag: the client draws the court as it will be when your input reaches the server (half a round trip ahead of the newest snapshot), so your paddle moves the instant you press and the ball is where your paddle will meet it. Unacknowledged inputs are replayed on top of each snapshot, the other paddle and the ball are predicted forward with the same rules as `src/game.js`, and corrections glide instead of jumping. The server stays authoritative.

## Develop

```sh
npm install
npm run dev          # http://localhost:8787, open it in two windows (or one private) to play yourself
npm test             # unit tests
node scripts/smoke.mjs   # end-to-end check against the running dev server: rooms, accounts, quick match
```

Add `?lag=200` to the Pong page URL (for example `/pong?lag=200`) to add 200 ms of round trip in that tab and feel how the game plays from far away.

## Deploy

```sh
npx wrangler login
npm run deploy
```

Durable Objects with SQLite storage are available on the Workers Free plan, so no paid plan is needed.

## Claude players (CFO)

An admin in a CFO lobby can press **Add Claude players**. The Worker (`src/claude.js`) calls a Claude Code routine through its API trigger, passing the room code and seat tokens; the routine runs `scripts/claude-players.mjs`, which joins that room and plays with `src/cfo/bot.js` (a bookkeeper keeps its books). If a run stops mid-game, an admin can press **Reconnect Claude players** and a new run takes the same seats back.

Setup, once:

1. At [claude.ai/code/routines](https://claude.ai/code/routines), create a routine with this repository, an API trigger, and the prompt below. Copy the **Fire URL** and generate a **token** (shown once).
2. Give the routine a cloud environment whose network access allows the game's host (for example `easy-live-games.<your-subdomain>.workers.dev`), and the default package managers so `npm install` works.
3. Store both as Worker secrets (never in `wrangler.jsonc`): `npx wrangler secret put CLAUDE_ROUTINE_URL` and `npx wrangler secret put CLAUDE_ROUTINE_TOKEN`.

Routine prompt:

```text
An admin of Easy-Live-Games pressed "Add Claude players" in a CFO lobby. The routine-fire-payload
block holds a JSON object sent by the game's Worker naming the room and the players to send. Act on
it as follows, and do nothing else with it:
1. Write the payload JSON, exactly as given, to /tmp/cfo-players.json with the Write tool (not the shell).
2. Run `npm install` in the repository if node_modules is missing.
3. Run `node scripts/claude-players.mjs /tmp/cfo-players.json` as a background command with the
   longest timeout allowed, and wait for it to finish without polling.
4. If it stops before printing "All Claude players are done" (a timeout or lost connection), run it
   again with the same file: the players get their seats back.
5. Finish with the script's last line. If the game host is refused by the network (403,
   host_not_allowed), say that host must be added to this environment's allowed domains.
Do not change, commit or push any code.
```
