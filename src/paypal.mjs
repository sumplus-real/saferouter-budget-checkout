import { createHash } from 'node:crypto';

export const SANDBOX = 'https://api-m.sandbox.paypal.com';
const orders = '/v2/checkout/orders';
const authorizations = '/v2/payments/authorizations';
const captures = '/v2/payments/captures';

export function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function usd(cents) {
  invariant(Number.isSafeInteger(cents) && cents >= 0 && cents <= 50, 'Invalid sandbox amount');
  return { currency_code: 'USD', value: (cents / 100).toFixed(2) };
}

export function matchMoney(amount, cents) {
  const expected = usd(cents);
  return amount?.currency_code === expected.currency_code && amount?.value === expected.value;
}

export function resourceId(value) {
  invariant(typeof value === 'string' && /^[a-z0-9-]{1,64}$/i.test(value), 'Invalid PayPal resource ID');
  return value;
}

const safeCode = (value) => typeof value === 'string' && /^[A-Z0-9_]{1,100}$/.test(value) ? value : undefined;
const safeDebugId = (value) => typeof value === 'string' && /^[0-9a-f]{8,32}$/i.test(value) ? value : undefined;

export class PayPalError extends Error {
  constructor(stage, http, body, headers) {
    const name = body?.name || (body?.error === 'invalid_client' ? 'INVALID_CLIENT' : undefined);
    const codes = (Array.isArray(body?.details) ? body.details : []).map((detail) => safeCode(detail?.issue)).filter(Boolean);
    super([stage, `HTTP ${http}`, safeCode(name), ...codes].filter(Boolean).join(' · '));
    this.stage = stage;
    this.http = http;
    this.codes = [safeCode(name), ...codes].filter(Boolean);
    this.debugId = safeDebugId(body?.debug_id || headers?.get('paypal-debug-id'));
  }
}

export function failure(error) {
  if (error instanceof PayPalError) {
    return { message: error.message, stage: error.stage, http: error.http, codes: error.codes, debugId: error.debugId };
  }
  return { message: error.message };
}

export function approvalLink(order) {
  const href = order.links?.find(({ rel }) => rel === 'payer-action' || rel === 'approve')?.href;
  if (!href) return undefined;
  const url = new URL(href);
  invariant(url.origin === 'https://www.sandbox.paypal.com' || url.origin === 'https://sandbox.paypal.com', 'Unexpected approval host');
  invariant(!url.username && !url.password && url.searchParams.get('token') === order.id, 'Approval link does not match order');
  return url.href;
}

export function unitFor(order, orderId, reference, cents) {
  invariant(order.id === orderId && order.intent === 'AUTHORIZE' && order.purchase_units?.length === 1, 'Order does not match frozen checkout');
  const unit = order.purchase_units[0];
  invariant(unit.reference_id === reference && matchMoney(unit.amount, cents), 'Order amount or reference mismatch');
  return unit;
}

export function captureMatches(capture, id, authorizationId, orderId, reference, cents) {
  const upLink = capture.links?.find(({ rel }) => rel === 'up')?.href;
  const related = capture.supplementary_data?.related_ids;
  invariant(capture.id === id && matchMoney(capture.amount, cents) && capture.final_capture === true, 'Capture ID, amount or final flag mismatch');
  if (capture.invoice_id !== undefined) invariant(capture.invoice_id === reference, 'Capture invoice mismatch');
  if (related?.authorization_id !== undefined) invariant(related.authorization_id === authorizationId, 'Capture authorization mismatch');
  if (related?.order_id !== undefined) invariant(related.order_id === orderId, 'Capture order mismatch');
  const linked = upLink === `${SANDBOX}${authorizations}/${authorizationId}`;
  invariant(linked || related?.authorization_id === authorizationId || related?.order_id === orderId, 'Capture lacks a matching PayPal parent');
}

export function paypalFromEnv(env = process.env) {
  const clientId = env.PAYPAL_SANDBOX_CLIENT_ID;
  const secret = env.PAYPAL_SANDBOX_CLIENT_SECRET;
  invariant(clientId && secret, 'Project PayPal Sandbox app credentials are missing');
  return new PayPalSandbox({ clientId, secret });
}

export class PayPalSandbox {
  mode = 'paypal-sandbox';
  #access;
  #expires = 0;
  #basic;
  #fetch;

  constructor({ clientId, secret, fetchImpl = fetch }) {
    this.accountBinding = createHash('sha256').update(clientId).digest('hex');
    this.#basic = Buffer.from(`${clientId}:${secret}`).toString('base64');
    this.#fetch = fetchImpl;
  }

  async #send(stage, path, options) {
    let response;
    let data;
    try {
      response = await this.#fetch(SANDBOX + path, {
        ...options, redirect: 'error', signal: AbortSignal.timeout(12_000),
      });
      const raw = await response.text();
      data = raw ? JSON.parse(raw) : undefined;
    } catch {
      if (response && !response.ok) throw new PayPalError(stage, response.status, undefined, response.headers);
      throw new Error(`${stage}: PayPal response unavailable; recover existing operation`);
    }
    if (!response.ok) throw new PayPalError(stage, response.status, data, response.headers);
    return data;
  }

  async #token() {
    if (Date.now() < this.#expires && this.#access) return this.#access;
    const data = await this.#send('merchant OAuth', '/v1/oauth2/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${this.#basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    invariant(typeof data?.access_token === 'string' && Number.isFinite(data.expires_in), 'Invalid PayPal OAuth response');
    this.#access = data.access_token;
    this.#expires = Date.now() + Math.max(0, data.expires_in - 60) * 1000;
    return this.#access;
  }

  async #request(stage, path, method = 'GET', body, key) {
    const headers = { Authorization: `Bearer ${await this.#token()}`, Prefer: 'return=representation' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (key) headers['PayPal-Request-Id'] = key;
    try {
      return await this.#send(stage, path, { method, headers, body: JSON.stringify(body) });
    } catch (error) {
      if (error.http === 401) this.#expires = 0;
      throw error;
    }
  }

  create({ reference, cents, returnUrl, cancelUrl, key }) {
    invariant(cents > 0 && key, 'Missing frozen order parameters');
    return this.#request('create order', orders, 'POST', {
      intent: 'AUTHORIZE',
      purchase_units: [{ reference_id: reference, amount: usd(cents), description: 'SafeRouter product-card batch budget' }],
      payment_source: { paypal: { experience_context: {
        shipping_preference: 'NO_SHIPPING', landing_page: 'LOGIN', user_action: 'CONTINUE',
        return_url: returnUrl, cancel_url: cancelUrl,
      } } },
    }, key);
  }

  order(id) {
    return this.#request('read order', `${orders}/${resourceId(id)}`);
  }

  authorize(id, key) {
    return this.#request('authorize order', `${orders}/${resourceId(id)}/authorize`, 'POST', {}, key);
  }

  authorization(id) {
    return this.#request('read authorization', `${authorizations}/${resourceId(id)}`);
  }

  capture(authorizationId, cents, maxCents, reference, key) {
    invariant(cents > 0 && cents <= maxCents && key, 'Capture exceeds frozen approved maximum');
    usd(maxCents);
    return this.#request('capture authorization', `${authorizations}/${resourceId(authorizationId)}/capture`, 'POST',
      { amount: usd(cents), final_capture: true, invoice_id: reference }, key);
  }

  readCapture(id) {
    return this.#request('read capture', `${captures}/${resourceId(id)}`);
  }

  void(id) {
    return this.#request('void authorization', `${authorizations}/${resourceId(id)}/void`, 'POST');
  }
}
