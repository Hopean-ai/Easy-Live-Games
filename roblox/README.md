# CFO on Roblox

A Roblox game where people play CFO in the same rooms as players on the website. The website stays in charge of every game: the Roblox game server only relays. It joins its players to a room, forwards their moves, and asks the website for changes every two seconds.

```
Roblox player ⇄ Roblox client (src/client) ⇄ Roblox game server (src/server)
                                                  │ HTTPS, X-Roblox-Key
                                                  ▼
                       website: POST /api/roblox/cfo/<room>  →  CfoRoom (src/cfo/room.js)
```

## Why web changes don't need Roblox changes

The Roblox code knows nothing about the rules. Everything it shows comes from the website:

- **The board** (`robloxBoard` in `src/cfo/roblox.js`): square names, colors and counts.
- **The state** (`slimView` in `src/cfo/moves.js`): players, tiles, the card rows, the player's own books, the log.
- **The moves** (`movesFor` in `src/cfo/moves.js`): one button per legal move, with its label. The website finds them by trying every candidate on a copy of the game with the real rules, so a rule change on the web changes the Roblox buttons with it.
- **The forms** (`FORMS` in `src/cfo/moves.js`): property deals, supply contracts and the board plan, described field by field, so the Roblox screens draw them without knowing what they do.
- **The books**: the documents, journal entries, open fiscal years, the statements preview and the last review, plus every account name (`robloxBoard`). Roblox players keep their own books with the same journal as the web (an entry editor with an account picker and the balancing plug), or hire the bookkeeper.

What you might need to do when the web game changes:

| Web change | What to do |
| --- | --- |
| A rule, a price, a card, a square | Nothing. |
| A new action in `act()` (rules.js) | `npm test` fails until it is added to `MOVES` in `src/cfo/moves.js` (say which parameters it takes and give it a label), to `FORMS` and `SCREENS` if it needs several fields at once, or to `WEB_ONLY` with a reason. No Roblox publish needed for a move or a form. |
| A new field kind in a form, or a new bookkeeping action | Needs Roblox screen code (`src/client`) and a publish. |
| A renamed field the Roblox screens use (players, tiles, log, moves) | The **Roblox** workflow's screen test fails on the web PR. Fix `slimView` or the screens. |
| Something that would break a Roblox build already published | Bump `BRIDGE_VERSION` in `src/cfo/roblox.js` and `Bridge.SUPPORTED` in `src/shared/Bridge.luau` together (a test checks they match). Players on the old build see an "update needed" notice until the new build publishes. |

Every web action is on Roblox now; `WEB_ONLY` is empty.

**Quick match.** Roblox players join the same quick-match queue as web players. The Roblox server asks `POST /api/roblox/match/cfo` every two seconds while a player waits (a place lapses after 10 seconds without asking), and on a match joins the room it was given, saying how many players to expect, so the game starts once everyone is in.

**Linked accounts.** A player signed in on the website can link their Roblox account: the home page hands out a six-letter code (good for 10 minutes) and they type it into the **Link code** box in the Roblox lobby. The Roblox server sends it to `POST /api/roblox/link` (ops `status`, `redeem`, `unlink`), and the `Accounts` object (`src/accounts.js`) keeps the link, so it holds on every Roblox server and nothing is stored on Roblox. After that, when the Roblox server joins the player to a room, the router looks up their account and the room seats them as it: their admin role and host rights apply, the game shows in their list of games on both sides (the Roblox lobby has a Rejoin button for each), and they can move their seat between Roblox and the browser mid-game, the newer one taking over. The Roblox side is only told whether a player is linked, never the account name, and a seat that moved to Roblox shows the player's Roblox name there. Five wrong codes lock that Roblox player out for 15 minutes. Either side can unlink.

Web players' names are shown in Roblox as "Web player 1", "Web player 2" and so on, in seat lists, the log and move labels. Roblox requires text shown in a game to come from Roblox users or go through its filter, and these names come from outside. The Roblox game also never points players to the website.

## Setup, once

On the website (Cloudflare):

1. Make a long random key, for example with `openssl rand -hex 32`.
2. Store it as a Worker secret: `npx wrangler secret put ROBLOX_KEY` (or in the dashboard, under the Worker's **Variables and Secrets**, not the Builds variables). Without it, the Roblox route answers 404 and nothing else changes.

On Roblox ([Creator Hub](https://create.roblox.com/dashboard/creations)):

1. Create an experience. Its URL in the Creator Hub shows the **universe ID** (the experience) and the **start place ID**.
2. Under the experience's **Secrets**, add a secret named `cfo_bridge_key` with the same key, for the website's domain, `easy-live-games.milestpitts.workers.dev` (the address in `src/server/Config.luau`).
3. Fill in the experience's maturity questionnaire, then make it public when you want people to find it.
4. Under **Open Cloud > API Keys**, create a key with the **universe-places** API, **Write**, for this experience. GitHub's runners change IP, so allow `0.0.0.0/0`.

On GitHub (repository **Settings > Secrets and variables > Actions**), add:

- `ROBLOX_API_KEY`: the Open Cloud key
- `ROBLOX_UNIVERSE_ID`: the universe ID
- `ROBLOX_PLACE_ID`: the start place ID

From then on, every merge to main that changes `roblox/` publishes the game (the **Roblox** workflow). You can also run that workflow by hand.

## Develop

Tools: [Rojo](https://rojo.space) 7.7 and [Lune](https://lune-org.github.io/docs) 0.11 (`cargo install rojo lune --locked`, or Rokit/Aftman).

```sh
cd roblox
lune run tests/syntax        # every file compiles
lune run tests/run           # the shared helpers
node ../scripts/roblox-fixture.mjs > tests/fixture.json
lune run tests/screens       # draws the screens from what the website sends today
rojo build -o cfo.rbxl       # the place file the workflow publishes
```

To try it in Roblox Studio, run `rojo serve` and connect with the Rojo plugin, or open the built `cfo.rbxl`. Studio needs the `cfo_bridge_key` secret too (**Game Settings > Security**), and a website to talk to: either the deployed one, or `npx wrangler dev --var ROBLOX_KEY:local-key` exposed through a tunnel, since Roblox can't reach localhost.

`scripts/smoke-roblox.mjs` plays a few turns against a local `wrangler dev` the way the Roblox server does, without Roblox.

Publishing replaces the whole place, so anything made by hand in Studio is lost on the next publish unless it is saved into this folder (Rojo can hold models as `.rbxm` files).
