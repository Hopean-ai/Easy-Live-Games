// Every game the site offers. The game selection page lists these, and matchmaking only queues
// for ids found here. To add a game: give it a page in public/, a Durable Object for its rooms,
// and an entry below naming that binding. To also offer it in the Roblox hub (roblox/README.md),
// give its room a `roblox(body)` method and its entry `roblox`: the name of its Luau modules in
// roblox/src/shared/games and roblox/src/client/games (test/roblox-games.test.js checks both).
export const GAMES = [
  {
    id: 'pong',
    name: 'Pong',
    blurb: 'Two players, one ball, first to 7. Spend skill points as you go.',
    players: 2,
    page: '/pong',
    rooms: 'ROOMS',
  },
  {
    id: 'cfo',
    name: 'CFO',
    blurb: 'An accounting board game: buy land, build PP&E, keep real books, and get rich personally.',
    players: '2–6',
    minPlayers: 2,
    maxPlayers: 6,
    page: '/cfo',
    rooms: 'CFO_ROOMS',
    roblox: 'Cfo',
  },
  {
    id: 'driftmail',
    name: 'Driftmail',
    blurb: 'Alone on an island, you write letters, throw them to sea, and read what strangers send back.',
    players: 'Any number of',
    page: '/driftmail',
    // One shared ocean rather than rooms, so there's no quick match; it needs an account.
    world: 'OCEAN',
  },
];

export function findGame(id) {
  return GAMES.find((g) => g.id === id) ?? null;
}

// How many players quick match puts in one room.
export function tableSize(game) {
  const min = game.minPlayers ?? game.players;
  return { min, max: game.maxPlayers ?? min };
}

// What the browser needs to draw the selection page.
export function publicGames() {
  return GAMES.map(({ id, name, blurb, players, page, roblox }) => ({ id, name, blurb, players, page, roblox: Boolean(roblox) }));
}

// What the Roblox hub lists in its game picker: the games it can relay, in the site's order.
export function robloxGames() {
  return GAMES.filter((g) => g.roblox).map((g) => {
    const { min, max } = tableSize(g);
    return { id: g.id, name: g.name, blurb: g.blurb, players: String(g.players), minPlayers: min, maxPlayers: max };
  });
}
