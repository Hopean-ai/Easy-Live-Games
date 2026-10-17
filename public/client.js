// Browser client. The room's Durable Object runs the game; this file sends paddle input,
// predicts ahead of the snapshots it receives (see netcode.js), and draws them. Player names are
// only ever put on the page with textContent, never innerHTML, so a name like <img onerror=...>
// renders as text.
import { Clock, Smoothed, predictBall, replayPaddle } from './netcode.js';

const PING_EVERY_MS = 2000;
const MAX_PREDICT_S = 0.5; // past this, a silent server means trouble, not lag: stop guessing
// ?lag=200 adds that many ms of round trip in this tab, to feel how the game plays far away.
const FAKE_LAG_MS = Math.min(1000, Math.max(0, Number(new URLSearchParams(location.search).get('lag')) || 0));

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');

let ws = null;
let room = null;
let me = { side: null, token: sessionStorage.getItem('pong-token') || randomToken() };
let config = null; // field/paddle/ball sizes from the server
let lobby = null;
let latest = null; // newest state snapshot
let myY = null; // where my paddle is drawn, used by touch controls
let dir = 0;
let inputSeq = 0;
let pending = []; // inputs the server has not acknowledged yet: [{ seq, dir, at }]
const clock = new Clock();
const shown = { l: new Smoothed(), r: new Smoothed(), bx: new Smoothed(), by: new Smoothed() };
let lastFrame = performance.now();
let reconnectDelay = 500;
let pingTimer = null;
let over = null;
let replaced = false;

sessionStorage.setItem('pong-token', me.token);
$('name').value = localStorage.getItem('pong-name') || '';

function randomToken() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
}

// ---- Lobby ----

$('create').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/new-room');
    const { code } = await res.json();
    enterRoom(code);
  } catch {
    $('lobby-error').textContent = 'Could not create a room. Try again.';
  }
});

$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('code').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(code)) {
    $('lobby-error').textContent = 'Room codes are 4 to 12 letters or digits.';
    return;
  }
  enterRoom(code);
});

$('copy').addEventListener('click', async () => {
  const link = `${location.origin}/?room=${room}`;
  try {
    await navigator.clipboard.writeText(link);
    $('copy').textContent = 'Copied';
  } catch {
    prompt('Copy this link', link);
  }
  setTimeout(() => ($('copy').textContent = 'Copy invite link'), 1500);
});

$('rematch').addEventListener('click', () => {
  send({ t: 'rematch' });
  $('rematch').disabled = true;
  $('overlay-sub').textContent = 'Waiting for the other player…';
});

function enterRoom(code) {
  room = code;
  localStorage.setItem('pong-name', $('name').value.trim());
  history.replaceState(null, '', `/?room=${code}`);
  $('room-code').textContent = code;
  $('lobby').hidden = true;
  $('play').hidden = false;
  connect();
}

const fromLink = new URLSearchParams(location.search).get('room');
if (fromLink && /^[A-Za-z0-9]{4,12}$/.test(fromLink)) {
  $('code').value = fromLink.toUpperCase();
  if (localStorage.getItem('pong-name')) enterRoom(fromLink.toUpperCase());
}

// ---- Connection ----

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const params = new URLSearchParams({ token: me.token, name: $('name').value.trim() });
  ws = new WebSocket(`${proto}://${location.host}/api/rooms/${room}/ws?${params}`);
  setStatus('Connecting…');

  ws.addEventListener('open', () => {
    reconnectDelay = 500;
    clearTimeout(pingTimer);
    // A few quick pings first so the clock and round trip are known within a second.
    let quick = 4;
    const ping = () => {
      send({ t: 'ping', id: performance.now() });
      pingTimer = setTimeout(ping, quick-- > 0 ? 250 : PING_EVERY_MS);
    };
    ping();
  });

  ws.addEventListener('message', (e) => later(() => onMessage(JSON.parse(e.data))));

  ws.addEventListener('close', (e) => {
    clearTimeout(pingTimer);
    if (replaced || e.code === 4000) {
      setStatus('This room is open in another tab.');
      return;
    }
    setStatus('Connection lost. Reconnecting…');
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 8000);
  });
}

function send(msg) {
  const socket = ws;
  later(() => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  });
}

// Runs fn now, or after half the simulated round trip when ?lag= is set.
function later(fn) {
  if (FAKE_LAG_MS) setTimeout(fn, FAKE_LAG_MS / 2);
  else fn();
}

function sendInput() {
  inputSeq += 1;
  pending.push({ seq: inputSeq, dir, at: performance.now() });
  send({ t: 'input', dir, seq: inputSeq });
}

function onMessage(msg) {
  switch (msg.t) {
    case 'welcome':
      me.side = msg.side;
      config = { field: msg.field, paddle: msg.paddle, ball: msg.ball, winScore: msg.winScore };
      latest = null;
      pending = [];
      myY = null;
      for (const v of Object.values(shown)) v.correct(0, 0, true);
      break;
    case 'lobby':
      lobby = msg;
      if (msg.status !== 'over') hideOverlay();
      // The server zeroes input while paused; re-send a key that is still held.
      if (msg.status === 'playing' && dir) sendInput();
      renderLobby();
      break;
    case 'state':
      onState(msg);
      $('left-score').textContent = msg.sl;
      $('right-score').textContent = msg.sr;
      break;
    case 'over':
      over = msg;
      showOverlay();
      break;
    case 'replaced':
      replaced = true;
      setStatus('This room is open in another tab.');
      break;
    case 'pong':
      if (typeof msg.now === 'number') clock.sample(msg.id, performance.now(), msg.now);
      $('ping').textContent = `${Math.round(performance.now() - msg.id)} ms`;
      break;
  }
}

function playerName(side) {
  return lobby?.players[side]?.name ?? (side === 'left' ? 'Left' : 'Right');
}

function renderLobby() {
  for (const side of ['left', 'right']) {
    const el = $(`${side}-name`);
    const p = lobby.players[side];
    el.textContent = p ? p.name : 'Waiting for player…';
    el.classList.toggle('away', !p || !p.connected);
    el.classList.toggle('you', side === me.side);
  }
  const away = ['left', 'right'].find((s) => lobby.players[s] && !lobby.players[s].connected);
  if (lobby.status === 'waiting') {
    setStatus(me.side ? 'Waiting for an opponent. Share the invite link.' : 'Waiting for players.');
  } else if (lobby.status === 'paused' && away) {
    setStatus(`${playerName(away)} disconnected. Waiting for them to come back…`);
  } else if (lobby.status === 'playing') {
    setStatus(me.side ? `You are ${me.side}.` : 'Spectating.');
  } else if (lobby.status === 'over') {
    setStatus('Game over.');
  }
  if (lobby.status === 'over' && over) showOverlay();
}

function setStatus(text) {
  $('status').textContent = text;
}

function showOverlay() {
  const winner = over.winner;
  $('overlay-title').textContent = winner === me.side ? 'You win!' : `${playerName(winner)} wins!`;
  const why = over.reason === 'forfeit' ? 'The other player left.' : '';
  const asked = lobby?.rematch ?? [];
  if (me.side && asked.includes(me.side)) {
    $('overlay-sub').textContent = 'Waiting for the other player…';
  } else if (asked.length) {
    $('overlay-sub').textContent = `${playerName(asked[0])} wants a rematch.`;
  } else {
    $('overlay-sub').textContent = why;
  }
  $('rematch').hidden = !me.side;
  $('rematch').disabled = me.side ? asked.includes(me.side) : true;
  $('overlay').hidden = false;
}

function hideOverlay() {
  over = null;
  $('overlay').hidden = true;
}

// ---- Input ----

const held = new Set();
const UP = new Set(['KeyW', 'ArrowUp']);
const DOWN = new Set(['KeyS', 'ArrowDown']);

function updateDir() {
  const up = [...held].some((k) => UP.has(k));
  const down = [...held].some((k) => DOWN.has(k));
  setDir(up === down ? 0 : up ? -1 : 1);
}

function setDir(d) {
  if (d === dir) return;
  dir = d;
  sendInput();
}

addEventListener('keydown', (e) => {
  if (!UP.has(e.code) && !DOWN.has(e.code)) return;
  if (document.activeElement?.tagName === 'INPUT') return;
  e.preventDefault();
  held.add(e.code);
  updateDir();
});
addEventListener('keyup', (e) => {
  held.delete(e.code);
  updateDir();
});
addEventListener('blur', () => {
  held.clear();
  updateDir();
});

// Touch: hold above or below your paddle to move toward your finger.
let touchY = null;
function onTouch(e) {
  e.preventDefault();
  const t = e.touches[0];
  if (!t) {
    touchY = null;
    setDir(0);
    return;
  }
  const rect = canvas.getBoundingClientRect();
  touchY = ((t.clientY - rect.top) / rect.height) * canvas.height;
}
canvas.addEventListener('touchstart', onTouch, { passive: false });
canvas.addEventListener('touchmove', onTouch, { passive: false });
canvas.addEventListener('touchend', onTouch, { passive: false });
canvas.addEventListener('touchcancel', onTouch, { passive: false });

// ---- Prediction ----

// The court as it will be when an input sent now reaches the server (for spectators: as it is
// on the server now), worked out from one snapshot.
function predict(snap, now) {
  const at = clock.toLocal(snap.now);
  const lead = me.side ? clock.lead() : 0;
  const until = now + lead;
  const seconds = snap.status === 'playing' ? Math.min(MAX_PREDICT_S, Math.max(0, (until - at) / 1000)) : 0;
  const ack = me.side === 'left' ? snap.al : snap.ar;
  const unacked = pending.filter((p) => p.seq > ack);

  const paddleY = (side, t) => {
    const key = side === 'left' ? 'l' : 'r';
    const d = side === 'left' ? snap.il : snap.ir;
    if (side === me.side && seconds > 0) {
      return replayPaddle(snap[key], d, at, unacked, at + t * 1000, lead, config);
    }
    // The other player: assume they keep doing what they were doing.
    const max = config.field.height - config.paddle.height;
    return Math.max(0, Math.min(max, snap[key] + d * config.paddle.speed * t));
  };
  const ball = predictBall(snap, seconds, paddleY, config);
  return { l: paddleY('left', seconds), r: paddleY('right', seconds), bx: ball.bx, by: ball.by, serving: ball.serving };
}

function onState(msg) {
  const now = performance.now();
  clock.seed(msg.now, now);
  const prev = latest;
  const before = prev && config ? predict(prev, now) : null;
  const ack = me.side === 'left' ? msg.al : msg.ar;
  pending = pending.filter((p) => p.seq > ack);
  latest = msg;
  if (!before) return;
  // The snapshot moved our guess for this moment; glide to the new guess rather than jump,
  // except when the ball was reset or play stopped or started.
  const after = predict(msg, now);
  const reset = before.serving !== after.serving || prev.status !== msg.status
    || prev.sl + prev.sr !== msg.sl + msg.sr;
  for (const k of ['l', 'r']) shown[k].correct(before[k], after[k], Math.abs(before[k] - after[k]) > 150);
  for (const k of ['bx', 'by']) shown[k].correct(before[k], after[k], reset || Math.abs(before[k] - after[k]) > 200);
}

// ---- Rendering ----

function frame(now) {
  const dt = Math.min((now - lastFrame) / 1000, 0.05);
  lastFrame = now;
  draw(now, dt);
  requestAnimationFrame(frame);
}

function draw(now, dt) {
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (!config) return;

  const sx = W / config.field.width;
  const sy = H / config.field.height;
  const { paddle, ball, field } = config;

  ctx.fillStyle = '#2a313c';
  for (let y = 10; y < H; y += 28) ctx.fillRect(W / 2 - 2, y, 4, 14);

  if (!latest) return;
  const s = latest;

  if (me.side && touchY !== null && myY !== null) {
    const centre = myY + paddle.height / 2;
    setDir(Math.abs(touchY - centre) < 8 ? 0 : touchY < centre ? -1 : 1);
  }

  const p = predict(s, now);
  const ms = dt * 1000;
  const leftY = shown.l.value(p.l, ms);
  const rightY = shown.r.value(p.r, ms);
  const bx = shown.bx.value(p.bx, ms);
  const by = shown.by.value(p.by, ms);
  if (me.side) myY = me.side === 'left' ? leftY : rightY;

  ctx.fillStyle = '#e8ecf1';
  ctx.fillRect(paddle.inset * sx, leftY * sy, paddle.width * sx, paddle.height * sy);
  ctx.fillRect((field.width - paddle.inset - paddle.width) * sx, rightY * sy, paddle.width * sx, paddle.height * sy);

  if (!s.winner) {
    ctx.fillStyle = p.serving ? '#5ad1a5' : '#e8ecf1';
    ctx.fillRect(bx * sx, by * sy, ball.size * sx, ball.size * sy);
  }
}

requestAnimationFrame(frame);
