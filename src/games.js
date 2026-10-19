// Every game the site offers. The game selection page lists these, and matchmaking only queues
// for ids found here. To add a game: give it a page in public/, a Durable Object for its rooms,
// and an entry below naming that binding.
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
  return GAMES.map(({ id, name, blurb, players, page }) => ({ id, name, blurb, players, page }));
}
