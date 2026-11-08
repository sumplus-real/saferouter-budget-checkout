import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { URL } from 'node:url';
import { lockStore } from './store.mjs';
import { advance, newBatch } from './checkout.mjs';
import { modelFromEnv } from './model.mjs';
import { fixturePayPal } from './fixture-paypal.mjs';
import { failure, invariant, paypalFromEnv } from './paypal.mjs';
import { createSigningKey } from './receipt.mjs';

const port = Number(process.env.PORT || 4188);
invariant(Number.isInteger(port) && port > 0 && port <= 65535, 'Invalid port');
const origin = `http://127.0.0.1:${port}`;
const paymentMode = process.env.PAYMENT_MODE || 'fixture';
invariant(['fixture', 'paypal-sandbox'].includes(paymentMode), 'Invalid payment mode');
if (paymentMode === 'paypal-sandbox') {
  try {
    invariant((statSync('.env').mode & 0o077) === 0, 'Restrict .env to owner access (0600)');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
const model = modelFromEnv();
const sandbox = paymentMode === 'paypal-sandbox' ? paypalFromEnv() : undefined;
const store = lockStore(process.env.SAFEROUTER_STORE || `.runtime/app-${paymentMode}`);
let state;
try {
  state = store.read();
  state.signing ??= createSigningKey();
  store.save(state);
} catch (error) {
  store.close();
  throw error;
}
const save = () => store.save(state);
const api = sandbox ?? fixturePayPal(state, save);
const busy = new Map();
const directory = new URL('../public/', import.meta.url);
const staticFiles = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.mjs', ['app.mjs', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']],
  ['/verifier', ['verifier.html', 'text/html']],
  ['/verifier-ui.mjs', ['verifier-ui.mjs', 'text/javascript']],
  ['/verify.mjs', ['verify.mjs', 'text/javascript']],
]);

const headers = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

function reply(response, status, data, type = 'application/json') {
  response.writeHead(status, { ...headers, 'Content-Type': type + '; charset=utf-8' });
  response.end(type === 'application/json' ? JSON.stringify(data) : data);
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    invariant(length <= 48_000, 'Input exceeds 48 KB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function view(batch) {
  const { id, quote, rows, stage, reservedTokens, lastError, payment, receipt } = batch;
  return {
    id, quote, rows, stage, reservedTokens, lastError, hasReceipt: Boolean(receipt), busy: busy.has(id),
    payment: {
      mode: payment.mode, approvalUrl: payment.approvalUrl, orderId: payment.orderId,
      orderStatus: payment.orderStatus, authorizationId: payment.authorizationId, authorizationStatus: payment.authorizationStatus,
      captureId: payment.captureId, captureStatus: payment.captureStatus, outcome: payment.outcome,
    },
  };
}

function start(batch, action) {
  invariant(!busy.has(batch.id), 'Batch is already executing');
  if (action !== 'order') invariant(batch.payment.orderId || action === 'cancel', 'Create the order first');
  const task = Promise.resolve().then(async () => {
    delete batch.lastError;
    save();
    await advance(batch, action, api, model, save, state.signing.privateKey);
  }).catch((error) => {
    batch.lastError = failure(error);
    save();
  }).finally(() => busy.delete(batch.id));
  busy.set(batch.id, task);
}

const server = createServer(async (request, response) => {
  try {
    invariant(request.headers.host === `127.0.0.1:${port}`, 'Unexpected host');
    const { pathname } = new URL(request.url, origin);
    if (request.method === 'POST') {
      invariant(request.headers.origin === origin && request.headers['x-saferouter'] === '1' &&
        request.headers['content-type'] === 'application/json', 'Use the same-origin checkout client');
    }
    if (request.method === 'GET') {
      const file = staticFiles.get(pathname) ?? (/^\/(return|cancel)\/[a-f0-9-]{36}$/.test(pathname) ? staticFiles.get('/') : undefined);
      if (file) return reply(response, 200, readFileSync(new URL(file[0], directory)), file[1]);
      if (pathname === '/sample') return reply(response, 200, JSON.parse(readFileSync(new URL('../fixtures/ten-products.json', import.meta.url), 'utf8')));
      if (pathname === '/api/config') return reply(response, 200, { paymentMode, model: model.label, modelMode: model.mode, publicKey: state.signing.publicKey });
    }
    if (request.method === 'POST' && pathname === '/api/batches') {
      const body = await readJson(request);
      const batch = await newBatch(body.input, { model, paymentMode, origin, controlledFaults: body.controlledFaults });
      state.batches[batch.id] = batch;
      save();
      return reply(response, 201, view(batch));
    }
    const match = /^\/api\/batches\/([a-f0-9-]{36})(?:\/(order|run|cancel|receipt))?$/.exec(pathname);
    const batch = match && state.batches[match[1]];
    if (!batch) return reply(response, 404, { error: 'Not found' });
    const action = match[2];
    if (request.method === 'GET' && !action) return reply(response, 200, view(batch));
    if (request.method === 'GET' && action === 'receipt' && batch.receipt) return reply(response, 200, batch.receipt);
    if (request.method === 'POST' && ['order', 'run', 'cancel'].includes(action)) {
      if (busy.has(batch.id)) return reply(response, 409, { error: 'Batch is already executing' });
      start(batch, action);
      return reply(response, 202, view(batch));
    }
    reply(response, 404, { error: 'Not found' });
  } catch (error) {
    reply(response, 400, { error: failure(error).message });
  }
});

server.on('error', (error) => { console.error(error.message); store.close(); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`SafeRouter Budget Checkout at ${origin} · ${paymentMode} · ${model.mode}`));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  await Promise.allSettled(busy.values());
  store.close();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
