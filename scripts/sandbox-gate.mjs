import { join } from 'node:path';
import { statSync } from 'node:fs';
import { lockStore, atomicJson } from '../src/store.mjs';
import { createOrder, authorizeOrder, newPayment, settlePayment } from '../src/payment.mjs';
import { failure, invariant, paypalFromEnv } from '../src/paypal.mjs';

const [action, scenario] = process.argv.slice(2);
const scenarios = { partial: 40, void: 0 };
const directory = '.runtime/gate';
let store;
try {
  invariant(['create', 'finish'].includes(action) && Object.hasOwn(scenarios, scenario), 'Usage: npm run sandbox:gate -- create|finish partial|void');
  try {
    invariant((statSync('.env').mode & 0o077) === 0, 'Restrict .env to owner access (0600)');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const api = paypalFromEnv();
  store = lockStore(directory);
  const state = store.read();
  const save = () => store.save(state);
  const callback = 'http://127.0.0.1:4188/';
  if (action === 'finish') invariant(state.batches[scenario]?.orderId, 'No original order. Run create and approve as the test buyer first.');
  const payment = state.batches[scenario] ??= newPayment(api.mode, 50, callback, callback);
  save();
  try {
    await createOrder(api, payment, save);
    if (action === 'create') {
      if (!payment.approvalUrl) await authorizeOrder(api, payment, save, () => false);
      invariant(payment.approvalUrl, 'PayPal has not supplied an approval URL');
      console.log('Open this Sandbox checkout in the separate test buyer profile:');
      console.log(payment.approvalUrl);
    } else if (!payment.outcome) {
      if (payment.finalCents === undefined) {
        invariant(await authorizeOrder(api, payment, save), 'Buyer approval or ready authorization still required');
      }
      await settlePayment(api, payment, scenarios[scenario], save);
    }
    delete payment.lastError;
    save();
  } catch (error) {
    payment.lastError = failure(error);
    save();
    throw error;
  } finally {
    const safe = (p) => ({
      orderIdSuffix: p.orderId?.slice(-5), authorizationIdSuffix: p.authorizationId?.slice(-5),
      captureIdSuffix: p.captureId?.slice(-5), captureStatus: p.captureStatus, orderStatus: p.orderStatus,
      buyerApprovalStatus: p.buyerApprovalStatus, authorizedCents: p.authorizedCents,
      authorizationBeforeSettlement: p.authorizationBeforeSettlement, authorizationStatus: p.authorizationStatus, approvedCapCents: p.capCents,
      outcome: p.outcome, operations: p.steps, failure: p.lastError,
    });
    const evidence = Object.fromEntries(Object.entries(state.batches).map(([name, value]) => [name, safe(value)]));
    atomicJson(join(directory, 'redacted-evidence.json'), { mode: 'paypal-sandbox', observedAt: new Date().toISOString(), evidence });
    if (action === 'finish' && payment.outcome) console.log(JSON.stringify(evidence[scenario], null, 2));
  }
} catch (error) {
  console.error(JSON.stringify(failure(error)));
  process.exitCode = 1;
} finally {
  store?.close();
}
