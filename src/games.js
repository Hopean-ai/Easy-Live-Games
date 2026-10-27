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
    id: 'career',
    name: 'CFO Career',
    blurb: 'Be the CFO of a startup: post its books, delegate as it grows, and decide how to fund it. Long, solo, and saved on your account.',
    players: 1,
    page: '/career',
    // Played alone, so no rooms or quick match: the Office object (src/career/office.js) keeps
    // each account's career. Not on Roblox yet.
    solo: 'OFFICE',
  },
  {
    id: 'driftmail',
    name: 'Driftmail',
    blurb: 'Alone on an island, you write letters, throw them to sea, and read what strangers send back.',
    players: 'Any number of',
    page: '/driftmail',
    // One shared ocean rather than rooms, so there's no quick match. On the web it needs an
    // account; on Roblox, an unlinked player gets an island of their own (src/driftmail/roblox.js).
    world: 'OCEAN',
    roblox: 'Driftmail',
  },
  {
    id: 'legio',
    name: 'Legio',
    blurb: 'Enlist in a Roman legion in 235 AD and climb from recruit to emperor, if you live. One life, about an hour, and a leaderboard.',
    players: 1,
    page: '/legio',
    // Played alone against the dice, so no rooms or quick match: the Camp object (src/legio/camp.js)
    // keeps each account's career and the leaderboard. On Roblox the hub opens it like a world
    // (src/legio/roblox.js): an unlinked player gets a career of their own.
    solo: 'CAMP',
    roblox: 'Legio',
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
    // A world, or a game played alone, has no rooms or tables: the hub opens its screens straight away.
    if (g.world || g.solo) return { id: g.id, name: g.name, blurb: g.blurb, players: String(g.players), world: true, ...(g.solo ? { solo: true } : {}) };
    const { min, max } = tableSize(g);
    return { id: g.id, name: g.name, blurb: g.blurb, players: String(g.players), minPlayers: min, maxPlayers: max };
  });
}
