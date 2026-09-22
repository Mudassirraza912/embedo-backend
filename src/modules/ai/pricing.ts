/**
 * USD per 1M tokens. Matched by longest model-name prefix; unknown models fall back to a
 * conservative Sol-tier rate so cost is never under-reported. Update as vendor pricing changes.
 */
interface Price {
  input: number;
  output: number;
  cachedInput?: number;
}

const PRICES: Array<{ prefix: string; price: Price }> = [
  { prefix: 'gpt-4o-mini', price: { input: 0.15, output: 0.6, cachedInput: 0.075 } },
  { prefix: 'gpt-4o', price: { input: 5, output: 15, cachedInput: 2.5 } },
  { prefix: 'gpt-4.1-mini', price: { input: 0.4, output: 1.6, cachedInput: 0.1 } },
  { prefix: 'gpt-4.1', price: { input: 2, output: 8, cachedInput: 0.5 } },
  { prefix: 'o3-mini', price: { input: 1.1, output: 4.4, cachedInput: 0.55 } },
  { prefix: 'claude-3-5-haiku', price: { input: 0.8, output: 4, cachedInput: 0.08 } },
  { prefix: 'claude-3-5-sonnet', price: { input: 3, output: 15, cachedInput: 0.3 } },
  { prefix: 'claude-sonnet', price: { input: 3, output: 15, cachedInput: 0.3 } },
  { prefix: 'claude-haiku', price: { input: 0.8, output: 4, cachedInput: 0.08 } },
  { prefix: 'claude-opus', price: { input: 15, output: 75, cachedInput: 1.5 } },
  { prefix: 'gemini-1.5-flash', price: { input: 0.075, output: 0.3 } },
  { prefix: 'gemini-1.5-pro', price: { input: 1.25, output: 5 } },
  { prefix: 'gemini-2', price: { input: 0.1, output: 0.4 } },
  { prefix: 'text-embedding-3-small', price: { input: 0.02, output: 0 } },
  { prefix: 'text-embedding-3-large', price: { input: 0.13, output: 0 } },
];

const FALLBACK: Price = { input: 5, output: 15 };

export const priceForModel = (modelName: string): Price => {
  const name = modelName.toLowerCase();
  let best: { prefix: string; price: Price } | undefined;
  for (const entry of PRICES) {
    if (name.startsWith(entry.prefix) && (!best || entry.prefix.length > best.prefix.length)) {
      best = entry;
    }
  }
  return best?.price ?? FALLBACK;
};

export const estimateCostUsd = (
  modelName: string,
  inputTokens: number,
  outputTokens: number,
  cachedTokens = 0
): number => {
  const p = priceForModel(modelName);
  const cached = Math.min(cachedTokens, inputTokens);
  const uncached = inputTokens - cached;
  const cost =
    (uncached * p.input + cached * (p.cachedInput ?? p.input) + outputTokens * p.output) / 1_000_000;
  return Number(cost.toFixed(6));
};
