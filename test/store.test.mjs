import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lockStore } from '../src/store.mjs';
import { createOrder, newPayment } from '../src/payment.mjs';

test('reopening the durable journal preserves a lost create request and rejects a second writer', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'saferouter-store-'));
  let store;
  try {
    store = lockStore(directory);
    assert.throws(() => lockStore(directory), /Another writer/);
    const payment = newPayment('paypal-sandbox', 50, 'http://127.0.0.1:4188/', 'http://127.0.0.1:4188/');
    const requests = [];
    const api = { mode: 'paypal-sandbox', accountBinding: 'test-app', async create(args) {
      requests.push(args);
      if (requests.length === 1) throw new Error('lost after dispatch');
      return { id: 'ORIGINAL-ORDER' };
    } };
    await assert.rejects(() => createOrder(api, payment, () => store.save({ payment })), /lost after dispatch/);
    store.close();
    store = lockStore(directory);
    const recovered = store.read().payment;
    await createOrder(api, recovered, () => store.save({ payment: recovered }));
    assert.deepEqual(requests[1], requests[0]);
    assert.equal(recovered.orderId, 'ORIGINAL-ORDER');
    assert.equal(recovered.steps.create.attempts, 2);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
