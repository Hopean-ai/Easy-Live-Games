import { DurableObject } from 'cloudflare:workers';
import { RANKS, choose, score, start, view } from './rules.js';

const BOARD_SIZE = 20;

// One Durable Object (named "legio") holds every player's career in progress and the leaderboard,
// in SQLite. The router reaches it over RPC as the signed-in account. Each account has at most one
// career at a time; when it ends, it goes on the board and stays visible until a new one starts.
export class Camp extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.now = () => Date.now();
    this.seed = () => crypto.getRandomValues(new Uint32Array(1))[0] | 0;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS careers (account TEXT PRIMARY KEY, run TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS records (
        id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, name TEXT NOT NULL, score INTEGER NOT NULL,
        rank TEXT NOT NULL, fate TEXT NOT NULL, ended INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS best ON records (score DESC);
    `);
  }

  career(account) {
    const row = this.sql.exec('SELECT run FROM careers WHERE account = ?', account.toLowerCase()).toArray()[0];
    return row ? JSON.parse(row.run) : null;
  }

  save(account, run) {
    this.sql.exec('INSERT OR REPLACE INTO careers (account, run, updated) VALUES (?, ?, ?)', account.toLowerCase(), JSON.stringify(run), this.now());
  }

  // What the page needs: the career in front of this player, and the board.
  async state(account) {
    const run = this.career(account);
    return { run: run ? view(run) : null, ...this.board(account) };
  }

  // Enlist afresh. A career still in progress is given up (it never reaches the board).
  async enlist(account) {
    const run = start(this.seed());
    this.save(account, run);
    return this.state(account);
  }

  // Answer the card in front. `turn` must match, so a double click can't answer twice.
  async choose(account, { i, turn } = {}) {
    const run = this.career(account);
    if (!run) return { error: 'Enlist first.' };
    if (turn !== run.turn) return { error: 'That card has already been answered.', ...(await this.state(account)) };
    const result = choose(run, Number(i));
    if (result.error) return { error: result.error, ...(await this.state(account)) };
    if (run.over && !run.recorded) {
      run.recorded = true;
      this.sql.exec(
        'INSERT INTO records (account, name, score, rank, fate, ended) VALUES (?, ?, ?, ?, ?, ?)',
        account, run.name, score(run), RANKS[run.best].name, run.fate, this.now(),
      );
    }
    this.save(account, run);
    return this.state(account);
  }

  board(account) {
    const top = this.sql.exec(`SELECT account, name, score, rank, fate, ended FROM records ORDER BY score DESC, ended ASC LIMIT ${BOARD_SIZE}`).toArray();
    const mine = this.sql.exec('SELECT name, score, rank, fate, ended FROM records WHERE account = ? COLLATE NOCASE ORDER BY score DESC LIMIT 1', account).toArray()[0] ?? null;
    const careers = this.sql.exec('SELECT COUNT(*) AS n FROM records WHERE account = ? COLLATE NOCASE', account).toArray()[0].n;
    return { leaderboard: top, best: mine, careers };
  }
}
