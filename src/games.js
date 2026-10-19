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
];

export function findGame(id) {
  return GAMES.find((g) => g.id === id) ?? null;
}

// What the browser needs to draw the selection page.
export function publicGames() {
  return GAMES.map(({ id, name, blurb, players, page }) => ({ id, name, blurb, players, page }));
}
