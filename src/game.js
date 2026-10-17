// Pure Pong simulation. No I/O, so it runs the same in the Durable Object and in tests.
// Coordinates are in a fixed virtual field; clients scale to their canvas.

export const FIELD = { width: 800, height: 500 };
export const PADDLE = { width: 12, height: 90, inset: 24, speed: 420 }; // speed in units/second
export const BALL = { size: 12, startSpeed: 320, maxSpeed: 900, speedup: 1.06 };
export const WIN_SCORE = 7;
export const SERVE_DELAY = 1; // seconds of pause before each serve

export const SIDES = ['left', 'right'];

export function createGame(rand = Math.random) {
  const game = {
    paddles: {
      left: { y: (FIELD.height - PADDLE.height) / 2, input: 0 },
      right: { y: (FIELD.height - PADDLE.height) / 2, input: 0 },
    },
    ball: { x: 0, y: 0, vx: 0, vy: 0 },
    score: { left: 0, right: 0 },
    serveIn: SERVE_DELAY,
    winner: null,
  };
  resetBall(game, rand() < 0.5 ? 'left' : 'right', rand);
  return game;
}

// Puts the ball in the middle, aimed at `toward`, frozen until serveIn runs out.
export function resetBall(game, toward, rand = Math.random) {
  const angle = (rand() - 0.5) * (Math.PI / 3); // within ±30°
  const dir = toward === 'left' ? -1 : 1;
  game.ball.x = (FIELD.width - BALL.size) / 2;
  game.ball.y = (FIELD.height - BALL.size) / 2;
  game.ball.vx = dir * BALL.startSpeed * Math.cos(angle);
  game.ball.vy = BALL.startSpeed * Math.sin(angle);
  game.serveIn = SERVE_DELAY;
}

// input: -1 (up), 0 (stop), 1 (down). Anything else is treated as 0.
export function setInput(game, side, input) {
  if (!SIDES.includes(side)) return;
  game.paddles[side].input = input === -1 || input === 1 ? input : 0;
}

export function paddleX(side) {
  return side === 'left' ? PADDLE.inset : FIELD.width - PADDLE.inset - PADDLE.width;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Advances the simulation by dt seconds. Returns 'left' or 'right' when that side scores.
export function step(game, dt, rand = Math.random) {
  if (game.winner) return null;

  for (const side of SIDES) {
    const p = game.paddles[side];
    p.y = clamp(p.y + p.input * PADDLE.speed * dt, 0, FIELD.height - PADDLE.height);
  }

  if (game.serveIn > 0) {
    game.serveIn = Math.max(0, game.serveIn - dt);
    return null;
  }

  const b = game.ball;
  const prevX = b.x;
  b.x += b.vx * dt;
  b.y += b.vy * dt;

  if (b.y <= 0) {
    b.y = -b.y;
    b.vy = Math.abs(b.vy);
  } else if (b.y + BALL.size >= FIELD.height) {
    b.y = 2 * (FIELD.height - BALL.size) - b.y;
    b.vy = -Math.abs(b.vy);
  }

  // Paddle hits. Checking the crossing (prevX -> x) stops a fast ball tunnelling through.
  if (b.vx < 0) {
    const face = paddleX('left') + PADDLE.width;
    if (prevX >= face && b.x < face && hitsPaddle(game, 'left')) bounce(game, 'left', face);
  } else {
    const face = paddleX('right');
    if (prevX + BALL.size <= face && b.x + BALL.size > face && hitsPaddle(game, 'right')) {
      bounce(game, 'right', face - BALL.size);
    }
  }

  let scorer = null;
  if (b.x + BALL.size < 0) scorer = 'right';
  else if (b.x > FIELD.width) scorer = 'left';

  if (scorer) {
    game.score[scorer] += 1;
    if (game.score[scorer] >= WIN_SCORE) {
      game.winner = scorer;
    } else {
      resetBall(game, scorer === 'left' ? 'right' : 'left', rand);
    }
  }
  return scorer;
}

function hitsPaddle(game, side) {
  const p = game.paddles[side];
  const b = game.ball;
  return b.y + BALL.size >= p.y && b.y <= p.y + PADDLE.height;
}

// Reflects off a paddle; where it hits sets the outgoing angle, and each hit speeds it up.
function bounce(game, side, x) {
  const p = game.paddles[side];
  const b = game.ball;
  const offset = (b.y + BALL.size / 2 - (p.y + PADDLE.height / 2)) / (PADDLE.height / 2);
  const angle = clamp(offset, -1, 1) * (Math.PI / 4);
  const speed = Math.min(Math.hypot(b.vx, b.vy) * BALL.speedup, BALL.maxSpeed);
  const dir = side === 'left' ? 1 : -1;
  b.x = x;
  b.vx = dir * speed * Math.cos(angle);
  b.vy = speed * Math.sin(angle);
}

// The compact state sent to clients each broadcast.
export function snapshot(game) {
  return {
    l: round(game.paddles.left.y),
    r: round(game.paddles.right.y),
    bx: round(game.ball.x),
    by: round(game.ball.y),
    bvx: round(game.ball.vx),
    bvy: round(game.ball.vy),
    sl: game.score.left,
    sr: game.score.right,
    il: game.paddles.left.input,
    ir: game.paddles.right.input,
    si: Math.round(game.serveIn * 1000) / 1000,
    serve: game.serveIn > 0,
    winner: game.winner,
  };
}

function round(n) {
  return Math.round(n * 10) / 10;
}
