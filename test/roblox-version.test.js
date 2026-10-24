import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BRIDGE_VERSION } from '../src/cfo/roblox.js';

// The website's bridge version and the one the Roblox game understands move together: bumping
// one without the other would either break published Roblox games or hide the update notice.
test('the Roblox game understands the current bridge version', () => {
  const luau = readFileSync(new URL('../roblox/src/shared/Bridge.luau', import.meta.url), 'utf8');
  const supported = Number(luau.match(/Bridge\.SUPPORTED = (\d+)/)?.[1]);
  assert.equal(supported, BRIDGE_VERSION, 'update Bridge.SUPPORTED in roblox/src/shared/Bridge.luau with BRIDGE_VERSION in src/cfo/roblox.js');
});
