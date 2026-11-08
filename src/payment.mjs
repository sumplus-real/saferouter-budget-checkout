import { randomUUID } from 'node:crypto';
import { approvalLink, captureMatches, invariant, matchMoney, resourceId, unitFor } from './paypal.mjs';

const replayWindowMs = 5 * 60_000;
const one = (values = []) => {
  invariant(Array.isArray(values) && values.length <= 1, 'Unexpected number of PayPal resources');
  return values[0];
};

export function newPayment(mode, capCents, returnUrl, cancelUrl) {
  return {
    mode, capCents, reference: randomUUID(), returnUrl, cancelUrl,
    keys: { create: randomUUID(), authorize: randomUUID(), capture: randomUUID() },
    steps: {},
  };
}

// Stamp before the wire call. Never mint a replacement request ID.
function begin(p, step, save) {
  const previous = p.steps[step];
  if (previous) {
    invariant(Date.now() >= previous.started && Date.now() - previous.started < replayWindowMs, 'Automatic replay window closed; reconcile the original PayPal operation');
    invariant(previous.attempts < 2, 'Replay limit reached; reconcile the original PayPal operation');
    previous.attempts += 1;
  } else {
    p.steps[step] = { started: Date.now(), attempts: 1 };
  }
  save();
}

function checkAccount(api, p) {
  invariant(api.mode === p.mode && api.accountBinding === p.accountBinding, 'Restore the original PayPal Sandbox app for this payment');
}

export async function createOrder(api, p, save) {
  if (!p.steps.create && !p.orderId) p.accountBinding = api.accountBinding;
  checkAccount(api, p);
  if (p.orderId) return;
  begin(p, 'create', save);
  const result = await api.create({
    reference: p.reference, cents: p.capCents, returnUrl: p.returnUrl, cancelUrl: p.cancelUrl, key: p.keys.create,
  });
  p.orderId = resourceId(result.id);
  save();
  p.approvalUrl = api.mode === 'fixture' ? undefined : approvalLink(result);
  save();
}

async function readOrder(api, p, save) {
  const order = await api.order(p.orderId);
  const unit = unitFor(order, p.orderId, p.reference, p.capCents);
  p.orderStatus = order.status;
  if (api.mode !== 'fixture' && !p.approvalUrl && ['CREATED', 'PAYER_ACTION_REQUIRED'].includes(order.status)) {
    p.approvalUrl = approvalLink(order);
  }
  save();
  return { order, authorization: one(unit.payments?.authorizations), capture: one(unit.payments?.captures) };
}

async function readAuthorization(api, p, save) {
  const a = await api.authorization(p.authorizationId);
  invariant(a.id === p.authorizationId && matchMoney(a.amount, p.capCents), 'PayPal authorization ID or amount mismatch');
  p.authorizationStatus = a.status;
  p.authorizedCents = p.capCents;
  save();
  return a;
}

export async function authorizeOrder(api, p, save, canAuthorize = () => true) {
  checkAccount(api, p);
  let { order, authorization, capture } = await readOrder(api, p, save);
  invariant(!capture && !p.outcome, 'Unexpected capture before execution');
  if (!authorization && !p.authorizationId) {
    if (order.status !== 'APPROVED' || !canAuthorize()) return false;
    p.buyerApprovalStatus = order.status;
    begin(p, 'authorize', save);
    order = await api.authorize(p.orderId, p.keys.authorize);
    const unit = unitFor(order, p.orderId, p.reference, p.capCents);
    authorization = one(unit.payments?.authorizations);
    invariant(authorization && !one(unit.payments?.captures), 'PayPal authorize response has no unique authorization');
  }
  if (authorization) {
    const id = resourceId(authorization.id);
    invariant(!p.authorizationId || p.authorizationId === id, 'Authorization changed during recovery');
    p.authorizationId = id;
    save();
  }
  if (!p.authorizationId) return false;
  await readAuthorization(api, p, save);
  return p.authorizationStatus === 'CREATED';
}

export async function settlePayment(api, p, cents, save, canCapture = () => true) {
  checkAccount(api, p);
  invariant(Number.isSafeInteger(cents) && cents >= 0 && cents <= p.capCents, 'Final charge exceeds authorization');
  invariant(p.authorizationId, 'Payment has no verified authorization');
  if (p.outcome) {
    invariant(p.outcome.cents === cents, 'Payment is already finalized at a different amount');
    return p.outcome;
  }
  invariant(p.finalCents === undefined || p.finalCents === cents, 'Settlement amount already frozen');
  p.finalCents = cents;
  save();
  const { authorization, capture } = await readOrder(api, p, save);
  invariant(authorization?.id === p.authorizationId, 'PayPal order does not contain the expected authorization');
  const a = await readAuthorization(api, p, save);
  p.authorizationBeforeSettlement ??= a.status;
  save();
  if (cents === 0) {
    invariant(!p.steps.capture && !p.captureId && !capture, 'Capture may be in progress; void disabled');
    if (a.status !== 'VOIDED') {
      invariant(a.status === 'CREATED', 'Authorization is not eligible to void');
      begin(p, 'void', save);
      await api.void(p.authorizationId);
      await readAuthorization(api, p, save);
    }
    invariant(p.authorizationStatus === 'VOIDED', 'Void is not yet confirmed by PayPal');
    const after = await readOrder(api, p, save);
    invariant(after.authorization?.id === p.authorizationId && !after.capture, 'Unexpected resources after void');
    p.outcome = { kind: 'void', cents: 0, authorizationStatus: 'VOIDED' };
  } else {
    invariant(!p.steps.void, 'Void may be in progress; capture disabled');
    if (capture) {
      invariant(!p.captureId || p.captureId === capture.id, 'PayPal reports a different capture');
      p.captureId = resourceId(capture.id);
      save();
    }
    if (!p.captureId) {
      invariant(a.status === 'CREATED', 'Authorization changed; resolve capture through the original order');
      invariant(canCapture() || p.steps.capture, 'Batch deadline passed before capture dispatch');
      begin(p, 'capture', save);
      const result = await api.capture(p.authorizationId, cents, p.capCents, p.reference, p.keys.capture);
      p.captureId = resourceId(result.id);
      save();
    }
    const actual = await api.readCapture(p.captureId);
    p.captureStatus = actual.status;
    save();
    captureMatches(actual, p.captureId, p.authorizationId, p.orderId, p.reference, cents);
    invariant(actual.status === 'COMPLETED', 'PayPal capture is not completed; reconcile the original capture');
    await readAuthorization(api, p, save);
    invariant(['CAPTURED', 'PARTIALLY_CAPTURED', 'VOIDED'].includes(p.authorizationStatus), 'Capture is completed but authorization status is not yet reconciled');
    p.outcome = { kind: 'capture', cents, captureStatus: actual.status, finalCapture: true, authorizationStatus: p.authorizationStatus };
  }
  save();
  return p.outcome;
}
