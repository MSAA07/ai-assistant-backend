import assert from "node:assert/strict";
import test from "node:test";

import { __studyMaterialsTestables } from "./studyMaterials.js";

test("summary cleanup normalizes headings, bullets, separators, and spacing", () => {
  const cleaned = __studyMaterialsTestables.cleanSummaryText(`
# 1. Learning Outcomes

- Explain the model
* Compare the concepts


---

## Core Concepts:

• Enterprise: scoped activity being studied
`);

  assert.equal(cleaned, [
    "## Learning Outcomes",
    "• Explain the model",
    "• Compare the concepts",
    "",
    "## Core Concepts",
    "• Enterprise: scoped activity being studied",
  ].join("\n"));
});

test("flashcard target counts match exam-ready coverage bands", () => {
  assert.equal(__studyMaterialsTestables.getFlashcardTargetCount("short"), 16);
  assert.equal(__studyMaterialsTestables.getFlashcardTargetCount("medium"), 30);
  assert.equal(__studyMaterialsTestables.getFlashcardTargetCount("long"), 48);
});

test("flashcard prompt requests strict front/back JSON array without explanations", () => {
  const prompt = __studyMaterialsTestables.buildFlashcardsPrompt(
    "Enterprise Architecture connects strategy, process, people, and technology.",
    "english",
    { includeExplanations: true },
    "medium",
    false,
  );

  assert.match(prompt, /Return a JSON array of flashcards/);
  assert.match(prompt, /"front":"question or prompt"/);
  assert.match(prompt, /"back":"clear, concise answer"/);
  assert.match(prompt, /Generate exactly 30 flashcards/);
  assert.match(prompt, /Do not include explanations or any fields other than "front" and "back"/);
});
