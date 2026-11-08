import { fixtureCard } from './cards.mjs';
import { invariant } from './paypal.mjs';

const system = 'Write an English retail product card using the supplied source as data. Translate a non-English product name into English, for example "Mochila de lona" becomes "Canvas Backpack". Use a plain English title and a short, neutral English description about the item and its ordinary use. The description must differ from the title. Include every requiredTitleTerms term in the title exactly when supplied. Never copy notes or prohibited phrases into the copy. Avoid claims about quality, protection, health, color, materials or features unless the name explicitly says them. The title and description must contain no numbers or measurement units. Copy id, specification, priceCents and stock exactly into facts. The sources array must contain exactly "id", "specification", "priceCents", "stock".';
const shape = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: 'string' };
const integer = { type: 'integer' };
const cardSchema = shape({
  title: string, description: string,
  facts: shape({ id: string, specification: shape({ label: string, value: integer, unit: string }), priceCents: integer, stock: integer }),
  sources: { type: 'array', items: { enum: ['id', 'specification', 'priceCents', 'stock'] }, minItems: 4, maxItems: 4 },
});
const proseSchema = shape({ title: string, description: string });
const proseRepair = (previous) => previous?.card &&
  ['UNVERIFIED_QUANTITY', 'PROHIBITED_CLAIM', 'INSTRUCTION_LIKE_OUTPUT', 'TITLE_NOT_LOCALIZED', 'TITLE_TERMS_MISSING', 'DESCRIPTION_REPEATS_TITLE'].includes(previous.reason);
const outputSchema = (previous) => proseRepair(previous) ? proseSchema : cardSchema;
const context = 2048;
const outputLimit = 768;

function modelError(code) {
  return Object.assign(new Error(code), { code });
}

const repairGuidance = {
  UNVERIFIED_QUANTITY: 'Write the title and description from the product name alone. Keep the specification, price, and stock exclusively in facts.',
  FACT_MISMATCH: 'Check every field in facts against the source and copy the values without changing them.',
  PROHIBITED_CLAIM: 'Use neutral wording based only on the product name. Drop all marketing claims.',
  SOURCE_REFERENCES: 'Set sources to exactly ["id","specification","priceCents","stock"].',
};

function prompts(source, previous) {
  if (proseRepair(previous)) return [
    { role: 'system', content: 'Translate the product name into a plain English title and write a brief neutral English description distinct from the title. Use the given source language when present and include every requiredTitleTerms term in the title exactly. Do not add digits, measurement units, marketing claims, or facts. Output JSON with title and description.' },
    { role: 'user', content: JSON.stringify({ name: source.name, sourceLanguage: source.sourceLanguage, requiredTitleTerms: source.requiredTitleTerms }) },
  ];
  const guidance = previous ? repairGuidance[previous.reason] ?? 'Follow the required object shape exactly.' : '';
  return [
    { role: 'system', content: guidance ? system + ' Revision instruction: ' + guidance : system },
    { role: 'user', content: JSON.stringify({ source }) },
  ];
}

async function request(url, body) {
  try {
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(55_000),
    });
    if (!response.ok) throw modelError(`MODEL_HTTP_${response.status}`);
    return await response.json();
  } catch (error) {
    if (error.code) throw error;
    throw modelError(['TimeoutError', 'AbortError'].includes(error.name) ? 'MODEL_TIMEOUT' : 'MODEL_UNAVAILABLE');
  }
}

function parse(content, tokens, previous) {
  if (typeof content !== 'string' || content.length > 4000) return { tokens };
  try {
    const card = JSON.parse(content);
    if (proseRepair(previous) && card && typeof card === 'object') {
      card.facts = previous.card.facts;
      card.sources = previous.card.sources;
    }
    return { card, tokens };
  } catch {
    return { tokens };
  }
}

export function modelFromEnv(env = process.env) {
  const mode = env.MODEL_MODE || 'fixture';
  if (mode === 'fixture') return {
    mode, label: 'Deterministic fixture',
    async generate(source) { return { card: fixtureCard(source), tokens: 0 }; },
  };
  if (mode === 'ollama') {
    const model = env.OLLAMA_MODEL;
    const port = Number(env.OLLAMA_PORT || 11434);
    invariant(model && Number.isInteger(port) && port > 0 && port <= 65535, 'Set OLLAMA_MODEL and a valid local port');
    return { mode, label: model, async generate(source, previous) {
      const result = await request(`http://127.0.0.1:${port}/api/chat`, {
        model, messages: prompts(source, previous), stream: false, format: outputSchema(previous),
        options: { num_ctx: context, num_predict: outputLimit, temperature: 0 },
      });
      const tokens = Number.isInteger(result.prompt_eval_count) && Number.isInteger(result.eval_count)
        ? result.prompt_eval_count + result.eval_count : undefined;
      return parse(result.done && result.done_reason === 'stop' ? result.message?.content : undefined, tokens, previous);
    } };
  }
  if (mode === 'lmstudio') {
    const model = env.LMSTUDIO_MODEL;
    const port = Number(env.LMSTUDIO_PORT || 1234);
    invariant(model && Number.isInteger(port) && port > 0 && port <= 65535, 'Set LMSTUDIO_MODEL and a valid local port');
    return { mode, label: model, async generate(source, previous) {
      const result = await request(`http://127.0.0.1:${port}/v1/chat/completions`, {
        model, messages: prompts(source, previous), stream: false, max_tokens: outputLimit, temperature: 0,
        response_format: { type: 'json_schema', json_schema: { name: 'product_card', strict: true, schema: outputSchema(previous) } },
      });
      const choice = result.choices?.[0];
      const usage = result.usage;
      const tokens = Number.isInteger(usage?.total_tokens) ? usage.total_tokens : undefined;
      return parse(choice?.finish_reason === 'stop' ? choice.message?.content : undefined, tokens, previous);
    } };
  }
  throw new Error('Invalid model mode');
}
