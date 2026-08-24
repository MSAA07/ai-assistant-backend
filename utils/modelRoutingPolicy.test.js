import assert from "node:assert/strict";
import test from "node:test";

import { DOCUMENT_GENERATION_TYPES } from "./documentGeneration.js";
import {
  DEFAULT_GENERATION_MODEL,
  EXAM_GENERATION_MODEL,
  FREE_FLASHCARD_GENERATION_MODEL,
  FLASHCARD_GENERATION_MODEL,
  ROUTING_CACHE_TTL_MS,
  resolveModelForGeneration,
} from "./modelRoutingPolicy.js";

test("worker routing cache refreshes within 15 seconds", () => {
  assert.equal(ROUTING_CACHE_TTL_MS, 15_000);
});

test("free flashcard generation keeps the cheaper gpt-4o-mini fallback", async () => {
  assert.equal(FREE_FLASHCARD_GENERATION_MODEL, "gpt-4o-mini");
  const routing = await resolveModelForGeneration({
    generationType: DOCUMENT_GENERATION_TYPES.flashcards,
    plan: "free",
  });
  assert.deepEqual(routing, { model: "gpt-4o-mini", reasoningEffort: null });
});

test("premium flashcard generation falls back to gpt-4.1-mini", async () => {
  assert.equal(FLASHCARD_GENERATION_MODEL, "gpt-4.1-mini");
  const routing = await resolveModelForGeneration({
    generationType: DOCUMENT_GENERATION_TYPES.flashcards,
    plan: "premium",
  });
  assert.deepEqual(routing, { model: "gpt-4.1-mini", reasoningEffort: null });
});

test("summary routing falls back to the default generation model when config is unavailable", async () => {
  assert.equal(DEFAULT_GENERATION_MODEL, "gpt-4.1-nano");
  const routing = await resolveModelForGeneration({
    generationType: DOCUMENT_GENERATION_TYPES.summary,
    plan: "free",
  });
  assert.deepEqual(routing, { model: "gpt-4.1-nano", reasoningEffort: null });
});

test("exam generation falls back to gpt-5.4-mini with low reasoning", async () => {
  assert.equal(EXAM_GENERATION_MODEL, "gpt-5.4-mini");
  const routing = await resolveModelForGeneration({
    generationType: DOCUMENT_GENERATION_TYPES.exam,
    plan: "premium",
  });
  assert.deepEqual(routing, { model: "gpt-5.4-mini", reasoningEffort: "low" });
});
