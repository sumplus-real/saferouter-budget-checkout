import { readFile } from 'node:fs/promises';
import { newBatch } from '../src/checkout.mjs';
import { runCards } from '../src/cards.mjs';
import { modelFromEnv } from '../src/model.mjs';

const [file = 'fixtures/ten-products.json', scenario] = process.argv.slice(2);
const input = JSON.parse(await readFile(file, 'utf8'));
const model = modelFromEnv();
const result = {};
for (const baseline of [true, false]) {
  const batch = await newBatch(input, {
    model, paymentMode: 'fixture', origin: 'http://127.0.0.1:4188', controlledFaults: scenario === '--faults',
  });
  const start = performance.now();
  await runCards(batch, model, () => {}, { baseline, canContinue: () => !batch.modelStopped });
  const attempts = batch.rows.flatMap(({ attempts }) => attempts);
  const accepted = batch.rows.filter(({ status }) => status === 'accepted').length;
  result[baseline ? 'directSingleAttempt' : 'budgetWithOneRepair'] = {
    accepted, rejected: input.length - accepted, attempts: attempts.length,
    usageTokens: attempts.every((attempt) => Number.isInteger(attempt.tokens))
      ? attempts.reduce((sum, attempt) => sum + attempt.tokens, 0) : null,
    reservedTokens: batch.reservedTokens,
    hypotheticalCustomerCents: baseline ? null : accepted * batch.quote.unitCents,
    actualCustomerCents: 0,
    providerApiCostUSD: model.mode === 'fixture' ? null : 0,
    elapsedMs: Math.round(performance.now() - start),
    outcomes: batch.rows.map(({ id, status, reason, card, attempts: itemAttempts }) => ({
      id, status, reason, card, attempts: itemAttempts.map(({ number, status, reason, tokens, ms }) => ({ number, status, reason, tokens, ms })),
    })),
  };
}
console.log(JSON.stringify({ modelMode: model.mode, model: model.label, controlledFaults: scenario === '--faults', result }, null, 2));
