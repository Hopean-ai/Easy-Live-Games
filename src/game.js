// Pure Pong simulation. No I/O, so it runs the same in the Durable Object and in tests.
// Coordinates are in a fixed virtual field; clients scale to their canvas.
import { createSkillState, buySkill, modifiers, POINTS_PER_CONCEDE } from './skills.js';

export const FIELD = { width: 800, height: 500 };
export const PADDLE = { width: 12, height: 90, inset: 24, speed: 420 }; // speed in units/second
export const BALL = { size: 12, startSpeed: 320, maxSpeed: 900, speedup: 1.06 };
export const WIN_SCORE = 7;
export const SERVE_DELAY = 1; // seconds of pause before each serve
export const SPIN_ANGLE = Math.PI / 12; // 15° of bend when the paddle is moving as it hits
const MAX_BOUNCE_ANGLE = (70 * Math.PI) / 180;

export const SIDES = ['left', 'right'];

export function createGame(rand = Math.random) {
  const game = {
    paddles: {
      left: { y: (FIELD.height - PADDLE.height) / 2, input: 0 },
      right: { y: (FIELD.height - PADDLE.height) / 2, input: 0 },
    },
    ball: { x: 0, y: 0, vx: 0, vy: 0 },
    score: { left: 0, right: 0 },
    skills: { left: createSkillState(), right: createSkillState() },
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

// What a side's upgrades add up to, in the units the simulation uses. The room sends this to
// clients too, so their prediction (public/netcode.js) plays by the same numbers.
export function sideStats(game, side) {
  const mods = modifiers(game.skills[side].owned);
  return {
    height: PADDLE.height * mods.height,
    speed: PADDLE.speed * mods.speed,
    maxAngle: mods.maxAngle,
    spinAngle: mods.spin ? SPIN_ANGLE : 0,
    bendLimit: MAX_BOUNCE_ANGLE,
    speedup: 1 + (BALL.speedup - 1) * mods.speedupBoost,
  };
}

export function paddleHeight(game, side) {
  return sideStats(game, side).height;
}

export function paddleSpeed(game, side) {
  return sideStats(game, side).speed;
}

// Spends `side`'s skill points on `id`. Returns true if it was bought. A taller paddle grows
// around its centre so buying one never teleports it.
export function buy(game, side, id) {
  if (!SIDES.includes(side) || game.winner) return false;
  const p = game.paddles[side];
  const centre = p.y + paddleHeight(game, side) / 2;
  if (!buySkill(game.skills[side], id)) return false;
  const h = paddleHeight(game, side);
  p.y = clamp(centre - h / 2, 0, FIELD.height - h);
  return true;
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
    p.y = clamp(p.y + p.input * paddleSpeed(game, side) * dt, 0, FIELD.height - paddleHeight(game, side));
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
    game.skills[scorer === 'left' ? 'right' : 'left'].points += POINTS_PER_CONCEDE;
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
  return b.y + BALL.size >= p.y && b.y <= p.y + paddleHeight(game, side);
}

// Reflects off a paddle; where it hits sets the outgoing angle, and each hit speeds it up.
// The hitter's skills widen the angle, add spin from paddle movement, and boost the speedup.
function bounce(game, side, x) {
  const p = game.paddles[side];
  const b = game.ball;
  const st = sideStats(game, side);
  const offset = (b.y + BALL.size / 2 - (p.y + st.height / 2)) / (st.height / 2);
  let angle = clamp(offset, -1, 1) * st.maxAngle;
  if (st.spinAngle) angle = clamp(angle + p.input * st.spinAngle, -st.bendLimit, st.bendLimit);
  const speed = Math.min(Math.hypot(b.vx, b.vy) * st.speedup, BALL.maxSpeed);
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
    lh: round(paddleHeight(game, 'left')),
    rh: round(paddleHeight(game, 'right')),
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
