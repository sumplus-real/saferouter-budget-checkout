import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { advance, newBatch } from '../src/checkout.mjs';
import { checkCard, fixtureCard, readRows, runCards, TOKEN_RESERVATION } from '../src/cards.mjs';
import { fixturePayPal } from '../src/fixture-paypal.mjs';
import { modelFromEnv } from '../src/model.mjs';
import { createSigningKey } from '../src/receipt.mjs';
import { canonical, verifyReceipt } from '../public/verify.mjs';
import { sign } from 'node:crypto';

const input = (file = 'ten-products') => JSON.parse(readFileSync(new URL(`../fixtures/${file}.json`, import.meta.url)));
const fixture = modelFromEnv({});
const origin = 'http://127.0.0.1:4188';

async function setup(rows = input(), controlledFaults = false) {
  const state = {};
  const save = () => {};
  const api = fixturePayPal(state, save);
  const key = createSigningKey();
  const batch = await newBatch(rows, { model: fixture, paymentMode: api.mode, origin, controlledFaults });
  const step = (action, driver = api, model = fixture) => advance(batch, action, driver, model, save, key.privateKey);
  return { state, api, key, batch, step };
}

test('controlled failure batch settles 8 of 10 at 40 of 50 cents and verifies', async () => {
  const { state, key, batch, step } = await setup(input(), true);
  await step('order');
  await step('run');
  assert.equal(batch.stage, 'settled');
  assert.equal(batch.payment.outcome.cents, 40);
  assert.equal(batch.rows[1].attempts[0].reason, 'FACT_MISMATCH');
  assert.equal(batch.rows[1].attempts[1].status, 'accepted');
  assert.deepEqual([batch.rows[2].status, batch.rows[9].status], ['rejected', 'rejected']);
  assert.equal(batch.reservedTokens, 13 * TOKEN_RESERVATION);
  assert.deepEqual(await verifyReceipt(batch.receipt, key.publicKey), {
    delivered: 8, totalCents: 40, capCents: 50, paymentMode: 'fixture', authorizationStatus: 'PARTIALLY_CAPTURED',
  });
  const receipt = structuredClone(batch.receipt);
  receipt.body.items[0].amountCents += 1;
  await assert.rejects(() => verifyReceipt(receipt, key.publicKey), /Signature mismatch/);
  receipt.signature = sign(null, Buffer.from(canonical(receipt.body)), key.privateKey).toString('base64');
  await assert.rejects(() => verifyReceipt(receipt, key.publicKey), /Billable item amount/);
  await assert.rejects(() => verifyReceipt(batch.receipt, createSigningKey().publicKey), /Signature mismatch/);
  const captureId = batch.payment.captureId;
  await step('run');
  await step('order');
  assert.equal(batch.payment.captureId, captureId);
  assert.equal(Object.keys(state.fixture).length, 1);
});

test('ordinary run has ten acceptances without prescribed failures', async () => {
  const { batch, step } = await setup();
  await step('order');
  await step('run');
  assert.equal(batch.payment.outcome.cents, 50);
  assert.equal(batch.rows.length, 10);
  assert.ok(batch.rows.every((row) => row.attempts.length === 1 && row.status === 'accepted'));
});

test('malformed, contradictory and injection-like source rows cause zero calls, zero captures and confirmed void', async () => {
  const { state, batch, step, key } = await setup(input('all-rejected'));
  await step('order');
  await step('run');
  assert.equal(batch.stage, 'voided');
  assert.deepEqual(batch.rows.map(({ reason }) => reason), ['INVALID_SOURCE', 'CONFLICTING_AVAILABILITY', 'INSTRUCTION_LIKE_SOURCE']);
  assert.equal(batch.reservedTokens, 0);
  assert.equal(state.fixture[batch.payment.orderId].capture, undefined);
  assert.equal((await verifyReceipt(batch.receipt, key.publicKey)).totalCents, 0);
});

test('fresh product values, IDs, unsupported claims and duplicate IDs are checked', () => {
  const product = { id: 'Z9-NOVEL', name: 'Plum Fiber Basket', specification: { label: 'Width', value: 39, unit: 'cm' }, priceCents: 2188, stock: 17, prohibited: ['bleach safe'] };
  assert.equal(readRows([product])[0].status, 'waiting');
  assert.equal(checkCard(fixtureCard(product), product), undefined);
  for (const [field, value] of [['id', 'X'], ['priceCents', 2189], ['stock', 18]]) {
    const changed = fixtureCard(product);
    changed.facts[field] = value;
    assert.equal(checkCard(changed, product), 'FACT_MISMATCH');
  }
  const badText = fixtureCard(product);
  badText.description = 'Bleach–safe fiber.';
  assert.equal(checkCard(badText, product), 'PROHIBITED_CLAIM');
  badText.description = 'New value ３９';
  assert.equal(checkCard(badText, product), 'UNVERIFIED_QUANTITY');
  const second = { ...product, id: product.id.toLowerCase() };
  assert.ok(readRows([product, second]).every((row) => row.reason === 'DUPLICATE_ID'));
});

test('lost capture response is reconciled by GET without another order or capture', async () => {
  const { state, api, batch, step } = await setup(input(), true);
  await step('order');
  let calls = 0;
  const driver = { ...api, async capture(...args) {
    calls += 1;
    await api.capture(...args);
    throw new Error('response lost');
  } };
  await assert.rejects(() => step('run', driver), /response lost/);
  assert.equal(batch.stage, 'settling');
  await step('order', driver);
  assert.equal(batch.stage, 'settling');
  assert.equal(batch.payment.captureId, undefined);
  await assert.rejects(() => step('cancel', driver), /Capture may be in progress/);
  await step('run', driver);
  assert.equal(batch.payment.outcome.cents, 40);
  assert.equal(calls, 1);
  assert.equal(Object.keys(state.fixture).length, 1);
});

test('failed capture dispatch retries once after GET with original request identifier and amount', async () => {
  const { api, batch, step } = await setup(input(), true);
  await step('order');
  const requests = [];
  const driver = { ...api, async capture(...args) {
    requests.push(args);
    if (requests.length === 1) throw new Error('response lost before commit');
    return api.capture(...args);
  } };
  await assert.rejects(() => step('run', driver), /response lost/);
  await step('run', driver);
  assert.equal(batch.payment.outcome.cents, 40);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
});

test('lost create response reuses the same request key and same order', async () => {
  const { state, api, batch, step } = await setup();
  const requests = [];
  const driver = { ...api, async create(args) {
    requests.push(args);
    const value = await api.create(args);
    if (requests.length === 1) throw new Error('create response lost');
    return value;
  } };
  await assert.rejects(() => step('order', driver), /response lost/);
  await step('order', driver);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(Object.keys(state.fixture).length, 1);
  assert.ok(batch.payment.orderId);
});

test('pending known capture is polled and never retried or voided', async () => {
  const { api, batch, step } = await setup();
  await step('order');
  let poll = 0;
  const driver = { ...api, async readCapture(id) {
    const value = await api.readCapture(id);
    return ++poll === 1 ? { ...value, status: 'PENDING' } : value;
  } };
  await assert.rejects(() => step('run', driver), /capture is not completed/);
  const captureId = batch.payment.captureId;
  await assert.rejects(() => step('cancel', driver), /Capture may be in progress/);
  await step('run', driver);
  assert.equal(batch.payment.captureId, captureId);
  assert.equal(batch.payment.steps.capture.attempts, 1);
});

test('deadline during model generation voids without capture', async () => {
  const { api, batch, step } = await setup();
  await step('order');
  const originalNow = Date.now;
  let afterDeadline = false;
  Date.now = () => afterDeadline ? batch.quote.expiresAt + 1 : originalNow();
  try {
    await step('run', api, { ...fixture, async generate(source) {
      afterDeadline = true;
      return fixture.generate(source);
    } });
  } finally {
    Date.now = originalNow;
  }
  assert.equal(batch.stage, 'voided');
  assert.equal(batch.payment.steps.capture, undefined);
  assert.equal(batch.rows[0].status, 'cancelled');
});

test('token breach stops later dispatch and a journaled interrupted row stays uncharged', async () => {
  const { batch } = await setup(input().slice(0, 3));
  batch.reservedTokens = TOKEN_RESERVATION;
  batch.rows[0].attempts.push({ number: 1, status: 'dispatched', reservedTokens: TOKEN_RESERVATION });
  let calls = 0;
  await runCards(batch, { ...fixture, async generate(source) {
    calls += 1;
    return { card: fixtureCard(source), tokens: TOKEN_RESERVATION + 1 };
  } }, () => {}, { canContinue: () => !batch.modelStopped });
  assert.equal(calls, 1);
  assert.deepEqual(batch.rows.map(({ reason }) => reason), ['INTERRUPTED_ATTEMPT', 'MODEL_TOKEN_BOUND_EXCEEDED', 'BATCH_STOPPED']);
});

test('a lower token budget stops the next dispatch before work', async () => {
  const { batch } = await setup(input().slice(0, 2));
  batch.quote.tokenBudget = TOKEN_RESERVATION;
  await runCards(batch, fixture, () => {});
  assert.equal(batch.reservedTokens, TOKEN_RESERVATION);
  assert.equal(batch.rows[0].status, 'accepted');
  assert.equal(batch.rows[1].attempts.length, 0);
  assert.equal(batch.rows[1].reason, 'MODEL_BUDGET');
});

test('lost void response is read back on the same authorization with no capture', async () => {
  const { api, batch, step } = await setup(input('all-rejected'));
  await step('order');
  let calls = 0;
  const driver = { ...api, async void(id) {
    calls += 1;
    await api.void(id);
    throw new Error('void response lost');
  } };
  await assert.rejects(() => step('run', driver), /void response lost/);
  const authorization = batch.payment.authorizationId;
  await step('run', driver);
  assert.equal(batch.payment.authorizationId, authorization);
  assert.equal(batch.payment.outcome.kind, 'void');
  assert.equal(batch.payment.captureId, undefined);
  assert.equal(calls, 1);
});

test('unknown order cannot be recreated using a different merchant app', async () => {
  const { api, batch, step } = await setup();
  const first = { ...api, accountBinding: 'app-first', async create() { throw new Error('create response lost'); } };
  await assert.rejects(() => step('order', first), /response lost/);
  let called = false;
  const second = { ...api, accountBinding: 'app-second', async create() { called = true; } };
  await assert.rejects(() => step('order', second), /Restore the original PayPal Sandbox app/);
  assert.equal(batch.payment.steps.create.attempts, 1);
  assert.equal(called, false);
});

test('declared foreign-language title must change and the description cannot repeat the title', () => {
  const [source] = input('unseen-mixed');
  const card = fixtureCard(source);
  assert.equal(checkCard(card, source), 'TITLE_NOT_LOCALIZED');
  card.title = 'Plastic Storage Tray';
  assert.equal(checkCard(card, source), 'TITLE_TERMS_MISSING');
  card.title = 'Wicker Storage Basket';
  card.description = card.title;
  assert.equal(checkCard(card, source), 'DESCRIPTION_REPEATS_TITLE');
  card.description = 'A wicker basket for keeping everyday items together.';
  assert.equal(checkCard(card, source), undefined);
});
