import { invariant } from './paypal.mjs';

export const UNIT_CENTS = 5;
export const MAX_ROWS = 10;
export const POLICY = 'product-card-v1';
export const BANNED = ['guaranteed', 'cures', 'clinically proven', 'risk free', 'ignore previous instructions'];
export const MAX_ATTEMPTS = 2;
export const TOKEN_RESERVATION = 2816;
const units = ['mm', 'cm', 'm', 'g', 'kg', 'mL', 'L', 'W', 'pcs'];
const normalize = (s) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const suspicious = /ignore.{0,60}(instructions?|rules?|polic(?:y|ies))|\b(always|force|mark).{0,24}(charge|bill|paid|pass)\b/i;
const clean = (value, max) => typeof value === 'string' && value.trim().length > 0 &&
  value.length <= max && !/[\p{Cc}\p{Cf}<>]/u.test(value);
const whole = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const obj = (value) => value && typeof value === 'object' && !Array.isArray(value);
const sku = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(value);
const keysOnly = (record, keys) => Object.keys(record).every((key) => keys.includes(key));
const termList = (value, limit) => value === undefined || (Array.isArray(value) && value.length <= limit &&
  value.every((term) => clean(term, 40) && normalize(term).length > 0));

export function readRows(rows) {
  invariant(Array.isArray(rows) && rows.length >= 1 && rows.length <= MAX_ROWS, 'Upload a JSON array of 1 to 10 product records');
  const seen = new Map();
  for (const item of rows) {
    if (sku(item?.id)) {
      const key = item.id.toUpperCase();
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  return rows.map((source, index) => {
    const row = { index, status: 'waiting', attempts: [] };
    if (!obj(source) || !sku(source.id) || !clean(source.name, 80) ||
        !obj(source.specification) || !clean(source.specification.label, 40) ||
        !whole(source.specification.value, 1, 100000) || !units.includes(source.specification.unit) ||
        !whole(source.priceCents, 0, 10000000) || !whole(source.stock, 0, 1000000) ||
        !keysOnly(source, ['id', 'name', 'specification', 'priceCents', 'stock', 'availability', 'notes', 'prohibited', 'sourceLanguage', 'requiredTitleTerms']) ||
        !keysOnly(source.specification, ['label', 'value', 'unit'])) return reject(row, 'INVALID_SOURCE');
    row.id = source.id;
    if (seen.get(source.id.toUpperCase()) !== 1) return reject(row, 'DUPLICATE_ID');
    if (source.availability !== undefined && source.availability !== (source.stock > 0 ? 'in_stock' : 'out_of_stock')) {
      return reject(row, 'CONFLICTING_AVAILABILITY');
    }
    if ((source.sourceLanguage !== undefined && (typeof source.sourceLanguage !== 'string' || !/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(source.sourceLanguage) || source.sourceLanguage.length > 20)) ||
        (source.notes !== undefined && !clean(source.notes, 180)) ||
        !termList(source.prohibited, 6) || !termList(source.requiredTitleTerms, 4)) return reject(row, 'INVALID_SOURCE');
    if ([source.name, source.notes ?? '', source.specification.label, ...(source.prohibited ?? []), ...(source.requiredTitleTerms ?? [])]
      .some((s) => suspicious.test(normalize(s)))) return reject(row, 'INSTRUCTION_LIKE_SOURCE');
    return row;
  });
}

const factsFor = (source) => ({
  id: source.id, specification: source.specification, priceCents: source.priceCents, stock: source.stock,
});

const refs = ['id', 'specification', 'priceCents', 'stock'];
export function fixtureCard(source) {
  return {
    title: source.name,
    description: 'See the product details below for the listed specification, price and availability.',
    facts: factsFor(source),
    sources: [...refs],
  };
}

export function checkCard(card, source) {
  if (!obj(card) || !keysOnly(card, ['title', 'description', 'facts', 'sources']) ||
      !clean(card.title, 100) || !clean(card.description, 260) ||
      !/[A-Za-z]{2}/.test(card.title) || !/[A-Za-z]{2}/.test(card.description)) return 'INVALID_CARD';
  const { facts, sources } = card;
  if (!Array.isArray(sources) || sources.length !== refs.length || refs.some((key) => !sources.includes(key))) return 'SOURCE_REFERENCES';
  if (!obj(facts) || !keysOnly(facts, refs) || !obj(facts.specification) ||
      !keysOnly(facts.specification, ['label', 'value', 'unit']) ||
      facts.id !== source.id || facts.priceCents !== source.priceCents || facts.stock !== source.stock ||
      facts.specification.label !== source.specification.label || facts.specification.value !== source.specification.value ||
      facts.specification.unit !== source.specification.unit) return 'FACT_MISMATCH';
  const sourceLanguage = source.sourceLanguage?.split('-')[0].toLowerCase();
  if (sourceLanguage && sourceLanguage !== 'en' && normalize(card.title) === normalize(source.name)) return 'TITLE_NOT_LOCALIZED';
  const title = ` ${normalize(card.title)} `;
  if ((source.requiredTitleTerms ?? []).some((term) => !title.includes(` ${normalize(term)} `))) return 'TITLE_TERMS_MISSING';
  if (normalize(card.description) === normalize(card.title)) return 'DESCRIPTION_REPEATS_TITLE';
  const prose = normalize(`${card.title} ${card.description}`);
  const searchable = ` ${normalize(`${card.title} ${card.description} ${facts.specification.label}`)} `;
  if ([...BANNED, ...(source.prohibited ?? [])].some((phrase) => searchable.includes(` ${normalize(phrase)} `))) return 'PROHIBITED_CLAIM';
  if (suspicious.test(prose)) return 'INSTRUCTION_LIKE_OUTPUT';
  if (/[\p{N}]/u.test(prose) || /\b(?:mm|cm|kg|ml|watt|watts|grams|meters|liters|inches|ounces|pounds|percent|usd)\b/i.test(prose)) {
    return 'UNVERIFIED_QUANTITY';
  }
  return undefined;
}

function reject(row, reason) {
  row.status = 'rejected';
  row.reason = reason;
  return row;
}

function injectFault(card, index, attempt) {
  if ([2, 9].includes(index) || (index === 1 && attempt === 1)) {
    return { ...card, facts: { ...card?.facts, stock: -1 } };
  }
  return card;
}

export async function runCards(batch, model, save, { baseline = false, canContinue = () => true } = {}) {
  for (const row of batch.rows) {
    if (row.status !== 'waiting') continue;
    const pending = row.attempts.at(-1);
    if (pending?.status === 'dispatched') {
      pending.status = 'unknown';
      pending.reason = 'INTERRUPTED_ATTEMPT';
      reject(row, pending.reason);
      save();
      continue;
    }
    const limit = baseline ? 1 : MAX_ATTEMPTS;
    while (row.attempts.length < limit) {
      const open = canContinue();
      if (!open || batch.reservedTokens + TOKEN_RESERVATION > batch.quote.tokenBudget) {
        reject(row, open ? 'MODEL_BUDGET' : 'BATCH_STOPPED');
        break;
      }
      const previous = row.attempts.at(-1);
      const attempt = { number: row.attempts.length + 1, status: 'dispatched', model: model.label, reservedTokens: TOKEN_RESERVATION };
      batch.reservedTokens += TOKEN_RESERVATION;
      row.attempts.push(attempt);
      save();
      const start = performance.now();
      try {
        const generated = await model.generate(batch.input[row.index], previous);
        if (Number.isInteger(generated.tokens) && generated.tokens >= 0) attempt.tokens = generated.tokens;
        if (!baseline && !Number.isInteger(attempt.tokens)) {
          attempt.reason = 'MODEL_USAGE_UNKNOWN';
        } else if (!baseline && attempt.tokens > TOKEN_RESERVATION) {
          attempt.reason = 'MODEL_TOKEN_BOUND_EXCEEDED';
        } else {
          const card = batch.quote.controlledFaults ? injectFault(generated.card, row.index, attempt.number) : generated.card;
          if (obj(card)) attempt.card = card;
          attempt.reason = checkCard(card, batch.input[row.index]);
        }
      } catch (error) {
        attempt.reason = error.code ?? 'MODEL_UNAVAILABLE';
      }
      attempt.ms = Math.round(performance.now() - start);
      attempt.status = attempt.reason ? 'rejected' : 'accepted';
      if (!attempt.reason) {
        row.card = attempt.card;
        row.status = 'accepted';
      }
      if (attempt.reason === 'MODEL_TOKEN_BOUND_EXCEEDED') batch.modelStopped = true;
      save();
      if (row.status === 'accepted' || batch.modelStopped) break;
    }
    if (row.status === 'waiting') reject(row, row.attempts.at(-1)?.reason ?? 'MODEL_BUDGET');
    save();
  }
}
