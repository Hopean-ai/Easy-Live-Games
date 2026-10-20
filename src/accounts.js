import { DurableObject } from 'cloudflare:workers';
import {
  checkUsername, checkPassword, hashPassword, verifyPassword, newSessionToken, tokenKey, SESSION_TTL_MS,
} from './auth.js';

const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const GAME_TTL_MS = 60 * 24 * 60 * 60 * 1000;

// One Durable Object (named "accounts") holds every account and session in its SQLite storage.
// Durable Objects need no setup in the Cloudflare dashboard, unlike a D1 database. The Worker
// calls it over RPC; it only wakes for sign-ups, logins and session checks.
export class Accounts extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        key TEXT PRIMARY KEY, name TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL,
        iterations INTEGER NOT NULL, created INTEGER NOT NULL,
        failures INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS sessions (
        key TEXT PRIMARY KEY, user TEXT NOT NULL, expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS games (
        user TEXT NOT NULL, game TEXT NOT NULL, code TEXT NOT NULL, players TEXT NOT NULL,
        updated INTEGER NOT NULL, PRIMARY KEY (user, game, code)
      );
    `);
  }

  async register(username, password) {
    const name = checkUsername(username);
    if (!name) return { error: 'Usernames are 3 to 16 letters, digits, - or _.' };
    const bad = checkPassword(password);
    if (bad) return { error: bad };
    if (this.user(name)) return { error: 'That username is taken.' };
    const { salt, hash, iterations } = await hashPassword(password);
    this.sql.exec(
      'INSERT INTO users (key, name, salt, hash, iterations, created) VALUES (?, ?, ?, ?, ?, ?)',
      name.toLowerCase(), name, salt, hash, iterations, Date.now(),
    );
    return this.startSession(name);
  }

  async login(username, password) {
    const failed = { error: 'Wrong username or password.' };
    const name = checkUsername(username);
    const user = name && this.user(name);
    if (!user || typeof password !== 'string') return failed;
    const now = Date.now();
    if (user.locked_until > now) return { error: 'Too many failed attempts. Try again in a few minutes.' };
    if (!(await verifyPassword(password, user))) {
      const failures = user.failures + 1;
      const lock = failures >= MAX_FAILURES;
      this.sql.exec(
        'UPDATE users SET failures = ?, locked_until = ? WHERE key = ?',
        lock ? 0 : failures, lock ? now + LOCKOUT_MS : 0, user.key,
      );
      return failed;
    }
    this.sql.exec('UPDATE users SET failures = 0, locked_until = 0 WHERE key = ?', user.key);
    return this.startSession(user.name);
  }

  // Returns the account name for a session token, or null.
  async session(token) {
    if (typeof token !== 'string' || token.length > 64) return null;
    const row = this.sql
      .exec('SELECT s.expires, u.name FROM sessions s JOIN users u ON u.key = s.user WHERE s.key = ?', await tokenKey(token))
      .toArray()[0];
    return row && row.expires > Date.now() ? row.name : null;
  }

  async logout(token) {
    if (typeof token === 'string') this.sql.exec('DELETE FROM sessions WHERE key = ?', await tokenKey(token));
  }

  // Rooms record which accounts are playing in them, so a player can find and rejoin a game.
  // Games untouched for GAME_TTL_MS are dropped, so abandoned ones don't pile up.
  async setGame(name, game, code, players, playing) {
    const key = String(name).toLowerCase();
    if (playing) {
      this.sql.exec(
        'INSERT OR REPLACE INTO games (user, game, code, players, updated) VALUES (?, ?, ?, ?, ?)',
        key, game, code, String(players).slice(0, 200), Date.now(),
      );
    } else {
      this.sql.exec('DELETE FROM games WHERE user = ? AND game = ? AND code = ?', key, game, code);
    }
  }

  async games(name) {
    this.sql.exec('DELETE FROM games WHERE updated <= ?', Date.now() - GAME_TTL_MS);
    return this.sql
      .exec('SELECT game, code, players, updated FROM games WHERE user = ? ORDER BY updated DESC LIMIT 20', String(name).toLowerCase())
      .toArray();
  }

  user(name) {
    return this.sql.exec('SELECT * FROM users WHERE key = ?', name.toLowerCase()).toArray()[0] ?? null;
  }

  async startSession(name) {
    const token = newSessionToken();
    const now = Date.now();
    this.sql.exec('DELETE FROM sessions WHERE expires <= ?', now); // tidy up while we're here
    this.sql.exec(
      'INSERT INTO sessions (key, user, expires) VALUES (?, ?, ?)',
      await tokenKey(token), name.toLowerCase(), now + SESSION_TTL_MS,
    );
    return { name, token };
  }
}
