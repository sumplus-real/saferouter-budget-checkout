import { generateKeyPairSync, sign } from 'node:crypto';
import { canonical, digest } from '../public/verify.mjs';

export function createSigningKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

export async function makeReceipt(batch, privateKey) {
  const items = [];
  for (const row of batch.rows) {
    items.push({
      ...row,
      amountCents: row.status === 'accepted' ? batch.quote.unitCents : 0,
      cardDigest: row.card ? await digest(row.card) : undefined,
    });
  }
  const body = {
    batchId: batch.id, quote: batch.quote, input: batch.input, items, reservedTokens: batch.reservedTokens,
    delivered: items.filter((row) => row.status === 'accepted').length,
    totalCents: items.reduce((sum, row) => sum + row.amountCents, 0),
    payment: { ...batch.payment.outcome, mode: batch.payment.mode,
      orderId: batch.payment.orderId, authorizationId: batch.payment.authorizationId, captureId: batch.payment.captureId },
  };
  return { schema: 'saferouter-checkout/1', body, signature: sign(null, Buffer.from(canonical(body)), privateKey).toString('base64') };
}
