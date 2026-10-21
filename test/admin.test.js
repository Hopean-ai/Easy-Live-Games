import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAdmin, hostSeat } from '../src/admin.js';

test('admins are the accounts named in ADMIN_USERS, in any case', () => {
  const env = { ADMIN_USERS: ' Miles_Pitts ,other' };
  assert.equal(isAdmin(env, 'miles_pitts'), true);
  assert.equal(isAdmin(env, 'OTHER'), true);
  assert.equal(isAdmin(env, 'Miles'), false);
});

test('guests and unset config are never admin', () => {
  assert.equal(isAdmin({ ADMIN_USERS: 'Miles_Pitts' }, null), false);
  assert.equal(isAdmin({ ADMIN_USERS: '' }, ''), false);
  assert.equal(isAdmin({}, 'Miles_Pitts'), false);
  assert.equal(isAdmin(undefined, 'Miles_Pitts'), false);
});

test('the first admin to join hosts the lobby, otherwise the first player', () => {
  assert.equal(hostSeat([{}, {}, {}]), 0);
  assert.equal(hostSeat([{}, { admin: true }, { admin: true }]), 1);
  assert.equal(hostSeat([{ admin: true }, {}]), 0);
  assert.equal(hostSeat([]), 0);
});
