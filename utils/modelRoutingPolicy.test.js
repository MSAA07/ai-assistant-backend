import assert from "node:assert/strict";
import test from "node:test";

import { DOCUMENT_GENERATION_TYPES } from "./documentGeneration.js";
import {
  DEFAULT_GENERATION_MODEL,
  FLASHCARD_GENERATION_MODEL,
  GPT55_SUMMARY_MODEL,
  resolveModelForGeneration,
} from "./modelRoutingPolicy.js";

test("flashcard generation always routes to gpt-4o", () => {
  assert.equal(FLASHCARD_GENERATION_MODEL, "gpt-4o");
  assert.equal(
    resolveModelForGeneration({ generationType: DOCUMENT_GENERATION_TYPES.flashcards }),
    "gpt-4o",
  );
});

test("summary and exam routing keep their existing model policy", () => {
  assert.equal(
    resolveModelForGeneration({ generationType: DOCUMENT_GENERATION_TYPES.summary }),
    GPT55_SUMMARY_MODEL,
  );
  assert.equal(
    resolveModelForGeneration({ generationType: DOCUMENT_GENERATION_TYPES.exam }),
    DEFAULT_GENERATION_MODEL,
  );
});
