// Driftmail: your island from above, the letters on your shelf, and writing a letter to throw.
// The ocean lives on the server (src/driftmail/ocean.js); this page asks for the island's state
// now and then and draws it. Letters are only ever put on the page with textContent.
const $ = (id) => document.getElementById(id);
const canvas = $('beach');
const ctx = canvas.getContext('2d');

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const DIR_WORDS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
const SUPPLY_NAMES = { bottles: 'Bottles', corks: 'Corks', paper: 'Paper', ink: 'Ink' };
const FONTS = ['Caveat', 'Covered By Your Grace', 'Gochi Hand', 'Homemade Apple', 'Indie Flower', 'Kalam', 'Nanum Pen Script', 'Patrick Hand', 'Reenie Beanie', 'Shadows Into Light'];
const INKS = ['#1f2a44', '#2b2620', '#3a2a5a', '#173d33', '#5a2222', '#24364f', '#4a3b1c'];
const GLYPHS = ['✶', '☽', '⚓', '❀', '✦', '♆', '☀', '✿', '◈', '❖', '✺', '♠', '♣', '♥', '♦', '☘'];
const WAX = ['#8e2b2b', '#2b4f8e', '#2f6b3f', '#6b3f8e', '#8e6a2b', '#3a3a3a', '#8e2b62'];
const POLL_MS = 30_000;

let state = null;
let offset = 0; // server clock minus ours
let dir = null;
let replyTo = null;
let throwing = null; // the bottle flying off after a throw, for a moment
const bottleSpots = [];

// --- talking to the ocean -------------------------------------------------------------------

async function call(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  if (res.status === 401) {
    showSignIn();
    return null;
  }
  return res.json().catch(() => ({ error: 'Something went wrong. Try again.' }));
}

function showSignIn() {
  $('game').hidden = true;
  $('write').hidden = true;
  $('signin').hidden = false;
  // A guest would bounce straight back here from the home page, so only offer the round trip
  // to someone who isn't one.
  if (!localStorage.getItem('guest-name')) $('signin-link').href = '/?next=/driftmail';
}

async function refresh() {
  const s = await call('/api/driftmail/state');
  if (s && !s.error) take(s);
}

function take(s) {
  state = s;
  offset = s.now - Date.now();
  $('signin').hidden = true;
  $('game').hidden = false;
  if (s.found?.length) {
    $('found').hidden = false;
    $('found').textContent = `The tide left you ${list(s.found)}.`;
  }
  render();
}

// --- time and tide, the same rules as src/driftmail/world.js ------------------------------

function clockNow() {
  const t = Date.now() + offset;
  const dayMs = state.clock.dayMs;
  const day = (t % dayMs) / dayMs;
  const phase = ((t % (dayMs / 2)) / (dayMs / 2)) * 2 * Math.PI;
  const tide = Math.cos(phase);
  const ebbing = Math.sin(phase) > 0;
  const part = [[0.2, 'night'], [0.3, 'dawn'], [0.45, 'morning'], [0.6, 'midday'], [0.7, 'afternoon'], [0.8, 'dusk'], [1, 'night']].find(([end]) => day < end)[1];
  const words = tide > 0.8 ? 'high tide' : tide < -0.8 ? 'low tide' : ebbing ? 'tide going out' : 'tide coming in';
  // The current: north at dawn, turning clockwise through the day.
  const angle = Math.PI / 2 - 2 * Math.PI * (day - 0.25);
  const currentDir = ((Math.round((Math.PI / 2 - angle) / (Math.PI / 4)) % 8) + 8) % 8;
  return { day, tide, ebbing, part, words, currentDir };
}

// --- drawing the island ---------------------------------------------------------------------

const W = canvas.width;
const H = canvas.height;
const CX = W / 2;
const CY = H / 2 + 10;

function waterline(tide) {
  const low = (1 - tide) / 2; // 0 at high tide, 1 at low
  return { rx: 250 + 55 * low, ry: 150 + 38 * low };
}

function draw() {
  if (!state) return;
  const c = clockNow();
  const sea = mix('#0a1d2e', '#2a7fa8', daylight(c.day));
  ctx.fillStyle = sea;
  ctx.fillRect(0, 0, W, H);

  // A few ripples so the water reads as water.
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 18; i++) {
    const x = (i * 137 + (Date.now() / 90) % 140) % W;
    const y = (i * 71) % H;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + 12, y - 4, x + 24, y);
    ctx.stroke();
  }

  const wl = waterline(c.tide);
  ellipse(wl.rx + 8, wl.ry + 6, 'rgba(255,255,255,0.18)'); // surf
  ellipse(wl.rx, wl.ry, '#b59c6d'); // wet sand
  ellipse(246, 146, '#e2cc98'); // dry sand above the high-water mark

  // Trees across the north of the island.
  ctx.fillStyle = '#4c7a43';
  ctx.beginPath();
  ctx.ellipse(CX - 10, CY - 70, 165, 58, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#3d6637';
  for (const [x, y] of [[-120, -80], [-60, -98], [10, -104], [80, -92], [140, -72], [-20, -60], [60, -58]]) {
    ctx.beginPath();
    ctx.arc(CX + x, CY + y, 18, 0, Math.PI * 2);
    ctx.fill();
  }

  // Places to build later, marked out on the sand.
  plot(CX - 40, CY - 30, 84, 56, 'shack (not built yet)');
  plot(CX + 80, CY - 10, 62, 42, 'garden');
  // The crate you washed up beside.
  ctx.fillStyle = '#7a5531';
  ctx.fillRect(CX + 6, CY + 60, 28, 20);
  ctx.strokeStyle = '#4e351d';
  ctx.strokeRect(CX + 6, CY + 60, 28, 20);
  // The fire: embers by day, a glow at night.
  const dark = 1 - daylight(c.day);
  const fx = CX - 90;
  const fy = CY + 40;
  if (dark > 0.3) {
    const g = ctx.createRadialGradient(fx, fy, 2, fx, fy, 70);
    g.addColorStop(0, `rgba(255,170,80,${0.5 * dark})`);
    g.addColorStop(1, 'rgba(255,170,80,0)');
    ctx.fillStyle = g;
    ctx.fillRect(fx - 70, fy - 70, 140, 140);
  }
  ctx.fillStyle = '#5b4632';
  ctx.beginPath();
  ctx.arc(fx, fy, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = dark > 0.3 ? '#ffb347' : '#c0603a';
  ctx.beginPath();
  ctx.arc(fx, fy, 5, 0, Math.PI * 2);
  ctx.fill();

  // Bottles waiting on the wet sand, on the beach they washed up on.
  bottleSpots.length = 0;
  for (const b of state.beach) {
    const spot = bottleSpot(b, wl);
    bottleSpots.push({ ...spot, id: b.id });
    drawBottle(spot.x, spot.y, spot.angle);
  }
  if (throwing) {
    const k = Math.min(1, (performance.now() - throwing.start) / 1400);
    const a = Math.PI / 2 - (throwing.dir * Math.PI) / 4;
    const r = 1 + k * 1.6;
    drawBottle(CX + Math.cos(a) * wl.rx * r, CY - Math.sin(a) * wl.ry * r, k * 9);
    if (k >= 1) throwing = null;
  }

  // Light: dark blue at night, warm at dawn and dusk.
  if (dark > 0) {
    ctx.fillStyle = `rgba(4,10,35,${0.55 * dark})`;
    ctx.fillRect(0, 0, W, H);
  }
  if (c.part === 'dawn' || c.part === 'dusk') {
    ctx.fillStyle = 'rgba(255,140,80,0.12)';
    ctx.fillRect(0, 0, W, H);
  }
  compassRose();
  canvas.classList.toggle('pointer', bottleSpots.length > 0);
}

function ellipse(rx, ry, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(CX, CY, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
}

function plot(x, y, w, h, label) {
  ctx.save();
  ctx.setLineDash([6, 5]);
  ctx.strokeStyle = 'rgba(80,60,30,0.6)';
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
  ctx.fillStyle = 'rgba(70,52,26,0.75)';
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(label, x + w / 2, y + h / 2 + 4);
}

const SHORE_ANGLE = { north: -Math.PI / 2, east: 0, south: Math.PI / 2, west: Math.PI };

function bottleSpot(b, wl) {
  const spread = (((b.id * 37) % 60) - 30) * (Math.PI / 180);
  const a = (SHORE_ANGLE[b.shore] ?? Math.PI / 2) + spread;
  const k = 0.5 + ((b.id * 13) % 10) / 40; // somewhere on the wet sand
  const rx = 246 + (wl.rx - 246) * k + 6;
  const ry = 146 + (wl.ry - 146) * k + 4;
  return { x: CX + Math.cos(a) * rx, y: CY + Math.sin(a) * ry, angle: a + b.id };
}

function drawBottle(x, y, angle) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = 'rgba(120,190,150,0.85)';
  ctx.strokeStyle = 'rgba(30,70,50,0.9)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(-11, -5, 16, 10, 4);
  ctx.fill();
  ctx.stroke();
  ctx.fillRect(5, -2.5, 6, 5);
  ctx.fillStyle = '#9b6b3a';
  ctx.fillRect(10, -2.5, 4, 5);
  ctx.fillStyle = 'rgba(243,234,214,0.9)';
  ctx.fillRect(-7, -2, 9, 4); // the rolled letter inside
  ctx.restore();
}

function compassRose() {
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = 'bold 14px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('N', W - 32, 28);
  ctx.beginPath();
  ctx.moveTo(W - 32, 34);
  ctx.lineTo(W - 38, 52);
  ctx.lineTo(W - 26, 52);
  ctx.closePath();
  ctx.fill();
}

// 0 at midnight, 1 through the middle of the day, ramping at dawn and dusk.
function daylight(day) {
  if (day < 0.2 || day >= 0.8) return 0;
  if (day < 0.3) return (day - 0.2) / 0.1;
  if (day >= 0.7) return 1 - (day - 0.7) / 0.1;
  return 1;
}

function mix(a, b, k) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * k)).join(',')})`;
}

canvas.addEventListener('click', (e) => {
  const r = canvas.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * W;
  const y = ((e.clientY - r.top) / r.height) * H;
  const hit = bottleSpots.find((s) => Math.hypot(s.x - x, s.y - y) < 22);
  if (hit) openBottle(hit.id);
});

// --- the panels -----------------------------------------------------------------------------

function render() {
  const c = clockNow();
  $('time').textContent = `${cap(c.part)} on your island, ${c.words}.`;
  $('beach-hint').textContent = state.beach.length
    ? `${state.beach.length === 1 ? 'A bottle has' : `${state.beach.length} bottles have`} washed up. Tap one to open it.`
    : 'Nothing on the sand right now.';

  $('supplies').replaceChildren(...Object.entries(SUPPLY_NAMES).map(([k, label]) => {
    const li = el('li', state.island.supplies[k] < 1 ? 'low' : '', label);
    li.append(el('strong', '', String(state.island.supplies[k])));
    return li;
  }));

  $('shelf').replaceChildren(...state.shelf.map((l) => {
    const b = el('button', 'link', l.own ? `Your own letter, back again: ${firstLine(l.text)}` : firstLine(l.text));
    b.addEventListener('click', () => read(l));
    const li = el('li');
    li.append(b, el('span', 'when', `${l.shore} beach, ${ago(l.landed)}`));
    return li;
  }));
  $('shelf-empty').hidden = state.shelf.length > 0;

  $('sent').replaceChildren(...state.sent.map((s) => {
    const li = el('li', '', firstLine(s.text));
    li.append(el('span', 'when', `${s.ashore ? 'Washed up somewhere' : 'Still drifting'} · thrown ${ago(s.thrown)}`));
    return li;
  }));
  $('sent-empty').hidden = state.sent.length > 0;

  $('curios').replaceChildren(...state.island.curios.map((c) => {
    const li = el('li', c.unique ? 'dm-unique' : '', cap(c.name));
    if (c.unique) li.title = 'One of a kind. Nobody else has this.';
    return li;
  }));
  draw();
}

// --- reading --------------------------------------------------------------------------------

async function openBottle(id) {
  $('error').textContent = '';
  const s = await call('/api/driftmail/open', { id });
  if (!s) return;
  if (s.error) {
    $('error').textContent = s.error;
    return;
  }
  take(s);
  const letter = s.shelf.find((l) => l.id === s.opened);
  if (letter) read(letter);
}

let reading = null;

function read(letter) {
  reading = letter;
  $('read-note').textContent = letter.own
    ? `Your own bottle washed back to your ${letter.shore} beach. Nobody else was in reach.`
    : `Washed up on your ${letter.shore} beach at ${letter.part}, ${letter.tide}.`;
  const paper = $('read-paper');
  paper.replaceChildren();
  handwriting(paper, letter.hand);
  if (letter.replyTo) paper.append(el('span', 'reply-of', `In answer to your letter: “${letter.replyTo}”`));
  paper.append(document.createTextNode(letter.text));
  if (letter.name) paper.append(el('span', 'sig', `— ${letter.name}`));
  paper.append(seal(letter.emblem, letter.marked));
  $('reply').hidden = letter.own;
  $('reader').showModal();
}

$('close-reader').addEventListener('click', () => $('reader').close());
$('reply').addEventListener('click', () => {
  $('reader').close();
  compose(reading);
});

// Each writer's hand, the same on every letter they send: a font, a slant, a size, an ink.
function handwriting(node, seed) {
  const r = rng(seed);
  const pick = (list) => list[Math.floor(r() * list.length)];
  node.style.fontFamily = `"${pick(FONTS)}", cursive`;
  node.style.color = pick(INKS);
  node.style.fontSize = `${(1.15 + r() * 0.45).toFixed(2)}rem`;
  node.style.letterSpacing = `${(r() * 1.6 - 0.4).toFixed(2)}px`;
  node.style.transform = `skewX(${(r() * 10 - 6).toFixed(1)}deg)`;
}

// The writer's mark pressed in wax. Castaways kept by Claude have a faint wave pressed in too.
function seal(seed, marked) {
  const r = rng(seed);
  const s = el('span', 'dm-seal', GLYPHS[Math.floor(r() * GLYPHS.length)]);
  s.style.background = WAX[Math.floor(r() * WAX.length)];
  s.title = marked ? 'A faint wave is pressed into the wax: this island is kept by Claude.' : 'The writer\'s mark, pressed in wax.';
  if (marked) s.append(el('span', 'wave', '≈≈'));
  return s;
}

// --- writing --------------------------------------------------------------------------------

$('compass').append(...[7, 0, 1, 6, null, 2, 5, 4, 3].map((d) => {
  if (d === null) return el('span', 'middle', 'you');
  const b = el('button', '', DIRS[d]);
  b.type = 'button';
  b.dataset.dir = d;
  b.setAttribute('aria-label', `Throw ${DIR_WORDS[d]}`);
  b.addEventListener('click', () => {
    dir = d;
    for (const x of $('compass').querySelectorAll('button')) x.setAttribute('aria-pressed', String(Number(x.dataset.dir) === d));
  });
  return b;
}));

function compose(answering = null) {
  replyTo = answering;
  dir = null;
  for (const x of $('compass').querySelectorAll('button')) x.setAttribute('aria-pressed', 'false');
  $('compose-error').textContent = '';
  $('letter').value = '';
  $('count').textContent = '0';
  handwriting($('letter'), state.island.hand);
  $('letter').style.transform = '';
  $('reply-note').hidden = !answering;
  if (answering) {
    $('reply-note').textContent = `Answering the letter from your ${answering.shore} beach. Throw back the way it came and it may find its way home.`;
  }
  const c = clockNow();
  $('throw-hint').textContent = `Right now it's ${c.part}, ${c.words}, and the current runs ${DIR_WORDS[c.currentDir]}.${c.ebbing ? ' An outgoing tide carries bottles far.' : ''}`;
  $('compose').showModal();
}

$('write').addEventListener('click', () => state && compose());
$('letter').addEventListener('input', () => { $('count').textContent = String($('letter').value.length); });
$('cancel-compose').addEventListener('click', () => $('compose').close());

$('compose-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'throw') return;
  e.preventDefault();
  if (dir === null) {
    $('compose-error').textContent = 'Pick which way to throw it.';
    return;
  }
  const s = await call('/api/driftmail/throw', {
    text: $('letter').value,
    signed: $('signed').checked,
    dir,
    strength: Number($('strength').value) / 100,
    replyTo: replyTo?.id ?? null,
  });
  if (!s) return;
  if (s.error) {
    $('compose-error').textContent = s.error;
    return;
  }
  $('compose').close();
  throwing = { dir, start: performance.now() };
  $('found').hidden = false;
  $('found').textContent = `Your bottle bobs away to the ${DIR_WORDS[dir]}.`;
  take({ ...s, found: [] });
});

// --- little helpers -------------------------------------------------------------------------

function el(tag, cls = '', text = '') {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function firstLine(text) {
  const line = text.split('\n')[0];
  return line.length > 48 ? `${line.slice(0, 46).trimEnd()}…` : line;
}

function ago(t) {
  const m = Math.round((Date.now() + offset - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function list(items) {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function loop() {
  draw();
  requestAnimationFrame(loop);
}

refresh();
setInterval(refresh, POLL_MS);
setInterval(() => state && render(), 60_000);
requestAnimationFrame(loop);
