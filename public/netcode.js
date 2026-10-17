// Lag hiding for the browser client. The server stays authoritative: these functions only guess
// where things are between snapshots, and every new snapshot corrects the guess. No DOM code here,
// so test/netcode.test.js can check the guesses against the real simulation in src/game.js.
//
// The idea: a key you press now reaches the server about half a round trip from now. So the client
// draws the whole court at that moment ("the present" for this player): your paddle moves the
// instant you press, and the ball is drawn where it will be when your input lands. If your paddle
// covers the ball on screen, it covers it on the server too.

const SUBSTEP = 1 / 120; // seconds per simulated step when predicting forward
const MAX_LEAD_MS = 250; // never predict further ahead than this, however bad the connection

// Tracks the offset between this tab's clock (performance.now) and the server's (Date.now),
// and the round-trip time, from ping/pong pairs.
export class Clock {
  constructor() {
    this.samples = [];
    this.offset = null; // server ms = local ms + offset
    this.rtt = null;
  }

  sample(sentAt, receivedAt, serverNow) {
    const rtt = Math.max(0, receivedAt - sentAt);
    this.samples.push({ rtt, offset: serverNow - (sentAt + rtt / 2) });
    if (this.samples.length > 8) this.samples.shift();
    // The fastest round trip has the least queueing in it, so its offset is the most accurate.
    this.offset = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset;
    this.rtt = this.rtt === null ? rtt : this.rtt * 0.75 + rtt * 0.25;
  }

  // Until the first pong arrives, assume a snapshot took no time to get here.
  seed(serverNow, receivedAt) {
    if (this.offset === null) this.offset = serverNow - receivedAt;
  }

  toLocal(serverMs) {
    return serverMs - (this.offset ?? 0);
  }

  // How far ahead of the newest snapshot a player's view should be: half a round trip.
  lead() {
    return Math.min(MAX_LEAD_MS, (this.rtt ?? 0) / 2);
  }
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// A side's paddle and hitting numbers after skill upgrades (src/game.js sideStats). Without
// upgrades they come from the base config.
export function statsFor(cfg, side) {
  return cfg.sides?.[side] ?? {
    height: cfg.paddle.height,
    speed: cfg.paddle.speed,
    maxAngle: Math.PI / 4,
    spinAngle: 0,
    bendLimit: Math.PI / 4,
    speedup: cfg.ball.speedup,
  };
}

// Where my paddle will be at local time `until`, replaying inputs the server has not applied yet.
// `y`/`dir` are the server's paddle position and direction at local time `from` (the snapshot).
// Each pending input ({ dir, at }) is assumed to land `lead` ms after it was sent.
export function replayPaddle(y, dir, from, pending, until, lead, cfg, side) {
  const { height, speed } = statsFor(cfg, side);
  const max = cfg.field.height - height;
  let t = from;
  for (const input of pending) {
    const lands = clamp(input.at + lead, t, until);
    y = clamp(y + (dir * speed * (lands - t)) / 1000, 0, max);
    t = lands;
    dir = input.dir;
  }
  return clamp(y + (dir * speed * Math.max(0, until - t)) / 1000, 0, max);
}

// Advances a snapshot `seconds` forward with the same rules as src/game.js `step`, minus scoring:
// a ball that leaves the court just keeps going until the server says who scored.
// paddleY(side, t) gives each paddle's y at t seconds after the snapshot, and paddleDir(side, t)
// its direction then (spin depends on it); by default each paddle keeps the snapshot's direction.
export function predictBall(snap, seconds, paddleY, cfg, paddleDir = (side) => (side === 'left' ? snap.il : snap.ir) ?? 0) {
  const { field, paddle, ball } = cfg;
  const b = { x: snap.bx, y: snap.by, vx: snap.bvx, vy: snap.bvy };
  let serveIn = snap.si ?? (snap.serve ? 1 : 0);
  let t = 0;
  while (t < seconds - 1e-9) {
    const dt = Math.min(SUBSTEP, seconds - t);
    t += dt;
    if (serveIn > 0) {
      serveIn = Math.max(0, serveIn - dt); // like the server, the tick that ends the serve is still
      continue;
    }
    const prevX = b.x;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (b.y <= 0) {
      b.y = -b.y;
      b.vy = Math.abs(b.vy);
    } else if (b.y + ball.size >= field.height) {
      b.y = 2 * (field.height - ball.size) - b.y;
      b.vy = -Math.abs(b.vy);
    }
    const leftFace = paddle.inset + paddle.width;
    const rightFace = field.width - paddle.inset - paddle.width;
    const left = statsFor(cfg, 'left');
    const right = statsFor(cfg, 'right');
    if (b.vx < 0 && prevX >= leftFace && b.x < leftFace && covers(paddleY('left', t), left, b, cfg)) {
      bounce(b, paddleY('left', t), paddleDir('left', t), left, 1, leftFace, cfg);
    } else if (b.vx > 0 && prevX + ball.size <= rightFace && b.x + ball.size > rightFace
      && covers(paddleY('right', t), right, b, cfg)) {
      bounce(b, paddleY('right', t), paddleDir('right', t), right, -1, rightFace - ball.size, cfg);
    }
  }
  return { bx: b.x, by: b.y, serving: serveIn > 0 };
}

function covers(py, st, b, cfg) {
  return b.y + cfg.ball.size >= py && b.y <= py + st.height;
}

// Same as bounce() in src/game.js, with the hitter's upgrades in `st`.
function bounce(b, py, input, st, dir, x, cfg) {
  const { ball } = cfg;
  const offset = (b.y + ball.size / 2 - (py + st.height / 2)) / (st.height / 2);
  let angle = clamp(offset, -1, 1) * st.maxAngle;
  if (st.spinAngle) angle = clamp(angle + input * st.spinAngle, -st.bendLimit, st.bendLimit);
  const speed = Math.min(Math.hypot(b.vx, b.vy) * st.speedup, ball.maxSpeed);
  b.x = x;
  b.vx = dir * speed * Math.cos(angle);
  b.vy = speed * Math.sin(angle);
}

// A position drawn on screen that follows a prediction, but when a new snapshot moves the
// prediction it glides to the corrected spot instead of jumping.
export class Smoothed {
  constructor(tauMs = 80) {
    this.tau = tauMs;
    this.error = 0;
  }

  // Call when a snapshot changes the prediction for the same moment from `before` to `after`.
  correct(before, after, snap = false) {
    this.error = snap ? 0 : this.error + before - after;
  }

  // The value to draw this frame, given the current prediction.
  value(predicted, dtMs) {
    this.error *= Math.exp(-dtMs / this.tau);
    if (Math.abs(this.error) < 0.05) this.error = 0;
    return predicted + this.error;
  }
}
