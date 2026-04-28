export const MODEL_PRICING_VERSION = "openai-text-pricing-2026-04-27-v1";
export const DEFAULT_USD_TO_SAR_RATE = 3.75;

// USD per 1M text tokens. Keep ledger costs in USD; SAR conversion belongs to display code.
export const MODEL_TOKEN_PRICING_USD_PER_1M = Object.freeze({
  "gpt-4o-mini": Object.freeze({ input: 0.15, output: 0.6 }),
  "gpt-4o": Object.freeze({ input: 2.5, output: 10.0 }),
  "gpt-5.5": Object.freeze({ input: 5.0, output: 30.0 }),
});

const DEFAULT_PRICING_MODEL = "gpt-4o-mini";

function normalizeModelName(modelName) {
  return typeof modelName === "string" ? modelName.trim() : "";
}

export function resolvePricingModelKey(modelName) {
  const normalized = normalizeModelName(modelName);
  if (MODEL_TOKEN_PRICING_USD_PER_1M[normalized]) {
    return normalized;
  }

  if (normalized.startsWith("gpt-4o-mini")) {
    return "gpt-4o-mini";
  }

  if (normalized.startsWith("gpt-4o")) {
    return "gpt-4o";
  }

  if (normalized.startsWith("gpt-5.5")) {
    return "gpt-5.5";
  }

  return DEFAULT_PRICING_MODEL;
}

export function getModelPricing(modelName) {
  return MODEL_TOKEN_PRICING_USD_PER_1M[resolvePricingModelKey(modelName)];
}

export function estimateCost(modelName, inputTokens = 0, outputTokens = 0) {
  const pricing = getModelPricing(modelName);
  const safeInputTokens = Math.max(0, Number(inputTokens) || 0);
  const safeOutputTokens = Math.max(0, Number(outputTokens) || 0);

  return (safeInputTokens / 1_000_000) * pricing.input
    + (safeOutputTokens / 1_000_000) * pricing.output;
}

export function estimateCostUsdString(modelName, inputTokens = 0, outputTokens = 0) {
  return estimateCost(modelName, inputTokens, outputTokens).toFixed(8);
}

export function getUsdToSarRate(env = process.env) {
  const configuredRate = Number(env.USD_TO_SAR_RATE ?? env.ADMIN_USD_TO_SAR_RATE);
  return Number.isFinite(configuredRate) && configuredRate > 0
    ? configuredRate
    : DEFAULT_USD_TO_SAR_RATE;
}

export function convertUsdToSar(usdAmount, env = process.env) {
  return (Number(usdAmount) || 0) * getUsdToSarRate(env);
}
