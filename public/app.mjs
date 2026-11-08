const element = (id) => document.getElementById(id);
const money = (cents) => '$' + (cents / 100).toFixed(2);
const label = (name) => name.replaceAll('_', ' ').toLowerCase();
const terminal = ['settled', 'voided', 'closed'];
const post = { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SafeRouter': '1' } };
let batch;
let timer;
let config;
const openRows = new Set();
let previousRows = '';
let rowBatch;
let route = /^\/(return|cancel)\/([a-f0-9-]{36})$/.exec(location.pathname);
const currentBatch = () => route?.[2] ?? sessionStorage.getItem('saferouterBatch');

async function request(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error);
  return body;
}

function node(tag, text, className) {
  const el = document.createElement(tag);
  el.textContent = text;
  if (className) el.className = className;
  return el;
}

function showError(error) { element('error').textContent = error?.message ?? ''; }

function download(name, value, type) {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function cardView(card) {
  const box = node('div', '', 'card');
  if (typeof card.title === 'string') box.append(node('strong', card.title));
  if (typeof card.description === 'string') box.append(node('p', card.description));
  if (card.facts?.specification) {
    const { label: spec, value, unit } = card.facts.specification;
    if (typeof spec === 'string' && typeof unit === 'string' && [value, card.facts.priceCents, card.facts.stock].every(Number.isInteger)) {
      box.append(node('p', `${spec} ${value} ${unit} · price ${money(card.facts.priceCents)} · stock ${card.facts.stock}`, 'muted'));
    }
  }
  if (Array.isArray(card.sources) && card.sources.every((item) => typeof item === 'string')) box.append(node('p', 'Source fields: ' + card.sources.join(', '), 'muted'));
  return box;
}

function renderRows() {
  if (rowBatch !== batch.id) {
    rowBatch = batch.id;
    previousRows = '';
    openRows.clear();
  }
  const data = JSON.stringify(batch.rows);
  if (data === previousRows) return;
  previousRows = data;
  const list = element('rows');
  list.replaceChildren();
  for (const row of batch.rows) {
    const item = document.createElement('details');
    item.open = openRows.has(row.index);
    item.addEventListener('toggle', () => item.open ? openRows.add(row.index) : openRows.delete(row.index));
    const summary = node('summary', row.id ?? `Product ${row.index + 1}`);
    const fee = row.status === 'waiting' ? '—' : money(row.status === 'accepted' ? batch.quote.unitCents : 0);
    summary.append(node('span', `${row.status} · ${fee}`, `state ${row.status}`));
    item.append(summary);
    if (row.reason) item.append(node('p', label(row.reason), 'muted'));
    for (const attempt of row.attempts) {
      item.append(node('p', `Attempt ${attempt.number} · ${attempt.status}${attempt.reason ? ' · ' + label(attempt.reason) : ''}`, 'muted'));
      if (attempt.card?.title) item.append(cardView(attempt.card));
    }
    list.append(item);
  }
}

function render() {
  const { stage, busy, payment, quote, rows } = batch;
  const accepted = rows.filter(({ status }) => status === 'accepted').length;
  element('cap').textContent = money(quote.capCents);
  element('count').textContent = `${accepted} / ${rows.length}`;
  element('total').textContent = payment.outcome ? money(payment.outcome.cents) : stage === 'closed' ? '$0.00' : '—';
  const status = {
    quoted: 'Quote frozen. Create a buyer approval to continue.',
    approval: route?.[1] === 'return' ? 'Back from PayPal. Verify the buyer approval to begin.' : 'Awaiting buyer approval.',
    authorization_pending: 'PayPal has not confirmed a usable authorization.',
    running: 'Generating and validating product cards.',
    settling: 'Checking the original payment before finalizing.',
    settled: payment.mode === 'fixture' ? 'Simulated final capture recorded.' : 'PayPal final capture confirmed.',
    voided: payment.mode === 'fixture' ? 'Simulated authorization void recorded.' : 'PayPal authorization void confirmed. No charge.',
    closed: 'Batch closed before funds were authorized.',
  };
  element('status').textContent = batch.lastError?.message ?? status[stage];
  const data = [
    ['Mode', payment.mode === 'fixture' ? 'Simulated payment' : 'PayPal Sandbox'],
    ['Quote expires', new Date(quote.expiresAt).toLocaleTimeString()],
    ['Test faults', quote.controlledFaults ? 'Enabled' : 'Off'],
    ['Model reserve', `${batch.reservedTokens} / ${quote.tokenBudget} tokens`],
    ['Order', payment.orderStatus], ['Authorization', payment.authorizationStatus],
    ['Capture', payment.captureStatus],
    ['Order ID', payment.orderId], ['Authorization ID', payment.authorizationId], ['Capture ID', payment.captureId],
    ['PayPal issue', batch.lastError?.debugId],
  ];
  element('facts').replaceChildren(...data.filter(([, value]) => value).flatMap(([key, value]) => [node('dt', key), node('dd', value)]));
  element('order').hidden = stage !== 'quoted';
  element('approve').hidden = busy || stage !== 'approval' || !payment.approvalUrl;
  if (payment.approvalUrl) element('approve').href = payment.approvalUrl;
  element('run').hidden = stage === 'quoted' || terminal.includes(stage);
  element('run').textContent = stage === 'approval' ?
    (payment.mode === 'fixture' ? 'Simulate approval and run' : 'Verify approval and run') : 'Recover original payment';
  element('cancel').hidden = terminal.includes(stage);
  element('receipt').hidden = !batch.hasReceipt;
  element('key').hidden = !batch.hasReceipt;
  element('cards').hidden = !batch.hasReceipt || accepted === 0;
  for (const id of ['order', 'run', 'cancel']) element(id).disabled = busy;
  element('quote').disabled = busy || !terminal.includes(stage);
  renderRows();
  clearTimeout(timer);
  if (busy) timer = setTimeout(() => refresh(batch.id).catch(showError), 400);
}

async function refresh(id) {
  batch = await request('/api/batches/' + id);
  render();
}

function handle(id, callback, event = 'click') {
  element(id).addEventListener(event, () => Promise.resolve().then(() => {
    showError();
    return callback();
  }).catch(showError));
}

handle('sample', async () => { element('input').value = JSON.stringify(await request('/sample'), null, 2); });
handle('file', async () => {
  const file = element('file').files[0];
  if (!file) return;
  if (file.size > 48_000) throw new Error('Choose a JSON file under 48 KB');
  element('input').value = await file.text();
}, 'change');
handle('quote', async () => {
  if (route) {
    history.replaceState(null, '', '/');
    route = null;
  }
  batch = await request('/api/batches', {
    ...post, body: JSON.stringify({ input: JSON.parse(element('input').value), controlledFaults: element('faults').checked }),
  });
  sessionStorage.setItem('saferouterBatch', batch.id);
  render();
});
for (const action of ['order', 'run', 'cancel']) {
  handle(action, async () => {
    batch = await request(`/api/batches/${batch.id}/${action}`, post);
    render();
  });
}
handle('receipt', async () => download('saferouter-receipt.json',
  JSON.stringify(await request(`/api/batches/${batch.id}/receipt`), null, 2), 'application/json'));
handle('cards', () => download('saferouter-accepted-cards.json',
  JSON.stringify(batch.rows.filter(({ status }) => status === 'accepted').map(({ card }) => card), null, 2), 'application/json'));
handle('key', () => download('saferouter-public-key.txt', config.publicKey + '\n', 'text/plain'));
try {
  config = await request('/api/config');
  element('modes').append(node('span', config.paymentMode === 'fixture' ? 'PAYMENT · SIMULATED' : 'PAYMENT · PAYPAL SANDBOX', 'tag'),
    node('span', config.modelMode === 'fixture' ? 'MODEL · SIMULATED' : `MODEL · LOCAL ${config.model}`, 'tag'));
  if (currentBatch()) {
    sessionStorage.setItem('saferouterBatch', currentBatch());
    await refresh(currentBatch());
  }
} catch (error) { showError(error); }
