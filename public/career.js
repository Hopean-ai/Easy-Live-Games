// CFO Career: the page for one CFO's career. The server (src/career/office.js) runs the game and
// keeps the career on the account; this page shows the desk and sends back what the player does.
// Everything the game wrote is put on the page with textContent.
const $ = (id) => document.getElementById(id);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const BY = { you: 'Posted by you', pos: 'Posted by the POS system', bookkeeper: 'Posted by the bookkeeper' };

let state = null;
let busy = false;
let open = null; // the document whose entry form is showing
// The accounts last used for each kind of document, so a repeat entry starts with them filled in.
const patterns = {};

async function init() {
  const res = await fetch('/api/career/state');
  if (res.status === 401) {
    $('signin').hidden = false;
    $('signin-link').href = `/?next=${encodeURIComponent('/career')}`;
    return;
  }
  show(await res.json());
}

function show(next) {
  state = next;
  const run = state.run;
  $('intro').hidden = Boolean(run);
  $('game').hidden = !run;
  renderRecord();
  if (!run) return;
  for (const d of run.journal) if (d.posted?.by === 'you' && !patterns[d.kind]) patterns[d.kind] = shape(d.posted.lines);
  $('sub').textContent = `${run.stage.name} · Week ${run.weekInMonth} of ${run.month}, year ${run.year}`;
  renderBar(run);
  renderCard(run);
  renderDesk(run);
  renderReview(run);
  renderJournal(run);
  renderShop(run);
  renderProjects(run);
  renderBooks(run);
  renderGoal(run);
  renderLog(run);
}

function renderRecord() {
  const rows = state.record ?? [];
  $('record').replaceChildren(...rows.map((r) => li(`Stage ${r.stage}: ${r.result === 'graduated' ? 'completed' : 'replaced'}, score ${fmt(r.score)}`)));
}

function renderBar(run) {
  $('hours').textContent = `${run.hours} of ${run.hoursPerWeek}`;
  const meter = $('hours-meter');
  meter.style.width = `${Math.max(0, Math.min(100, (run.hours / run.hoursPerWeek) * 100))}%`;
  meter.className = run.hours < 5 ? 'low' : '';
  $('bank').textContent = money(run.bank);
  $('score').textContent = fmt(run.score);
  $('file').hidden = !run.canFile || run.over;
  $('file').textContent = `File ${run.month}'s books (${run.fileHours} h)`;
  $('file').disabled = run.hours < run.fileHours;
  $('end-week').hidden = run.over;
  $('end-week').disabled = Boolean(run.card);
  $('end-week').title = run.card ? 'Answer Sam first.' : '';
  $('ended').hidden = !run.over;
  if (run.over) {
    const won = run.result === 'graduated';
    $('ended-title').textContent = won ? 'Stage 1 complete' : 'The founders hired a new CFO';
    $('ended-text').textContent = won
      ? 'The company has the revenue and the books to raise money and grow. The growth stage is being built; your result is saved on your account.'
      : 'The company wasn\'t ready to grow in time.';
    $('ended-score').textContent = fmt(run.score);
    $('ended-missing').replaceChildren(...run.missing.map((m) => li(`Still needed: ${m}`)));
  }
}

function renderCard(run) {
  const card = run.card;
  $('card').hidden = !card;
  if (!card) return;
  $('card-title').textContent = card.title;
  $('card-text').textContent = card.text;
  $('choices').replaceChildren(...card.choices.map((c, i) => {
    const b = document.createElement('button');
    b.className = 'cc-choice';
    b.disabled = Boolean(c.off) || busy;
    b.append(span(c.label), span(c.off ? `${c.hint} ${c.off}` : c.hint, 'hint'));
    b.addEventListener('click', () => send({ type: 'choose', i }));
    return b;
  }));
}

function renderDesk(run) {
  $('desk-count').textContent = run.inbox.length ? `(${run.inbox.length} waiting)` : '';
  $('desk-empty').hidden = run.inbox.length > 0;
  $('inbox').replaceChildren(...run.inbox.map((d) => docItem(d, run)));
}

function renderJournal(run) {
  $('journal-empty').hidden = run.journal.length > 0;
  $('journal').replaceChildren(...run.journal.map((d) => docItem(d, run)));
}

function docItem(d, run) {
  const item = document.createElement('li');
  item.className = 'cc-doc';
  const head = document.createElement('header');
  head.append(span(d.title, 'title'), span(d.when, 'when'));
  item.append(head, para(d.text));
  if (d.posted) {
    item.append(linesTable(d.posted.lines, BY[d.posted.by] ?? null));
  }
  if (open === d.id) {
    item.append(entryForm(d, run));
  } else if (!run.over && (!d.posted || d.fixable)) {
    const row = document.createElement('div');
    row.className = 'row';
    const b = document.createElement('button');
    b.className = d.posted ? 'secondary' : '';
    b.textContent = d.posted ? `Fix (${d.hours} h)` : `Post (${d.hours} h)`;
    b.disabled = d.hours > run.hours || busy;
    b.addEventListener('click', () => {
      open = d.id;
      show(state);
    });
    row.append(b);
    item.append(row);
  }
  return item;
}

// A journal entry form: an account, a debit or a credit on each line.
function entryForm(d, run) {
  const form = document.createElement('form');
  form.className = 'cc-entry';
  const heads = document.createElement('div');
  heads.className = 'heads';
  heads.append(span('Account'), span('Debit'), span('Credit'), span(''));
  const rows = document.createElement('div');
  rows.className = 'cc-entry';
  const totals = para('', 'totals');
  const start = d.posted ? d.posted.lines.map((l) => ({ account: l.account, dr: l.dr || '', cr: l.cr || '' }))
    : (patterns[d.kind] ?? [{ side: 'dr' }, { side: 'cr' }]).map((p) => ({ account: p.account ?? '', dr: '', cr: '' }));
  const addLine = (l = { account: '', dr: '', cr: '' }) => {
    const line = document.createElement('div');
    line.className = 'line';
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Account');
    select.append(option('', 'Choose an account'));
    let group = null;
    for (const a of run.accounts) {
      if (group?.label !== typeLabel(a.type)) {
        group = document.createElement('optgroup');
        group.label = typeLabel(a.type);
        select.append(group);
      }
      group.append(option(a.name, a.name));
    }
    select.value = l.account;
    const debit = amountInput('Debit', l.dr);
    const credit = amountInput('Credit', l.cr);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'x';
    remove.textContent = '×';
    remove.setAttribute('aria-label', 'Remove line');
    remove.addEventListener('click', () => {
      if (rows.children.length > 2) line.remove();
      tally();
    });
    for (const input of [debit, credit]) input.addEventListener('input', tally);
    line.append(select, debit, credit, remove);
    rows.append(line);
  };
  const read = () => [...rows.children].map((line) => {
    const [select, debit, credit] = line.querySelectorAll('select, input');
    return { account: select.value, dr: Number(debit.value || 0), cr: Number(credit.value || 0) };
  });
  const tally = () => {
    const lines = read();
    const dr = lines.reduce((t, l) => t + l.dr, 0);
    const cr = lines.reduce((t, l) => t + l.cr, 0);
    totals.textContent = `Debits ${money(dr)} · Credits ${money(cr)}${Math.abs(dr - cr) > 0.005 ? ' · not balanced' : ''}`;
    totals.className = `totals${Math.abs(dr - cr) > 0.005 ? ' off' : ''}`;
  };
  start.forEach(addLine);
  tally();
  const buttons = document.createElement('div');
  buttons.className = 'row';
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'secondary';
  more.textContent = 'Add a line';
  more.addEventListener('click', () => {
    if (rows.children.length < 8) addLine();
  });
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'secondary';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => {
    open = null;
    show(state);
  });
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = d.posted ? `Re-post (${d.hours} h)` : `Post (${d.hours} h)`;
  buttons.append(submit, more, cancel);
  form.append(heads, rows, totals, buttons);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const lines = read().filter((l) => l.account || l.dr || l.cr);
    const ok = await send({ type: 'post', doc: d.id, lines });
    if (ok) {
      patterns[d.kind] = shape(lines);
      open = null;
      show(state);
    }
  });
  queueMicrotask(() => form.querySelector('select')?.focus());
  return form;
}

function renderReview(run) {
  const r = run.review;
  $('review-panel').hidden = !r;
  if (!r) return;
  $('review-month').textContent = `${r.month}, year ${r.year}`;
  const n = r.errors + r.missing;
  $('review-summary').textContent = n
    ? `${n} problem${n === 1 ? '' : 's'}${r.late ? ', and the books went in late' : ''}. Fix them before the year end, when the tax office fines whatever is still wrong.`
    : `Clean books${r.late ? ', but they went in late' : ''}.`;
  // Wrong entries are shown in full, beside the right one. Unposted documents are still on the
  // desk, so they're only counted here.
  const missing = r.found.filter((f) => f.problem === 'missing');
  const items = r.found.filter((f) => f.problem !== 'missing').map((f) => {
    const item = document.createElement('li');
    item.className = `cc-doc ${f.problem}`;
    const head = document.createElement('header');
    head.append(span(f.title, 'title'), span(f.when, 'when'));
    item.append(head, para(f.problem === 'wrong' ? 'Posted wrong.' : 'Fixed since.'));
    if (f.posted && f.problem === 'wrong') item.append(linesTable(f.posted, 'You posted'));
    item.append(linesTable(f.correct, 'The right entry'));
    return item;
  });
  if (missing.length) {
    const kinds = {};
    for (const f of missing) {
      const name = f.title.replace(/,.*$| \(.*$/, '');
      kinds[name] = (kinds[name] ?? 0) + 1;
    }
    const item = document.createElement('li');
    item.className = 'cc-doc missing';
    item.append(span(`Never posted: ${missing.length} document${missing.length === 1 ? '' : 's'}`, 'title'),
      para(Object.entries(kinds).map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(', ')));
    items.push(item);
  }
  $('review').replaceChildren(...items);
}

function renderShop(run) {
  const b = run.business;
  const rows = [
    ['Machines', `${b.machines} (${b.workers} worker${b.workers === 1 ? '' : 's'})`],
    ['Can make', `${fmt(b.capacity)} a week`],
    ['This week', `${fmt(b.sold)} sold of ${fmt(b.demand)} wanted`],
    ['Revenue this week', money(b.revenue)],
    ['Widgets in stock', fmt(b.stock)],
  ];
  if (b.payables) rows.push(['Owed to the supplier', money(b.payables)]);
  if (b.loan) rows.push(['Bank loan', money(b.loan)]);
  if (b.investorShare) rows.push(['Outside investors own', `${Math.round(b.investorShare * 100)}%`]);
  $('shop').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', k), el('dd', v)]));
}

function renderProjects(run) {
  $('projects').replaceChildren(...run.projects.map((p) => {
    const div = document.createElement('div');
    div.className = `cc-project${p.done ? ' done' : ''}`;
    div.append(el('strong', p.name), span(p.text, 'why'));
    if (p.done) {
      div.append(span('Done.', 'why'));
    } else {
      const b = document.createElement('button');
      b.className = p.toggle ? 'secondary' : '';
      b.textContent = p.toggle ? (run.delegates.review ? 'Stop' : 'Start') : `Do it (${p.hours} h)`;
      b.disabled = Boolean(p.off) || run.over || busy;
      b.addEventListener('click', () => send({ type: 'project', id: p.id }));
      div.append(b);
      if (p.off) div.append(span(p.off, 'why'));
    }
    return div;
  }));
}

function renderBooks(run) {
  const st = run.statements;
  const income = $('income');
  const head = document.createElement('tr');
  head.append(el('th', 'Income statement'), el('th', run.month, 'amt'), el('th', 'Year', 'amt'));
  const rows = st.income.filter((l) => l.year || l.month).map((l) => {
    const tr = document.createElement('tr');
    tr.className = l.type === 'expense' || l.contra ? 'sub' : '';
    const sign = l.type === 'expense' ? -1 : 1;
    tr.append(el('td', l.name), el('td', money(sign * (l.month ?? 0)), 'amt'), el('td', money(sign * l.year), 'amt'));
    return tr;
  });
  const total = document.createElement('tr');
  total.className = 'total';
  total.append(el('td', 'Profit'), el('td', money(st.monthProfit ?? 0), 'amt'), el('td', money(st.profit), 'amt'));
  income.replaceChildren(head, ...rows, total);

  const balance = $('balance');
  const bhead = document.createElement('tr');
  bhead.append(el('th', 'Balance sheet'), el('th', 'Now', 'amt'));
  const part = (type, title, extra = []) => {
    const lines = st.balance.filter((l) => l.type === type && l.amount).map((l) => row(l.name, l.amount, 'sub'));
    return [...lines, ...extra];
  };
  balance.replaceChildren(
    bhead,
    ...part('asset'), row('Total assets', st.assets, 'total'),
    ...part('liability'), row('Total liabilities', st.liabilities, 'total'),
    ...part('equity', 'Equity', [row('Profit this year', st.profit, 'sub')]), row('Total equity', st.equity, 'total'),
  );
}

function row(name, amount, cls) {
  const tr = document.createElement('tr');
  tr.className = cls;
  tr.append(el('td', name), el('td', money(amount), 'amt'));
  return tr;
}

function renderGoal(run) {
  const g = run.goal;
  $('goal').textContent = `By the end of the year: average revenue of ${money(g.revenue)} a month over the last ${g.months} months, no more than ${g.maxErrors} problems in the year's books, and money in the bank. You have ${g.years} years.`;
  $('filings').replaceChildren(...run.filings.map((f) => {
    const item = li(`${f.month.slice(0, 3)}${f.year > 1 ? ` y${f.year}` : ''}: ${f.problems ? `${f.problems} problem${f.problems === 1 ? '' : 's'}` : 'clean'}${f.late ? ', late' : ''}`);
    item.className = f.problems || f.late ? 'bad' : 'clean';
    return item;
  }));
}

function renderLog(run) {
  $('log').replaceChildren(...run.log.slice().reverse().map((entry) => {
    const item = document.createElement('li');
    const m = Math.floor((entry.week - 1) / run.weeksPerMonth);
    item.append(span(`Wk ${((entry.week - 1) % run.weeksPerMonth) + 1} ${MONTHS[m % 12]}`, 'when'), entry.text);
    return item;
  }));
}

async function send(action) {
  if (busy || !state?.run) return false;
  busy = true;
  $('error').textContent = '';
  const res = await postJson('/api/career/act', { ...action, turn: state.run.turn });
  busy = false;
  if (!res) {
    $('error').textContent = 'Could not reach the office. Try again.';
    return false;
  }
  if (res.run) show(res);
  if (res.error) {
    $('error').textContent = res.error;
    return false;
  }
  return true;
}

async function begin() {
  if (state?.run && !state.run.over && !confirm('Give up your current career and start again?')) return;
  const res = await postJson('/api/career/begin', {});
  if (res?.run) {
    open = null;
    show(res);
  }
}

$('begin').addEventListener('click', begin);
$('again').addEventListener('click', begin);
$('file').addEventListener('click', () => send({ type: 'file' }));
$('end-week').addEventListener('click', async () => {
  const waiting = state?.run?.inbox.length ?? 0;
  if (waiting && !confirm(`${waiting} document${waiting === 1 ? ' is' : 's are'} still on your desk. End the week anyway?`)) return;
  if (await send({ type: 'endWeek' })) {
    open = null;
    show(state);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
});

function shape(lines) {
  return lines.map((l) => ({ account: l.account, side: l.dr ? 'dr' : 'cr' }));
}

function typeLabel(type) {
  return { asset: 'Assets', liability: 'Liabilities', equity: 'Equity', revenue: 'Revenue', expense: 'Expenses' }[type];
}

function linesTable(lines, caption) {
  const table = document.createElement('table');
  table.className = 'cc-lines';
  if (caption) {
    const c = document.createElement('caption');
    c.textContent = caption;
    table.append(c);
  }
  for (const l of lines) {
    const tr = document.createElement('tr');
    tr.append(el('td', l.account, l.cr ? 'cr-acct' : ''), el('td', l.dr ? money(l.dr) : '', 'amt'), el('td', l.cr ? money(l.cr) : '', 'amt'));
    table.append(tr);
  }
  return table;
}

function amountInput(label, value) {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.step = '0.01';
  input.inputMode = 'decimal';
  input.placeholder = '0';
  input.setAttribute('aria-label', label);
  input.value = value;
  return input;
}

function option(value, text) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = text;
  return o;
}

function money(n) {
  const v = Math.round(n * 100) / 100;
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function fmt(n) {
  return Number(n ?? 0).toLocaleString('en-US');
}

function el(tag, text, cls) {
  const e = document.createElement(tag);
  e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

const span = (text, cls) => el('span', text, cls);
const para = (text, cls) => el('p', text, cls);
const li = (text) => el('li', text);

async function postJson(path, body) {
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await res.json();
  } catch {
    return null;
  }
}

init();
