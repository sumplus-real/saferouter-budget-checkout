import test from 'node:test';
import assert from 'node:assert/strict';
import { PayPalSandbox, SANDBOX, approvalLink, captureMatches, failure, usd } from '../src/paypal.mjs';

const order = 'ORDERTEST';
const authorization = 'AUTHTEST';
const key = 'a-test-operation-id';
const capture = 'CAPTURETEST';

test('PayPal wire shape, only sandbox URLs, stable request IDs and strict cap', async () => {
  const calls = [];
  const api = new PayPalSandbox({ clientId: 'test-client', secret: 'test-only', fetchImpl: async (url, options) => {
    calls.push({ url, method: options.method, headers: options.headers, body: options.body });
    if (url.endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'test-only-token', expires_in: 120 });
    if (url.endsWith('/void')) return new Response(null, { status: 204 });
    return Response.json({ id: order });
  } });
  await api.create({ reference: 'reference', cents: 50, returnUrl: 'http://127.0.0.1:4188/', cancelUrl: 'http://127.0.0.1:4188/', key });
  await api.order(order);
  await api.authorize(order, key);
  await api.authorization(authorization);
  assert.throws(() => api.capture(authorization, 51, 50, 'reference', key), /exceeds/);
  assert.throws(() => api.capture(authorization, 0, 50, 'reference', key), /exceeds/);
  await api.capture(authorization, 40, 50, 'reference', key);
  await api.readCapture(capture);
  await api.void(authorization);
  assert.equal(calls.length, 8);
  assert.ok(calls.every(({ url }) => url.startsWith(SANDBOX + '/')));
  assert.equal(calls[1].headers['PayPal-Request-Id'], key);
  assert.equal(JSON.parse(calls[1].body).intent, 'AUTHORIZE');
  assert.deepEqual(JSON.parse(calls[1].body).purchase_units[0].amount, usd(50));
  assert.deepEqual(JSON.parse(calls[5].body), { amount: usd(40), final_capture: true, invoice_id: 'reference' });
  assert.equal(calls[5].headers['PayPal-Request-Id'], key);
  assert.equal(calls[7].url, SANDBOX + '/v2/payments/authorizations/AUTHTEST/void');
});

test('PayPal errors retain stage, HTTP status, issue and debug ID without private response fields', async () => {
  const api = new PayPalSandbox({ clientId: 'test-client', secret: 'test-only', fetchImpl: async (url) =>
    url.endsWith('/token') ? Response.json({ access_token: 'test-only-token', expires_in: 120 }) :
      Response.json({ name: 'UNPROCESSABLE_ENTITY', debug_id: 'abcd0123', message: 'private payer detail', details: [
        { issue: 'AUTHORIZATION_DENIED', description: 'private payer detail' },
      ] }, { status: 422 }),
  });
  await assert.rejects(() => api.capture(authorization, 40, 50, 'reference', key), (error) => {
    assert.deepEqual(failure(error), {
      message: 'capture authorization · HTTP 422 · UNPROCESSABLE_ENTITY · AUTHORIZATION_DENIED',
      stage: 'capture authorization', http: 422, codes: ['UNPROCESSABLE_ENTITY', 'AUTHORIZATION_DENIED'], debugId: 'abcd0123',
    });
    return true;
  });
});

test('capture readback fails closed for unrelated resources or altered amounts', () => {
  const result = { id: capture, amount: usd(40), final_capture: true, invoice_id: 'reference',
    links: [{ rel: 'up', href: SANDBOX + '/v2/payments/authorizations/' + authorization }] };
  assert.doesNotThrow(() => captureMatches(result, capture, authorization, order, 'reference', 40));
  assert.throws(() => captureMatches(result, capture, 'OTHER', order, 'reference', 40), /matching PayPal parent/);
  assert.throws(() => captureMatches(result, capture, authorization, order, 'reference', 45), /amount/);
  assert.throws(() => approvalLink({ id: order, links: [{ rel: 'approve', href: 'https://www.paypal.com/checkoutnow?token=' + order }] }), /Unexpected approval host/);
});
