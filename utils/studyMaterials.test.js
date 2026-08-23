import assert from "node:assert/strict";
import test from "node:test";

import { DOCUMENT_GENERATION_TYPES } from "./documentGeneration.js";
import {
  __studyMaterialsTestables,
  generateStudyMaterialFromExcerpts,
} from "./studyMaterials.js";

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

test("summary diagnostics capture empty GPT response metadata without requiring raw source text", () => {
  const response = {
    model: "gpt-5.5",
    choices: [
      {
        finish_reason: "length",
        message: {
          role: "assistant",
          content: "",
        },
      },
    ],
    usage: {
      prompt_tokens: 5100,
      completion_tokens: 7000,
      total_tokens: 12100,
      completion_tokens_details: {
        reasoning_tokens: 7000,
      },
    },
  };

  const error = __studyMaterialsTestables.createEmptySummaryOutputError(response, "");

  assert.equal(error.code, "empty_summary_output");
  assert.equal(error.diagnostics.model, "gpt-5.5");
  assert.equal(error.diagnostics.finishReason, "length");
  assert.equal(error.diagnostics.contentLength, 0);
  assert.equal(error.diagnostics.usage.reasoningTokens, 7000);
});

test("summary response content reader supports array-style chat message content", () => {
  const text = __studyMaterialsTestables.getChatMessageTextContent({
    content: [
      { type: "text", text: "Big Picture" },
      { type: "text", text: "Core Concepts" },
    ],
  });

  assert.equal(text, "Big Picture\nCore Concepts");
});

test("forced empty summary fallback keeps the configured model and reasoning params for every stage", async () => {
  const configuredModel = "gpt-5.4-mini";
  const returnedModel = "gpt-5.4-mini-2026-08-01";
  const calls = [];
  const finalText = [
    "## Title",
    "Configured Model Study Guide",
    "## Big Picture",
    "Overview.",
    "## Learning Outcomes",
    "• Learn the topic",
    "## Core Concepts",
    "Core concept.",
    "## Main Models / Frameworks",
    "Framework.",
    "## Comparisons",
    "| Item | Meaning |",
    "| --- | --- |",
    "| A | B |",
    "## Processes / Mechanisms",
    "Process.",
    "## Key Distinctions",
    "Distinction.",
    "## Exam-Level Takeaways",
    "• First takeaway",
    "• Second takeaway",
    "• Third takeaway",
    "## Common Pitfalls",
    "Pitfall.",
    "## What to Memorize",
    "Memory point.",
    "## One-Page Summary",
    "Recap.",
  ].join("\n");
  const structuredResponses = [
    { topics: ["Routing"] },
    { topics: ["Routing"], likely_exam_points: ["Configured model must persist"] },
    { text: "Draft summary" },
    { text: "Optimized summary" },
    { text: finalText },
  ];
  const openai = {
    chat: {
      completions: {
        async create(params) {
          calls.push(params);
          if (calls.length === 1) {
            return {
              model: returnedModel,
              choices: [{ finish_reason: "length", message: { content: "" } }],
              usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
            };
          }
          return {
            model: returnedModel,
            choices: [{ finish_reason: "stop", message: { content: JSON.stringify(structuredResponses.shift()) } }],
            usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
          };
        },
      },
    },
  };

  __studyMaterialsTestables.setOpenAiClientForTests(openai);
  try {
    const result = await generateStudyMaterialFromExcerpts({
      generationType: DOCUMENT_GENERATION_TYPES.summary,
      excerpts: [{ content: "Routing must remain trustworthy.", slideOrPage: 1, charOffset: 0, excerptType: "slide_text" }],
      language: "english",
      options: { length: "medium" },
      plan: "premium",
      modelRoutingResolver: async () => ({ model: configuredModel, reasoningEffort: "medium" }),
    });

    assert.equal(calls.length, 6);
    assert.equal(calls[0].model, configuredModel);
    for (const params of calls.slice(1)) {
      assert.equal(params.model, configuredModel);
      assert.equal(params.reasoning_effort, "medium");
      assert.ok(params.max_completion_tokens > 0);
      assert.equal(params.max_tokens, undefined);
      assert.equal(params.temperature, undefined);
    }
    assert.equal(result.modelUsed, returnedModel);
    assert.equal(result.effectiveOptions.summaryPipeline, "structured_fallback");
  } finally {
    __studyMaterialsTestables.setOpenAiClientForTests(null);
  }
});

test("structured summary fallback adds a title when format enforcement omits it", () => {
  const text = __studyMaterialsTestables.ensureSummaryStudyGuideTitle("## Big Picture\nDense reference material");

  assert.equal(text, "## Title\nStudy Guide\n\n## Big Picture\nDense reference material");
  assert.equal(
    __studyMaterialsTestables.ensureSummaryStudyGuideTitle("## Title\nPhysics deck"),
    "## Title\nPhysics deck",
  );
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

test("flashcard output normalization accepts strict JSON arrays", () => {
  const output = __studyMaterialsTestables.normalizeFlashcardsOutput([
    { front: "What is Enterprise Architecture?", back: "A discipline for aligning strategy, processes, people, and technology." },
    { front: "", back: "Invalid card" },
  ]);

  assert.deepEqual(output, {
    cards: [
      {
        question: "What is Enterprise Architecture?",
        answer: "A discipline for aligning strategy, processes, people, and technology.",
      },
    ],
  });
});

test("flashcard QA prompt requires fixing issues and returning only a JSON array", () => {
  const prompt = __studyMaterialsTestables.buildFlashcardQaPrompt(
    [
      { question: "Explain EA", answer: "EA is about lots of things including strategy, technology, people, process, and governance with many related details." },
    ],
    "english",
    "Enterprise Architecture aligns strategy, processes, people, and technology.",
    16,
  );

  assert.match(prompt, /Validate AND improve flashcards/);
  assert.match(prompt, /You must FIX issues/);
  assert.match(prompt, /Return ONLY the improved JSON array/);
  assert.match(prompt, /"front":"question or prompt"/);
  assert.match(prompt, /"back":"clear, concise answer"/);
});

test("QA completion params branch consistently for standard and reasoning models", () => {
  const messages = [{ role: "user", content: "Validate" }];
  assert.deepEqual(__studyMaterialsTestables.buildModelCompletionParams({
    model: "gpt-4.1-mini",
    messages,
    maxTokens: 3_800,
    temperature: 0.15,
    reasoningEffort: null,
  }), {
    model: "gpt-4.1-mini",
    messages,
    temperature: 0.15,
    max_tokens: 3_800,
  });
  assert.deepEqual(__studyMaterialsTestables.buildModelCompletionParams({
    model: "gpt-5.4-mini",
    messages,
    maxTokens: 6_000,
    temperature: 0.15,
    reasoningEffort: "medium",
  }), {
    model: "gpt-5.4-mini",
    messages,
    reasoning_effort: "medium",
    max_completion_tokens: 6_000,
  });
});

test("exam target counts follow source-size question bands", () => {
  assert.equal(__studyMaterialsTestables.getExamTargetCount("short", 5), 10);
  assert.equal(__studyMaterialsTestables.getExamTargetCount("short", 15), 15);
  assert.equal(__studyMaterialsTestables.getExamTargetCount("medium", 10), 15);
  assert.equal(__studyMaterialsTestables.getExamTargetCount("medium", 25), 25);
  assert.equal(__studyMaterialsTestables.getExamTargetCount("long", 15), 25);
});

test("exam prompt requests gpt-4o-quality mock exam structure and distribution", () => {
  const prompt = __studyMaterialsTestables.buildExamPrompt(
    "Enterprise Architecture aligns strategy, people, processes, and technology.",
    "english",
    20,
    {},
    false,
  );

  assert.match(prompt, /Create a high-quality mock exam/);
  assert.match(prompt, /Return exactly this JSON object shape/);
  assert.match(prompt, /70-80% MCQ and 20-30% True\/False/);
  assert.match(prompt, /produce 14-16 MCQs and 4-6 True\/False questions/);
  assert.match(prompt, /correctAnswer must exactly match the full text of the correct option/);
  assert.match(prompt, /correctAnswer must be a JSON boolean true or false/);
});

test("exam QA prompt requires fixing correctness, distractors, clarity, and coverage", () => {
  const prompt = __studyMaterialsTestables.buildExamQaPrompt(
    [
      {
        type: "mcq",
        question: "What is EA?",
        options: ["Architecture", "A database", "A server", "A diagram"],
        correctAnswer: "Architecture",
        explanation: "EA is architecture.",
      },
      {
        type: "true_false",
        question: "EA is only about software.",
        correctAnswer: "False",
        explanation: "EA also includes people and processes.",
      },
    ],
    "english",
    "Enterprise Architecture aligns strategy, people, processes, and technology.",
    10,
  );

  assert.match(prompt, /Fix the exam until it reaches production quality/);
  assert.match(prompt, /ensure every correct answer is actually correct/);
  assert.match(prompt, /realistic topic-related distractors/);
  assert.match(prompt, /remove duplicate or overlapping questions/);
  assert.match(prompt, /definitions, models, comparisons, and key concepts/);
  assert.match(prompt, /Return ONLY the improved JSON object/);
  assert.doesNotMatch(prompt, /Use model: gpt-4o/);
});

test("exam QA input serializes true false answers as JSON booleans", () => {
  assert.deepEqual(
    __studyMaterialsTestables.toExamQaInput([
      {
        type: "true_false",
        question: "EA only concerns software systems.",
        correctAnswer: "False",
        explanation: "EA also includes people, process, and strategy.",
      },
    ]),
    [
      {
        type: "true_false",
        question: "EA only concerns software systems.",
        correctAnswer: false,
        explanation: "EA also includes people, process, and strategy.",
      },
    ],
  );
});
