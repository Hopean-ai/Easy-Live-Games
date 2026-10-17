// Browser client. The room's Durable Object runs the game; this file sends paddle input,
// smooths the snapshots it receives, and draws them. Player names are only ever put on the
// page with textContent, never innerHTML, so a name like <img onerror=...> renders as text.

const INTERP_DELAY_MS = 70; // render this far behind the newest snapshot to hide jitter
const PING_EVERY_MS = 2000;

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');

let ws = null;
let room = null;
let me = { side: null, token: sessionStorage.getItem('pong-token') || randomToken() };
let config = null; // field/paddle/ball sizes from the server
let lobby = null;
let snaps = []; // [{ at, ...state }]
let latest = null;
let myY = null; // predicted position of my own paddle
let dir = 0;
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
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ t: 'ping', id: performance.now() }), PING_EVERY_MS);
  });

  ws.addEventListener('message', (e) => onMessage(JSON.parse(e.data)));

  ws.addEventListener('close', (e) => {
    clearInterval(pingTimer);
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
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function onMessage(msg) {
  switch (msg.t) {
    case 'welcome':
      me.side = msg.side;
      config = { field: msg.field, paddle: msg.paddle, ball: msg.ball, winScore: msg.winScore };
      snaps = [];
      myY = null;
      break;
    case 'lobby':
      lobby = msg;
      if (msg.status !== 'over') hideOverlay();
      // The server zeroes input while paused; re-send a key that is still held.
      if (msg.status === 'playing' && dir) send({ t: 'input', dir });
      renderLobby();
      break;
    case 'state':
      latest = msg;
      snaps.push({ at: performance.now(), ...msg });
      if (snaps.length > 30) snaps.shift();
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
  send({ t: 'input', dir });
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

// ---- Rendering ----

function interpolated(now) {
  const target = now - INTERP_DELAY_MS;
  let a = null;
  let b = null;
  for (let i = snaps.length - 1; i > 0; i--) {
    if (snaps[i - 1].at <= target) {
      a = snaps[i - 1];
      b = snaps[i];
      break;
    }
  }
  if (!a) return snaps[0] ?? null;
  const k = Math.min(1, (target - a.at) / Math.max(1, b.at - a.at));
  // A score resets the ball to the centre; never slide it across the court.
  const jumped = a.sl !== b.sl || a.sr !== b.sr;
  const lerp = (x, y) => (jumped ? y : x + (y - x) * k);
  return { ...b, l: lerp(a.l, b.l), r: lerp(a.r, b.r), bx: lerp(a.bx, b.bx), by: lerp(a.by, b.by) };
}

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

  const s = interpolated(now);
  if (!s) return;

  // Predict my own paddle so it responds instantly, and ease it back toward the server's view.
  if (me.side && latest) {
    const serverY = latest[me.side === 'left' ? 'l' : 'r'];
    if (myY === null) myY = serverY;
    if (touchY !== null) {
      const centre = myY + paddle.height / 2;
      setDir(Math.abs(touchY - centre) < 8 ? 0 : touchY < centre ? -1 : 1);
    }
    const moving = latest.status === 'playing' ? dir : 0;
    myY = Math.max(0, Math.min(field.height - paddle.height, myY + moving * paddle.speed * dt));
    myY += (serverY - myY) * (moving ? 0.05 : 0.2);
  }

  const leftY = me.side === 'left' && myY !== null ? myY : s.l;
  const rightY = me.side === 'right' && myY !== null ? myY : s.r;

  ctx.fillStyle = '#e8ecf1';
  ctx.fillRect(paddle.inset * sx, leftY * sy, paddle.width * sx, paddle.height * sy);
  ctx.fillRect((field.width - paddle.inset - paddle.width) * sx, rightY * sy, paddle.width * sx, paddle.height * sy);

  if (!s.winner) {
    ctx.fillStyle = s.serve ? '#5ad1a5' : '#e8ecf1';
    ctx.fillRect(s.bx * sx, s.by * sy, ball.size * sx, ball.size * sy);
  }
}

requestAnimationFrame(frame);
