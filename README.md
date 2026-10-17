# Easy-Live-Games

Real-time two-player Pong on Cloudflare Workers and Durable Objects.

One player creates a room and shares the link; the second player joins and the game starts. Anyone else who opens the link watches as a spectator. First to 7 wins.

## How it works

- **`src/index.js` / `src/router.js`**: the Worker. Static files in `public/` are served by Workers Assets; `/api/new-room` hands out a room code and `/api/rooms/:code/ws` forwards the WebSocket to that room's Durable Object.
- **`src/room.js`**: the `PongRoom` Durable Object, one per room code. It is the only place the game is simulated (60 Hz physics, 30 Hz snapshots to every socket), so players can't drift apart. Clients only send paddle direction.
  - Seats are tied to a per-tab token, so a reconnecting player gets their side back. A second tab with the same token replaces the first.
  - If a player drops mid-game the game pauses and their seat is held for 15 seconds; after that they forfeit.
  - Uses the WebSocket Hibernation API, so an idle room costs nothing.
- **`src/game.js`**: the pure simulation (paddles, ball, scoring), shared by the room and the tests.
- **`src/skills.js`**: the skill tree. You earn a skill point each time the other player scores and spend it on one of three branches (paddle size, paddle speed, ball spin), each three nodes deep. The client only asks to buy a node; the room validates the purchase and `game.js` applies every effect. The tree resets with each new game.
- **`src/names.js`**: player-name cleanup. Names are also only ever rendered with `textContent` in the client.
- **`public/`**: the browser client. `public/netcode.js` hides lag: the client draws the court as it will be when your input reaches the server (half a round trip ahead of the newest snapshot), so your paddle moves the instant you press and the ball is where your paddle will meet it. Unacknowledged inputs are replayed on top of each snapshot, the other paddle and the ball are predicted forward with the same rules as `src/game.js`, and corrections glide instead of jumping. The server stays authoritative.

## Develop

```sh
npm install
npm run dev          # http://localhost:8787, open it in two tabs
npm test             # unit tests
node scripts/smoke.mjs   # end-to-end multiplayer check against the running dev server
```

Add `?lag=200` to the URL (before joining a room) to add 200 ms of round trip in that tab and feel how the game plays from far away.

## Deploy

```sh
npx wrangler login
npm run deploy
```

Durable Objects with SQLite storage are available on the Workers Free plan, so no paid plan is needed.
