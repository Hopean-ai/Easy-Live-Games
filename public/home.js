// Home page: sign in (or pick a guest name), then choose a game. Accounts live on the server
// behind an HttpOnly cookie; a guest is just a name kept in this browser. Names are only ever put
// on the page with textContent.
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

let games = [];
let account = null;
let admin = false;

// Invite links used to point at the home page; send them on to the game.
const oldInvite = params.get('room');
if (oldInvite && /^[A-Za-z0-9]{4,12}$/.test(oldInvite)) location.replace(`/pong?room=${oldInvite}`);

async function init() {
  const [me, list] = await Promise.all([getJson('/api/me'), getJson('/api/games')]);
  account = me?.name ?? null;
  admin = Boolean(me?.admin);
  games = list?.games ?? [];
  $('guest-name').value = localStorage.getItem('guest-name') || localStorage.getItem('pong-name') || '';
  render();
}

function render() {
  const guest = localStorage.getItem('guest-name');
  const name = account || guest;
  if (name && goNext()) return;
  $('auth').hidden = Boolean(name);
  $('pick').hidden = !name;
  if (!name) return;
  $('who').textContent = name;
  $('who-guest').hidden = Boolean(account);
  $('who-admin').hidden = !(account && admin);
  $('logout').textContent = account ? 'Log out' : 'Sign in instead';
  $('games').replaceChildren(...games.map(gameCard));
}

function gameCard(game) {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.className = 'game';
  a.href = game.page;
  const title = document.createElement('strong');
  title.textContent = game.name;
  const blurb = document.createElement('span');
  blurb.textContent = game.blurb;
  const players = document.createElement('span');
  players.className = 'small';
  players.textContent = `${game.players} players`;
  a.append(title, blurb, players);
  li.append(a);
  return li;
}

// After signing in, return to the game page that sent us here (only ever one of our own).
function goNext() {
  const next = params.get('next');
  if (!next) return false;
  const url = new URL(next, location.origin);
  if (url.origin !== location.origin || !games.some((g) => g.page === url.pathname)) return false;
  location.replace(url.pathname + url.search);
  return true;
}

$('account-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const mode = e.submitter?.value === 'register' ? 'register' : 'login';
  $('auth-error').textContent = '';
  try {
    const res = await fetch(`/api/${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('username').value.trim(), password: $('password').value }),
    });
    const body = await res.json();
    if (!res.ok) {
      $('auth-error').textContent = body.error || 'That did not work. Try again.';
      return;
    }
    account = body.name;
    $('password').value = '';
    render();
  } catch {
    $('auth-error').textContent = 'Could not reach the server. Try again.';
  }
});

$('guest-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('guest-name').value.trim();
  if (!name) return;
  localStorage.setItem('guest-name', name);
  render();
});

$('logout').addEventListener('click', async () => {
  localStorage.removeItem('guest-name');
  if (account) {
    await fetch('/api/logout', { method: 'POST' }).catch(() => {});
    account = null;
  }
  render();
});

async function getJson(path) {
  try {
    const res = await fetch(path);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

init();
