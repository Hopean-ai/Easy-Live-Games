// Legio on Roblox (roblox/README.md): the Roblox hub's game server plays a career for its players
// over POST /api/roblox/world/legio. A linked Roblox player plays their account's career and
// shares its leaderboard place; anyone else gets a career of their own, keyed by Roblox user id.
//
// Everything in a career is the game's own words (soldier names come from the game's lists), so
// nothing needs Roblox's text filter. The one thing players wrote, their account names on the
// leaderboard, is left out: Roblox sees each row's soldier and whether it is the player's own.

// Bump this, and SUPPORTED in roblox/src/shared/games/Legio.luau, when a change would break a
// Roblox build already published.
export const BRIDGE_VERSION = 1;

// The career a Roblox player plays: their account's when linked.
export function robloxCareer(userId, account) {
  return account ?? `roblox:${userId}`;
}

// Runs one Roblox request against the Camp object and returns the Roblox view.
export async function robloxLegio(camp, { op, userId, account, i, turn }) {
  const key = robloxCareer(userId, account);
  let result;
  if (op === 'state') result = await camp.state(key);
  else if (op === 'enlist') result = await camp.enlist(key);
  else if (op === 'choose') result = await camp.choose(key, { i: Number(i), turn: Number(turn) });
  else return { error: 'Bad request.' };
  const mine = (row) => row.account.toLowerCase() === key.toLowerCase();
  return {
    bridge: BRIDGE_VERSION,
    // A stale answer still comes with the career as it stands, so it is a note rather than a failure.
    note: result.error ?? null,
    run: result.run,
    leaderboard: result.leaderboard.map((row) => ({ name: row.name, rank: row.rank, fate: row.fate, score: row.score, you: mine(row) })),
    best: result.best ? { name: result.best.name, rank: result.best.rank, fate: result.best.fate, score: result.best.score } : null,
    careers: result.careers,
  };
}
