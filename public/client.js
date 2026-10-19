// Browser client. The room's Durable Object runs the game; this file sends paddle input,
// predicts ahead of the snapshots it receives (see netcode.js), and draws them. Player names are
// only ever put on the page with textContent, never innerHTML, so a name like <img onerror=...>
// renders as text.
import { Clock, Smoothed, predictBall, replayPaddle, statsFor } from './netcode.js';

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
let config = null; // field/paddle/ball sizes and the skill tree from the server
let skills = null; // { left: { points, owned, stats }, right: ... } from the server
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

let myName = '';
let fromMatch = false; // entered the room through quick match
let matchWs = null;
let matchPing = null;

sessionStorage.setItem('pong-token', me.token);

function randomToken() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
}

function wsBase() {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
}

// ---- Lobby ----

// Signed-in players play under their account name (the server enforces it); guests pick a name
// on the home page. Anyone who has done neither is sent there first and comes straight back.
async function init() {
  let account = null;
  try {
    account = (await (await fetch('/api/me')).json()).name;
  } catch {
    // Treat as signed out.
  }
  const guest = localStorage.getItem('guest-name');
  if (!account && !guest) {
    location.replace(`/?next=${encodeURIComponent(location.pathname + location.search)}`);
    return;
  }
  myName = account || guest;
  $('me-name').textContent = myName;
  $('me-guest').hidden = Boolean(account);

  const params = new URLSearchParams(location.search);
  const fromLink = params.get('room');
  if (fromLink && /^[A-Za-z0-9]{4,12}$/.test(fromLink)) {
    enterRoom(fromLink.toUpperCase());
    return;
  }
  $('lobby').hidden = false;
  if (params.has('quick')) {
    history.replaceState(null, '', location.pathname);
    findMatch();
  }
}

$('quick').addEventListener('click', () => findMatch());
$('cancel').addEventListener('click', () => stopMatch());

// Waits in the matchmaking queue until the server pairs us with someone and names a room.
function findMatch() {
  stopMatch();
  $('lobby-error').textContent = '';
  $('searching').hidden = false;
  $('quick').disabled = true;
  const sock = (matchWs = new WebSocket(`${wsBase()}/api/match/pong/ws?${new URLSearchParams({ token: me.token })}`));
  // Keeps the connection from idling out; the server answers without waking up.
  sock.addEventListener('open', () => (matchPing = setInterval(() => sock.send('ping'), 30_000)));
  sock.addEventListener('message', (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return; // 'pong'
    }
    if (msg.t === 'matched' && /^[A-Z0-9]{4,12}$/.test(msg.room)) {
      stopMatch();
      fromMatch = true;
      enterRoom(msg.room);
    } else if (msg.t === 'replaced') {
      stopMatch();
      $('lobby-error').textContent = 'You are searching in another tab.';
    }
  });
  sock.addEventListener('close', () => {
    if (matchWs !== sock) return;
    stopMatch();
    $('lobby-error').textContent = 'Lost the connection to matchmaking. Try again.';
  });
}

function stopMatch() {
  const sock = matchWs;
  matchWs = null;
  clearInterval(matchPing);
  sock?.close();
  $('searching').hidden = true;
  $('quick').disabled = false;
}

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
  const link = `${location.origin}/pong?room=${room}`;
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

// A matched opponent who never shows up shouldn't strand you: offer to queue again.
$('requeue').addEventListener('click', () => location.replace('/pong?quick=1'));

function enterRoom(code) {
  room = code;
  history.replaceState(null, '', `/pong?room=${code}`);
  $('room-code').textContent = code;
  $('lobby').hidden = true;
  $('play').hidden = false;
  if (fromMatch) {
    setTimeout(() => {
      if (lobby?.status === 'waiting' && me.side) $('requeue').hidden = false;
    }, 20_000);
  }
  connect();
}

init();

// ---- Connection ----

function connect() {
  const params = new URLSearchParams({ token: me.token, name: myName });
  ws = new WebSocket(`${wsBase()}/api/rooms/${room}/ws?${params}`);
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
      config = { field: msg.field, paddle: msg.paddle, ball: msg.ball, winScore: msg.winScore, skills: msg.skills };
      latest = null;
      pending = [];
      myY = null;
      for (const v of Object.values(shown)) v.correct(0, 0, true);
      buildTree();
      break;
    case 'skills':
      skills = msg;
      renderTree();
      break;
    case 'lobby':
      lobby = msg;
      if (msg.status !== 'over') hideOverlay();
      renderTree();
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
    el.textContent = p ? p.name + (p.guest ? ' (guest)' : '') : 'Waiting for player…';
    el.classList.toggle('away', !p || !p.connected);
    el.classList.toggle('you', side === me.side);
  }
  const away = ['left', 'right'].find((s) => lobby.players[s] && !lobby.players[s].connected);
  if (lobby.status === 'waiting') {
    if (!me.side) setStatus('Waiting for players.');
    else setStatus(fromMatch ? 'Waiting for your opponent to join…' : 'Waiting for an opponent. Share the invite link.');
  } else if (lobby.status === 'paused' && away) {
    setStatus(`${playerName(away)} disconnected. Waiting for them to come back…`);
  } else if (lobby.status === 'playing') {
    setStatus(me.side ? `You are ${me.side}.` : 'Spectating.');
  } else if (lobby.status === 'over') {
    setStatus('Game over.');
  }
  if (lobby.status !== 'waiting') $('requeue').hidden = true;
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

// ---- Skill tree ----
// The server owns skill points and applies every effect; this only shows the tree and asks to buy.

const treeButtons = new Map(); // skill id -> button

function buildTree() {
  const root = $('tree');
  root.replaceChildren();
  treeButtons.clear();
  const branches = [...new Set(config.skills.map((s) => s.branch))];
  for (const branch of branches) {
    const col = document.createElement('div');
    col.className = 'branch';
    for (const skill of config.skills.filter((s) => s.branch === branch)) {
      const key = config.skills.indexOf(skill) + 1;
      const btn = document.createElement('button');
      btn.className = 'skill';
      btn.title = `${skill.desc} (key ${key})`;
      const name = document.createElement('span');
      name.className = 'skill-name';
      name.textContent = `${key}. ${skill.name}`;
      const meta = document.createElement('span');
      meta.className = 'skill-meta';
      meta.textContent = `${skill.cost} pt · ${skill.desc}`;
      btn.append(name, meta);
      btn.addEventListener('click', () => buySkill(skill.id));
      col.append(btn);
      treeButtons.set(skill.id, btn);
    }
    root.append(col);
  }
  renderTree();
}

function buySkill(id) {
  if (me.side) send({ t: 'skill', id });
}

function renderTree() {
  const panel = $('skills');
  panel.hidden = !config || !me.side;
  if (panel.hidden) return;
  const mine = skills?.[me.side] ?? { points: 0, owned: [] };
  const theirs = skills?.[me.side === 'left' ? 'right' : 'left'];
  $('skill-points').textContent = `${mine.points} skill point${mine.points === 1 ? '' : 's'}`;
  const named = (ids) => ids.map((id) => config.skills.find((s) => s.id === id)?.name).filter(Boolean);
  $('their-skills').textContent = theirs?.owned.length ? `Opponent has: ${named(theirs.owned).join(', ')}` : '';
  const playing = lobby?.status === 'playing';
  for (const skill of config.skills) {
    const btn = treeButtons.get(skill.id);
    const owned = mine.owned.includes(skill.id);
    const locked = skill.requires && !mine.owned.includes(skill.requires);
    btn.classList.toggle('owned', owned);
    btn.classList.toggle('locked', Boolean(locked));
    btn.disabled = owned || locked || mine.points < skill.cost || !playing;
  }
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
  const digit = /^Digit([1-9])$/.exec(e.code);
  if (digit && config?.skills && document.activeElement?.tagName !== 'INPUT') {
    const skill = config.skills[Number(digit[1]) - 1];
    if (skill) buySkill(skill.id);
    return;
  }
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

// The config with each side's skill upgrades, so prediction plays by the server's numbers. The
// paddle height comes from the snapshot itself, so it always matches that snapshot's positions.
function courtFor(snap) {
  const side = (s) => ({
    ...(skills?.[s]?.stats ?? statsFor(config, s)),
    height: snap[s === 'left' ? 'lh' : 'rh'] ?? config.paddle.height,
  });
  return { ...config, sides: { left: side('left'), right: side('right') } };
}

// The court as it will be when an input sent now reaches the server (for spectators: as it is
// on the server now), worked out from one snapshot.
function predict(snap, now) {
  const court = courtFor(snap);
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
      return replayPaddle(snap[key], d, at, unacked, at + t * 1000, lead, court, side);
    }
    // The other player: assume they keep doing what they were doing.
    const { height, speed } = statsFor(court, side);
    const max = config.field.height - height;
    return Math.max(0, Math.min(max, snap[key] + d * speed * t));
  };
  // Spin depends on which way a paddle is moving as it hits; for mine, that's my latest input
  // to have landed by then.
  const paddleDir = (side, t) => {
    let d = side === 'left' ? snap.il : snap.ir;
    if (side === me.side) {
      for (const input of unacked) if (input.at + lead <= at + t * 1000) d = input.dir;
    }
    return d ?? 0;
  };
  const ball = predictBall(snap, seconds, paddleY, court, paddleDir);
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
    const centre = myY + statsFor(courtFor(s), me.side).height / 2;
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
  const leftH = statsFor(courtFor(s), 'left').height;
  const rightH = statsFor(courtFor(s), 'right').height;
  ctx.fillRect(paddle.inset * sx, leftY * sy, paddle.width * sx, leftH * sy);
  ctx.fillRect((field.width - paddle.inset - paddle.width) * sx, rightY * sy, paddle.width * sx, rightH * sy);

  if (!s.winner) {
    ctx.fillStyle = p.serving ? '#5ad1a5' : '#e8ecf1';
    ctx.fillRect(bx * sx, by * sy, ball.size * sx, ball.size * sy);
  }
}

requestAnimationFrame(frame);
