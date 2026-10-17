import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, step, setInput, snapshot, FIELD, PADDLE, BALL } from '../src/game.js';
import { Clock, Smoothed, predictBall, replayPaddle } from '../public/netcode.js';

const cfg = { field: FIELD, paddle: PADDLE, ball: BALL };
const half = () => 0.5;
const DT = 1 / 60;

function run(game, seconds) {
  for (let t = 0; t < seconds - 1e-9; t += DT) step(game, DT, half);
}

// The client's guess has to follow the same rules as the server, or every snapshot is a correction.
test('predicted ball matches the server simulation, walls and paddles included', () => {
  const g = createGame(half);
  run(g, 1.2); // past the serve
  g.ball.vy = 400; // add some angle so it hits walls
  for (const side of ['left', 'right']) g.paddles[side].y = 0; // paddles out of the way at first
  const snap = snapshot(g);
  const at = (side) => g.paddles[side].y;
  const predicted = predictBall(snap, 0.9, (side) => at(side), cfg); // short of the goal line
  run(g, 0.9);
  assert.equal(g.score.left + g.score.right, 0);
  assert.ok(Math.abs(predicted.bx - g.ball.x) < 6, `x ${predicted.bx} vs ${g.ball.x}`);
  assert.ok(Math.abs(predicted.by - g.ball.y) < 6, `y ${predicted.by} vs ${g.ball.y}`);
});

test('predicted ball bounces off a paddle like the server does', () => {
  const g = createGame(half);
  run(g, 1.1);
  const side = g.ball.vx < 0 ? 'left' : 'right';
  g.paddles[side].y = g.ball.y - 30; // squarely in the way, a little off centre
  const snap = snapshot(g);
  const predicted = predictBall(snap, 1.2, (s) => g.paddles[s].y, cfg);
  run(g, 1.2);
  assert.equal(g.score.left + g.score.right, 0, 'the server ball was returned');
  assert.ok(Math.abs(predicted.bx - g.ball.x) < 8, `x ${predicted.bx} vs ${g.ball.x}`);
  assert.ok(Math.abs(predicted.by - g.ball.y) < 8, `y ${predicted.by} vs ${g.ball.y}`);
});

test('predicted ball waits out the serve', () => {
  const g = createGame(half);
  const snap = snapshot(g);
  const p = predictBall(snap, 0.5, () => 0, cfg);
  assert.equal(p.bx, snap.bx);
  assert.equal(p.serving, true);
  assert.equal(predictBall(snap, 1.5, () => 0, cfg).serving, false);
});

// One player, 80 ms each way. They press down at local time 1000 and let go at 1300. A snapshot
// sent before the press arrives is all the client has; replaying the unacknowledged inputs has to
// land on what the server will actually have when an input sent now gets there.
test('replaying unacknowledged inputs predicts the server paddle', () => {
  const oneWay = 80;
  const g = createGame(half);
  const startY = g.paddles.left.y;
  const inputs = [{ seq: 1, dir: 1, at: 1000 }, { seq: 2, dir: 0, at: 1300 }];

  // Server timeline in the same ms as the client (offset 0): inputs land at at + oneWay.
  const serverY = (t) => {
    let y = startY;
    for (let s = 0; s < t; s += 1) {
      const d = inputs.filter((i) => i.at + oneWay <= s).at(-1)?.dir ?? 0;
      y = Math.min(FIELD.height - PADDLE.height, y + (d * PADDLE.speed) / 1000);
    }
    return y;
  };

  for (const now of [1000, 1100, 1250, 1300, 1400]) {
    // Newest snapshot was taken at server time now - oneWay, before either input landed.
    const snapAt = now - oneWay;
    const sent = inputs.filter((i) => i.at <= now);
    const predicted = replayPaddle(serverY(snapAt), 0, snapAt, sent, now + oneWay, oneWay, cfg);
    assert.ok(Math.abs(predicted - serverY(now + oneWay)) < 1, `at ${now}: ${predicted} vs ${serverY(now + oneWay)}`);
  }
});

test('replayPaddle stays on the field', () => {
  const y = replayPaddle(10, -1, 0, [], 1000, 0, cfg);
  assert.equal(y, 0);
});

test('clock trusts its fastest round trip for the offset', () => {
  const c = new Clock();
  c.sample(0, 100, 5050); // offset 5000
  c.sample(1000, 1400, 6300); // slow sample, offset 5100: queueing, ignore
  assert.equal(c.offset, 5000);
  assert.equal(c.toLocal(5500), 500);
  assert.ok(c.lead() > 50 && c.lead() < 200);
});

test('smoothing glides to a correction instead of jumping', () => {
  const s = new Smoothed(80);
  s.correct(100, 140);
  const first = s.value(140, 16);
  assert.ok(first > 100 && first < 140);
  for (let i = 0; i < 60; i++) s.value(140, 16);
  assert.equal(s.value(140, 16), 140);
  s.correct(0, 300, true);
  assert.equal(s.value(300, 16), 300);
});
