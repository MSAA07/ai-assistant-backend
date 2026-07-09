import assert from "node:assert/strict";
import test from "node:test";

import { DOCUMENT_GENERATION_TYPES } from "./documentGeneration.js";
import {
  DEFAULT_GENERATION_MODEL,
  EXAM_GENERATION_MODEL,
  FLASHCARD_GENERATION_MODEL,
  resolveModelForGeneration,
} from "./modelRoutingPolicy.js";

test("flashcard generation falls back to gpt-4o when config is unavailable", async () => {
  assert.equal(FLASHCARD_GENERATION_MODEL, "gpt-4o");
  const routing = await resolveModelForGeneration({
    generationType: DOCUMENT_GENERATION_TYPES.flashcards,
    plan: "free",
  });
  assert.deepEqual(routing, { model: "gpt-4o", reasoningEffort: null });
});

test("summary routing falls back to the default generation model when config is unavailable", async () => {
  assert.equal(DEFAULT_GENERATION_MODEL, "gpt-4o-mini");
  const routing = await resolveModelForGeneration({
    generationType: DOCUMENT_GENERATION_TYPES.summary,
    plan: "free",
  });
  assert.deepEqual(routing, { model: "gpt-4o-mini", reasoningEffort: null });
});

test("exam generation falls back to gpt-4o when config is unavailable", async () => {
  assert.equal(EXAM_GENERATION_MODEL, "gpt-4o");
  const routing = await resolveModelForGeneration({
    generationType: DOCUMENT_GENERATION_TYPES.exam,
    plan: "premium",
  });
  assert.deepEqual(routing, { model: "gpt-4o", reasoningEffort: null });
});
