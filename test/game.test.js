import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, step, setInput, resetBall, snapshot, paddleX,
  FIELD, PADDLE, BALL, WIN_SCORE, SERVE_DELAY,
} from '../src/game.js';

const half = () => 0.5; // deterministic: serve straight, no angle
const DT = 1 / 60;

function run(game, seconds, rand = half) {
  const scorers = [];
  for (let t = 0; t < seconds; t += DT) {
    const s = step(game, DT, rand);
    if (s) scorers.push(s);
  }
  return scorers;
}

test('ball waits for the serve delay before moving', () => {
  const g = createGame(half);
  const x0 = g.ball.x;
  run(g, SERVE_DELAY - 0.1);
  assert.equal(g.ball.x, x0);
  run(g, 0.3);
  assert.notEqual(g.ball.x, x0);
});

test('paddles move with input and stay on the field', () => {
  const g = createGame(half);
  setInput(g, 'left', -1);
  run(g, 3);
  assert.equal(g.paddles.left.y, 0);
  setInput(g, 'left', 1);
  run(g, 3);
  assert.equal(g.paddles.left.y, FIELD.height - PADDLE.height);
});

test('invalid input is treated as stop', () => {
  const g = createGame(half);
  setInput(g, 'left', 99);
  assert.equal(g.paddles.left.input, 0);
  setInput(g, 'nobody', 1); // ignored, no throw
});

test('ball bounces off the top and bottom walls', () => {
  const g = createGame(half);
  g.serveIn = 0;
  g.ball.y = 2;
  g.ball.vx = 0;
  g.ball.vy = -300;
  step(g, DT);
  assert.ok(g.ball.vy > 0);
  assert.ok(g.ball.y >= 0);
  g.ball.y = FIELD.height - BALL.size - 2;
  g.ball.vy = 300;
  step(g, DT);
  assert.ok(g.ball.vy < 0);
  assert.ok(g.ball.y + BALL.size <= FIELD.height);
});

test('a centred paddle returns the ball and speeds it up', () => {
  const g = createGame(half);
  resetBall(g, 'left', half);
  g.serveIn = 0;
  // Line the paddle up with the ball.
  g.paddles.left.y = g.ball.y + BALL.size / 2 - PADDLE.height / 2;
  const speed0 = Math.hypot(g.ball.vx, g.ball.vy);
  let returned = false;
  for (let i = 0; i < 300 && !returned; i++) {
    step(g, DT, half);
    if (g.ball.vx > 0) returned = true;
  }
  assert.ok(returned, 'ball should come back off the left paddle');
  assert.ok(g.ball.x >= paddleX('left') + PADDLE.width);
  assert.ok(Math.hypot(g.ball.vx, g.ball.vy) > speed0);
  assert.equal(g.score.right, 0);
});

test('a very fast ball does not tunnel through a paddle', () => {
  const g = createGame(half);
  g.serveIn = 0;
  g.paddles.left.y = 200;
  g.ball.y = 230;
  g.ball.x = paddleX('left') + PADDLE.width + 5;
  g.ball.vx = -BALL.maxSpeed * 3; // moves ~45 units in one tick, more than the paddle is wide
  g.ball.vy = 0;
  step(g, DT);
  assert.ok(g.ball.vx > 0);
});

test('missing the ball scores for the other side and re-serves toward the scorer\'s opponent', () => {
  const g = createGame(half);
  resetBall(g, 'left', half);
  g.paddles.left.y = 0;
  g.paddles.right.y = 0;
  const scorers = run(g, 5);
  assert.equal(scorers[0], 'right');
  assert.equal(g.score.right >= 1, true);
});

test('first to WIN_SCORE wins and the game stops', () => {
  const g = createGame(half);
  g.score.right = WIN_SCORE - 1;
  resetBall(g, 'left', half);
  g.paddles.left.y = 0;
  run(g, 5);
  assert.equal(g.winner, 'right');
  assert.equal(g.score.right, WIN_SCORE);
  const before = JSON.stringify(g);
  step(g, DT);
  assert.equal(JSON.stringify(g), before);
});

test('snapshot is compact and rounded', () => {
  const g = createGame(half);
  g.ball.x = 1.23456;
  const s = snapshot(g);
  assert.equal(s.bx, 1.2);
  assert.deepEqual(Object.keys(s).sort(), ['bvx', 'bvy', 'bx', 'by', 'l', 'r', 'serve', 'sl', 'sr', 'winner']);
});
