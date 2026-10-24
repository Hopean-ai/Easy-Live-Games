import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCtx } from './helpers/workers-stub.js';

const { Matchmaker, HTTP_STALE_MS } = await import('../src/matchmaker.js');
const size = { min: 2, max: 6 };
const ask = (mm, who, op = 'poll') => mm.httpQueue({ who, op, ...size });

test('Roblox players queue over HTTP and are matched once the wait for more runs out', async () => {
  const mm = new Matchmaker(fakeCtx(), {});
  assert.deepEqual(await ask(mm, 'roblox:1', 'join'), { queued: { waiting: 1, max: 6 } });
  const two = await ask(mm, 'roblox:2', 'join');
  assert.equal(two.queued.waiting, 2);
  assert.ok(two.queued.startsAt > Date.now(), 'a countdown starts once the minimum is waiting');
  await mm.alarm();
  const a = await ask(mm, 'roblox:1');
  const b = await ask(mm, 'roblox:2');
  assert.equal(a.matched.players, 2);
  assert.equal(a.matched.room, b.matched.room);
  assert.deepEqual(await ask(mm, 'roblox:1', 'join'), { queued: { waiting: 1, max: 6 } }, 'queueing again starts afresh');
});

test('a full table is matched at once, and leaving or going quiet gives up the place', async (t) => {
  const mm = new Matchmaker(fakeCtx(), {});
  await ask(mm, 'roblox:quiet', 'join');
  await ask(mm, 'roblox:gone', 'join');
  assert.deepEqual(await ask(mm, 'roblox:gone', 'leave'), { left: true });
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + HTTP_STALE_MS + 1000);
  for (let i = 1; i <= 5; i++) await ask(mm, `roblox:p${i}`, 'join');
  const last = await ask(mm, 'roblox:p6', 'join');
  assert.equal(last.matched.players, 6, 'six players fill the table without the quiet one');
  assert.equal((await ask(mm, 'roblox:p1')).matched.room, last.matched.room);
});
