import { DurableObject } from 'cloudflare:workers';
import {
  checkUsername, checkPassword, hashPassword, verifyPassword, newSessionToken, tokenKey, SESSION_TTL_MS,
} from './auth.js';
import { newRoomCode } from './codes.js';

const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const GAME_TTL_MS = 60 * 24 * 60 * 60 * 1000;
export const LINK_CODE_LENGTH = 6;
export const LINK_CODE_TTL_MS = 10 * 60 * 1000;

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
      CREATE TABLE IF NOT EXISTS roblox_links (
        roblox TEXT PRIMARY KEY, user TEXT NOT NULL UNIQUE, roblox_name TEXT NOT NULL, linked INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS link_codes (
        code TEXT PRIMARY KEY, user TEXT NOT NULL, expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS link_failures (
        roblox TEXT PRIMARY KEY, failures INTEGER NOT NULL, locked_until INTEGER NOT NULL
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

  // Linking a Roblox player to an account: the website hands a signed-in player a short code, and
  // they type it into the Roblox game, whose server sends it here with their Roblox user id. After
  // that the Roblox player plays as the account. One Roblox player per account, and the other way
  // round; linking again moves the link.
  async robloxLinkCode(name) {
    const user = String(name).toLowerCase();
    const now = Date.now();
    this.sql.exec('DELETE FROM link_codes WHERE user = ? OR expires <= ?', user, now);
    let code;
    do code = newRoomCode(LINK_CODE_LENGTH);
    while (this.sql.exec('SELECT 1 FROM link_codes WHERE code = ?', code).toArray().length);
    const expires = now + LINK_CODE_TTL_MS;
    this.sql.exec('INSERT INTO link_codes (code, user, expires) VALUES (?, ?, ?)', code, user, expires);
    return { code, expires };
  }

  // A Roblox player's typed code. Wrong guesses lock that Roblox player out for a while, as
  // wrong passwords do.
  async redeemRobloxLink(roblox, robloxName, rawCode) {
    const id = String(roblox);
    const now = Date.now();
    const fail = this.sql.exec('SELECT * FROM link_failures WHERE roblox = ?', id).toArray()[0];
    if (fail && fail.locked_until > now) return { error: 'Too many wrong codes. Try again in a few minutes.' };
    const code = String(rawCode ?? '').trim().toUpperCase();
    const row = /^[A-Z0-9]{4,12}$/.test(code)
      ? this.sql.exec('SELECT user FROM link_codes WHERE code = ? AND expires > ?', code, now).toArray()[0]
      : null;
    const owner = row && this.user(row.user);
    if (!owner) {
      const failures = (fail?.failures ?? 0) + 1;
      const lock = failures >= MAX_FAILURES;
      this.sql.exec(
        'INSERT OR REPLACE INTO link_failures (roblox, failures, locked_until) VALUES (?, ?, ?)',
        id, lock ? 0 : failures, lock ? now + LOCKOUT_MS : 0,
      );
      return { error: 'That code is wrong or has run out. Get a new one and try again.' };
    }
    this.sql.exec('DELETE FROM link_failures WHERE roblox = ?', id);
    this.sql.exec('DELETE FROM link_codes WHERE code = ?', code);
    this.sql.exec('DELETE FROM roblox_links WHERE roblox = ? OR user = ?', id, owner.key);
    this.sql.exec(
      'INSERT INTO roblox_links (roblox, user, roblox_name, linked) VALUES (?, ?, ?, ?)',
      id, owner.key, String(robloxName ?? '').slice(0, 40), now,
    );
    return { account: owner.name };
  }

  // The account a Roblox player is linked to, or null.
  async robloxAccount(roblox) {
    const row = this.sql
      .exec('SELECT u.name FROM roblox_links l JOIN users u ON u.key = l.user WHERE l.roblox = ?', String(roblox))
      .toArray()[0];
    return row?.name ?? null;
  }

  // The Roblox player an account is linked to, for the website, or null.
  async robloxLink(name) {
    const row = this.sql.exec('SELECT roblox, roblox_name, linked FROM roblox_links WHERE user = ?', String(name).toLowerCase()).toArray()[0];
    return row ? { robloxId: row.roblox, robloxName: row.roblox_name, linked: row.linked } : null;
  }

  // Pass an account name or a Roblox user id.
  async unlinkRoblox({ name, roblox }) {
    if (name) this.sql.exec('DELETE FROM roblox_links WHERE user = ?', String(name).toLowerCase());
    if (roblox) this.sql.exec('DELETE FROM roblox_links WHERE roblox = ?', String(roblox));
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
