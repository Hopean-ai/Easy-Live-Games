import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest, newRoomCode } from '../src/router.js';

const worker = { fetch: handleRequest };

function env(onRoom) {
  return {
    ROOMS: {
      idFromName: (name) => name,
      get: (id) => ({ fetch: () => onRoom(id) }),
    },
    ASSETS: { fetch: () => new Response('asset') },
  };
}

test('new-room returns a readable code', async () => {
  const res = await worker.fetch(new Request('http://x/api/new-room'), env());
  const { code } = await res.json();
  assert.match(code, /^[A-HJ-NP-Z2-9]{5}$/);
  assert.match(newRoomCode(8), /^[A-HJ-NP-Z2-9]{8}$/);
});

test('room sockets route to the Durable Object named by the upper-cased code', async () => {
  let routed = null;
  const e = env((id) => {
    routed = id;
    return new Response('ok');
  });
  const req = new Request('http://x/api/rooms/abcd1/ws', { headers: { Upgrade: 'websocket' } });
  await worker.fetch(req, e);
  assert.equal(routed, 'ABCD1');
});

test('rejects bad codes and non-WebSocket requests', async () => {
  const e = env(() => assert.fail('should not reach the room'));
  const bad2 = await worker.fetch(
    new Request('http://x/api/rooms/a%3Cb/ws', { headers: { Upgrade: 'websocket' } }), e,
  );
  assert.equal(bad2.status, 400);
  const plain = await worker.fetch(new Request('http://x/api/rooms/ABCD/ws'), e);
  assert.equal(plain.status, 426);
});
