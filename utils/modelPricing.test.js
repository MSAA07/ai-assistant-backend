import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateCost,
  getModelPricing,
  MODEL_PRICING_VERSION,
  MODEL_TOKEN_PRICING_USD_PER_1M,
  resolvePricingModelKey,
} from "./modelPricing.js";
import { ALLOWED_MODELS } from "./modelRoutingPolicy.js";

const expectedPricing = Object.freeze({
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1": { input: 2.0, output: 8.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5 },
  "gpt-5.4": { input: 2.5, output: 15.0 },
  "gpt-5.5": { input: 5.0, output: 30.0 },
});

test("pricing table covers every current allow-list model at the verified rates", () => {
  assert.equal(MODEL_PRICING_VERSION, "openai-text-pricing-2026-08-23-v2");
  assert.deepEqual(ALLOWED_MODELS.map(({ id }) => id).sort(), Object.keys(expectedPricing).sort());
  assert.deepEqual(Object.keys(MODEL_TOKEN_PRICING_USD_PER_1M).sort(), Object.keys(expectedPricing).sort());
  for (const [model, pricing] of Object.entries(expectedPricing)) {
    assert.deepEqual(getModelPricing(model), pricing);
  }
});

test("dated OpenAI response model ids resolve to the correct base pricing key", () => {
  assert.equal(resolvePricingModelKey("gpt-4.1-nano-2025-04-14"), "gpt-4.1-nano");
  assert.equal(resolvePricingModelKey("gpt-4.1-mini-2025-04-14"), "gpt-4.1-mini");
  assert.equal(resolvePricingModelKey("gpt-4.1-2025-04-14"), "gpt-4.1");
  assert.equal(resolvePricingModelKey("gpt-5.4-mini-2026-08-01"), "gpt-5.4-mini");
  assert.equal(estimateCost("gpt-4.1-mini-2025-04-14", 1_000_000, 1_000_000), 2.0);
});

test("unknown models fail loudly instead of inheriting GPT-4o mini pricing", () => {
  assert.equal(resolvePricingModelKey("gpt-future-unpriced"), null);
  assert.throws(
    () => estimateCost("gpt-future-unpriced", 1_000, 1_000),
    (error) => error?.code === "model_pricing_missing" && /gpt-future-unpriced/.test(error.message),
  );
});
