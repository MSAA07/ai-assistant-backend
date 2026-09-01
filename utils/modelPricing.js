import { captureSentryException } from "./sentry.js";

export const MODEL_PRICING_VERSION = "openai-text-pricing-2026-08-31-v3";
export const DEFAULT_USD_TO_SAR_RATE = 3.75;

// USD per 1M text tokens. Keep ledger costs in USD; SAR conversion belongs to display code.
export const MODEL_TOKEN_PRICING_USD_PER_1M = Object.freeze({
  "gpt-4.1-nano": Object.freeze({ input: 0.1, output: 0.4 }),
  "gpt-4.1-mini": Object.freeze({ input: 0.4, output: 1.6 }),
  "gpt-4.1": Object.freeze({ input: 2.0, output: 8.0 }),
  "gpt-4o-mini": Object.freeze({ input: 0.15, output: 0.6 }),
  "gpt-4o": Object.freeze({ input: 2.5, output: 10.0 }),
  "gpt-5.4-nano": Object.freeze({ input: 0.2, output: 1.25 }),
  "gpt-5.4-mini": Object.freeze({ input: 0.75, output: 4.5 }),
  "gpt-5.4": Object.freeze({ input: 2.5, output: 15.0 }),
  "gpt-5.5": Object.freeze({ input: 5.0, output: 30.0 }),
});

function normalizeModelName(modelName) {
  return typeof modelName === "string" ? modelName.trim() : "";
}

export function resolvePricingModelKey(modelName) {
  const normalized = normalizeModelName(modelName);
  if (MODEL_TOKEN_PRICING_USD_PER_1M[normalized]) {
    return normalized;
  }

  return Object.keys(MODEL_TOKEN_PRICING_USD_PER_1M)
    .sort((left, right) => right.length - left.length)
    .find((pricingKey) => normalized.startsWith(`${pricingKey}-`))
    ?? null;
}

export function getModelPricing(modelName) {
  const pricingKey = resolvePricingModelKey(modelName);
  if (!pricingKey) {
    const normalized = normalizeModelName(modelName) || "<missing>";
    console.error("[modelPricing] no pricing configured for model", {
      model: normalized,
      pricingVersion: MODEL_PRICING_VERSION,
    });
    const error = new Error(`No pricing configured for model: ${normalized}`);
    error.code = "model_pricing_missing";
    captureSentryException(error, {
      level: "error",
      tags: { util: "model_pricing", anomaly: "missing_pricing" },
      extra: {
        model: normalized,
        pricingVersion: MODEL_PRICING_VERSION,
      },
    });
    throw error;
  }

  return MODEL_TOKEN_PRICING_USD_PER_1M[pricingKey];
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
