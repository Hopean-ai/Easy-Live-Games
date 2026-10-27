// Legio: the page for one soldier's career. The server (src/legio/camp.js) runs the game and keeps
// the career on the account; this page only shows the card in front and sends back which choice
// was picked. Everything players or the game wrote is put on the page with textContent.
const $ = (id) => document.getElementById(id);

const STATS = [
  { key: 'virtus', name: 'Virtus', gloss: 'courage, and being seen to have it' },
  { key: 'gratia', name: 'Gratia', gloss: 'favour with the men who promote you' },
  { key: 'litterae', name: 'Litterae', gloss: 'reading, writing and accounts' },
  { key: 'milites', name: 'Milites', gloss: 'your soldiers\' love', officer: true },
];

let state = null;
let me = null;
let busy = false;

async function init() {
  const res = await fetch('/api/legio/state');
  if (res.status === 401) {
    $('signin').hidden = false;
    $('signin-link').href = `/?next=${encodeURIComponent('/legio')}`;
    return;
  }
  me = (await getJson('/api/me'))?.name ?? null;
  show(await res.json());
}

function show(next) {
  state = next;
  const run = state.run;
  $('intro').hidden = Boolean(run);
  $('game').hidden = !run;
  $('board-section').hidden = false;
  renderBoard();
  if (!run) {
    $('sub').textContent = 'From recruit to emperor, if you live.';
    return;
  }
  $('sub').textContent = run.name
    ? `${run.name} · ${run.ranks[run.rank].name} · ${run.year} AD`
    : 'A new recruit';
  renderCard(run);
  renderSide(run);
  renderLog(run);
}

function renderCard(run) {
  const card = run.card;
  $('ended').hidden = !run.over;
  $('card').hidden = run.over;
  if (run.over) {
    $('fate').textContent = run.fate;
    $('final-score').textContent = run.score;
    $('story').replaceChildren(...run.story.map((line) => li(line)));
    return;
  }
  $('card-title').textContent = card.title;
  $('card-text').textContent = card.text;
  $('choices').replaceChildren(...card.choices.map((c, i) => {
    const b = document.createElement('button');
    b.className = 'lg-choice';
    b.disabled = c.off;
    const label = document.createElement('span');
    label.textContent = c.label;
    b.append(label);
    if (c.hint) {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = c.off ? `${c.hint} (not now)` : c.hint;
      b.append(hint);
    }
    b.addEventListener('click', () => answer(i));
    return b;
  }));
}

function renderSide(run) {
  $('soldier-name').textContent = run.name || 'A recruit';
  $('soldier-rank').textContent = `${run.ranks[run.rank].name}: ${run.ranks[run.rank].gloss}`;
  $('f-legion').textContent = run.legion ? `${run.legion}, ${run.base}` : '—';
  $('f-front').textContent = run.front ?? '—';
  $('f-emperor').textContent = run.emperor;
  $('f-age').textContent = `${run.age}`;
  $('f-years').textContent = `${run.years} year${run.years === 1 ? '' : 's'} · ${run.season}, ${run.year} AD`;
  $('f-denarii').textContent = `${run.denarii} denarii${run.debt ? ` (owes ${run.debt})` : ''}`;
  $('f-score').textContent = run.score;

  const rows = [{ key: 'health', name: 'Health', gloss: 'wounds, fever and age', value: run.health }];
  for (const s of STATS) if (!s.officer || run.officer) rows.push({ ...s, value: run.stats[s.key] });
  $('stats').replaceChildren(...rows.map((s) => {
    const div = document.createElement('div');
    div.className = `lg-stat${s.key === 'health' ? ' health' : ''}${s.key === 'health' && s.value < 35 ? ' low' : ''}`;
    const name = document.createElement('strong');
    name.textContent = s.name;
    const value = document.createElement('span');
    value.textContent = Math.round(s.value);
    const meter = document.createElement('div');
    meter.className = 'meter';
    const fill = document.createElement('span');
    fill.style.width = `${Math.max(0, Math.min(100, s.value))}%`;
    meter.append(fill);
    const gloss = document.createElement('span');
    gloss.className = 'gloss';
    gloss.textContent = s.gloss;
    div.append(name, value, meter, gloss);
    return div;
  }));

  $('ladder').replaceChildren(...run.ranks.map((r, i) => i).reverse().map((i) => {
    const r = run.ranks[i];
    const item = document.createElement('li');
    if (i <= run.best) item.classList.add('reached');
    if (i === run.rank) item.classList.add('now');
    const name = document.createElement('span');
    name.textContent = r.name;
    const gloss = document.createElement('span');
    gloss.className = 'gloss';
    gloss.textContent = r.gloss;
    item.append(name, gloss);
    return item;
  }));

  $('decorations-panel').hidden = !run.decorations.length;
  $('decorations').replaceChildren(...run.decorations.map((d) => li(d)));
}

function renderLog(run) {
  $('log').replaceChildren(...run.log.slice().reverse().map((entry) => {
    const item = document.createElement('li');
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = `${entry.half ? 'Winter' : 'Summer'} ${entry.year}`;
    item.append(when, entry.text);
    return item;
  }));
}

function renderBoard() {
  const rows = state.leaderboard ?? [];
  $('board-empty').hidden = rows.length > 0;
  $('board').replaceChildren(...rows.map((r, i) => {
    const tr = document.createElement('tr');
    if (me && r.account.toLowerCase() === me.toLowerCase()) tr.className = 'you';
    const who = document.createElement('td');
    who.className = 'who';
    const name = document.createElement('span');
    name.textContent = r.name;
    const account = document.createElement('span');
    account.className = 'small';
    // A Roblox player who never linked an account plays under their Roblox id.
    account.textContent = r.account.startsWith('roblox:') ? 'Roblox player' : r.account;
    who.append(name, account);
    const fate = cell(r.fate);
    fate.className = 'fate';
    const score = cell(String(r.score));
    score.className = 'num';
    tr.append(cell(String(i + 1)), who, cell(r.rank), fate, score);
    return tr;
  }));
  const best = state.best;
  $('my-best').textContent = best
    ? `Your best: ${best.name}, ${best.rank}, ${best.score} points, over ${state.careers} career${state.careers === 1 ? '' : 's'}.`
    : 'Finish a career to get on the board.';
}

async function answer(i) {
  if (busy || !state?.run) return;
  busy = true;
  $('error').textContent = '';
  for (const b of $('choices').querySelectorAll('button')) b.disabled = true;
  const res = await postJson('/api/legio/choose', { i, turn: state.run.turn });
  busy = false;
  if (!res) {
    $('error').textContent = 'Could not reach the camp. Try again.';
    renderCard(state.run);
    return;
  }
  if (res.run) show(res);
  if (res.error) $('error').textContent = res.error;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function enlist() {
  if (state?.run && !state.run.over && !confirm('Give up your current career and enlist again? It will not reach the leaderboard.')) return;
  const res = await postJson('/api/legio/enlist', {});
  if (res?.run) show(res);
}

$('enlist').addEventListener('click', enlist);
$('again').addEventListener('click', enlist);

function li(text) {
  const item = document.createElement('li');
  item.textContent = text;
  return item;
}

function cell(text) {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

async function postJson(path, body) {
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await res.json();
  } catch {
    return null;
  }
}

async function getJson(path) {
  try {
    const res = await fetch(path);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

init();
