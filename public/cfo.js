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
  if (params.has('quick')) {
    history.replaceState(null, '', location.pathname);
    findMatch();
  }
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
  renderHand();
  renderRows();
  renderStatements();
  $('log').replaceChildren(...[...state.game.log].reverse().map((line) => el('li', {}, line))); // newest first
}

function renderWaiting() {
  $('seat-list').replaceChildren(
    ...state.seats.map((s, i) =>
      el('li', { class: s.connected ? '' : 'away' },
        el('span', { class: 'dot', style: { background: COLORS[i] } }),
        `${s.name}${s.guest ? ' (guest)' : ''}${i === mySeat ? ' (you)' : ''}${i === 0 ? ' · host' : ''}`)),
  );
  const n = state.seats.length;
  const max = rules?.config.maxPlayers ?? 6;
  let text;
  if (mySeat === null) text = n >= max ? 'This room is full, so you are watching.' : 'Joining…';
  else if (state.expect) text = `Waiting for ${state.expect - n} more matched player${state.expect - n === 1 ? '' : 's'} to arrive.`;
  else if (mySeat === 0) text = n < 2 ? 'Share the invite link. You need at least one more player.' : `Start when everyone is here (up to ${max}).`;
  else text = 'Waiting for the host to start.';
  $('wait-text').textContent = text;
  $('start').hidden = mySeat !== 0;
  $('start').disabled = n < (rules?.config.minPlayers ?? 2);
}

// The board is a 22 x 11 loop, laid out like the spreadsheet: FYE top-left, Bank top-right,
// CPE bottom-right and Interim Review bottom-left.
function gridPos(pos) {
  if (pos <= 21) return [1, pos + 1];
  if (pos <= 31) return [pos - 20, 22];
  if (pos <= 52) return [11, 53 - pos];
  return [63 - pos, 1];
}

const CORNER_NAMES = { fye: ['FYE', 'Fiscal year end'], bank: ['Bank', 'Borrow here'], cpe: ['CPE', 'Sit out a turn'], review: ['Interim Review', 'Audit'] };
const DECK_NAMES = { market: 'Market Forces', fraud: 'Fraud', personal: 'Personal Assets' };
const MODE_ICONS = { truck: '🚚', rail: '🚆', air: '✈️' };

let squareEls = [];

function buildBoard() {
  const board = $('board');
  squareEls = rules.squares.map((sq, pos) => {
    const [row, col] = gridPos(pos);
    const node = el('button', { class: `sq ${sq.kind}`, style: { gridRow: row, gridColumn: col }, onclick: () => select(pos) });
    if (sq.kind === 'land') node.append(el('span', { class: 'stripe', style: { background: rules.sets[sq.set].color } }));
    const title = sq.kind === 'land' ? sq.name
      : sq.kind === 'transport' ? `${MODE_ICONS[sq.mode]} ${rules.modes[sq.mode].name}`
        : sq.kind === 'deck' ? DECK_NAMES[sq.deck]
          : CORNER_NAMES[sq.kind][0];
    node.append(el('span', { class: 'sq-name' }, title));
    if (sq.price) node.append(el('span', { class: 'sq-price' }, money(sq.price)));
    if (CORNER_NAMES[sq.kind]) node.append(el('span', { class: 'sq-price' }, CORNER_NAMES[sq.kind][1]));
    node.append(el('span', { class: 'sq-build' }), el('span', { class: 'tokens' }));
    board.append(node);
    return node;
  });
}

function renderBoard() {
  const g = state.game;
  squareEls.forEach((node, pos) => {
    const tile = g.tiles[pos];
    node.style.borderColor = tile?.owner !== null && tile?.owner !== undefined ? COLORS[tile.owner] : '';
    node.classList.toggle('owned', Boolean(tile && tile.owner !== null));
    node.classList.toggle('selected', selected === pos);
    const b = node.querySelector('.sq-build');
    b.textContent = tile?.building ? rules.rarities[tile.building.rarity].name[0] : tile?.zone ? rules.zones[tile.zone].name[0].toLowerCase() : '';
    b.title = tile?.zone ? `${rules.zones[tile.zone].name}${tile.building ? `, ${rules.rarities[tile.building.rarity].name} PP&E` : ''}` : '';
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
    $('turn-text').textContent = `${g.players[g.winner].name} wins with ${g.endReason}.`;
  } else {
    $('turn-text').textContent = myTurn() ? 'Your turn' : `${cur.name}'s turn${state.seats[g.turn]?.connected ? '' : ' (away)'}`;
  }
  $('resign').hidden = mySeat === null || g.phase === 'over' || g.players[mySeat]?.out;
  const box = $('actions');
  box.replaceChildren();
  if (g.phase === 'over') {
    if (mySeat !== null) box.append(el('button', { onclick: () => send({ t: 'again' }) }, 'Play again with this table'));
    return;
  }
  if (!myTurn()) return;
  const me = g.players[mySeat];
  const sq = rules.squares[me.pos];
  if (g.phase === 'roll') box.append(el('button', { onclick: () => actNow({ a: 'roll' }) }, 'Roll the dice'));
  if (g.phase === 'buy') {
    const label = sq.kind === 'transport' ? sq.name : sq.name;
    box.append(el('p', {}, `${label} is for sale at ${money(sq.price)}. Your company has ${money(me.cash)}.`));
    if (sq.kind === 'land' && g.zoningRow.length) {
      box.append(el('p', { class: 'small' }, 'Buying it takes one of the available zoning cards:'));
      const row = el('div', { class: 'row' });
      g.zoningRow.forEach((z, i) => row.append(el('button', { onclick: () => actNow({ a: 'buy', zone: i }) }, `Buy as ${rules.zones[z].name}`)));
      box.append(row);
    } else {
      box.append(el('button', { onclick: () => actNow({ a: 'buy' }) }, `Buy for ${money(sq.price)}`));
    }
    box.append(el('button', { class: 'secondary', onclick: () => actNow({ a: 'pass' }) }, 'Pass'));
  }
  if (g.phase === 'act') {
    const row = el('div', { class: 'row' });
    row.append(el('button', { onclick: () => actNow({ a: 'end' }) }, 'End turn'));
    row.append(el('button', { class: 'secondary', disabled: me.personalCash < rules.config.personalAssetPrice, onclick: () => actNow({ a: 'personal' }) },
      `Buy a personal asset (${money(rules.config.personalAssetPrice)})`));
    box.append(row);
    box.append(amountForm('Pay yourself', `Moves company cash to your personal cash, less ${Math.round(rules.config.personalTax * 100)}% personal tax.`, (amount) => actNow({ a: 'pay', amount })));
    if (me.sale && me.inventory > 0) box.append(saleControls(me));
    if (me.atBank) box.append(amountForm('Borrow', `The Bank lends up to ${money(rules.config.loanLimit)} in total at ${Math.round(rules.config.loanInterest * 100)}% a year.`, (amount) => actNow({ a: 'borrow', amount })));
    if (me.balance.liabilities.loan > 0) box.append(amountForm('Repay loan', `You owe ${money(me.balance.liabilities.loan)}.`, (amount) => actNow({ a: 'repay', amount })));
    box.append(el('p', { class: 'small' }, 'To build, tap one of your zoned squares on the board.'));
  }
}

// Landing on a Retail square: your own offers special sales; someone else's lets you sell through it.
function saleControls(me) {
  const g = state.game;
  const tile = g.tiles[me.sale.pos];
  const owner = g.players[tile.owner];
  const box = el('div', { class: 'sale' });
  if (tile.owner === mySeat) {
    const { units, price } = me.retail;
    box.append(el('p', {}, `Your store at ${rules.squares[me.sale.pos].name}: run a sale this turn?`));
    const row = el('div', { class: 'row' });
    for (const [id, s] of Object.entries(rules.retail.sales)) {
      row.append(el('button', { class: 'secondary', onclick: () => actNow({ a: 'sell', option: id }) },
        `${s.name}: up to ${Math.round(units * s.volume).toLocaleString('en-US')} widgets at $${(price * s.price).toFixed(2)}`));
    }
    box.append(row);
  } else {
    const units = Math.round(tile.building.cost * rules.retail.perTurn);
    box.append(el('button', { class: 'secondary', onclick: () => actNow({ a: 'sell' }) },
      `Sell up to ${units.toLocaleString('en-US')} widgets through ${owner.name}'s store at $${owner.retail.price.toFixed(2)} (they keep ${Math.round(rules.retail.commission * 100)}%)`));
  }
  return box;
}

function placesText(me) {
  const g = state.game;
  const where = g.tiles.map((t, pos) => ({ t, pos })).filter(({ t }) => t?.owner === mySeat && t.stock > 0);
  return where.map(({ t, pos }) => `${t.stock.toLocaleString('en-US')} at ${rules.squares[pos].name}`).join(', ');
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
  const head = el('tr', {}, ...['', 'Company cash', 'Personal cash', 'Portfolio', 'Net worth', 'Year'].map((h) => el('th', {}, h)));
  const rows = g.players.map((p, i) =>
    el('tr', { class: `${p.out ? 'out' : ''} ${i === g.turn ? 'current' : ''}` },
      el('td', {}, el('span', { class: 'dot', style: { background: COLORS[i] } }), `${p.name}${i === mySeat ? ' (you)' : ''}${p.out ? ' · out' : p.skip ? ' · at CPE' : ''}${state.seats[i]?.connected ? '' : ' · away'}`),
      el('td', {}, money(p.cash)),
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
    return;
  }
  const sq = rules.squares[selected];
  const tile = g.tiles[selected];
  const box = [];
  if (sq.kind === 'land') {
    const set = rules.sets[sq.set];
    $('tile-title').textContent = sq.name;
    box.push(el('p', {}, `${set.name} set of ${set.size}${set.placeholder ? ' (placeholder colour)' : ''}. Price ${money(sq.price)}.`));
  } else if (sq.kind === 'transport') {
    $('tile-title').textContent = sq.name;
    box.push(el('p', {}, `${rules.modes[sq.mode].name}. Price ${money(sq.price)}. Rent doubles for each other ${rules.modes[sq.mode].name.toLowerCase()} tile the owner holds.`));
  } else if (sq.kind === 'deck') {
    $('tile-title').textContent = DECK_NAMES[sq.deck];
    box.push(el('p', {}, sq.deck === 'personal' ? 'Land here to draw a free Personal Assets card.' : `Land here to draw a ${DECK_NAMES[sq.deck]} card.`));
  } else {
    $('tile-title').textContent = CORNER_NAMES[sq.kind][1];
    box.push(el('p', {}, {
      fye: 'Passing or landing here closes your fiscal year: core revenue, PP&E operations, depreciation, interest, tax, spouse costs, then statements.',
      bank: `Land here to borrow up to ${money(rules.config.loanLimit)} at ${Math.round(rules.config.loanInterest * 100)}% a year.`,
      cpe: 'Landing here means a turn out for Continuing Professional Education.',
      review: `An audit. Every fraud you have played since your last review costs ${money(rules.config.fraudFine)} and sends you to CPE.`,
    }[sq.kind]));
  }
  if (tile) {
    if (tile.owner === null) box.push(el('p', { class: 'small' }, 'Owned by the bank.'));
    else {
      box.push(el('p', {}, `Owner: ${g.players[tile.owner].name}. Rent: ${money(tile.rent)}.`));
      if (tile.zone) box.push(el('p', { class: 'small' }, `Zoned ${rules.zones[tile.zone].name}.`));
      if (tile.building) {
        const r = rules.rarities[tile.building.rarity];
        box.push(el('p', { class: 'small' }, `${r.name} PP&E, cost ${money(tile.building.cost)}, book value ${money(tile.building.cost - tile.building.dep)}.`));
        if (tile.stock) box.push(el('p', { class: 'small' }, `${tile.stock.toLocaleString('en-US')} widgets ${tile.zone === 'retail' ? 'on the shelves' : 'waiting to be collected'}.`));
      }
    }
    if (tile.owner === mySeat && myTurn() && g.phase === 'act' && sq.kind === 'land' && tile.zone && !tile.building) {
      const z = rules.zones[tile.zone];
      box.push(el('p', { class: 'small' }, zoneText(tile.zone)));
      const row = el('div', { class: 'row' });
      const extras = g.players[mySeat].bankOptions ?? [];
      [...g.ppeRow, ...extras].forEach((r, i) => row.append(el('button', { class: i >= g.ppeRow.length ? 'secondary' : '', onclick: () => actNow({ a: 'build', pos: selected, card: i }) },
        `Build ${rules.rarities[r].name} (${money(rules.rarities[r].price)})${i >= g.ppeRow.length ? ' · bank option' : ''}`)));
      if (!g.ppeRow.length && !extras.length) row.append(el('span', { class: 'small' }, 'The PP&E deck is empty.'));
      box.push(row);
    }
  }
  $('tile').replaceChildren(...box);
}

function zoneText(id) {
  const z = rules.zones[id];
  const pct = (x) => `${Math.round(x * 100)}%`;
  const yearly = {
    industrial: `each fiscal year spends ${pct(z.produce)} of its cost making widgets`,
    retail: `at the end of each of your turns sells your widgets, up to ${pct(rules.retail.perTurn)} of its cost in widgets. More stores raise your price per widget. Landing on it lets you run a special sale`,
    residential: `each fiscal year collects tenant rent of ${pct(z.yearly)} of its cost`,
    banking: `each fiscal year earns ${pct(z.interest)} interest on your company's cash plus fees of ${pct(z.yearly)} of its cost`,
  }[id];
  return `${z.name} PP&E charges visitors ${pct(z.rent)} of its cost, and ${yearly}.`;
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
      el('span', { class: 'small' }, `${fraud ? 'Fraud' : 'Market Forces'}${card.placeholder ? ' · placeholder' : ''}`),
      el('p', {}, card.text));
    if (myTurn() && g.phase === 'act') node.append(playControls(id, i));
    return node;
  });
  if (me.frauds) cards.push(el('p', { class: 'small warn' }, `${me.frauds} fraud${me.frauds > 1 ? 's' : ''} committed since your last Interim Review.`));
  $('hand').replaceChildren(...(cards.length ? cards : [el('p', { class: 'small' }, 'No cards.')]));

  const assets = me.assets.map((id) => el('span', { class: 'chip', title: rules.personal[id].text ?? '' }, `${rules.personal[id].name} ${money(rules.personal[id].value)}`));
  const r = me.retail;
  $('widgets').replaceChildren(
    el('p', {}, `${Math.floor(me.inventory).toLocaleString('en-US')} widgets: ${widgetText(me.inventory)}.`),
    el('p', { class: 'small' }, `${me.carried.toLocaleString('en-US')} on your token. ${placesText(me)}`),
    el('p', { class: 'small' }, 'Your token picks widgets up at your factories and drops them at your stores as it passes. Passing a transport tile ships them to your stores on that side of the board (freight is charged on other players\' lines).'),
    el('p', { class: 'small' }, r.stores
      ? `Your ${r.stores} store${r.stores > 1 ? 's' : ''} sell up to ${r.units.toLocaleString('en-US')} a turn at $${r.price.toFixed(2)} each.`
      : 'You have no Retail stores. Land on someone else\'s to sell through it, or build one.'),
  );
  $('assets').replaceChildren(
    el('p', { class: 'small' }, `Portfolio ${money(me.portfolio)} of the ${money(rules.config.portfolioGoal)} goal.`),
    el('div', { class: 'chips' }, assets),
  );
}

function playControls(id, i) {
  const g = state.game;
  const play = (extra = {}) => actNow({ a: 'play', card: i, ...extra });
  if (id === 'alienation') {
    const others = g.players.map((p, j) => ({ p, j })).filter(({ p, j }) => j !== mySeat && !p.out);
    return el('div', { class: 'row' }, others.map(({ p, j }) => el('button', { class: 'secondary', onclick: () => play({ target: j }) }, `Use on ${p.name}`)));
  }
  if (id === 'contractor') {
    const counts = g.ppeDeckCounts;
    const ok = selected !== null && g.tiles[selected]?.owner === mySeat && g.tiles[selected].zone && !g.tiles[selected].building;
    if (!ok) return el('p', { class: 'small' }, 'Select one of your zoned, empty squares first.');
    return el('div', { class: 'row' }, Object.keys(counts).map((r) =>
      el('button', { class: 'secondary', onclick: () => play({ pos: selected, rarity: r }) },
        `${rules.rarities[r].name} ×${counts[r]} (${money(rules.rarities[r].price * 0.9)})`)));
  }
  if (id === 'embezzle') return amountForm('Embezzle', 'Up to $2,000.', (amount) => play({ amount }));
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
