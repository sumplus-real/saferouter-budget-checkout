import { randomUUID } from 'node:crypto';
import { invariant, usd } from './paypal.mjs';

export function fixturePayPal(state, save) {
  const data = state.fixture ??= {};
  const byAuthorization = (id) => {
    const record = Object.values(data).find((item) => item.auth?.id === id);
    invariant(record, 'Unknown fixture authorization');
    return record;
  };
  const order = (id) => {
    const { reference, cents, status, auth, capture } = data[id];
    return { id, intent: 'AUTHORIZE', status, purchase_units: [
      { reference_id: reference, amount: usd(cents), payments: { authorizations: auth ? [auth] : [], captures: capture ? [capture] : [] } },
    ] };
  };
  return {
    mode: 'fixture',
    async create({ reference, cents }) {
      let id = Object.keys(data).find((key) => data[key].reference === reference);
      if (!id) {
        id = randomUUID();
        data[id] = { reference, cents, status: 'CREATED' };
        save();
      }
      return order(id);
    },
    approve(id) {
      if (data[id].status === 'CREATED') {
        data[id].status = 'APPROVED';
        save();
      }
    },
    async order(id) { return order(id); },
    async authorize(id) {
      const record = data[id];
      invariant(['APPROVED', 'COMPLETED'].includes(record.status), 'Fixture approval required');
      if (!record.auth) {
        record.status = 'COMPLETED';
        record.auth = { id: randomUUID(), status: 'CREATED', amount: usd(record.cents) };
        save();
      }
      return order(id);
    },
    async authorization(id) { return byAuthorization(id).auth; },
    async capture(id, cents, maxCents, reference) {
      const record = byAuthorization(id);
      invariant(record.auth.status === 'CREATED' && cents > 0 && cents <= maxCents && maxCents === record.cents, 'Fixture capture exceeds budget or is already finalized');
      record.auth.status = cents < maxCents ? 'PARTIALLY_CAPTURED' : 'CAPTURED';
      record.capture = { id: randomUUID(), status: 'COMPLETED', amount: usd(cents), final_capture: true,
        invoice_id: reference, supplementary_data: { related_ids: { authorization_id: id } } };
      save();
      return record.capture;
    },
    async readCapture(id) {
      const record = Object.values(data).find((item) => item.capture?.id === id);
      invariant(record, 'Unknown fixture capture');
      return record.capture;
    },
    async void(id) {
      const record = byAuthorization(id);
      invariant(!record.capture, 'Fixture authorization has a capture');
      record.auth.status = 'VOIDED';
      save();
    },
  };
}
