import { randomUUID } from 'node:crypto';
import { digest } from '../public/verify.mjs';
import { MAX_ATTEMPTS, POLICY, readRows, runCards, TOKEN_RESERVATION, UNIT_CENTS } from './cards.mjs';
import { authorizeOrder, createOrder, newPayment, settlePayment } from './payment.mjs';
import { invariant } from './paypal.mjs';
import { makeReceipt } from './receipt.mjs';

export async function newBatch(input, { model, paymentMode, origin, controlledFaults }) {
  const rows = readRows(input);
  const id = randomUUID();
  const now = Date.now();
  const quote = {
    policy: POLICY, currency: 'USD', unitCents: UNIT_CENTS,
    capCents: input.length * UNIT_CENTS, inputDigest: await digest(input),
    tokenBudget: rows.length * MAX_ATTEMPTS * TOKEN_RESERVATION, expiresAt: now + 30 * 60_000,
    modelMode: model.mode, model: model.label, paymentMode, controlledFaults: controlledFaults === true,
  };
  const payment = newPayment(paymentMode, quote.capCents, `${origin}/return/${id}`, `${origin}/cancel/${id}`);
  return { id, stage: 'quoted', quote, input, rows, reservedTokens: 0, payment };
}

function cancelRows(batch, reason) {
  for (const row of batch.rows) {
    if (row.status === 'rejected') continue;
    const last = row.attempts.at(-1);
    if (last?.status === 'dispatched') {
      last.status = 'unknown';
      last.reason = 'INTERRUPTED_ATTEMPT';
    }
    delete row.card;
    row.status = 'cancelled';
    row.reason = reason;
  }
}

export async function advance(batch, action, api, model, save, privateKey) {
  const p = batch.payment;
  invariant(api.mode === p.mode, 'Restore the frozen payment mode for this batch');
  if (batch.receipt || batch.stage === 'closed') return;
  const withinDeadline = () => Date.now() < batch.quote.expiresAt;
  if (action === 'cancel' || !withinDeadline()) {
    if (!p.steps.capture && !p.captureId) {
      batch.stopReason ??= action === 'cancel' ? 'BUYER_CANCELLED' : 'BATCH_EXPIRED';
      save();
    } else if (action === 'cancel') {
      throw new Error('Capture may be in progress. Recover the original settlement before cancellation.');
    }
  }
  if (action === 'order' && !batch.stopReason) {
    if (batch.stage !== 'quoted') return;
    await createOrder(api, p, save);
    batch.stage = 'approval';
    save();
    return;
  }
  if (!p.orderId || (batch.stopReason && !p.authorizationId && !p.steps.authorize)) {
    invariant(batch.stopReason, 'Create the order before starting execution');
    cancelRows(batch, batch.stopReason);
    batch.stage = 'closed';
    save();
    return;
  }
  if (!p.authorizationId || !['running', 'settling'].includes(batch.stage)) {
    if (action === 'run' && api.mode === 'fixture' && !batch.stopReason) api.approve(p.orderId);
    const ready = await authorizeOrder(api, p, save, () => !batch.stopReason && withinDeadline());
    if (!ready) {
      invariant(p.authorizationId || !p.steps.authorize, 'Authorization is unresolved. Recover the original PayPal order.');
      if (!p.authorizationId && !withinDeadline()) {
        batch.stopReason ??= 'BATCH_EXPIRED';
        cancelRows(batch, batch.stopReason);
        batch.stage = 'closed';
        save();
        return;
      }
      if (p.authorizationStatus !== 'VOIDED' || !batch.stopReason) {
        batch.stage = p.authorizationId ? 'authorization_pending' : 'approval';
        save();
        return;
      }
    }
    batch.stage = 'running';
    save();
  }
  if (batch.stopReason) {
    cancelRows(batch, batch.stopReason);
    p.finalCents = 0;
    save();
  } else if (batch.stage === 'running') {
    invariant(batch.quote.model === model.label && batch.quote.modelMode === model.mode, 'Restore the frozen model configuration for this batch');
    await runCards(batch, model, save, { canContinue: () => withinDeadline() && !batch.modelStopped });
    if (!withinDeadline()) {
      batch.stopReason = 'BATCH_EXPIRED';
      cancelRows(batch, batch.stopReason);
    }
  }
  const cents = batch.rows.filter(({ status }) => status === 'accepted').length * batch.quote.unitCents;
  batch.stage = 'settling';
  save();
  await settlePayment(api, p, cents, save, withinDeadline);
  batch.receipt = await makeReceipt(batch, privateKey);
  batch.stage = p.outcome.kind === 'capture' ? 'settled' : 'voided';
  save();
}
