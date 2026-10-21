// CFO browser client. The room's Durable Object holds the game and checks every move; this page
// only draws the view it is sent and asks for actions. Player names are only ever put on the page
// with textContent.
const $ = (id) => document.getElementById(id);
const COLORS = ['#5ad1a5', '#f0b429', '#7aa2ff', '#ff7a9c', '#c792ea', '#ff9f43'];
const money = (n) => `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;

let ws = null;
let room = null;
let myName = '';
let token = sessionStorage.getItem('cfo-token') || randomToken();
let mySeat = null;
let rules = null; // board, cards and numbers, sent once by the room
let state = null; // latest { status, seats, game }
let selected = null; // board position the player tapped
let statementSeat = null;
let expect = 0;
let matchWs = null;
let matchPing = null;
let roomPing = null;
let searchTimer = null;
let reconnectDelay = 500;
let replaced = false;

sessionStorage.setItem('cfo-token', token);

function randomToken() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
}

function wsBase() {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') Object.assign(node.style, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node[k] = v;
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

// ---- Lobby ----

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
  const code = params.get('room');
  if (code && /^[A-Za-z0-9]{4,12}$/.test(code)) return enterRoom(code.toUpperCase());
  $('lobby').hidden = false;
  if (account) showMyGames();
  if (params.has('quick')) {
    history.replaceState(null, '', location.pathname);
    findMatch();
  }
}

// Games this account is still playing, from any device, each with a button to rejoin.
async function showMyGames() {
  let games = [];
  try {
    games = (await (await fetch('/api/my-games')).json()).games.filter((g) => g.game === 'cfo');
  } catch {
    return;
  }
  if (!games.length) return;
  $('my-games-list').replaceChildren(...games.map((g) => el('li', {},
    el('span', { class: 'pname' }, `Room ${g.code}: ${g.players}`),
    el('button', { class: 'secondary', onclick: () => enterRoom(g.code) }, 'Rejoin'))));
  $('my-games').hidden = false;
}

$('quick').addEventListener('click', () => findMatch());
$('cancel').addEventListener('click', () => stopMatch());

function findMatch() {
  stopMatch();
  $('lobby-error').textContent = '';
  $('searching').hidden = false;
  $('search-text').textContent = 'Looking for players…';
  $('quick').disabled = true;
  const sock = (matchWs = new WebSocket(`${wsBase()}/api/match/cfo/ws?${new URLSearchParams({ token })}`));
  sock.addEventListener('open', () => (matchPing = setInterval(() => sock.send('ping'), 30_000)));
  sock.addEventListener('message', (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return; // 'pong'
    }
    if (msg.t === 'queued') showQueue(msg);
    if (msg.t === 'matched' && /^[A-Z0-9]{4,12}$/.test(msg.room)) {
      stopMatch();
      expect = msg.players;
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

function showQueue(msg) {
  clearInterval(searchTimer);
  const text = () => {
    let s = `${msg.waiting} of up to ${msg.max} players waiting`;
    if (msg.startsAt) s += `, starting in ${Math.max(0, Math.ceil((msg.startsAt - Date.now()) / 1000))}s`;
    $('search-text').textContent = `${s}…`;
  };
  text();
  if (msg.startsAt) searchTimer = setInterval(text, 500);
}

function stopMatch() {
  const sock = matchWs;
  matchWs = null;
  clearInterval(matchPing);
  clearInterval(searchTimer);
  sock?.close();
  $('searching').hidden = true;
  $('quick').disabled = false;
}

$('create').addEventListener('click', async () => {
  try {
    const { code } = await (await fetch('/api/new-room')).json();
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
  const link = `${location.origin}/cfo?room=${room}`;
  try {
    await navigator.clipboard.writeText(link);
    $('copy').textContent = 'Copied';
  } catch {
    prompt('Copy this link', link);
  }
  setTimeout(() => ($('copy').textContent = 'Copy invite link'), 1500);
});

$('start').addEventListener('click', () => send({ t: 'start' }));
$('value-target').addEventListener('change', (e) => send({ t: 'option', valueTarget: Number(e.target.value) }));
$('max-years').addEventListener('change', (e) => send({ t: 'option', maxYears: Number(e.target.value) }));
$('resign').addEventListener('click', () => {
  if (confirm('Resign? Your company will be wound up and you will be out of the game.')) actNow({ a: 'resign' });
});

function enterRoom(code) {
  room = code;
  history.replaceState(null, '', `/cfo?room=${code}`);
  $('room-code').textContent = code;
  $('room-code-2').textContent = code;
  $('lobby').hidden = true;
  connect();
}

// ---- Connection ----

function connect() {
  const params = new URLSearchParams({ token, name: myName });
  if (expect) params.set('expect', expect);
  ws = new WebSocket(`${wsBase()}/api/rooms/cfo/${room}/ws?${params}`);
  setStatus('Connecting…');
  ws.addEventListener('open', () => {
    reconnectDelay = 500;
    setStatus('');
    clearInterval(roomPing);
    roomPing = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send('ping'), 30_000);
  });
  ws.addEventListener('message', (e) => {
    if (e.data === 'pong') return;
    onMessage(JSON.parse(e.data));
  });
  ws.addEventListener('close', (e) => {
    clearInterval(roomPing);
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

function actNow(action) {
  $('error').textContent = '';
  send({ t: 'act', ...action });
}

function setStatus(text) {
  $('status').textContent = text;
  $('wait-text').dataset.status = text;
}

function onMessage(msg) {
  switch (msg.t) {
    case 'welcome':
      mySeat = msg.seat;
      if (!rules) {
        rules = msg.rules;
        buildBoard();
      }
      break;
    case 'state':
      state = msg;
      render();
      break;
    case 'error':
      $('error').textContent = msg.text;
      if (editing?.saving) {
        editing.saving = false;
        editing.node.querySelector('.error').textContent = msg.text;
      }
      if (fyeForm?.sending) {
        fyeForm.sending = false;
        fyeForm.node.querySelector('.error').textContent = msg.text;
      }
      if (state?.status === 'waiting') $('wait-text').textContent = msg.text;
      break;
    case 'replaced':
      replaced = true;
      break;
  }
}

// ---- Rendering ----

function render() {
  const playing = state.status !== 'waiting' && state.game;
  $('waiting').hidden = Boolean(playing);
  $('play').hidden = !playing;
  if (!playing) return renderWaiting();
  renderBoard();
  renderTurn();
  renderPlayers();
  renderTile();
  renderOffers();
  renderHand();
  renderRows();
  renderStatements();
  renderBooks();
  renderFye();
  renderMarket();
  $('log').replaceChildren(...[...state.game.log].reverse().map((line) => el('li', {}, line))); // newest first
}

function renderWaiting() {
  const host = state.host ?? 0; // the first admin to join, else the first player
  $('seat-list').replaceChildren(
    ...state.seats.map((s, i) =>
      el('li', { class: s.connected ? '' : 'away' },
        el('span', { class: 'dot', style: { background: COLORS[i] } }),
        `${s.name}${s.guest ? ' (guest)' : ''}${i === mySeat ? ' (you)' : ''}${i === host ? ' · host' : ''}`)),
  );
  const n = state.seats.length;
  const max = rules?.config.maxPlayers ?? 6;
  let text;
  if (mySeat === null) text = n >= max ? 'This room is full, so you are watching.' : 'Joining…';
  else if (state.expect) text = `Waiting for ${state.expect - n} more matched player${state.expect - n === 1 ? '' : 's'} to arrive.`;
  else if (mySeat === host) text = n < 2 ? 'Share the invite link. You need at least one more player.' : `Start when everyone is here (up to ${max}).`;
  else text = 'Waiting for the host to start.';
  $('wait-text').textContent = text;
  renderWinOptions();
  $('start').hidden = mySeat !== host;
  $('start').disabled = n < (rules?.config.minPlayers ?? 2);
}

// Every way to win is live in every game; whichever happens first ends it.
function winLines(o) {
  const cfg = rules.config;
  return [
    'Last company standing: drive every other independent company out of business.',
    `Company value: the first company worth ${money(o.valueTarget ?? cfg.valueTarget)}.`,
    `Personal portfolio: the first player with ${money(cfg.portfolioGoal)} of personal assets who has made a lap of the island.`,
    ...(o.maxYears ? [`After ${o.maxYears} fiscal years, the highest net worth.`] : []),
  ];
}

function renderWinOptions() {
  const o = state.options ?? {};
  $('win-list').replaceChildren(...winLines(o).map((t) => el('li', {}, t)));
  // Don't overwrite a number the host is in the middle of typing.
  if (document.activeElement !== $('value-target')) $('value-target').value = o.valueTarget ?? rules?.config.valueTarget ?? '';
  if (document.activeElement !== $('max-years')) $('max-years').value = o.maxYears ?? 0;
  for (const id of ['value-target', 'max-years']) $(id).disabled = mySeat !== (state.host ?? 0);
}

// The board is a 22 x 11 loop, laid out like the spreadsheet: FYE top-left, Bank top-right,
// CPE bottom-right and Interim Review bottom-left.
function gridPos(pos) {
  // The island is a 7 x 7 ring inside the board, Terminal at its top-left.
  if (pos >= rules.islandStart) {
    const k = pos - rules.islandStart;
    if (k <= 6) return [3, 14 + k];
    if (k <= 12) return [k - 3, 20];
    if (k <= 18) return [9, 32 - k];
    return [27 - k, 14];
  }
  if (pos <= 21) return [1, pos + 1];
  if (pos <= 31) return [pos - 20, 22];
  if (pos <= 52) return [11, 53 - pos];
  return [63 - pos, 1];
}

const CORNER_NAMES = {
  fye: ['FYE', 'Fiscal year end'], bank: ['Bank', 'Borrow here'], cpe: ['CPE', 'Sit out a turn'], review: ['Interim Review', 'Audit'],
  terminal: ['Terminal', 'Fly home'], haven: ['Offshore Haven', 'Draw Fraud'], customs: ['Customs', 'Audit'], exchange: ['Exchange', 'Assets ½ price'],
};
const LANDMARK_COLOR = '#f5f5f5';
const isAirport = (pos) => rules.squares[pos]?.mode === 'air';
const DECK_NAMES = { market: 'Market Forces', fraud: 'Fraud', personal: 'Personal Assets' };
const MODE_ICONS = { truck: '🚚', rail: '🚆', air: '✈️' };

let squareEls = [];

function buildBoard() {
  const board = $('board');
  squareEls = rules.squares.map((sq, pos) => {
    const [row, col] = gridPos(pos);
    const node = el('button', { class: `sq ${sq.kind}${sq.island ? ' island' : ''}${sq.landmark ? ' landmark' : ''}`, style: { gridRow: row, gridColumn: col }, onclick: () => select(pos) });
    if (sq.kind === 'land') node.append(el('span', { class: 'stripe', style: { background: sq.landmark ? LANDMARK_COLOR : rules.sets[sq.set].color } }));
    const title = sq.kind === 'land' ? sq.name
      : sq.kind === 'transport' ? `${MODE_ICONS[sq.mode]} ${rules.modes[sq.mode].name}`
        : sq.kind === 'deck' ? DECK_NAMES[sq.deck]
          : CORNER_NAMES[sq.kind][0];
    node.append(el('span', { class: 'sq-name' }, title));
    if (sq.price) node.append(el('span', { class: 'sq-price' }, money(sq.price + (sq.landmark ? rules.landmarks[sq.landmark].building : 0))));
    if (CORNER_NAMES[sq.kind]) node.append(el('span', { class: 'sq-price' }, CORNER_NAMES[sq.kind][1]));
    node.append(el('span', { class: 'sq-tags' }), el('span', { class: 'tokens' }));
    board.append(node);
    return node;
  });
}

// Zoned lots show a zone tag, and built ones a rarity tag beside it.
const ZONE_MARKS = { industrial: 'Ind', retail: 'Shop', banking: 'Bank', residential: 'Res' };

function renderBoard() {
  const g = state.game;
  squareEls.forEach((node, pos) => {
    const tile = g.tiles[pos];
    node.style.borderColor = tile?.owner !== null && tile?.owner !== undefined ? COLORS[tile.owner] : '';
    node.classList.toggle('owned', Boolean(tile && tile.owner !== null));
    node.classList.toggle('selected', selected === pos);
    const tags = node.querySelector('.sq-tags');
    const key = `${tile?.zone ?? ''}:${tile?.building?.rarity ?? ''}`;
    if (tags.dataset.key !== key) {
      tags.dataset.key = key;
      const r = tile?.building && tile.building.rarity !== 'transport' && rules.rarities[tile.building.rarity];
      tags.replaceChildren(
        tile?.zone ? el('span', { class: `tag zone-${tile.zone}`, title: `Zoned ${rules.zones[tile.zone].name}` }, ZONE_MARKS[tile.zone] ?? '') : '',
        r ? el('span', { class: `tag rar-${tile.building.rarity}`, title: `${r.name} PP&E` }, r.name) : '',
      );
    }
    const tokens = node.querySelector('.tokens');
    tokens.replaceChildren(
      ...g.players.map((p, i) => (p.pos === pos && !p.out ? el('span', { class: 'token', title: p.name, style: { background: COLORS[i] } }) : null)).filter(Boolean),
    );
  });
}

function select(pos) {
  selected = selected === pos ? null : pos;
  render();
}

function myTurn() {
  return state.game.turn === mySeat && state.game.phase !== 'over' && !state.game.players[mySeat]?.out;
}

function renderTurn() {
  const g = state.game;
  const cur = g.players[g.turn];
  $('dice').textContent = g.dice ? `🎲 ${g.dice[0]} + ${g.dice[1]}` : '';
  if (g.phase === 'over') {
    const second = g.second !== null && g.second !== undefined ? ` ${g.players[g.second].name} is second with the largest subsidiary.` : '';
    $('turn-text').textContent = `${g.players[g.winner].name} wins with ${g.endReason}.${second}`;
  } else {
    $('turn-text').textContent = myTurn() ? 'Your turn' : `${cur.name}'s turn${state.seats[g.turn]?.connected ? '' : ' (away)'}`;
  }
  const self = g.players[mySeat];
  $('my-cash').textContent = self && !self.out && g.phase !== 'over' ? `Company cash ${money(self.cash)} · personal ${money(self.personalCash)}` : '';
  $('resign').hidden = mySeat === null || g.phase === 'over' || g.players[mySeat]?.out;
  if (g.win) {
    $('goal').textContent = `Win: last standing, company worth ${money(g.win.valueTarget)}, or ${money(rules.config.portfolioGoal)} portfolio after an island lap${g.win.maxYears ? `; ${g.win.maxYears} years max` : ''}`;
    $('goal').title = winLines(g.win).join('\n');
  }
  const box = $('actions');
  box.replaceChildren();
  if (g.phase === 'over') {
    const order = g.players.map((p, i) => ({ p, i })).sort((a, b) => (a.i === g.winner ? -1 : b.i === g.winner ? 1 : b.p.netWorth - a.p.netWorth));
    box.append(el('h2', {}, 'Final standings'), el('ol', { class: 'standings' }, order.map(({ p, i }) =>
      el('li', {}, `${p.name}${i === g.winner ? ' (winner)' : ''}${p.out ? ', out' : ''}: net worth ${money(p.netWorth)}, portfolio ${money(p.portfolio)}, ${p.years} fiscal year${p.years === 1 ? '' : 's'}`))));
    if (mySeat !== null) box.append(el('button', { onclick: () => send({ t: 'again' }) }, 'Play again with this table'));
    return;
  }
  if (!myTurn()) return;
  const me = g.players[mySeat];
  const sq = rules.squares[me.pos];
  if (g.phase === 'roll') box.append(el('button', { onclick: () => actNow({ a: 'roll' }) }, 'Roll the dice'));
  if (g.phase === 'buy') {
    const lm = sq.landmark && rules.landmarks[sq.landmark];
    const price = sq.price + (lm ? lm.building : 0);
    box.append(el('p', {}, `${sq.name} is for sale at ${money(price)}${lm ? `, with its ${rules.zones[lm.zone].name} landmark already built` : ''}. Your company has ${money(me.cash)}.`));
    if (sq.kind === 'land' && !lm && g.zoningRow.length) {
      box.append(el('p', { class: 'small' }, 'Buying it takes one of the available zoning cards:'));
      const row = el('div', { class: 'row' });
      g.zoningRow.forEach((z, i) => row.append(el('button', { onclick: () => actNow({ a: 'buy', zone: i }) }, `Buy as ${rules.zones[z].name}`)));
      box.append(row);
    } else {
      box.append(el('button', { onclick: () => actNow({ a: 'buy' }) }, `Buy for ${money(price)}`));
    }
    box.append(el('button', { class: 'secondary', onclick: () => actNow({ a: 'pass' }) }, 'Pass'));
  }
  if (g.phase === 'act') {
    const row = el('div', { class: 'row' });
    row.append(el('button', { onclick: () => actNow({ a: 'end' }) }, 'End turn'));
    const assetPrice = me.personalPrice ?? rules.config.personalAssetPrice;
    row.append(el('button', { class: 'secondary', disabled: me.personalCash < assetPrice, onclick: () => actNow({ a: 'personal' }) },
      `Buy a personal asset (${money(assetPrice)})`));
    box.append(row);
    box.append(...flightControls(me));
    if (me.atCustoms && me.frauds) {
      box.append(el('button', { class: 'secondary', disabled: me.cash < rules.config.settlement, onclick: () => actNow({ a: 'settle' }) },
        `Settle one fraud quietly (${money(rules.config.settlement)} in legal fees)`));
    }
    box.append(amountForm('Pay yourself extra', `Your salary is paid automatically at each fiscal year end. This pays you more now from company cash, less ${Math.round(rules.config.personalTax * 100)}% personal tax.`, (amount) => actNow({ a: 'pay', amount })));
    if (me.sale && (g.tiles[me.sale.pos].owner === mySeat ? g.tiles[me.sale.pos].stock > 0 : g.tiles.some((t) => t?.owner === mySeat && t.zone === 'industrial' && t.stock > 0))) box.append(saleControls(me));
    const cfg = rules.config;
    if (!me.isPublic && me.parent === null && me.years >= cfg.ipoYears) {
      box.append(el('button', { class: 'secondary', onclick: () => confirm(`Sell ${cfg.ipoShares} new shares to the public? You will own less of your company, and auditors will look twice as hard.`) && actNow({ a: 'ipo' }) },
        `Go public: sell ${cfg.ipoShares} new shares at about ${money(me.sharePrice * cfg.publicPremium)} each`));
    }
    if (g.players.length >= 3) {
      g.players.forEach((q, j) => {
        if (!q.out || j === mySeat) return;
        box.append(amountForm(`Hire ${q.name}`, `${q.name} is out. Fund a subsidiary for them to run (at least ${money(cfg.subsidiaryMin)}); you keep ${100 - cfg.managerShares}% of it.`, (amount) => actNow({ a: 'hire', target: j, amount })));
      });
    }
    if (me.atBank) box.append(amountForm('Borrow', `The Bank lends up to ${money(rules.config.loanLimit)} in total. Interest is ${Math.round(rules.config.loanInterest * 100)}% of the most you owe during each fiscal year, charged at its end.`, (amount) => actNow({ a: 'borrow', amount })));
    const loan = me.loan ?? me.balance?.liabilities.loan ?? 0;
    if (loan > 0) box.append(amountForm('Repay loan', `You owe ${money(loan)}.`, (amount) => actNow({ a: 'repay', amount })));
    box.append(el('p', { class: 'small' }, 'To build, tap one of your zoned squares on the board.'));
  }
}

// Flights: to the island from an airport someone owns, or home from the island's Terminal.
function flightControls(me) {
  const g = state.game;
  if (me.flew) return [];
  const fareTo = (pos) => (g.tiles[pos].owner === mySeat ? 'free on your own airline' : money(rules.config.islandFare));
  const cantPay = (pos) => g.tiles[pos].owner !== mySeat && me.cash < rules.config.islandFare;
  if (isAirport(me.pos) && g.tiles[me.pos].owner !== null) {
    return [el('button', { class: 'secondary', disabled: cantPay(me.pos), onclick: () => actNow({ a: 'fly' }) }, `Fly to the island (${fareTo(me.pos)})`)];
  }
  if (me.atTerminal) {
    const airports = rules.squares.map((sq, pos) => pos).filter(isAirport);
    return [el('p', { class: 'small' }, 'Fly home to:'), el('div', { class: 'row' }, airports.map((pos) =>
      el('button', { class: 'secondary', disabled: cantPay(pos), onclick: () => actNow({ a: 'fly', to: pos }) }, `${rules.squares[pos].name} (${fareTo(pos)})`)))];
  }
  return [];
}

// Landing on a Retail square: your own offers special sales; someone else's lets you sell through it.
function saleControls(me) {
  const g = state.game;
  const tile = g.tiles[me.sale.pos];
  const owner = g.players[tile.owner];
  const box = el('div', { class: 'sale' });
  if (tile.owner === mySeat) {
    const { units, price } = storeTerms(me.sale.pos, tile.building);
    box.append(el('p', {}, `Your store at ${rules.squares[me.sale.pos].name}: run a sale this turn?`));
    const row = el('div', { class: 'row' });
    for (const [id, s] of Object.entries(rules.retail.sales)) {
      row.append(el('button', { class: 'secondary', onclick: () => actNow({ a: 'sell', option: id }) },
        `${s.name}: up to ${Math.round(units * s.volume).toLocaleString('en-US')} widgets at $${(price * s.price).toFixed(2)}`));
    }
    box.append(row);
  } else {
    const { units, price } = storeTerms(me.sale.pos, tile.building);
    box.append(el('button', { class: 'secondary', onclick: () => actNow({ a: 'sell' }) },
      `Sell up to ${units.toLocaleString('en-US')} widgets from your factories through ${owner.name}'s store at $${price.toFixed(2)} (they keep ${Math.round(rules.retail.commission * 100)}%)`));
  }
  return box;
}

function placesText(me) {
  const g = state.game;
  const where = g.tiles.map((t, pos) => ({ t, pos })).filter(({ t }) => t?.owner === mySeat && t.stock > 0);
  const places = where.map(({ t, pos }) => `${t.stock.toLocaleString('en-US')} at ${rules.squares[pos].name}`);
  if (me.carried > 0) places.push(`${me.carried.toLocaleString('en-US')} in storage until you have a factory or store`);
  return places.join(', ');
}

// Miles: a production dial. The company can turn it at any time; it applies at the end of each turn.
function productionDial(me) {
  const levels = rules.supply.levels;
  const hint = {
    idle: 'make nothing and save cash; stores keep selling what they have',
    demand: `make only what your stores need to hold ${levels.demand.cover} turns of sales`,
    full: `run flat out; stores hold ${levels.full.cover} turns of sales and the rest waits in your factories`,
  };
  const current = me.production ?? 'demand';
  return el('div', {},
    el('p', { class: 'small' }, `Production: ${levels[current].name}. Factories ${hint[current]}.`),
    el('div', { class: 'row' }, Object.entries(levels).map(([id, l]) =>
      el('button', { class: 'secondary', disabled: id === current, onclick: () => actNow({ a: 'production', level: id }) }, l.name))));
}

function widgetText(n) {
  n = Math.floor(n);
  if (!n) return 'No widgets.';
  const parts = [];
  for (const [name, size] of rules.widgetTiers) {
    const k = Math.floor(n / size);
    if (k) parts.push(`${k} ${name}`);
    n -= k * size;
  }
  return parts.join(', ');
}

function amountForm(label, hint, onSubmit) {
  const input = el('input', { type: 'number', min: 1, step: 1, placeholder: 'Amount', inputMode: 'numeric' });
  const form = el('form', { class: 'inline', title: hint, onsubmit: (e) => (e.preventDefault(), onSubmit(Number(input.value))) },
    input, el('button', { class: 'secondary' }, label));
  return el('div', {}, form, el('p', { class: 'small hint-left' }, hint));
}

function renderPlayers() {
  const g = state.game;
  const head = el('tr', {}, ...['', 'Company', 'Personal', 'Portfolio', 'Net worth', 'Year'].map((h, k) => el('th', { title: ['', 'Company cash', 'Personal cash', 'Personal asset portfolio', 'Net worth', 'Fiscal years closed'][k] }, h)));
  const rows = g.players.map((p, i) =>
    el('tr', { class: `${p.out ? 'out' : ''} ${i === g.turn ? 'current' : ''}` },
      el('td', {}, el('span', { class: 'dot', style: { background: COLORS[i] } }), `${p.name}${i === mySeat ? ' (you)' : ''}${p.out ? ' · out' : p.skip ? ' · at CPE' : ''}${p.isPublic ? ' · public' : ''}${p.parent !== null && !p.out ? ` · runs ${g.players[p.parent].name}'s subsidiary` : ''}${state.seats[i]?.connected ? '' : ' · away'}`),
      el('td', { title: p.cash === null ? 'Hidden until they file statements' : i !== mySeat && !g.easyBooks ? 'As of their last filed statements' : '' }, p.cash === null ? '—' : money(p.cash)),
      el('td', {}, money(p.personalCash)),
      el('td', {}, money(p.portfolio)),
      el('td', {}, money(p.netWorth)),
      el('td', {}, String(p.years)),
    ));
  $('players').replaceChildren(el('thead', {}, head), el('tbody', {}, rows));
}

function renderTile() {
  const g = state.game;
  if (selected === null) {
    $('tile-title').textContent = 'Board';
    $('tile').replaceChildren(el('p', { class: 'small' }, 'Tap a square to see it. Tap your own zoned land to build on it.'));
    $('peek').textContent = 'Tap a square to see it.';
    return;
  }
  const sq = rules.squares[selected];
  const tile = g.tiles[selected];
  const box = [];
  if (sq.landmark) {
    const lm = rules.landmarks[sq.landmark];
    $('tile-title').textContent = sq.name;
    box.push(el('p', {}, `An island landmark: ${money(sq.price)} of land sold with a ${money(lm.building)} ${rules.zones[lm.zone].name} building already on it.`));
  } else if (sq.kind === 'land') {
    const set = rules.sets[sq.set];
    $('tile-title').textContent = sq.name;
    box.push(el('p', {}, `${set.name} set of ${set.size}${set.placeholder ? ' (placeholder colour)' : ''}. Price ${money(sq.price)}.`));
  } else if (sq.kind === 'transport') {
    $('tile-title').textContent = sq.name;
    box.push(el('p', {}, `${rules.modes[sq.mode].name}. Price ${money(sq.price)}. Rent doubles for each other ${rules.modes[sq.mode].name.toLowerCase()} tile the owner holds. Owning it lets your factories on this side ship free; other players' factories here pay you $${rules.retail.freight.toFixed(2)} a widget in freight.`));
    if (sq.mode === 'air') box.push(el('p', { class: 'small' }, `Land here to fly to the island for ${money(rules.config.islandFare)}, paid to the owner. The owner flies free.`));
  } else if (sq.kind === 'deck') {
    $('tile-title').textContent = DECK_NAMES[sq.deck];
    box.push(el('p', {}, sq.deck === 'personal' ? 'Land here for a free Personal Assets card (1 in 6), or half off one card (1 in 3), or a quarter off one card (1 in 2), bought that turn.' : `Land here to draw a ${DECK_NAMES[sq.deck]} card.`));
  } else {
    $('tile-title').textContent = CORNER_NAMES[sq.kind][1];
    box.push(el('p', {}, {
      fye: 'Passing or landing here closes your fiscal year: core revenue, PP&E operations, depreciation, interest, tax, spouse costs, then statements.',
      bank: `Land here to borrow up to ${money(rules.config.loanLimit)} at ${Math.round(rules.config.loanInterest * 100)}% a year, charged on the most you owe during the year.`,
      cpe: 'Landing here means a turn out for Continuing Professional Education.',
      review: `An audit. Misstatements in your books are fined. Auditors find one fraud on record ${(rules.config.auditFraudChance * 100).toFixed(1)}% of the time, and the chance grows with the square of your frauds: four is ${(rules.config.auditFraudChance * 1600).toFixed(1)}%. Being caught is an immediate loss. One fraud ages off the record every ${rules.config.fraudExpiryYears} fiscal years.`,
      terminal: `The island's airport. Passing or landing here completes a lap of the island and closes your fiscal year. That turn you can fly home to any airport for ${money(rules.config.islandFare)}. Your own airline flies you free.`,
      haven: 'An Offshore Haven. Land here to draw a Fraud card.',
      customs: 'Customs. Landing here means an audit, just like an Interim Review.',
      exchange: `The Exchange. Land here and personal assets cost ${money(rules.config.personalAssetPrice / 2)} that turn.`,
    }[sq.kind]));
  }
  if (tile) {
    if (tile.owner === null) box.push(el('p', { class: 'small' }, 'Owned by the bank.'));
    else {
      box.push(el('p', {}, `Owner: ${g.players[tile.owner].name}. Rent: ${money(tile.rent)}.`));
      if (tile.zone) box.push(el('p', { class: 'small' }, `Zoned ${rules.zones[tile.zone].name}.`));
      if (tile.building) {
        const r = rules.rarities[tile.building.rarity];
        box.push(el('p', { class: 'small' }, `${r.name} PP&E, cost ${money(tile.building.cost)}, book value ${money((tile.building.basis ?? tile.building.cost) - tile.building.dep)}.`));
        const what = buildingText(selected, tile);
        if (what) box.push(el('p', { class: 'small' }, what));
        if (tile.stock) box.push(el('p', { class: 'small' }, `${tile.stock.toLocaleString('en-US')} widgets ${tile.zone === 'retail' ? 'on the shelves' : 'waiting to ship'}.`));
      }
    }
    const mine = tile.owner === mySeat && myTurn() && g.phase === 'act' && sq.kind === 'land';
    if (mine && tile.zone && !sq.landmark) {
      // Building on empty land, or upgrading what's there: the old PP&E's salvage goes toward the new.
      const old = tile.building;
      const salvage = old ? salvageValue(old) : 0;
      if (!old) box.push(el('p', { class: 'small' }, zoneText(tile.zone)));
      const cash = g.players[mySeat].cash;
      box.push(el('p', { class: 'cash-line' }, `Company cash: ${money(cash)}${old ? `. Destroying this PP&E salvages ${money(salvage)} toward an upgrade.` : ''}`));
      const row = el('div', { class: 'row' });
      const extras = g.players[mySeat].bankOptions ?? [];
      [...g.ppeRow, ...extras].forEach((r, i) => {
        const price = rules.rarities[r].price;
        if (old && price <= old.cost) return;
        const net = price - salvage;
        const after = cash >= net ? `leaves ${money(cash - net)}` : `${money(net - cash)} short`;
        row.append(el('button', { class: `build${i >= g.ppeRow.length ? ' secondary' : ''}`, disabled: cash < net, onclick: () => actNow({ a: 'build', pos: selected, card: i }) },
          el('span', {}, old ? `Upgrade to ${rules.rarities[r].name} ${money(net)}` : `Build ${rules.rarities[r].name} ${money(price)}`),
          el('span', { class: 'build-after' }, `${after}${i >= g.ppeRow.length ? ' · bank option' : ''}`)));
      });
      if (!row.children.length) row.append(el('span', { class: 'small' }, old ? 'No pricier PP&E is face up to upgrade to.' : 'The PP&E deck is empty.'));
      box.push(row);
    }
    if (mine && !sq.landmark && g.zoningRow.some((z) => z !== tile.zone)) {
      const fee = Math.round(sq.price * rules.config.rezoneFee);
      box.push(el('p', { class: 'small' }, `Rezone for ${money(fee)}${tile.building ? `. The PP&E here is destroyed for ${money(salvageValue(tile.building))} salvage and must be rebuilt` : ''}:`));
      const row = el('div', { class: 'row' });
      g.zoningRow.forEach((z, i) => {
        if (z !== tile.zone) row.append(el('button', { class: 'secondary', onclick: () => actNow({ a: 'rezone', pos: selected, zone: i }) }, `Rezone ${rules.zones[z].name}`));
      });
      box.push(row);
    }
  }
  if (tile && tile.owner !== null && g.phase !== 'over' && !g.players[mySeat]?.out) box.push(...dealControls(selected, tile));
  $('tile').replaceChildren(...box);
  // Phones show the board without labels, so name the tapped square under it.
  $('peek').textContent = `${sq.name ?? CORNER_NAMES[sq.kind]?.[0] ?? DECK_NAMES[sq.deck]}${tile?.owner !== null && tile?.owner !== undefined ? `, owned by ${g.players[tile.owner].name}` : sq.price ? `, ${money(sq.price)}` : ''}. Details below.`;
}

// Property deals between players: sell your own lot to someone, or bid on someone else's.
function dealControls(pos, tile) {
  const g = state.game;
  const name = rules.squares[pos].name;
  if (tile.owner !== mySeat) {
    const owner = g.players[tile.owner];
    if (owner.out) return [];
    return [amountForm(`Offer for ${name}`, `Offer ${owner.name} a price for ${name} and anything built on it, paid from your company's cash.`,
      (amount) => actNow({ a: 'offer', pos, target: tile.owner, amount }))];
  }
  const others = g.players.map((p, j) => ({ p, j })).filter(({ p, j }) => j !== mySeat && !p.out);
  if (!others.length) return [];
  const who = el('select', {}, others.map(({ p, j }) => el('option', { value: j }, p.name)));
  const input = el('input', { type: 'number', min: 1, step: 1, placeholder: 'Price', inputMode: 'numeric' });
  const form = el('form', { class: 'inline', onsubmit: (e) => (e.preventDefault(), actNow({ a: 'offer', pos, target: Number(who.value), amount: Number(input.value) })) },
    who, input, el('button', { class: 'secondary' }, 'Offer to sell'));
  return [el('div', {}, form, el('p', { class: 'small hint-left' }, `Sell ${name}, with anything built on it, to another player's company. They can accept or decline.`))];
}

function renderOffers() {
  const g = state.game;
  const mine = (g.offers ?? []).filter((o) => o.from === mySeat || o.to === mySeat);
  $('offers').replaceChildren(...mine.map((o) => {
    const from = g.players[o.from];
    const to = g.players[o.to];
    const sq = rules.squares[o.pos];
    if (o.from === mySeat) {
      const text = o.seller === mySeat ? `You offered ${sq.name} to ${to.name} for ${money(o.amount)}.` : `You offered ${to.name} ${money(o.amount)} for ${sq.name}.`;
      return el('div', { class: 'row' }, el('span', { class: 'small' }, text), el('button', { class: 'secondary', onclick: () => actNow({ a: 'cancel' }) }, 'Withdraw'));
    }
    const text = o.seller === o.from ? `${from.name} offers to sell you ${sq.name} for ${money(o.amount)}.` : `${from.name} offers ${money(o.amount)} for your ${sq.name}.`;
    return el('div', { class: 'row' }, el('span', {}, text),
      el('button', { onclick: () => actNow({ a: 'respond', offer: o.id, accept: true }) }, 'Accept'),
      el('button', { class: 'secondary', onclick: () => actNow({ a: 'respond', offer: o.id, accept: false }) }, 'Decline'));
  }));
}

// Mirrors salvageValue() in src/cfo/rules.js.
const salvageValue = (b) => Math.round(((b.basis ?? b.cost) - b.dep) * rules.config.salvage);

// Mirrors production() and storeTerms() in src/cfo/rules.js: the land price and the PP&E both count.
function production(pos, cost) {
  return Math.round(rules.zones.industrial.produce * Math.sqrt(cost * rules.squares[pos].price));
}
function storeTerms(pos, building) {
  const r = rules.retail;
  return { units: Math.round(rules.squares[pos].price * r.perLandDollar), price: r.prices[building.rarity] ?? r.prices.common };
}

function zoneText(id) {
  const z = rules.zones[id];
  const pct = (x) => `${Math.round(x * 100)}%`;
  const r = rules.retail;
  const yearly = {
    industrial: `makes widgets at the end of each of your turns, only as many as your stores need, up to ${z.produce} × √(PP&E cost × land price) a turn, so both the PP&E's price and the land's price count. Each widget costs $1 of company cash. Landing on it runs an overtime shift of ${z.overtime} turns' worth`,
    retail: `at the end of each of your turns sells up to ${r.perLandDollar} widgets per dollar of land price from its shelves, so pricier land sells more. Pricier PP&E sells at a better price, $${r.prices.common.toFixed(2)} to $${r.prices.legendary.toFixed(2)} a widget. Landing on it lets you run a special sale`,
    residential: `pays you passive income at each fiscal year end of ${pct(z.yearly)} of its cost`,
    banking: `each fiscal year earns ${pct(z.interest)} interest on your company's cash plus fees of ${pct(z.yearly)} of its cost`,
  }[id];
  return z.rent ? `${z.name} PP&E charges visitors ${pct(z.rent)} of its cost, and ${yearly}.` : `${z.name} PP&E charges visitors only the land rent, and ${yearly}.`;
}

// What one built square does, in numbers.
function buildingText(pos, tile) {
  const b = tile.building;
  if (tile.zone === 'industrial') {
    const n = production(pos, b.cost);
    return `Makes up to ${n.toLocaleString('en-US')} widgets a turn, ${(n * rules.zones.industrial.overtime).toLocaleString('en-US')} in an overtime shift when its owner lands here.`;
  }
  if (tile.zone === 'retail') {
    const { units, price } = storeTerms(pos, b);
    return `Sells up to ${units.toLocaleString('en-US')} widgets a turn at $${price.toFixed(2)}.`;
  }
  if (tile.zone === 'residential') return `Pays ${money(b.cost * rules.zones.residential.yearly)} at each of its owner's fiscal year ends.`;
  return '';
}

function renderHand() {
  const g = state.game;
  const me = g.players[mySeat];
  if (!me) {
    $('hand').replaceChildren(el('p', { class: 'small' }, 'You are watching.'));
    $('assets').replaceChildren();
    $('widgets').replaceChildren();
    return;
  }
  const cards = (me.hand ?? []).map((id, i) => {
    const card = rules.fraud[id] ?? rules.market[id];
    const fraud = Boolean(rules.fraud[id]);
    const node = el('div', { class: `card ${fraud ? 'fraud' : 'market'}` },
      el('strong', {}, card.name),
      el('span', { class: 'small' }, `${fraud ? 'Fraud: if you are ever caught, you are out of the game' : 'Market Forces'}${card.placeholder ? ' · placeholder' : ''}`),
      el('p', {}, card.text));
    if (myTurn() && g.phase === 'act') node.append(playControls(id, i));
    return node;
  });
  if (me.frauds) {
    const pct = (x) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;
    cards.push(el('p', { class: 'small warn' }, `${me.frauds} fraud${me.frauds > 1 ? 's' : ''} committed. Chance of being caught: ${pct(me.fraudRisk.audit)} at an Interim Review or Customs, ${pct(me.fraudRisk.fye)} at each fiscal year end. Getting caught puts you out of the game. One fraud ages off your record every ${rules.config.fraudExpiryYears} fiscal years.`));
  }
  $('hand').replaceChildren(...(cards.length ? cards : [el('p', { class: 'small' }, 'No cards.')]));

  const assets = me.assets.map((id) => el('span', { class: 'chip', title: rules.personal[id].text ?? '' }, `${rules.personal[id].name} ${money(rules.personal[id].value)}`));
  const r = me.retail;
  $('widgets').replaceChildren(
    el('p', {}, `${Math.floor(me.inventory).toLocaleString('en-US')} widgets${me.inventory >= 1 ? `: ${widgetText(me.inventory)}` : ''}.`),
    el('p', { class: 'small' }, placesText(me)),
    productionDial(me),
    el('p', { class: 'small' }, `At the end of each of your turns your factories make widgets at the production level you set, and your company ships them to your stores. Shipping is free from a factory on a side of the board where you own a transport line. Otherwise it costs $${rules.retail.freight.toFixed(2)} a widget, paid to whoever owns a line on that side or to a hired carrier. Island factories ship free across the island, and goods move between the island and the main board only through an airport of your own.`),
    el('p', { class: 'small' }, r.stores
      ? `Your ${r.stores} store${r.stores > 1 ? 's' : ''} sell up to ${r.units.toLocaleString('en-US')} a turn at ${r.minPrice === r.maxPrice ? `$${r.maxPrice.toFixed(2)}` : `$${r.minPrice.toFixed(2)} to $${r.maxPrice.toFixed(2)}`} each.`
      : 'You have no Retail stores. Land on someone else\'s to sell through it, or build one.'),
  );
  // Everyone's personal assets are public, like a Monopoly player's deeds.
  const others = g.players.map((p, i) => ({ p, i })).filter(({ p, i }) => i !== mySeat && !p.out);
  $('assets').replaceChildren(
    el('p', { class: 'small' }, `Portfolio ${money(me.portfolio)} of the ${money(rules.config.portfolioGoal)} goal.`),
    el('div', { class: 'chips' }, assets),
    others.length ? el('h3', { class: 'small-head' }, 'Other players') : null,
    ...others.map(({ p, i }) => el('div', { class: 'rival-assets' },
      el('p', { class: 'small' }, el('span', { class: 'dot', style: { background: COLORS[i] } }), `${p.name}: ${money(p.portfolio)}`),
      el('div', { class: 'chips' }, p.assets.length ? groupAssets(p.assets) : el('span', { class: 'small' }, 'None yet.')))),
  );
}

// One chip per kind of card, with a count when a player holds several.
function groupAssets(ids) {
  const counts = new Map();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts].map(([id, n]) => el('span', { class: 'chip', title: rules.personal[id].text ?? '' },
    `${rules.personal[id].name}${n > 1 ? ` ×${n}` : ''} ${money(rules.personal[id].value * n)}`));
}

function playControls(id, i) {
  const g = state.game;
  const play = (extra = {}) => actNow({ a: 'play', card: i, ...extra });
  if (id === 'alienation' || id === 'whistle') {
    const others = g.players.map((p, j) => ({ p, j })).filter(({ p, j }) => j !== mySeat && !p.out);
    return el('div', { class: 'row' }, others.map(({ p, j }) => el('button', { class: 'secondary', onclick: () => play({ target: j }) }, `Use on ${p.name}`)));
  }
  if (id === 'contractor') {
    const counts = g.ppeDeckCounts;
    const ok = selected !== null && g.tiles[selected]?.owner === mySeat && g.tiles[selected].zone && !g.tiles[selected].building;
    if (!ok) return el('p', { class: 'small' }, 'Select one of your zoned, empty squares first.');
    return el('div', { class: 'row' }, Object.keys(counts).map((r) =>
      el('button', { class: 'secondary', disabled: g.players[mySeat].cash < rules.rarities[r].price * 0.9, onclick: () => play({ pos: selected, rarity: r }) },
        `${rules.rarities[r].name} ×${counts[r]} (${money(rules.rarities[r].price * 0.9)})`)));
  }
  if (id === 'embezzle') return amountForm('Embezzle', `Up to ${money(2000 * rules.moneyScale)}.`, (amount) => play({ amount }));
  if (id === 'insider') {
    const targets = g.players.map((p, j) => ({ p, j })).filter(({ p }) => p.isPublic && !p.out);
    if (!targets.length) return el('p', { class: 'small' }, 'No company is public yet.');
    return el('div', { class: 'row' }, targets.map(({ p, j }) => el('button', { class: 'secondary', onclick: () => play({ target: j }) }, `${p.name}'s shares`)));
  }
  if (id === 'backdate') {
    const ok = selected !== null && g.tiles[selected]?.owner === mySeat && g.tiles[selected].zone && !g.tiles[selected].building;
    if (!ok) return el('p', { class: 'small' }, 'Select one of your zoned, empty squares first.');
    return el('div', { class: 'row' }, g.ppeRow.map((r, k) =>
      el('button', { class: 'secondary', disabled: g.players[mySeat].cash < rules.rarities[r].price / 2, onclick: () => play({ pos: selected, row: k }) }, `${rules.rarities[r].name} (${money(rules.rarities[r].price / 2)})`)));
  }
  return el('button', { class: 'secondary', onclick: () => play() }, 'Play');
}

function renderRows() {
  const g = state.game;
  $('zoning-left').textContent = `(${g.zoningLeft} left in the deck)`;
  $('ppe-left').textContent = `(${g.ppeLeft} left in the deck)`;
  $('zoning-row').replaceChildren(...g.zoningRow.map((z) => el('span', { class: 'chip' }, rules.zones[z].name)));
  const extras = g.players[mySeat]?.bankOptions ?? [];
  $('ppe-row').replaceChildren(
    ...g.ppeRow.map((r) => el('span', { class: 'chip' }, `${rules.rarities[r].name} ${money(rules.rarities[r].price)}`)),
    ...extras.map((r) => el('span', { class: 'chip private', title: 'Only you can see this: a Banking building shows it to you.' }, `${rules.rarities[r].name} ${money(rules.rarities[r].price)} · bank option`)),
  );
}

function renderStatements() {
  const g = state.game;
  if (statementSeat === null || !g.players[statementSeat]) statementSeat = mySeat ?? 0;
  $('statement-tabs').replaceChildren(...g.players.map((p, i) =>
    el('button', { class: i === statementSeat ? '' : 'secondary', onclick: () => ((statementSeat = i), renderStatements()) }, p.name)));
  const p = g.players[statementSeat];
  const A = rules.accounts;
  if (!g.easyBooks) {
    $('statements').replaceChildren(...filedTables(p));
    return;
  }
  const line = (label, value, cls = '') => el('tr', { class: cls }, el('td', {}, label), el('td', {}, money(value)));
  const income = (s, title) => el('table', { class: 'fs' },
    el('caption', {}, title),
    el('tbody', {},
      Object.entries(s.revenue).filter(([, v]) => v).map(([k, v]) => line(A[k], v)),
      line('Total revenue', s.totalRevenue, 'total'),
      Object.entries(s.expenses).filter(([, v]) => v).map(([k, v]) => line(A[k], -v)),
      line('Income before tax', s.preTax, 'total'),
      line(A.expTax, -s.tax),
      line('Net income', s.netIncome, 'total')));
  const balance = (b, title) => el('table', { class: 'fs' },
    el('caption', {}, title),
    el('tbody', {},
      Object.entries(b.assets).filter(([, v]) => v).map(([k, v]) => line(A[k], v)),
      line('Total assets', b.totalAssets, 'total'),
      Object.entries(b.liabilities).filter(([, v]) => v).map(([k, v]) => line(A[k], v)),
      Object.entries(b.equity).filter(([, v]) => v).map(([k, v]) => line(k === 'netIncome' ? 'Net income this year' : k === 'draws' ? A.draws : A[k], v)),
      line('Total liabilities and equity', b.totalLiabilitiesAndEquity, 'total')));
  const parts = [income(p.income, `Income statement, year ${p.years + 1} to date`), balance(p.balance, 'Balance sheet, now')];
  if (p.report) {
    parts.push(income(p.report.income, `Income statement, fiscal year ${p.report.year}`), balance(p.report.balance, `Balance sheet, end of year ${p.report.year}`));
  }
  if (p.journal) {
    // Only your own journal is sent; the details element remembers being open across renders.
    const open = $('statements').querySelector('details')?.open ?? false;
    parts.push(el('details', { class: 'journal', open },
      el('summary', {}, `Your journal (${p.journal.length} latest entries, newest first)`),
      el('table', { class: 'fs' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Account'), el('th', {}, 'Debit'), el('th', {}, 'Credit'))),
        el('tbody', {}, [...p.journal].reverse().flatMap((e) => [
          el('tr', { class: 'entry' }, el('td', { colSpan: 3 }, e.text)),
          ...e.lines.map(([acct, v]) => el('tr', {},
            el('td', { class: v < 0 ? 'credit' : '' }, A[acct]),
            el('td', {}, v > 0 ? money(v) : ''),
            el('td', {}, v < 0 ? money(-v) : ''))),
        ])))));
  }
  $('statements').replaceChildren(...parts);
}

init();

// ---- Players' own books ----

let editing = null; // { id, node, saving, sent } for the journal entry being written
let fyeForm = null; // { year, node, sending } for the statements being filled in

function fieldLabel(f) {
  return {
    netIncome: 'Net income (loss)',
    totalAssets: 'Total assets',
    totalLiabilitiesAndEquity: 'Total liabilities and equity',
    accDep: 'Less accumulated depreciation',
    retained: 'Retained earnings',
  }[f] ?? rules.accounts[f];
}

function filedTables(p) {
  if (!p.filed) return [el('p', { class: 'small' }, `${p.name} has not filed any statements yet.`)];
  const table = (title, fields, values) => el('table', { class: 'fs' }, el('caption', {}, title),
    el('tbody', {}, fields.filter((f) => values[f] || /^total|netIncome/.test(f)).map((f) =>
      el('tr', { class: /^total|netIncome/.test(f) ? 'total' : '' }, el('td', {}, fieldLabel(f)), el('td', {}, money(values[f]))))));
  return [
    table(`Income statement, fiscal year ${p.filed.year} (as filed)`, rules.incomeFields, p.filed.income),
    table(`Balance sheet, end of year ${p.filed.year} (as filed)`, rules.balanceFields, p.filed.balance),
  ];
}

function renderBooks() {
  const g = state.game;
  const me = g.players[mySeat];
  const manual = !g.easyBooks && me?.docs && g.phase !== 'over';
  $('books-panel').hidden = !manual;
  if (!manual) return;
  $('books-intro').textContent = 'Every company transaction lands here as a source document. Record each one as a journal entry: debits on the left, credits on the right, and they must balance. You can record at any time, even on other players\' turns. At each fiscal year end your statements are built from these entries for you to review and submit, and an Interim Review fines every wrong entry.';
  renderCheck(me);
  $('bookkeeper').replaceChildren(me.outsourced
    ? el('p', { class: 'small' }, `A bookkeeper records your entries and files your statements for ${money(rules.config.bookkeeperFee)} a year. Clean-books bonuses go to people who keep their own books. `,
      el('button', { class: 'secondary', onclick: () => actNow({ a: 'outsource', on: false }) }, 'Keep my own books'))
    : el('p', { class: 'small' }, `Not an accountant? A bookkeeper records every entry and files your statements correctly for ${money(rules.config.bookkeeperFee)} a year, but you give up the clean-books bonus. `,
      el('button', { class: 'secondary', onclick: () => actNow({ a: 'outsource', on: true }) }, 'Hire a bookkeeper')));
  // Miles: with a bookkeeper there is nothing to record, so the documents stay out of the way.
  if (me.outsourced) {
    editing = null;
    $('docs').replaceChildren(el('p', { class: 'small' }, 'Your bookkeeper records every document at each fiscal year end.'));
    return;
  }
  const docs = [...me.docs].reverse();
  if (editing && !docs.some((d) => d.id === editing.id)) editing = null;
  if (editing?.saving) {
    const d = docs.find((x) => x.id === editing.id);
    if (d?.recorded && JSON.stringify(d.recorded) === editing.sent) editing = null;
  }
  // Rebuilding the list would pull the cursor out of an entry being typed.
  if (editing && editing.node.contains(document.activeElement)) return;
  const open = docs.filter((d) => !d.recorded).length;
  const rows = [el('p', { class: 'small' }, open ? `${open} document${open > 1 ? 's' : ''} still to record.` : 'Everything is recorded.')];
  for (const d of docs) {
    rows.push(el('div', { class: `doc ${d.recorded ? 'done' : 'todo'}` },
      el('span', { class: 'doc-text' }, d.text),
      el('span', { class: 'small' }, `Year ${d.year} · ${d.recorded ? entryText(d.recorded) : 'not recorded'}`),
      el('button', { class: d.recorded ? 'link' : 'secondary', onclick: () => startEditing(d) }, d.recorded ? 'Edit' : 'Record')));
    if (editing?.id === d.id) rows.push(editing.node);
  }
  $('docs').replaceChildren(...rows);
}

function entryText(lines) {
  return lines.map(([a, v]) => `${v > 0 ? 'Dr' : 'Cr'} ${rules.accounts[a]} ${money(Math.abs(v))}`).join(', ');
}

function startEditing(doc) {
  if (editing?.id === doc.id) {
    editing = null;
    return renderBooks();
  }
  const body = el('tbody');
  const totals = el('p', { class: 'small' });
  // The plug: whatever the amounts typed so far leave unbalanced is filled in, on the other side,
  // on the last line with no amount of its own (a new line if there is none). The player still
  // picks every account and types the amounts from the document; the plug only saves typing the
  // balancing figure. A plugged amount is shown in italics and becomes the player's own once typed
  // over; typing in either column of a line clears the other column.
  const amount = (row, side) => row.querySelectorAll('input')[side];
  const typed = (input) => input.value !== '' && !input.classList.contains('plug');
  let plugRow = null;
  const plug = () => {
    const rows = [...body.children];
    let diff = 0;
    for (const row of rows) {
      if (typed(amount(row, 0))) diff += Number(amount(row, 0).value) || 0;
      if (typed(amount(row, 1))) diff -= Number(amount(row, 1).value) || 0;
      for (const input of row.querySelectorAll('input.plug')) {
        input.value = '';
        input.classList.remove('plug');
      }
    }
    diff = Math.round(diff * 100) / 100;
    if (diff) {
      // The plug stays on its line while that line is still free, so it doesn't jump around.
      const free = (row) => !typed(amount(row, 0)) && !typed(amount(row, 1));
      let target = plugRow && rows.includes(plugRow) && free(plugRow) ? plugRow : rows.findLast(free);
      if (!target) target = addLine();
      plugRow = target;
      const input = amount(target, diff > 0 ? 1 : 0);
      input.value = Math.abs(diff);
      input.classList.add('plug');
    }
    const sum = (side) => [...body.children].reduce((t, row) => t + (Number(amount(row, side).value) || 0), 0);
    totals.textContent = `Debits ${money(sum(0))}, credits ${money(sum(1))}.${diff ? ' The plug is in italics.' : ''}`;
  };
  function addLine(acct = '', v = 0) {
    const select = el('select', {}, el('option', { value: '' }, 'Account…'),
      Object.entries(rules.accounts).map(([id, name]) => el('option', { value: id, selected: id === acct }, name)));
    const dr = el('input', { type: 'number', min: 0, step: 'any', placeholder: 'Debit', value: v > 0 ? v : '' });
    const cr = el('input', { type: 'number', min: 0, step: 'any', placeholder: 'Credit', value: v < 0 ? -v : '' });
    for (const [mine, other] of [[dr, cr], [cr, dr]]) {
      mine.addEventListener('input', () => {
        mine.classList.remove('plug');
        if (mine.value !== '') {
          other.value = '';
          other.classList.remove('plug');
        }
        plug();
      });
    }
    const row = el('tr', {}, el('td', {}, select), el('td', {}, dr), el('td', {}, cr),
      el('td', {}, el('button', { type: 'button', class: 'link', title: 'Remove line', onclick: () => { row.remove(); plug(); } }, '×')));
    body.append(row);
    return row;
  }
  for (const [a, v] of doc.recorded ?? [['', 0], ['', 0]]) addLine(a, v);
  plug();
  const err = el('p', { class: 'error' });
  const node = el('form', { class: 'entry-editor', onsubmit: (e) => {
    e.preventDefault();
    const lines = [...body.children].map((row) => {
      const [select, dr, cr] = row.querySelectorAll('select, input');
      return [select.value, (Number(dr.value) || 0) - (Number(cr.value) || 0)];
    }).filter(([a, v]) => a || v);
    err.textContent = '';
    editing.saving = true;
    editing.sent = JSON.stringify(lines.map(([a, v]) => [a, Math.round(v * 100) / 100]));
    actNow({ a: 'record', doc: doc.id, lines });
  } },
  el('p', { class: 'small' }, doc.text),
  el('table', { class: 'entry' }, el('thead', {}, el('tr', {}, el('th', {}, 'Account'), el('th', {}, 'Debit'), el('th', {}, 'Credit'), el('th'))), body),
  totals,
  el('div', { class: 'row' },
    el('button', { type: 'button', class: 'secondary', onclick: () => { addLine(); plug(); } }, 'Add a line'),
    el('button', {}, 'Save entry'),
    el('button', { type: 'button', class: 'link', onclick: () => ((editing = null), renderBooks()) }, 'Cancel')),
  err);
  editing = { id: doc.id, node, saving: false };
  renderBooks();
}

function renderCheck(me) {
  const c = me.lastCheck;
  if (!c) return $('check').replaceChildren();
  const head = el('p', { class: c.errors ? 'warn' : '' }, c.errors
    ? `Fiscal year ${c.year}: ${c.errors} misstatement${c.errors > 1 ? 's' : ''}, to be fined at your next Interim Review.`
    : `Fiscal year ${c.year}: clean books. You earned the ${money(rules.config.cleanBooksBonus)} bonus.`);
  if (!c.errors) return $('check').replaceChildren(head);
  const filed = me.filed ?? { income: {}, balance: {} };
  const lines = c.wrongFields.map((f) => {
    const kind = rules.incomeFields.includes(f) ? 'income' : 'balance';
    return el('tr', {}, el('td', {}, fieldLabel(f)), el('td', {}, money(filed[kind][f] ?? 0)), el('td', {}, money(c.truth[kind][f])));
  });
  const fixes = c.corrections.map((x) => el('li', {}, `${x.text}. You: ${x.recorded ? entryText(x.recorded) : 'not recorded'}. Correct: ${entryText(x.lines)}.`));
  $('check').replaceChildren(el('details', { class: 'check' }, el('summary', {}, head),
    lines.length ? el('table', { class: 'fs' }, el('thead', {}, el('tr', {}, el('th', {}, 'Line'), el('th', {}, 'You filed'), el('th', {}, 'Correct'))), el('tbody', {}, lines)) : null,
    fixes.length ? el('ul', { class: 'small' }, fixes) : null));
}

function renderFye() {
  const g = state.game;
  const me = g.players[mySeat];
  const due = !g.easyBooks && g.phase !== 'over' && me?.fyeDue;
  $('fye').hidden = !due;
  if (!due) {
    fyeForm = null;
    return;
  }
  // Miles: the statements are built from your own journal entries; you review them and submit.
  const preview = me.preview ?? { income: {}, balance: {} };
  const table = (title, fields, values) => el('table', { class: 'fs fye-table' }, el('caption', {}, title),
    el('tbody', {}, fields.map((f) => el('tr', { class: /^total|netIncome/.test(f) ? 'total' : '' }, el('td', {}, fieldLabel(f)), el('td', { class: 'num' }, money(values[f] ?? 0))))));
  const open = me.docs.filter((d) => d.year <= due && !d.recorded).length;
  if (fyeForm?.year !== due) {
    const statements = el('div', { class: 'statements' });
    const todo = el('p', { class: 'small warn' });
    const node = el('div', {},
      el('h2', {}, `Fiscal year ${due} is over: review and submit your statements`),
      el('p', { class: 'small' }, 'These are built from the journal entries you recorded, so a mistake in an entry shows up here too. You can fix entries below until you submit. Play goes on meanwhile, and anything not submitted by your next fiscal year end is submitted as it stands.'),
      todo,
      statements,
      el('button', { onclick: () => { fyeForm.sending = true; actNow({ a: 'statements' }); } }, 'Submit statements'),
      el('p', { class: 'error' }));
    fyeForm = { year: due, node, todo, statements, sending: false };
    $('fye').replaceChildren(node);
  }
  fyeForm.statements.replaceChildren(table('Income statement', rules.incomeFields, preview.income), table('Balance sheet', rules.balanceFields, preview.balance));
  fyeForm.todo.textContent = open ? `${open} document${open > 1 ? 's' : ''} from this year still to record. Anything left unrecorded counts as a misstatement.` : '';
}

// ---- Shares ----

function renderMarket() {
  const g = state.game;
  const canTrade = myTurn() && g.phase === 'act';
  const rows = g.players.map((c, i) => {
    if (c.out) return null;
    const total = Object.values(c.shares.holders).reduce((a, b) => a + b, 0) + c.shares.public;
    const mine = c.shares.holders[mySeat] ?? 0;
    const status = c.isPublic ? `Public, ${c.shares.public} of ${total} shares on the market` : c.parent !== null ? `Subsidiary of ${g.players[c.parent].name}` : 'Private';
    const row = el('div', { class: 'stock' },
      el('strong', {}, `${c.name}'s company`),
      el('span', { class: 'small' }, `${status}.${c.sharePrice === null ? '' : ` Share price ${money(c.sharePrice)}.`} You hold ${mine}.`));
    if (canTrade && c.isPublic) {
      const input = el('input', { type: 'number', min: 1, step: 1, placeholder: 'Shares', inputMode: 'numeric' });
      row.append(el('div', { class: 'inline3' }, input,
        el('button', { class: 'secondary', onclick: () => actNow({ a: 'trade', target: i, count: Number(input.value) }) }, 'Buy'),
        el('button', { class: 'secondary', onclick: () => actNow({ a: 'trade', target: i, count: -Number(input.value) }) }, 'Sell')));
    }
    const me = g.players[mySeat];
    if (canTrade && i !== mySeat && c.parent === null && me?.parent === null) {
      row.append(el('button', { class: 'secondary', disabled: me.cash < c.acquisitionPrice,
        onclick: () => confirm(`Buy ${c.name}'s company for ${money(c.acquisitionPrice)}? ${c.name} will be out of the game, and their business joins yours.`) && actNow({ a: 'acquire', target: i }) },
      `Buy the company for ${money(c.acquisitionPrice)}`));
    }
    return row;
  }).filter(Boolean);
  rows.push(el('p', { class: 'small' }, `You can buy a rival independent company outright for ${Math.round((rules.config.acquirePremium - 1) * 100)}% over its market value, taking its owner out of the game. Public companies are valued higher, so they cost more.`));
  rows.push(el('p', { class: 'small' }, `Companies with ${rules.config.ipoYears} fiscal years behind them can go public. The market values a public company at ${rules.config.publicPremium}× its equity, which counts toward net worth, but auditors look ${rules.config.publicScrutiny}× as hard: frauds are likelier to be caught and misstatements are fined more. Distributions are shared among all shareholders.`));
  $('market').replaceChildren(...rows);
}
