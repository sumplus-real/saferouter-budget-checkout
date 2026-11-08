const bytes = (value) => new TextEncoder().encode(value);
const decode = (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
const fail = (message) => { throw new Error(message); };
const require = (condition, message) => { if (!condition) fail(message); };
const int = Number.isSafeInteger;
const resource = (value) => typeof value === 'string' && /^[a-z0-9-]{1,64}$/i.test(value);

export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export async function digest(value) {
  const hash = await crypto.subtle.digest('SHA-256', bytes(canonical(value)));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyReceipt(envelope, trustedKey) {
  require(envelope?.schema === 'saferouter-checkout/1' && trustedKey, 'Expected a receipt and a separately trusted key');
  const key = await crypto.subtle.importKey('spki', decode(trustedKey.trim()), 'Ed25519', false, ['verify']);
  const { body } = envelope;
  require(body && await crypto.subtle.verify('Ed25519', key, decode(envelope.signature), bytes(canonical(body))), 'Signature mismatch');
  const { quote, input, items, payment } = body;
  require(quote?.policy === 'product-card-v1' && quote.currency === 'USD' && quote.unitCents === 5 &&
    int(quote.capCents) && int(quote.expiresAt) && int(quote.tokenBudget), 'Unsupported quote');
  require(Array.isArray(input) && Array.isArray(items) && input.length >= 1 && input.length <= 10 &&
    input.length === items.length && quote.capCents === input.length * quote.unitCents &&
    quote.tokenBudget > 0 && quote.tokenBudget <= 10 * 2 * 2816, 'Quote and row counts disagree');
  require(await digest(input) === quote.inputDigest, 'Input digest mismatch');
  const billed = new Set();
  let delivered = 0;
  let total = 0;
  let reservedTokens = 0;
  for (const [index, row] of items.entries()) {
    require(row?.index === index && ['accepted', 'rejected', 'cancelled'].includes(row.status), 'Invalid line order or status');
    require(Array.isArray(row.attempts) && row.attempts.length <= 2, 'Invalid attempt count');
    for (const [i, attempt] of row.attempts.entries()) {
      require(attempt?.number === i + 1 && attempt.reservedTokens === 2816 &&
        ['accepted', 'rejected', 'unknown'].includes(attempt.status), 'Invalid attempt record');
      reservedTokens += attempt.reservedTokens;
    }
    if (row.status === 'accepted') {
      require(row.card && row.id === input[index]?.id && row.card.facts?.id === row.id &&
        /^[A-Za-z0-9_-]{1,32}$/.test(row.id), 'Accepted card identity mismatch');
      const id = row.id.toUpperCase();
      require(!billed.has(id), 'Duplicate billed product');
      require(row.amountCents === quote.unitCents && await digest(row.card) === row.cardDigest, 'Billable item amount or digest mismatch');
      const attempt = row.attempts.at(-1);
      require(attempt?.status === 'accepted' && await digest(attempt.card) === row.cardDigest, 'Accepted output does not match attempt');
      billed.add(id);
      delivered += 1;
      total += quote.unitCents;
    } else {
      require(row.amountCents === 0 && !row.card && !row.cardDigest && typeof row.reason === 'string', 'Failed item has a charge or no reason');
    }
  }
  require(reservedTokens === body.reservedTokens && reservedTokens <= quote.tokenBudget, 'Model reservation mismatch');
  require(total <= quote.capCents && total === body.totalCents && delivered === body.delivered, 'Total does not match recomputed line charges');
  require(['fixture', 'paypal-sandbox'].includes(payment?.mode) && payment.mode === quote.paymentMode &&
    resource(payment.orderId) && resource(payment.authorizationId) && payment.cents === total, 'Payment amount or identity mismatch');
  if (total === 0) {
    require(payment.kind === 'void' && payment.authorizationStatus === 'VOIDED' && !payment.captureId, 'Zero-charge receipt lacks a confirmed void');
  } else {
    require(payment.kind === 'capture' && payment.finalCapture === true && payment.captureStatus === 'COMPLETED' &&
      resource(payment.captureId) && ['CAPTURED', 'PARTIALLY_CAPTURED', 'VOIDED'].includes(payment.authorizationStatus),
    'Receipt lacks confirmed final capture');
  }
  return { delivered, totalCents: total, capCents: quote.capCents, paymentMode: payment.mode, authorizationStatus: payment.authorizationStatus };
}
