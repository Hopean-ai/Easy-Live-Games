import { DurableObject } from 'cloudflare:workers';
import { act, start, view } from './rules.js';
import { STAGES } from './data.js';

// One Durable Object (named "career") holds every account's CFO Career in SQLite. The router
// reaches it over RPC as the signed-in account. Each account has one career at a time; finished
// stages are recorded, and finishing every stage that exists is what unlocks Classic, the board
// game (Miles: Classic is unlocked for an account once it has played Career through and won).
export class Office extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.now = () => Date.now();
    this.seed = () => crypto.getRandomValues(new Uint32Array(1))[0] | 0;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS careers (account TEXT PRIMARY KEY, run TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS stages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, stage INTEGER NOT NULL,
        result TEXT NOT NULL, score INTEGER NOT NULL, ended INTEGER NOT NULL
      );
    `);
  }

  career(account) {
    const row = this.sql.exec('SELECT run FROM careers WHERE account = ?', account.toLowerCase()).toArray()[0];
    return row ? JSON.parse(row.run) : null;
  }

  save(account, run) {
    this.sql.exec('INSERT OR REPLACE INTO careers (account, run, updated) VALUES (?, ?, ?)', account.toLowerCase(), JSON.stringify(run), this.now());
  }

  async state(account) {
    const run = this.career(account);
    return { run: run ? view(run) : null, record: this.record(account), classic: await this.classicUnlocked(account) };
  }

  // Start a new career at the startup stage. One in progress is given up.
  async begin(account) {
    this.save(account, start(this.seed()));
    return this.state(account);
  }

  // One action on the career in front. `turn` must match, so a double click can't act twice.
  async act(account, body = {}) {
    const run = this.career(account);
    if (!run) return { error: 'Start a career first.' };
    if (body.turn !== run.turn) return { error: 'The page was out of date. Try again.', ...(await this.state(account)) };
    const result = act(run, body);
    if (result.error) return { error: result.error, ...(await this.state(account)) };
    if (run.over && !run.recorded) {
      run.recorded = true;
      this.sql.exec('INSERT INTO stages (account, stage, result, score, ended) VALUES (?, ?, ?, ?, ?)',
        account.toLowerCase(), run.stage, run.result, run.score ?? 0, this.now());
    }
    this.save(account, run);
    return this.state(account);
  }

  record(account) {
    return this.sql.exec('SELECT stage, result, score, ended FROM stages WHERE account = ? ORDER BY ended DESC LIMIT 10', account.toLowerCase()).toArray();
  }

  // Won every stage built so far. While later stages are still being built, this is the last
  // built stage; it tightens on its own as stages are added.
  async classicUnlocked(account) {
    if (!account) return false;
    const last = Math.max(...STAGES.filter((s) => s.built).map((s) => s.id));
    return this.sql.exec("SELECT COUNT(*) AS n FROM stages WHERE account = ? AND stage = ? AND result = 'graduated'", account.toLowerCase(), last).toArray()[0].n > 0;
  }
}
