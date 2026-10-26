# Easy-Live-Games

Real-time multiplayer games on Cloudflare Workers and Durable Objects: Pong, CFO and Driftmail.

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

## Roblox hub

`roblox/` is one Roblox place with a game picker that joins the same rooms as the website, so Roblox and browser players can play together. Every game except Pong is on it (games flagged `roblox` in `src/games.js`; today CFO). The website runs the game; Roblox only relays and draws what it is sent, so rule changes on the web need no Roblox update. Setup, publishing, adding a game, and what to do when the web game changes: [roblox/README.md](roblox/README.md).

## Driftmail

Alone on an island, you write letters, throw them to sea, and read what strangers send back. It needs an account (your island is kept on it). There are no rooms: the whole game is one ocean, the `Ocean` Durable Object in `src/driftmail/ocean.js`, holding every island and bottle in SQLite. The page (`public/driftmail.html` / `driftmail.js`) asks `/api/driftmail/state` every 30 seconds and posts to `/api/driftmail/throw`, `open`, `fish` and `craft`.

- **`src/driftmail/world.js`**: the rules, as pure functions. An island day lasts five hours with two tides. Where a bottle comes to rest depends on the direction and strength of the throw, the current (north at dawn, east at midday, south at dusk, west at night) and the tide (an outgoing tide carries it twice as far). It goes to the nearest island seen in the last three days; if none is in reach it drifts on, looking further each hour, and after a day it goes to anyone, or back to its sender if nobody else is there. It washes up on the beach facing where it came from, and a reply thrown back that way bends toward the original writer.
- **Supplies**: a letter costs a bottle, a cork, paper and ink. You start with three of each, opening a bottle gives back its glass and cork, and each tide since your last visit (at most two) may leave flotsam.
- **Players never see coordinates**, only the beach a bottle landed on and when. Unsigned letters keep the writer's handwriting and wax mark (random per island, so they can't be traced to an account name).
- **Ocean events** (`eventOn` in `world.js`): about one tide in fourteen brings a storm (bottles fly further and off course, and more washes up), a spring tide (bottles fly further), a great shoal (better fishing) or wreckage (old bottles and supplies). Each tide's event is fixed by its number, so it's the same for everyone. The tide before, the page sometimes shows a slight sign.
- **Fishing**: one cast a tide (`cast`). Dawn, dusk and a rising tide bite best. Fish give bones; five bones make a bone hook (better bites), two fish boil down to glue, which seals a bottle in place of a cork. Cuttlefish give ink.
- **Journal pages and abilities**: old bottles (rare flotsam, more after wreckage or storms, now and then on a hook) hold pages from two old journals (`PAGES`). Four teach an ability: Reading hands (letters on your shelf in the same hand are numbered alike), Sea signs (a forecast two island days ahead), Reading the current (where each of your bottles came to rest) and Fisher's knots (better bites, two casts a tide). A page can be copied into a letter for another sheet and more ink, and whoever opens it learns it too.
- **On Roblox** (`src/driftmail/roblox.js`, [roblox/README.md](roblox/README.md)): the hub's picker opens Driftmail straight onto the island. A linked Roblox player plays their account's island; anyone else gets one of their own. Every word players wrote goes through Roblox's text filter on the Roblox side.
- **Claude castaways** (`src/driftmail/castaways.js`): two islands in the middle kept by Claude, which answer the letters that reach them 15 to 45 minutes later. Their wax carries a faint wave mark. They write through the Claude API with `claude-opus-5-5` at low effort, with server-side refusal fallbacks on. Set the key once with `npx wrangler secret put ANTHROPIC_API_KEY`; without it the castaways are quiet and bottles pass them by.

The brainstorm and what comes next (crops, building, seals, the map): [Driftmail brainstorm](https://claude.ai/artifact/Axmpz1BVCJTNzKVtgPQBXW).

## Claude players (CFO)

An admin in a CFO lobby can press **Add Claude players**. The Worker (`src/claude.js`) calls a Claude Code routine through its API trigger, passing the room code and seat tokens; the routine runs `scripts/claude-players.mjs`, which joins that room and plays with `src/cfo/bot.js` (a bookkeeper keeps its books). The players log off on their own five minutes after every other player has left. If a run stops mid-game, an admin can press **Reconnect Claude players** and a new run takes the same seats back.

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
   again with the same file: the players get their seats back. Once it prints "All Claude players
   are done" (the game ended, or every other player left and the players logged off), do not run it
   again; the run is finished.
5. Finish with the script's last line. If the game host is refused by the network (403,
   host_not_allowed), say that host must be added to this environment's allowed domains.
Do not change, commit or push any code.
```
