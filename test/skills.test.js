import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, step, setInput, resetBall, buy, paddleHeight, paddleSpeed, paddleX,
  FIELD, PADDLE, BALL,
} from '../src/game.js';
import { SKILLS, cannotBuy, createSkillState } from '../src/skills.js';

const half = () => 0.5;
const DT = 1 / 60;

// Lines the left paddle up with a ball served toward it and steps until it comes back.
function returnBall(g, { offset = 0 } = {}) {
  resetBall(g, 'left', half);
  g.serveIn = 0;
  g.paddles.left.y = g.ball.y + BALL.size / 2 - paddleHeight(g, 'left') / 2 + offset;
  for (let i = 0; i < 300; i++) {
    step(g, DT, half);
    if (g.ball.vx > 0) return g.ball;
  }
  throw new Error('ball was not returned');
}

test('every prerequisite is an earlier node in the same branch', () => {
  const ids = new Set();
  for (const s of SKILLS) {
    if (s.requires) {
      assert.ok(ids.has(s.requires), `${s.id} requires ${s.requires}`);
      assert.equal(SKILLS.find((x) => x.id === s.requires).branch, s.branch);
    }
    ids.add(s.id);
  }
});

test('conceding a point earns the other side a skill point', () => {
  const g = createGame(half);
  resetBall(g, 'left', half);
  g.paddles.left.y = 0;
  for (let t = 0; t < 5 && g.score.right === 0; t += DT) step(g, DT, half);
  assert.equal(g.score.right, 1);
  assert.equal(g.skills.left.points, 1);
  assert.equal(g.skills.right.points, 0);
});

test('buying checks points, prerequisites and duplicates', () => {
  const st = createSkillState();
  assert.equal(cannotBuy(st, 'reach1'), 'points');
  st.points = 10;
  assert.equal(cannotBuy(st, 'reach2'), 'locked');
  assert.equal(cannotBuy(st, 'nope'), 'unknown');
  const g = createGame(half);
  g.skills.left.points = 3;
  assert.equal(buy(g, 'left', 'reach1'), true);
  assert.equal(buy(g, 'left', 'reach1'), false);
  assert.equal(buy(g, 'left', 'reach2'), true);
  assert.equal(g.skills.left.points, 0);
  assert.equal(buy(g, 'left', 'speed1'), false);
  assert.equal(buy(g, 'spectator', 'speed1'), false);
});

test('a taller paddle grows around its centre and stays on the field', () => {
  const g = createGame(half);
  g.skills.left.points = 1;
  const centre = g.paddles.left.y + PADDLE.height / 2;
  buy(g, 'left', 'reach1');
  assert.equal(paddleHeight(g, 'left'), PADDLE.height * 1.2);
  assert.equal(g.paddles.left.y + paddleHeight(g, 'left') / 2, centre);

  g.paddles.right.y = FIELD.height - PADDLE.height;
  g.skills.right.points = 6;
  for (const id of ['reach1', 'reach2', 'reach3']) buy(g, 'right', id);
  assert.equal(g.paddles.right.y + paddleHeight(g, 'right'), FIELD.height);
});

test('the taller paddle reaches a ball the normal one would miss', () => {
  const g = createGame(half);
  g.skills.left.points = 1;
  buy(g, 'left', 'reach1');
  // Paddle top sits just below where a normal paddle would have ended.
  assert.ok(returnBall(g, { offset: PADDLE.height / 2 + 2 }).vx > 0);
});

test('speed upgrades move the paddle faster', () => {
  const g = createGame(half);
  g.skills.left.points = 1;
  buy(g, 'left', 'speed1');
  assert.equal(paddleSpeed(g, 'left'), PADDLE.speed * 1.2);
  const y0 = g.paddles.left.y;
  const r0 = g.paddles.right.y;
  setInput(g, 'left', 1);
  setInput(g, 'right', 1);
  step(g, 0.1, half);
  assert.ok(g.paddles.left.y - y0 > g.paddles.right.y - r0);
});

test('spin bends the return in the direction the paddle is moving', () => {
  // Same hit with the paddle moving down, with and without spin.
  const hit = (withSpin) => {
    const g = createGame(half);
    g.skills.left.points = 1;
    if (withSpin) buy(g, 'left', 'spin1');
    resetBall(g, 'left', half);
    g.serveIn = 0;
    g.ball.x = paddleX('left') + PADDLE.width + 1;
    g.paddles.left.y = g.ball.y + BALL.size / 2 - PADDLE.height / 2;
    setInput(g, 'left', 1);
    for (let i = 0; i < 10 && g.ball.vx < 0; i++) step(g, DT, half);
    assert.ok(g.ball.vx > 0);
    return Math.atan2(g.ball.vy, g.ball.vx);
  };
  const bend = hit(true) - hit(false);
  assert.ok(Math.abs(bend - Math.PI / 12) < 1e-9, `bend ${bend}`);
});

test('power shot doubles the speedup on your returns only', () => {
  const plain = returnBall(createGame(half));
  const g = createGame(half);
  g.skills.left.points = 3;
  buy(g, 'left', 'spin1');
  buy(g, 'left', 'spin2');
  const boosted = returnBall(g);
  const s0 = BALL.startSpeed;
  const gain = (b) => Math.hypot(b.vx, b.vy) / s0 - 1;
  assert.ok(Math.abs(gain(boosted) - 2 * gain(plain)) < 1e-9);
});

test('a rematch starts with a fresh tree', () => {
  const g = createGame(half);
  assert.deepEqual(g.skills, { left: { points: 0, owned: [] }, right: { points: 0, owned: [] } });
});

// The client copies the ball physics to predict ahead (public/netcode.js). With upgrades bought,
// its guess still has to match the server, or every snapshot becomes a visible correction.
test('client prediction matches the server with upgrades bought', async () => {
  const { predictBall } = await import('../public/netcode.js');
  const { snapshot, sideStats } = await import('../src/game.js');
  const g = createGame(half);
  g.skills.left.points = 7;
  for (const id of ['reach1', 'spin1', 'spin2', 'spin3']) assert.ok(buy(g, 'left', id), id);
  resetBall(g, 'left', half);
  g.serveIn = 0;
  // Catch it near the top edge of the taller paddle while moving down: wider angle, spin, power.
  g.ball.x = paddleX('left') + PADDLE.width + 20; // reaches the paddle in a few ticks
  g.paddles.left.y = g.ball.y + BALL.size / 2 - 8 - 20;
  setInput(g, 'left', 1);
  g.paddles.right.y = 0;
  const cfg = {
    field: FIELD, paddle: PADDLE, ball: BALL,
    sides: { left: sideStats(g, 'left'), right: sideStats(g, 'right') },
  };
  const snap = snapshot(g);
  const startY = g.paddles.left.y;
  const leftY = (t) => Math.min(FIELD.height - paddleHeight(g, 'left'), startY + paddleSpeed(g, 'left') * t);
  const predicted = predictBall(snap, 1, (side, t) => (side === 'left' ? leftY(t) : 0), cfg);
  for (let t = 0; t < 1 - 1e-9; t += DT) step(g, DT, half);
  assert.equal(g.score.left + g.score.right, 0, 'the server ball was returned');
  assert.ok(g.ball.vx > 0);
  assert.ok(Math.abs(predicted.bx - g.ball.x) < 8, `x ${predicted.bx} vs ${g.ball.x}`);
  assert.ok(Math.abs(predicted.by - g.ball.y) < 8, `y ${predicted.by} vs ${g.ball.y}`);
});
