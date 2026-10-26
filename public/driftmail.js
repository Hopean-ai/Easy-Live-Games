// Driftmail: your island from above, the letters on your shelf, and writing a letter to throw.
// The ocean lives on the server (src/driftmail/ocean.js); this page asks for the island's state
// now and then and draws it. Letters are only ever put on the page with textContent.
const $ = (id) => document.getElementById(id);
const canvas = $('beach');
const ctx = canvas.getContext('2d');

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const DIR_WORDS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
const SUPPLY_NAMES = { bottles: 'Bottles', corks: 'Corks', paper: 'Paper', ink: 'Ink' };
const MATERIAL_NAMES = {
  driftwood: 'Driftwood', rope: 'Rope', clay: 'Clay', sand: 'Sand', stones: 'Stones', leaves: 'Palm leaves', reeds: 'Reeds',
  berries: 'Berries', bark: 'Bark', wax: 'Wax', oil: 'Fish oil', scales: 'Fish scales', jars: 'Jars', shimmer: 'Shimmering ink', traps: 'Traps',
};
const GATHER = [['leaves', 'Palm leaves'], ['clay', 'Clay'], ['sand', 'Sand'], ['stones', 'Stones'], ['reeds', 'Wild reeds'], ['berries', 'Wild berries']];
const WAX_NAMES = ['red', 'blue', 'green', 'violet', 'amber', 'black', 'rose'];
const STRANGE_NOTES = {
  knowing: 'A bottle with no seal washed up, very cold to the touch. Nobody signed it. It seems to know you.',
  future: 'A bottle with no seal washed up. The letter inside is dated days from now.',
  clue: 'A bottle with no seal washed up. Inside are only numbers, and a shape like the tide.',
  echo: 'A bottle with no seal washed up. The letter is in your own hand, but you never wrote it quite like this.',
  fog: 'Your own bottle came back out of the fog. The words are yours, mostly.',
};
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
let casting = 0; // when the line last went out, for the little float on the water
let fishing = null; // the fishing minigame while it plays: { spot, phase, dip, pull, ... }
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

function act(op, body = {}) {
  return call('/api/driftmail/act', { ...body, op });
}

// Runs an action and shows its answer (or its error) in `note`.
async function doing(op, body, note, words) {
  const s = await act(op, body);
  if (!s) return null;
  if (s.error) {
    $(note).textContent = s.error;
    return null;
  }
  take({ ...s, found: [] });
  $(note).textContent = typeof words === 'function' ? words(s) : words ?? '';
  return s;
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
    $('found').textContent = `${s.welcome ? 'Welcome back. While you were away the sea saved a few things for you. ' : ''}The tide left you ${list(s.found)}.`;
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
  const reversed = state.event?.kind === 'reversal' && t < state.event.ends ? Math.PI : 0;
  const angle = Math.PI / 2 - 2 * Math.PI * (day - 0.25) + reversed;
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

  const wl = waterline(state.event?.kind === 'spring' ? Math.min(1, c.tide + 0.6) : c.tide);
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

  drawIsland(c);
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

  drawRocks(wl);

  // Bottles waiting on the wet sand, on the beach they washed up on.
  bottleSpots.length = 0;
  for (const b of state.beach) {
    const spot = bottleSpot(b, wl);
    bottleSpots.push({ ...spot, id: b.id });
    drawVessel(b.kind, spot.x, spot.y, spot.angle, b.old, b.strange);
  }
  if (throwing) {
    const k = Math.min(1, (performance.now() - throwing.start) / 1400);
    const a = Math.PI / 2 - (throwing.dir * Math.PI) / 4;
    const r = 1 + k * 1.6;
    drawVessel(throwing.kind, CX + Math.cos(a) * wl.rx * r, CY - Math.sin(a) * wl.ry * r, k * 9);
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
  const event = state.event && Date.now() + offset < state.event.ends ? state.event.kind : null;
  if (event) drawEvent(event);
  if (dark > 0.3) drawLights(dark);
  compassRose();
  canvas.classList.toggle('pointer', bottleSpots.length > 0);
}

function ellipse(rx, ry, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(CX, CY, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
}

// What you've built and planted. Places not yet built are marked out on the sand.
function drawIsland(c) {
  const b = state.builds;
  const dark = 1 - daylight(c.day);
  // The shack goes up in stages: a frame of poles, then walls, then a thatched roof.
  const sx = CX - 40;
  const sy = CY - 30;
  const stage = b.shack ?? 0;
  if (!stage) plot(sx, sy, 84, 56, 'shack');
  if (stage >= 1) {
    ctx.strokeStyle = '#6b4a2b';
    ctx.lineWidth = 4;
    ctx.strokeRect(sx, sy, 84, 56);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + 84, sy + 56);
    ctx.moveTo(sx + 84, sy);
    ctx.lineTo(sx, sy + 56);
    ctx.stroke();
  }
  if (stage >= 2) {
    ctx.fillStyle = '#8a6a44';
    ctx.fillRect(sx, sy, 84, 56);
    ctx.fillStyle = '#3c2a18';
    ctx.fillRect(sx + 36, sy + 46, 14, 10);
  }
  if (stage >= 3) {
    ctx.fillStyle = '#a99a5a';
    ctx.beginPath();
    ctx.moveTo(sx - 8, sy + 6);
    ctx.lineTo(sx + 42, sy - 16);
    ctx.lineTo(sx + 92, sy + 6);
    ctx.lineTo(sx + 92, sy + 40);
    ctx.lineTo(sx - 8, sy + 40);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(80,70,30,0.5)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 9; i++) {
      ctx.beginPath();
      ctx.moveTo(sx - 4 + i * 12, sy + 2);
      ctx.lineTo(sx - 4 + i * 12, sy + 38);
      ctx.stroke();
    }
    if (dark > 0.3) {
      ctx.fillStyle = `rgba(255,200,110,${0.8 * dark})`;
      ctx.fillRect(sx + 38, sy + 44, 10, 8);
    }
  }
  // The garden: four plots, each with what's growing in it.
  const gx = CX + 80;
  const gy = CY - 10;
  state.garden.forEach((p, i) => {
    const x = gx + (i % 2) * 32;
    const y = gy + Math.floor(i / 2) * 22;
    ctx.fillStyle = p.crop ? (p.dry ? '#8a6a48' : '#5a4330') : 'rgba(90,67,48,0.35)';
    ctx.fillRect(x, y, 28, 18);
    if (!p.crop) return;
    const k = Math.min(1, p.growth / p.needs);
    const color = { berries: '#7a2a5a', reeds: '#9fb06a', oak: '#3f6a34', flowers: '#e8c34a' }[p.crop];
    for (let j = 0; j < 3; j++) {
      ctx.fillStyle = k < 1 ? '#6a9a4a' : color;
      ctx.beginPath();
      ctx.arc(x + 6 + j * 8, y + 9, 2 + k * 3, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  // Small buildings, each in its own spot.
  const spots = {
    kiln: [CX - 150, CY - 20], rack: [CX - 160, CY + 20], press: [CX + 30, CY + 30], bench: [CX - 30, CY + 40],
    lookout: [CX - 200, CY - 40], beacon: [CX + 150, CY + 70], lighthouse: [CX + 190, CY - 70], dock: [CX, CY + 135],
  };
  for (const [k, [x, y]] of Object.entries(spots)) {
    if (!b[k]) continue;
    if (k === 'kiln') {
      ctx.fillStyle = '#9a5a3a';
      ctx.beginPath();
      ctx.arc(x, y, 13, Math.PI, 0);
      ctx.fillRect(x - 13, y, 26, 8);
      ctx.fill();
      ctx.fillStyle = '#ff8a3a';
      ctx.fillRect(x - 4, y + 1, 8, 6);
    } else if (k === 'rack') {
      ctx.strokeStyle = '#6b4a2b';
      ctx.lineWidth = 2;
      ctx.strokeRect(x - 14, y - 8, 28, 16);
      ctx.fillStyle = '#f3ead6';
      ctx.fillRect(x - 10, y - 5, 8, 10);
      ctx.fillRect(x + 2, y - 5, 8, 10);
    } else if (k === 'press') {
      ctx.fillStyle = '#7a776d';
      ctx.fillRect(x - 10, y - 6, 20, 12);
      ctx.fillStyle = '#4a2a5a';
      ctx.fillRect(x - 5, y - 3, 10, 6);
    } else if (k === 'bench') {
      ctx.fillStyle = '#8a6a44';
      ctx.fillRect(x - 14, y - 4, 28, 8);
      ctx.fillStyle = '#8e2b2b';
      ctx.beginPath();
      ctx.arc(x + 6, y, 3, 0, Math.PI * 2);
      ctx.fill();
    } else if (k === 'lookout') {
      ctx.strokeStyle = '#6b4a2b';
      ctx.lineWidth = 3;
      ctx.strokeRect(x - 10, y - 10, 20, 20);
      ctx.fillStyle = '#a99a5a';
      ctx.fillRect(x - 12, y - 12, 24, 6);
    } else if (k === 'beacon') {
      ctx.fillStyle = '#5b4632';
      ctx.fillRect(x - 6, y - 6, 12, 12);
      ctx.fillStyle = dark > 0.3 ? '#ffd27a' : '#c0603a';
      ctx.beginPath();
      ctx.arc(x, y - 6, dark > 0.3 ? 7 : 4, 0, Math.PI * 2);
      ctx.fill();
    } else if (k === 'lighthouse') {
      ctx.fillStyle = '#e8e2d4';
      ctx.beginPath();
      ctx.arc(x, y, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#a03a2a';
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fill();
      if (dark > 0.3) {
        // The beam sweeping out over the water.
        const a = performance.now() / 1600;
        const g = ctx.createRadialGradient(x, y, 4, x, y, 320);
        g.addColorStop(0, `rgba(255,240,180,${0.5 * dark})`);
        g.addColorStop(1, 'rgba(255,240,180,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.arc(x, y, 320, a - 0.12, a + 0.12);
        ctx.closePath();
        ctx.fill();
      }
    } else if (k === 'dock') {
      ctx.fillStyle = '#7a5531';
      ctx.fillRect(x - 10, y - 30, 20, 60);
      ctx.strokeStyle = '#4e351d';
      ctx.lineWidth = 1;
      for (let i = 0; i < 8; i++) {
        ctx.beginPath();
        ctx.moveTo(x - 10, y - 30 + i * 8);
        ctx.lineTo(x + 10, y - 30 + i * 8);
        ctx.stroke();
      }
    }
  }
  // Traps, floats bobbing off the rocks.
  state.kit.traps.forEach((t, i) => {
    const x = CX + 300 + i * 18;
    const y = CY + 80 + Math.sin(performance.now() / 700 + i) * 2;
    ctx.fillStyle = '#c9a86a';
    ctx.fillRect(x - 4, y - 4, 8, 8);
  });
}

// Neighbours' fires on the horizon at night: one light for each island near enough to see.
function drawLights(dark) {
  const n = Math.min(10, state.neighbours);
  for (let i = 0; i < n; i++) {
    const x = ((i * 173 + 61) % (W - 80)) + 40;
    const top = i % 2 === 0;
    const y = top ? 10 + (i * 7) % 14 : H - 12 - (i * 5) % 12;
    const flicker = 0.6 + 0.4 * Math.sin(performance.now() / (500 + i * 70) + i);
    ctx.fillStyle = `rgba(255,200,120,${dark * flicker * 0.8})`;
    ctx.beginPath();
    ctx.arc(x, y, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }
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

// A jar, a box or a barrel, or else a bottle.
function drawVessel(kind, x, y, angle, old = false, strange = false) {
  if (kind === 'jar') {
    ctx.fillStyle = 'rgba(190,150,100,0.95)';
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#8e2b2b';
    ctx.fillRect(x - 4, y - 10, 8, 4);
  } else if (kind === 'box') {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle * 0.2);
    ctx.fillStyle = '#7a5531';
    ctx.fillRect(-12, -9, 24, 18);
    ctx.strokeStyle = '#4e351d';
    ctx.strokeRect(-12, -9, 24, 18);
    ctx.restore();
  } else if (kind === 'barrel') {
    ctx.fillStyle = '#7a5531';
    ctx.beginPath();
    ctx.ellipse(x, y, 16, 11, angle, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#3a3a3a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(x, y, 10, 11, angle, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    drawBottle(x, y, angle, old, strange, kind === 'sailed');
  }
}

function drawBottle(x, y, angle, old = false, strange = false, sail = false) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = strange ? 'rgba(200,220,235,0.85)' : old ? 'rgba(110,95,60,0.9)' : 'rgba(120,190,150,0.85)';
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
  if (old) {
    // Barnacles.
    ctx.fillStyle = 'rgba(230,225,210,0.9)';
    for (const [bx, by] of [[-9, -3], [-4, 4], [2, -4], [-1, 3]]) ctx.fillRect(bx, by, 2, 2);
  }
  if (sail) {
    ctx.fillStyle = 'rgba(243,234,214,0.95)';
    ctx.beginPath();
    ctx.moveTo(-2, -5);
    ctx.lineTo(-2, -18);
    ctx.lineTo(8, -6);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

// The rocks on the east point, where you fish from, and your float when the line is out.
function drawRocks(wl) {
  const rx = CX + wl.rx - 30;
  const ry = CY + 30;
  ctx.fillStyle = '#6d6a62';
  for (const [x, y, r] of [[0, 0, 16], [18, 10, 12], [8, 22, 10], [-14, 14, 9]]) {
    ctx.beginPath();
    ctx.arc(rx + x, ry + y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const k = (performance.now() - casting) / 1000;
  if (fishing || (casting && k < 6)) {
    const [ox, oy] = SPOT_AT[fishing?.spot] ?? [70, 14];
    let fx = rx + ox;
    let fy = ry + oy + Math.sin(k * 3) * 2;
    let r = 4;
    const now = performance.now();
    if (fishing?.dipUntil > now) {
      // A nibble tugs the float down a little; the real bite pulls it right under.
      fy += fishing.deep ? 6 : 3;
      r = fishing.deep ? 1.5 : 3;
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.beginPath();
      ctx.arc(fx, fy, fishing.deep ? 10 + ((now / 60) % 6) : 6, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (fishing?.phase === 'fight') {
      // The fish runs, and the line goes with it.
      const pull = fishing.pull;
      fx += pull === 'left' ? -40 : pull === 'right' ? 40 : 0;
      fy += pull === 'away' ? -10 : 0;
      r = pull === 'away' ? 1.5 : 3;
    }
    ctx.strokeStyle = 'rgba(240,240,240,0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(rx + 6, ry - 4);
    ctx.quadraticCurveTo(rx + 40, ry - 30, fx, fy);
    ctx.stroke();
    ctx.fillStyle = '#e04a3a';
    ctx.beginPath();
    ctx.arc(fx, fy, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Where the float sits for each spot, from the rocks.
const SPOT_AT = { shallows: [50, 30], reef: [80, -30], weed: [70, 50], deep: [130, 6] };

// What the sea is doing, drawn over everything: rain, silver fish, floating planks.
function drawEvent(kind) {
  const t = performance.now();
  if (kind === 'storm') {
    ctx.fillStyle = 'rgba(20,25,35,0.35)';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(200,215,235,0.35)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 90; i++) {
      const x = (i * 97 + t / 3) % (W + 40) - 20;
      const y = (i * 53 + t / 1.5) % H;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - 8, y + 18);
      ctx.stroke();
    }
  } else if (kind === 'shoal') {
    ctx.fillStyle = 'rgba(220,235,245,0.55)';
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2 + t / 6000;
      const r = 1.35 + ((i * 7) % 5) / 20;
      const x = CX + Math.cos(a) * 250 * r;
      const y = CY + Math.sin(a) * 150 * r;
      if (x > 0 && x < W && y > 0 && y < H) ctx.fillRect(x, y, 6, 2);
    }
  } else if (kind === 'redtide') {
    ctx.fillStyle = 'rgba(150,40,30,0.22)';
    ctx.fillRect(0, 0, W, H);
  } else if (kind === 'fog') {
    for (let i = 0; i < 6; i++) {
      const x = ((i * 190 + t / 40) % (W + 300)) - 150;
      const g = ctx.createRadialGradient(x, (i * 97) % H, 10, x, (i * 97) % H, 220);
      g.addColorStop(0, 'rgba(225,230,235,0.45)');
      g.addColorStop(1, 'rgba(225,230,235,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
  } else if (kind === 'comet') {
    const x = W * 0.82;
    const y = 50;
    const g = ctx.createLinearGradient(x, y, x - 160, y + 60);
    g.addColorStop(0, 'rgba(240,250,255,0.9)');
    g.addColorStop(1, 'rgba(240,250,255,0)');
    ctx.strokeStyle = g;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - 160, y + 60);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'ebb') {
    // The sandbar the sea has pulled back from.
    ctx.fillStyle = 'rgba(181,156,109,0.8)';
    ctx.beginPath();
    ctx.ellipse(CX + 250, CY + 200, 160, 30, -0.3, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'reversal') {
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 12; i++) {
      const x = W - ((i * 137 + t / 60) % W);
      const y = (i * 83) % H;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 18, y - 6);
      ctx.moveTo(x, y);
      ctx.lineTo(x + 18, y + 6);
      ctx.stroke();
    }
  } else if (kind === 'wreck') {
    ctx.fillStyle = '#7a5531';
    for (let i = 0; i < 9; i++) {
      const x = (i * 131 + t / 120) % W;
      const y = (i * 89) % 70 + (i % 2 ? H - 70 : 6);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(i);
      ctx.fillRect(-14, -3, 28, 6);
      ctx.restore();
    }
  }
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

  const sea = $('sea');
  sea.hidden = !state.event && !state.sign;
  sea.classList.toggle('event', Boolean(state.event));
  sea.textContent = state.event ? state.event.words : state.sign ?? '';

  const kit = state.kit;
  $('catch').replaceChildren(...[['Fish', kit.fish], ['Bones', kit.bones], ['Fish glue', kit.glue], ['Hook', kit.hook ? 'bone' : 'nail']].map(([label, n]) => {
    const li = el('li', '', label);
    li.append(el('strong', '', String(n)));
    return li;
  }));
  $('casts-left').textContent = kit.casts < 1 ? 'The fish have gone quiet. Try again next tide.'
    : `Read the water, then pick where to cast${kit.casts > 1 ? ` (${kit.casts} casts left this tide)` : ''}:`;
  $('spots').replaceChildren(...kit.spots.map((sp) => {
    const b = el('button', 'secondary', sp.name);
    b.append(el('span', 'sign', sp.sign));
    b.disabled = kit.casts < 1 || Boolean(fishing);
    b.addEventListener('click', () => castAt(sp.id));
    const li = el('li');
    li.append(b);
    return li;
  }));
  $('spear').hidden = !kit.spear;
  $('spear').disabled = !kit.canSpear;
  $('spear').textContent = kit.canSpear ? 'Wade out with the spear' : kit.lowTide ? 'Speared this tide' : 'Spear (wait for low tide)';
  $('set-trap').hidden = !(state.materials.traps > 0) || kit.traps.length >= kit.maxTraps;
  $('pull-traps').hidden = kit.traps.length === 0;
  $('pull-traps').textContent = `Pull up the traps (${kit.traps.length} set)`;
  $('pull-traps').disabled = !kit.traps.some((t) => t.tides >= 1);
  $('bait').disabled = !(state.materials.berries > 0);
  $('snag').hidden = !kit.snag;
  renderIsland();

  $('abilities').replaceChildren(...state.abilities.map((a) => {
    const li = el('li', 'ability', a.name);
    li.append(el('span', 'when', a.words));
    return li;
  }));
  $('forecast').hidden = !state.forecast;
  if (state.forecast) {
    $('forecast').replaceChildren(...(state.forecast.length ? state.forecast : [null]).map((f) => (f
      ? el('li', 'forecast', `${cap(f.name)} ${until(f.start)}.`)
      : el('li', 'when', 'The sea will stay calm for the next two island days.'))));
  }
  $('journal').replaceChildren(...state.journal.map((p) => {
    const b = el('button', 'link', p.title);
    b.addEventListener('click', () => readPage(p));
    const li = el('li');
    li.append(b);
    if (p.teaches) li.append(el('span', 'when', `Teaches ${p.teaches}`));
    return li;
  }));
  $('journal-empty').hidden = state.journal.length > 0;

  $('supplies').replaceChildren(...Object.entries(SUPPLY_NAMES).map(([k, label]) => {
    const li = el('li', state.island.supplies[k] < 1 ? 'low' : '', label);
    li.append(el('strong', '', String(state.island.supplies[k])));
    return li;
  }));

  $('shelf').replaceChildren(...state.shelf.map((l) => {
    const label = l.strange ? `A bottle with no seal: ${firstLine(l.text)}`
      : l.old ? `An old journal page: ${l.title ?? firstLine(l.text)}` : l.own ? `Your own letter, back again: ${firstLine(l.text)}` : firstLine(l.text);
    const b = el('button', 'link', label);
    b.addEventListener('click', () => read(l));
    const li = el('li');
    li.append(b, el('span', 'when', `${l.shore} beach, ${ago(l.landed)}`));
    return li;
  }));
  $('shelf-empty').hidden = state.shelf.length > 0;

  $('sent').replaceChildren(...state.sent.map((s) => {
    const li = el('li', '', firstLine(s.text));
    const where = s.ashore ? (s.rest ? `Washed up somewhere, it ${s.rest}` : 'Washed up somewhere') : 'Still drifting';
    li.append(el('span', 'when', `${where} · thrown ${ago(s.thrown)}${s.page ? ` · with “${s.page}”` : ''}`));
    return li;
  }));
  $('sent-empty').hidden = state.sent.length > 0;

  $('curios').replaceChildren(...state.island.curios.map((c) => {
    const li = el('li', c.unique ? 'dm-unique' : c.strange ? 'forecast' : '', cap(c.name));
    if (c.unique) li.title = 'One of a kind. Nobody else has this.';
    return li;
  }));
  $('room').textContent = `(${state.held} of ${state.room})`;
  $('clues').replaceChildren(...state.clues.map((k) => {
    const li = el('li', 'forecast', k.text);
    li.append(el('span', 'when', `A clue from a strange bottle. It goes stale ${until(k.until)}.`));
    return li;
  }));
  const m = state.marks;
  $('marks').textContent = m.kind || m.useful
    ? `The sea has heard that ${[m.kind && `${m.kind} of your letters were kind`, m.useful && `${m.useful} were useful`].filter(Boolean).join(' and ')}.`
    : '';
  drawChart();
  guide();
  draw();
}

// The island panels: materials, gathering, the garden, building and making, and your seal.
function renderIsland() {
  const mats = Object.entries(state.materials);
  $('materials').replaceChildren(...(mats.length ? mats : [['none', 0]]).map(([k, n]) => {
    if (k === 'none') return el('li', 'when', 'Nothing yet. The tide brings driftwood and rope.');
    const li = el('li', '', MATERIAL_NAMES[k] ?? k);
    li.append(el('strong', '', String(n)));
    return li;
  }));
  $('gather-note').textContent = state.kit.gathered ? 'You have gathered all you can carry this tide.' : 'Once a tide you can gather inland:';
  $('gather').replaceChildren(...GATHER.map(([k, label]) => {
    const b = el('button', 'secondary', label);
    b.disabled = state.kit.gathered;
    b.addEventListener('click', () => doing('gather', { what: k }, 'gather-note', `You gather two loads of ${label.toLowerCase()}.`).then((r) => r && sound.fx('gather')));
    return b;
  }));

  $('garden').replaceChildren(...state.garden.map((p, i) => {
    if (p.locked) return el('li', 'when', 'Room for another plot, once you build garden beds.');
    const li = el('li');
    const row = el('div', 'row');
    if (!p.crop) {
      const pick = el('select');
      pick.append(el('option', '', 'Empty plot'), ...Object.entries(state.crops).filter(([k]) => state.seeds[k] > 0).map(([k, c]) => {
        const o = el('option', '', `Plant ${c.name.toLowerCase()} (${state.seeds[k]})`);
        o.value = k;
        return o;
      }));
      pick.addEventListener('change', () => pick.value && doing('plant', { plot: i, crop: pick.value }, 'seeds', 'Planted. Water it every tide or two.'));
      row.append(pick);
    } else {
      const status = p.ripe ? 'ripe' : p.dry ? 'dry' : '';
      row.append(el('span', status, `${p.name}: ${p.ripe ? 'ready to pick' : `${p.growth} of ${p.needs} tides${p.dry ? ', needs water' : ''}`}`));
      if (p.ripe) {
        const b = el('button', '', 'Harvest');
        b.addEventListener('click', () => doing('harvest', { plot: i }, 'seeds', (r) => `You harvest ${r.harvested}, and keep a seed back.`));
        row.append(b);
      }
    }
    li.append(row);
    return li;
  }));
  $('water').disabled = !state.garden.some((p) => p.crop && !p.watered);
  const seeds = Object.entries(state.seeds).filter(([, n]) => n > 0).map(([k, n]) => `${n} × ${state.crops[k].seed}`);
  if (!$('seeds').dataset.note) $('seeds').textContent = seeds.length ? `Seeds: ${seeds.join(', ')}.` : 'No seeds. Strangers sometimes send them.';

  $('blueprints').replaceChildren(...state.blueprints.map((b) => {
    const li = el('li');
    const row = el('div', 'row');
    const done = b.built >= b.stages;
    row.append(el('span', done ? 'ability' : '', `${b.name}${b.stages > 1 ? ` (${b.built}/${b.stages})` : ''}${done ? ' ✓' : ''}`));
    if (b.next) {
      const go = el('button', b.next.ok ? '' : 'secondary', b.stages > 1 ? `Build the ${b.next.name.split(' ').at(-1)}` : 'Build');
      go.disabled = !b.next.ok;
      go.addEventListener('click', () => doing('build', { what: b.id }, 'make-note', (r) => `You build the ${r.built.toLowerCase()}.`).then((r) => r && sound.fx('build')));
      row.append(go);
    }
    li.append(row, el('span', 'cost', b.next ? `${costWords(b.next.cost)}. ${b.words}` : b.blocked && !done ? `${b.blocked} ${b.words}` : b.words));
    return li;
  }));

  $('recipes').replaceChildren(...state.recipes.filter((r) => r.blocked !== 'Made.').map((r) => {
    const li = el('li');
    const row = el('div', 'row');
    row.append(el('span', '', r.name));
    const go = el('button', r.ok && !r.blocked ? '' : 'secondary', 'Make');
    go.disabled = !r.ok || Boolean(r.blocked);
    go.addEventListener('click', () => {
      const body = { what: r.id };
      if (r.id === 'stamp') body.pattern = Number($('stamp-pattern').value);
      doing('make', body, 'make-note', (x) => `Done: ${x.made.toLowerCase()}.`);
    });
    row.append(go);
    li.append(row, el('span', 'cost', `${costWords(r.cost)}${r.blocked ? `. ${r.blocked}` : ''}`));
    return li;
  }));
  const stampRecipe = state.recipes.find((r) => r.id === 'stamp');
  $('stamp-row').hidden = !stampRecipe || Boolean(stampRecipe.blocked);
  if ($('stamp-pattern').options.length !== state.stamps.length) {
    $('stamp-pattern').replaceChildren(...state.stamps.map((name, i) => {
      const o = el('option', '', name);
      o.value = String(i);
      return o;
    }));
  }

  $('seal-panel').hidden = !state.builds.bench;
  const sl = state.seal;
  $('seal-now').textContent = sl.ring
    ? `Your ring is cut with ${GLYPHS[sl.glyph]} for ${WAX_NAMES[sl.wax]} wax. Letters sealed with it cost a little wax.`
    : sl.designed ? 'You lost your seal ring. Cut a new one.' : 'Design your own crest, and cut it into a ring to seal letters with.';
  if ($('seal-glyph').options.length !== GLYPHS.length) {
    $('seal-glyph').replaceChildren(...GLYPHS.map((g, i) => {
      const o = el('option', '', g);
      o.value = String(i);
      return o;
    }));
    $('seal-wax').replaceChildren(...WAX_NAMES.map((w, i) => {
      const o = el('option', '', w);
      o.value = String(i);
      return o;
    }));
    $('seal-glyph').value = String(sl.glyph);
    $('seal-wax').value = String(sl.wax);
  }
}

$('water').addEventListener('click', () => doing('water', {}, 'seeds', 'You carry water up from the stream.').then((r) => r && sound.fx('water')));
$('design-seal').addEventListener('click', () => doing('seal', { glyph: Number($('seal-glyph').value), wax: Number($('seal-wax').value) }, 'seal-now', 'You cut your crest into a ring.'));
$('spear').addEventListener('click', () => doing('spear', {}, 'fish-note', (r) => (r.caught === 'nothing' ? 'You wade back with nothing.' : `You spear ${r.caught}.`)));
$('set-trap').addEventListener('click', () => doing('trap', {}, 'fish-note', 'You bait a trap with a berry and wedge it between the rocks.'));
$('pull-traps').addEventListener('click', () => doing('traps', {}, 'fish-note', (r) => (r.caught === 'nothing' ? 'The traps come up empty.' : `In the traps: ${r.caught}.`)));
$('snag-keep').addEventListener('click', () => doing('snag', { keep: true }, 'fish-note', 'You pull the bottle in. It is on your beach now.'));
$('snag-free').addEventListener('click', () => doing('snag', { keep: false }, 'fish-note', 'You untangle it and let it drift on its way.'));

function costWords(cost) {
  return Object.entries(cost).map(([k, n]) => `${n} ${(MATERIAL_NAMES[k] ?? SUPPLY_NAMES[k] ?? k).toLowerCase()}`).join(', ');
}

// The first time you play, three steps to your first throw.
function guide() {
  const first = state.sent.length === 0;
  $('guide').hidden = !first;
  if (!first) return;
  const open = $('compose').open;
  $('guide-1').className = open ? 'done' : 'now';
  $('guide-2').className = open ? 'now' : '';
  $('guide-3').className = '';
}

// Your chart, drawn only from the letters you've had: each signed writer sits off the beach
// their letters most often reach, closer the more they've written. Pen pals are ringed.
function drawChart() {
  const cv = $('chart');
  const g = cv.getContext('2d');
  const w = cv.width;
  const mid = w / 2;
  g.clearRect(0, 0, w, w);
  g.strokeStyle = 'rgba(90,70,40,0.25)';
  for (const r of [40, 75, 105]) {
    g.beginPath();
    g.arc(mid, mid, r, 0, Math.PI * 2);
    g.stroke();
  }
  g.fillStyle = '#6b5a3a';
  g.font = 'bold 11px system-ui, sans-serif';
  g.textAlign = 'center';
  g.fillText('N', mid, 12);
  g.fillStyle = '#c9a86a';
  g.beginPath();
  g.ellipse(mid, mid, 12, 8, 0, 0, Math.PI * 2);
  g.fill();
  const by = {};
  for (const c of state.chart) (by[c.shore] ??= []).push(c);
  g.font = '11px system-ui, sans-serif';
  for (const [shoreName, list] of Object.entries(by)) {
    list.slice(0, 5).forEach((c, i) => {
      const a = (SHORE_ANGLE[shoreName] ?? 0) + (i - (Math.min(list.length, 5) - 1) / 2) * 0.32;
      const r = Math.max(40, 92 - c.letters * 6);
      const x = mid + Math.cos(a) * r;
      const y = mid + Math.sin(a) * r;
      g.fillStyle = '#3a5a7a';
      g.beginPath();
      g.arc(x, y, 4, 0, Math.PI * 2);
      g.fill();
      if (state.pals.includes(c.name)) {
        g.strokeStyle = '#a0522d';
        g.beginPath();
        g.arc(x, y, 7, 0, Math.PI * 2);
        g.stroke();
      }
      g.fillStyle = '#2b2620';
      g.fillText(c.name.length > 14 ? `${c.name.slice(0, 13)}…` : c.name, x, y - 8);
    });
  }
  $('chart-note').textContent = !state.builds.desk ? 'Build a writing desk to keep a chart of who writes to you.'
    : state.chart.length
    ? `Placed by the beaches their letters reach.${state.pals.length ? ` Ringed: pen pals, with a steady current between you.` : ''}`
    : 'Signed letters you find will mark this chart, by the beach they wash up on.';
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
  if (letter) read(letter, s.learned);
}

let reading = null;

function read(letter, learned = null) {
  reading = letter;
  const vessel = { jar: 'A sealed jar', box: 'A wooden box', barrel: 'A barrel', double: 'A double-corked bottle', weighted: 'A weighted bottle', sailed: 'A little sailed float' }[letter.kind];
  let note = letter.strange
    ? STRANGE_NOTES[letter.strange] ?? STRANGE_NOTES.knowing
    : letter.old
      ? `An old bottle, crusted with barnacles, washed up on your ${letter.shore} beach. Inside is a page torn from someone's journal.`
      : letter.own
        ? `Your own bottle washed back to your ${letter.shore} beach. Nobody else was in reach.`
        : `${vessel ? `${vessel} washed` : 'Washed'} up on your ${letter.shore} beach at ${letter.part}, ${letter.tide}.`;
  if (letter.broken) note += ' It had broken open in a storm: only the letter survived.';
  if (letter.blurred === 'blurred') note += ' Water got in, and some of the words have run.';
  if (letter.blurred === 'restored') note += ' Water got in, but you can read the lost words in the dents of the pen.';
  if (letter.stained) note += ' The paper is stained red from the tide.';
  if (letter.forged) note += ' Something about the hand is off, as if someone were copying it.';
  if (letter.added) note += ' Someone added a line before throwing it on.';
  if (letter.handOf) {
    note += letter.handOf.letters > 1
      ? ` You know this hand: it's hand ${letter.handOf.mark}, on ${letter.handOf.letters} letters on your shelf.`
      : ` A hand you haven't seen before (hand ${letter.handOf.mark}).`;
  }
  $('read-note').textContent = note;
  const paper = $('read-paper');
  paper.replaceChildren();
  paper.classList.toggle('shimmer', Boolean(letter.shimmer));
  paper.classList.toggle('stained', Boolean(letter.stained));
  paper.classList.toggle('strange', Boolean(letter.strange));
  handwriting(paper, letter.hand);
  if (letter.replyTo) paper.append(el('span', 'reply-of', `In answer to your letter: “${letter.replyTo}”`));
  if (letter.title) paper.append(el('span', 'reply-of', letter.title));
  paper.append(document.createTextNode(letter.text));
  if (letter.name) paper.append(el('span', 'sig', `— ${letter.name}`));
  if (letter.added) {
    const add = el('span', 'added', letter.added.text);
    handwriting(add, letter.added.hand);
    add.style.transform = '';
    paper.append(add);
  }
  if (!letter.strange) paper.append(seal(letter.emblem, letter.marked, letter.old || letter.sealed));
  if (letter.stamp) paper.append(el('span', 'dm-stamp', `stamped: ${letter.stamp}`));
  showItems(letter.items ?? []);
  // A copied journal page folded in with the letter, in the writer's own hand.
  const pg = $('read-page');
  pg.hidden = !letter.page;
  if (letter.page) {
    pg.replaceChildren(el('span', 'title', `A copied journal page is folded in with it: “${letter.page.title}”`), document.createTextNode(letter.page.text));
    handwriting(pg, letter.hand);
  }
  $('read-learned').hidden = !learned;
  $('read-learned').textContent = learned ? `You learned something: ${learned}.` : '';
  $('reply').hidden = !letter.player;
  $('mark-row').hidden = !letter.player;
  for (const b of $('mark-row').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(letter.mark === b.dataset.mark));
    b.disabled = Boolean(letter.mark);
  }
  $('pass').hidden = letter.old || letter.id == null;
  $('burn').hidden = letter.id == null;
  $('pass-row').hidden = true;
  $('reader').showModal();
  sound.fx('open');
}

// What came in with the letter: curios, seeds, a drawing, a map, a bundle.
function showItems(items) {
  const box = $('read-items');
  box.replaceChildren();
  box.hidden = items.length === 0;
  for (const it of items) {
    if (it.kind === 'curio') box.append(el('div', '', `Tucked in with it: ${it.name}.`));
    else if (it.kind === 'seeds') box.append(el('div', '', `A pinch of seeds, wrapped in a leaf: ${state.crops[it.crop]?.seed ?? it.crop}.`));
    else if (it.kind === 'materials') box.append(el('div', '', `Packed in with it: ${costWords(it.what)}.`));
    else if (it.kind === 'drawing') {
      box.append(el('div', '', 'A drawing:'));
      const cv = document.createElement('canvas');
      cv.width = 240;
      cv.height = 160;
      paintDrawing(cv, it.data);
      box.append(cv);
    } else if (it.kind === 'map') {
      box.append(el('div', '', it.places.length
        ? `A hand-drawn chart of who writes to them: ${it.places.map((p) => `${p.name}, off their ${p.shore} beach`).join('; ')}.`
        : 'A hand-drawn chart of an island, and empty sea all round it.'));
    }
  }
}

function readPage(p) {
  read({ text: p.text, title: p.title, old: true, own: false, hand: 0, emblem: 0, shore: '', page: null });
  $('read-note').textContent = p.teaches ? `A page from your journal. It taught you ${p.teaches}.` : 'A page from your journal.';
  $('read-paper').querySelector('.dm-seal')?.remove();
}

$('close-reader').addEventListener('click', () => $('reader').close());
for (const b of $('mark-row').querySelectorAll('button')) {
  b.addEventListener('click', () => doing('mark', { id: reading.id, mark: b.dataset.mark }, 'read-note', 'The sea will remember.').then((r) => {
    if (r) reading = r.shelf.find((l) => l.id === reading.id) ?? reading;
    for (const x of $('mark-row').querySelectorAll('button')) {
      x.setAttribute('aria-pressed', String(x.dataset.mark === b.dataset.mark && Boolean(r)));
      x.disabled = Boolean(r);
    }
  }));
}
$('burn').addEventListener('click', async () => {
  if (!confirm('Burn this letter? It will be gone for good.')) return;
  const r = await doing('burn', { id: reading.id }, 'read-note', '');
  if (r) $('reader').close();
});
$('pass-dir').append(...DIR_WORDS.map((w, i) => {
  const o = el('option', '', w);
  o.value = String(i);
  return o;
}));
$('pass').addEventListener('click', () => {
  $('pass-row').hidden = false;
  $('pass-dir').value = String(clockNow().currentDir);
});
$('pass-cancel').addEventListener('click', () => { $('pass-row').hidden = true; });
$('pass-go').addEventListener('click', async () => {
  const d = Number($('pass-dir').value);
  const r = await doing('pass', { id: reading.id, line: $('pass-line').value, dir: d, strength: 0.6 }, 'read-note', '');
  if (!r) return;
  $('pass-line').value = '';
  $('reader').close();
  throwing = { dir: d, start: performance.now() };
  sound.fx('throw');
  $('found').hidden = false;
  $('found').textContent = `You throw it on to the ${DIR_WORDS[d]}.`;
});
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

// The writer's mark: in wax when they sealed it with a ring, otherwise pressed into the cork.
// Castaways kept by Claude have a faint wave pressed in too.
function seal(seed, marked, waxed = true) {
  const s = el('span', waxed ? 'dm-seal' : 'dm-seal pressed', GLYPHS[seed % 16]);
  s.style.background = WAX[Math.floor(seed / 16) % WAX.length];
  s.title = marked ? 'A faint wave is pressed into the wax: this island is kept by Claude.' : waxed ? 'The writer\'s mark, pressed in wax.' : 'The writer\'s mark, pressed into the cork.';
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
  $('glue-row').hidden = !(state.kit.glue > 0);
  $('glue').checked = false;
  const m = state.materials;
  $('container').replaceChildren(...state.containers.filter((k) => !k.blocked).map((k) => {
    const o = el('option', '', `${k.name} (${costWords(k.cost)}; ${k.items === 1 ? 'one thing' : `${k.items} things`})`);
    o.value = k.id;
    return o;
  }));
  $('container').value = 'bottle';
  containerNote();
  $('wax-row').hidden = !state.seal.ring;
  $('wax').checked = false;
  $('stamp-use-row').hidden = !state.stamp;
  $('stamp').checked = Boolean(state.stamp);
  $('shimmer-row').hidden = !(m.shimmer > 0);
  $('shimmer').checked = false;
  const forgeable = new Map();
  for (const l of state.shelf) if (l.canForge && !forgeable.has(l.hand)) forgeable.set(l.hand, l);
  $('forge-row').hidden = forgeable.size === 0;
  $('forge').replaceChildren(blank('My own hand'), ...[...forgeable.values()].map((l) => {
    const o = el('option', '', l.name ? `${l.name}'s hand` : `The hand of “${firstLine(l.text)}”`);
    o.value = String(l.id);
    return o;
  }));
  $('forge').value = '';
  $('item-curio').replaceChildren(blank('Nothing'), ...state.island.curios.map((c, i) => {
    const o = el('option', '', cap(c.name));
    o.value = String(i);
    return o;
  }));
  $('item-curio').value = '';
  $('item-seeds').replaceChildren(blank('None'), ...Object.entries(state.seeds).filter(([, n]) => n > 0).map(([k]) => {
    const o = el('option', '', state.crops[k].seed);
    o.value = k;
    return o;
  }));
  $('item-seeds').value = '';
  $('item-map').checked = false;
  $('item-drawing').checked = false;
  const desk = Boolean(state.builds.desk);
  $('item-map').closest('label').hidden = !desk;
  $('item-drawing').closest('label').hidden = !desk;
  $('pad').hidden = true;
  pad.fill(0);
  paintPad();
  $('bundle-what').replaceChildren(...Object.entries(m).filter(([k, n]) => n > 0 && k !== 'jars' && k !== 'traps' && k !== 'shimmer').map(([k]) => {
    const o = el('option', '', MATERIAL_NAMES[k] ?? k);
    o.value = k;
    return o;
  }));
  $('bundle-n').value = '0';
  $('page-row').hidden = state.journal.length === 0 || !state.builds.desk;
  $('page').replaceChildren(blank('No page'), ...state.journal.map((p) => {
    const o = el('option', '', p.title);
    o.value = p.id;
    return o;
  }));
  $('page').value = '';
  const c = clockNow();
  $('throw-hint').textContent = `Right now it's ${c.part}, ${c.words}, and the current runs ${DIR_WORDS[c.currentDir]}.${c.ebbing ? ' An outgoing tide carries bottles far.' : ''}`;
  $('compose').showModal();
  guide();
}

function containerNote() {
  const k = state.containers.find((x) => x.id === $('container').value);
  $('container-note').textContent = k?.words ?? '';
  $('bundle-row').hidden = !(k && k.items >= 8);
  $('glue-row').hidden = !(state.kit.glue > 0) || $('container').value !== 'bottle';
}
$('container').addEventListener('change', containerNote);
$('item-drawing').addEventListener('change', () => { $('pad').hidden = !$('item-drawing').checked; });

// The drawing pad: 24 by 16 squares, tapped or dragged on and off, sent as 96 hex digits.
const PAD_W = 24;
const PAD_H = 16;
const pad = new Uint8Array(PAD_W * PAD_H);
let padPaint = null;
function padCell(e) {
  const r = $('pad').getBoundingClientRect();
  const x = Math.floor(((e.clientX - r.left) / r.width) * PAD_W);
  const y = Math.floor(((e.clientY - r.top) / r.height) * PAD_H);
  return x >= 0 && x < PAD_W && y >= 0 && y < PAD_H ? y * PAD_W + x : -1;
}
$('pad').addEventListener('pointerdown', (e) => {
  const i = padCell(e);
  if (i < 0) return;
  padPaint = pad[i] ? 0 : 1;
  pad[i] = padPaint;
  $('pad').setPointerCapture(e.pointerId);
  paintPad();
});
$('pad').addEventListener('pointermove', (e) => {
  if (padPaint === null) return;
  const i = padCell(e);
  if (i >= 0 && pad[i] !== padPaint) {
    pad[i] = padPaint;
    paintPad();
  }
});
$('pad').addEventListener('pointerup', () => { padPaint = null; });
function padData() {
  let hex = '';
  for (let i = 0; i < pad.length; i += 4) hex += ((pad[i] << 3) | (pad[i + 1] << 2) | (pad[i + 2] << 1) | pad[i + 3]).toString(16);
  return hex;
}
function paintPad() {
  paintDrawing($('pad'), padData(), true);
}
function paintDrawing(cv, hex, grid = false) {
  const g = cv.getContext('2d');
  const cw = cv.width / PAD_W;
  const ch = cv.height / PAD_H;
  g.fillStyle = '#f3ead6';
  g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#2b2620';
  for (let i = 0; i < PAD_W * PAD_H; i++) {
    const bit = (parseInt(hex[i >> 2], 16) >> (3 - (i & 3))) & 1;
    if (bit) g.fillRect((i % PAD_W) * cw, Math.floor(i / PAD_W) * ch, cw + 0.5, ch + 0.5);
  }
  if (grid) {
    g.strokeStyle = 'rgba(90,120,160,0.15)';
    for (let x = 0; x <= PAD_W; x++) g.strokeRect(x * cw, 0, 0, cv.height);
    for (let y = 0; y <= PAD_H; y++) g.strokeRect(0, y * ch, cv.width, 0);
  }
}

$('write').addEventListener('click', () => state && compose());
$('letter').addEventListener('input', () => { $('count').textContent = String($('letter').value.length); });
$('cancel-compose').addEventListener('click', () => $('compose').close());
$('compose').addEventListener('close', () => state && guide());

$('compose-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'throw') return;
  e.preventDefault();
  if (dir === null) {
    $('compose-error').textContent = 'Pick which way to throw it.';
    return;
  }
  const items = [];
  if ($('item-curio').value !== '') items.push({ kind: 'curio', index: Number($('item-curio').value) });
  if ($('item-seeds').value) items.push({ kind: 'seeds', crop: $('item-seeds').value });
  if ($('item-map').checked) items.push({ kind: 'map' });
  if ($('item-drawing').checked) items.push({ kind: 'drawing', data: padData() });
  const bundle = Number($('bundle-n').value);
  if (!$('bundle-row').hidden && bundle > 0 && $('bundle-what').value) items.push({ kind: 'materials', what: { [$('bundle-what').value]: bundle } });
  const s = await call('/api/driftmail/throw', {
    text: $('letter').value,
    signed: $('signed').checked,
    dir,
    strength: Number($('strength').value) / 100,
    replyTo: replyTo?.id ?? null,
    glue: $('glue').checked && $('container').value === 'bottle',
    page: $('page').value || null,
    kind: $('container').value,
    items,
    wax: $('wax').checked,
    stamp: $('stamp').checked,
    shimmer: $('shimmer').checked,
    forge: $('forge').value ? Number($('forge').value) : null,
  });
  if (!s) return;
  if (s.error) {
    $('compose-error').textContent = s.error;
    return;
  }
  $('compose').close();
  throwing = { dir, start: performance.now(), kind: $('container').value };
  sound.fx('throw');
  $('found').hidden = false;
  $('found').textContent = `Your ${$('container').value === 'bottle' ? 'bottle' : $('container').selectedOptions[0].textContent.split(' (')[0].toLowerCase()} bobs away to the ${DIR_WORDS[dir]}.${s.lostRing ? ' As it goes, you feel your seal ring slip off your wet finger and into the waves.' : ''}`;
  take({ ...s, found: [] });
});

// --- fishing -------------------------------------------------------------------------------

// The minigame: cast at a spot, watch the float, strike on the real bite, then answer the pulls.
// The server has already decided what's down there and how it fights; this plays it out and
// sends back when you struck and how you answered.
const NIBBLE_MS = 450;
const BITE_MS = 900;
const PULL_MS = 2200;
const PULL_WORDS = { left: 'It runs hard to the left!', right: 'It runs hard to the right!', away: 'It dives for the deep water!' };

async function castAt(spot) {
  if (fishing) return;
  casting = performance.now();
  sound.fx('cast');
  const s = await act('cast', { spot, bait: $('bait').checked });
  if (!s) return;
  if (s.error) {
    $('fish-note').textContent = s.error;
    return;
  }
  take({ ...s, found: [] });
  $('bait').checked = false;
  $('fish-note').textContent = '';
  fishing = { spot, line: s.line, phase: 'wait', dips: 0, struck: null, answers: [], timers: [] };
  showLine('The float settles on the water. Watch it…', 'wait');
  render();
  if (!s.line.bite) {
    later(4000 + Math.random() * 2500, () => endFishing('Nothing so much as nibbles here. You reel the line back in.'));
    return;
  }
  // A few nibbles at uneven gaps, then the real bite.
  let t = 1200 + Math.random() * 1500;
  for (let i = 0; i < s.line.nibbles; i++) {
    const at = t;
    later(at, () => dip(false));
    t += 1300 + Math.random() * 1800;
  }
  later(t, () => dip(true));
}

function later(ms, fn) {
  fishing.timers.push(setTimeout(fn, ms));
}

function dip(deep) {
  if (!fishing || fishing.phase !== 'wait') return;
  const index = fishing.dips++;
  fishing.deep = deep;
  fishing.dipUntil = performance.now() + (deep ? BITE_MS : NIBBLE_MS);
  fishing.dipIndex = index;
  sound.fx(deep ? 'bite' : 'nibble');
  showLine(deep ? 'The float goes right under!' : 'The float dips…', deep ? 'urgent' : 'wait');
  // Too slow on the real bite: it spits the hook.
  if (deep) later(BITE_MS, () => fishing?.phase === 'wait' && reel(fishing.line.nibbles + 1));
}

function strike() {
  if (!fishing || fishing.phase !== 'wait') return;
  const now = performance.now();
  // Struck while nothing was pulling counts as striking at a nibble.
  const on = fishing.dipUntil > now ? fishing.dipIndex : -1;
  if (on !== fishing.line.nibbles) {
    reel(on);
    return;
  }
  fishing.phase = 'fight';
  fishing.round = 0;
  showLine('Hooked! Hold on…', 'urgent');
  nextPull();
}

function nextPull() {
  const runs = fishing.line.runs;
  if (fishing.round >= runs.length) {
    reel(fishing.line.nibbles);
    return;
  }
  const round = fishing.round;
  fishing.pull = runs[round];
  sound.fx('pull');
  showLine(PULL_WORDS[fishing.pull], 'fight');
  later(PULL_MS, () => fishing?.round === round && answer(null));
}

// One answer per pull: presses between pulls count for nothing.
function answer(a) {
  if (!fishing || fishing.phase !== 'fight' || !fishing.pull) return;
  fishing.answers.push(a);
  fishing.round++;
  fishing.pull = null;
  for (const id of ['lean-left', 'give-line', 'lean-right']) $(id).disabled = true;
  later(500, nextPull);
}

async function reel(strikeAt) {
  if (!fishing || fishing.phase === 'done') return;
  fishing.phase = 'done';
  const s = await act('reel', { strike: strikeAt, answers: fishing.answers });
  if (!s || s.error) {
    endFishing(s?.error ?? '');
    return;
  }
  take({ ...s, found: [] });
  endFishing(s.caught === 'nothing' ? s.lost ?? 'It got away.' : `You land ${s.caught}.`);
}

function endFishing(words) {
  if (fishing) for (const t of fishing.timers) clearTimeout(t);
  fishing = null;
  $('line').hidden = true;
  $('fish-note').textContent = words;
  if (state) render();
}

function showLine(words, mode) {
  $('line').hidden = false;
  $('line-say').textContent = words;
  $('line-say').classList.toggle('urgent', mode === 'urgent' || mode === 'fight');
  const fight = mode === 'fight';
  $('strike').hidden = fight || fishing?.phase === 'fight';
  for (const id of ['lean-left', 'give-line', 'lean-right']) {
    $(id).hidden = !(fishing?.phase === 'fight');
    $(id).disabled = !fight;
  }
}

$('strike').addEventListener('click', strike);
$('lean-left').addEventListener('click', () => answer('left'));
$('lean-right').addEventListener('click', () => answer('right'));
$('give-line').addEventListener('click', () => answer('give'));
document.addEventListener('keydown', (e) => {
  if (!fishing || e.target.closest?.('textarea, input, select')) return;
  const key = { ' ': 'strike', ArrowLeft: 'left', ArrowRight: 'right', ArrowDown: 'give' }[e.key];
  if (!key) return;
  e.preventDefault();
  if (key === 'strike') strike();
  else if (fishing.phase === 'fight' && fishing.pull) answer(key);
});

// --- sound ---------------------------------------------------------------------------------
// All made in the browser with WebAudio, nothing downloaded: the sea is filtered noise that
// swells with the tide, the music a few slow notes on a pentatonic scale, and small effects.
// Off until you turn it on (browsers only allow sound after a tap); volumes are remembered.

const sound = (() => {
  let ac = null;
  const gains = {};
  const vol = { sea: 60, music: 40, fx: 70 };
  try {
    Object.assign(vol, JSON.parse(localStorage.getItem('driftmail-sound') ?? '{}'));
  } catch {}
  for (const k of Object.keys(vol)) $(`vol-${k}`).value = String(vol[k]);

  function start() {
    ac = new AudioContext();
    for (const k of Object.keys(vol)) {
      gains[k] = ac.createGain();
      gains[k].gain.value = vol[k] / 100;
      gains[k].connect(ac.destination);
    }
    // The sea: brown noise through a low-pass filter whose cutoff swells slowly, like waves.
    const len = ac.sampleRate * 4;
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      data[i] = last * 3.5;
    }
    const noise = ac.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 500;
    const lfo = ac.createOscillator();
    lfo.frequency.value = 0.12;
    const depth = ac.createGain();
    depth.gain.value = 350;
    lfo.connect(depth).connect(lp.frequency);
    const seaLevel = ac.createGain();
    seaLevel.gain.value = 0.5;
    noise.connect(lp).connect(seaLevel).connect(gains.sea);
    noise.start();
    lfo.start();
    music();
  }

  // A slow note every few seconds, lower at night.
  const SCALE = [0, 2, 4, 7, 9, 12, 14, 16];
  function music() {
    if (!ac) return;
    const night = state ? clockNow().part === 'night' : false;
    const note = SCALE[Math.floor(Math.random() * SCALE.length)];
    tone(220 * 2 ** ((note - (night ? 12 : 0)) / 12), 2.8, 'sine', gains.music, 0.12);
    setTimeout(music, 2600 + Math.random() * 3200);
  }

  function tone(freq, dur, type, out, level) {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(level, ac.currentTime + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
    o.connect(g).connect(out);
    o.start();
    o.stop(ac.currentTime + dur + 0.05);
  }

  function fx(name) {
    if (!ac) return;
    const out = gains.fx;
    if (name === 'throw' || name === 'cast') {
      // A splash: a burst of noise falling away.
      const n = ac.createBufferSource();
      const b = ac.createBuffer(1, ac.sampleRate * 0.6, ac.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 3;
      n.buffer = b;
      const f = ac.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = name === 'cast' ? 1800 : 900;
      n.connect(f).connect(out);
      n.start();
    } else if (name === 'nibble' || name === 'bite') {
      tone(name === 'bite' ? 330 : 520, name === 'bite' ? 0.35 : 0.1, 'sine', out, name === 'bite' ? 0.3 : 0.12);
    } else if (name === 'pull') {
      tone(180, 0.25, 'sawtooth', out, 0.06); // the line singing
    } else if (name === 'open') {
      tone(880, 0.15, 'triangle', out, 0.25); // the cork
      setTimeout(() => ac && tone(660, 0.4, 'sine', out, 0.1), 90);
    } else if (name === 'build' || name === 'gather') {
      for (let i = 0; i < 3; i++) setTimeout(() => ac && tone(140 + i * 10, 0.12, 'square', out, 0.08), i * 140);
    } else if (name === 'water') {
      for (let i = 0; i < 5; i++) setTimeout(() => ac && tone(1200 + Math.random() * 600, 0.08, 'sine', out, 0.05), i * 70);
    }
  }

  $('sound').addEventListener('click', () => {
    if (ac) {
      ac.close();
      ac = null;
      $('sound').textContent = 'Turn sound on';
      return;
    }
    start();
    $('sound').textContent = 'Turn sound off';
  });
  for (const k of Object.keys(vol)) {
    $(`vol-${k}`).addEventListener('input', () => {
      vol[k] = Number($(`vol-${k}`).value);
      if (gains[k]) gains[k].gain.value = vol[k] / 100;
      try {
        localStorage.setItem('driftmail-sound', JSON.stringify(vol));
      } catch {}
    });
  }
  return { fx };
})();

// --- little helpers -------------------------------------------------------------------------

// A select's "none of these" choice, with an empty value.
function blank(text) {
  const o = el('option', '', text);
  o.value = '';
  return o;
}

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

function until(t) {
  const m = Math.round((t - Date.now() - offset) / 60000);
  if (m < 2) return 'any moment now';
  if (m < 60) return `in about ${m} minutes`;
  return `in about ${Math.round(m / 60)} hours`;
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
