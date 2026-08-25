import assert from "node:assert/strict";
import test from "node:test";

import { DOCUMENT_GENERATION_TYPES } from "./documentGeneration.js";
import {
  __studyMaterialsTestables,
  generateStudyMaterialFromExcerpts,
} from "./studyMaterials.js";

function makeFlashcards(count) {
  return Array.from({ length: count }, (_, index) => ({
    front: `Question ${index + 1}?`,
    back: `Answer ${index + 1}`,
    sourceQuote: `Question ${index + 1} Answer ${index + 1} Correct ${index + 1} Explanation ${index + 1}`,
  }));
}

function makeQaSource(count = 50) {
  return Array.from(
    { length: count },
    (_, index) => `Question ${index + 1} Answer ${index + 1} Correct ${index + 1} Explanation ${index + 1} documented concept.`,
  ).join(" ");
}

function makeExamQuestions(count) {
  return Array.from({ length: count }, (_, index) => {
    const sourceQuote = `Question ${index + 1} Answer ${index + 1} Correct ${index + 1} Explanation ${index + 1}`;
    if (index % 4 === 3) {
      return {
        type: "true_false",
        question: `Statement ${index + 1}`,
        correctAnswer: true,
        explanation: `Explanation ${index + 1}`,
        sourceQuote,
      };
    }

    const correctAnswer = `Correct ${index + 1}`;
    return {
      type: "mcq",
      question: `Question ${index + 1}?`,
      options: [correctAnswer, `Wrong A ${index + 1}`, `Wrong B ${index + 1}`, `Wrong C ${index + 1}`],
      correctAnswer,
      explanation: `Explanation ${index + 1}`,
      sourceQuote,
    };
  });
}

function makeQaResponse(content, tokenBase) {
  return {
    model: "gpt-5.4-mini-2026-08-01",
    choices: [{ message: { content: JSON.stringify(content) } }],
    usage: {
      prompt_tokens: tokenBase,
      completion_tokens: tokenBase / 2,
      total_tokens: tokenBase * 1.5,
    },
  };
}

const THIN_SOURCE_FACTS = [
  "Photosynthesis converts light energy into chemical energy in plant cells",
  "Chlorophyll absorbs photons and powers light-dependent reactions",
  "Water splitting releases oxygen and supplies electrons",
  "The Calvin cycle fixes carbon dioxide into glucose",
  "Environmental conditions influence the overall rate of photosynthesis",
];

function makeRepeatedThinSourceExcerpts(count = 63) {
  return Array.from({ length: count }, (_, index) => ({
    slideOrPage: index + 1,
    excerptType: "slide_text",
    charOffset: 0,
    content: `${THIN_SOURCE_FACTS.join(". ")}. Iteration ${index + 1} adds more content for recovery testing.`,
  }));
}

function makeThinGroundedFlashcards() {
  return [
    { front: "What does photosynthesis convert?", back: "Light energy into chemical energy.", sourceQuote: THIN_SOURCE_FACTS[0] },
    { front: "What does chlorophyll absorb?", back: "Chlorophyll absorbs photons.", sourceQuote: THIN_SOURCE_FACTS[1] },
    { front: "What does water splitting release?", back: "Water splitting releases oxygen.", sourceQuote: THIN_SOURCE_FACTS[2] },
    { front: "What does the Calvin cycle fix?", back: "The Calvin cycle fixes carbon dioxide.", sourceQuote: THIN_SOURCE_FACTS[3] },
    { front: "What influences the rate of photosynthesis?", back: "Environmental conditions influence the rate.", sourceQuote: THIN_SOURCE_FACTS[4] },
  ];
}

function makeThinGroundedExamQuestions() {
  return [
    {
      type: "mcq",
      question: "What kind of energy does photosynthesis convert?",
      options: ["Light energy", "Chemical energy", "Environmental conditions", "Water splitting"],
      correctAnswer: "Light energy",
      explanation: "Photosynthesis converts light energy into chemical energy.",
      sourceQuote: THIN_SOURCE_FACTS[0],
    },
    {
      type: "mcq",
      question: "What does chlorophyll absorb?",
      options: ["Photons", "Oxygen", "Glucose", "Electrons"],
      correctAnswer: "Photons",
      explanation: "Chlorophyll absorbs photons.",
      sourceQuote: THIN_SOURCE_FACTS[1],
    },
    {
      type: "mcq",
      question: "What does water splitting release?",
      options: ["Oxygen", "Glucose", "Carbon dioxide", "Photons"],
      correctAnswer: "Oxygen",
      explanation: "Water splitting releases oxygen.",
      sourceQuote: THIN_SOURCE_FACTS[2],
    },
    {
      type: "mcq",
      question: "What does the Calvin cycle fix?",
      options: ["Carbon dioxide", "Oxygen", "Photons", "Environmental conditions"],
      correctAnswer: "Carbon dioxide",
      explanation: "The Calvin cycle fixes carbon dioxide.",
      sourceQuote: THIN_SOURCE_FACTS[3],
    },
    {
      type: "true_false",
      question: "Environmental conditions influence the rate of photosynthesis.",
      correctAnswer: true,
      explanation: "Environmental conditions influence the overall rate.",
      sourceQuote: THIN_SOURCE_FACTS[4],
    },
  ];
}

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

test("source grounding inventory deduplicates repeated facts and ignores iteration filler", () => {
  const repeatedSource = makeRepeatedThinSourceExcerpts()
    .map((excerpt) => `[Page ${excerpt.slideOrPage} | slide text]\n${excerpt.content}`)
    .join("\n\n");
  const grounding = __studyMaterialsTestables.inspectSourceGrounding(repeatedSource);

  assert.equal(grounding.distinctStatementCount, 5);
  assert.equal(__studyMaterialsTestables.resolveGroundedTargetCount(48, grounding), 5);
  assert.equal(__studyMaterialsTestables.resolveGroundedTargetCount(25, grounding), 5);
});

test("source-limited prompts expose the smaller effective count without changing rich-source targets", () => {
  const thinSource = `${THIN_SOURCE_FACTS.join(". ")}.`;
  const flashcards = __studyMaterialsTestables.buildPromptForGeneration({
    generationType: DOCUMENT_GENERATION_TYPES.flashcards,
    language: "english",
    options: { includeExplanations: false },
    sourceText: thinSource,
    sourceTier: "long",
    sampled: false,
  });
  const exam = __studyMaterialsTestables.buildPromptForGeneration({
    generationType: DOCUMENT_GENERATION_TYPES.exam,
    language: "english",
    options: { questionCount: 15 },
    sourceText: thinSource,
    sourceTier: "long",
    sampled: false,
  });

  assert.equal(flashcards.effectiveOptions.requestedCardCount, 48);
  assert.equal(flashcards.effectiveOptions.cardCount, 5);
  assert.equal(flashcards.effectiveOptions.sourceLimited, true);
  assert.match(flashcards.prompt, /Generate up to 5 flashcards/);
  assert.equal(exam.effectiveOptions.requestedQuestionCount, 25);
  assert.equal(exam.effectiveOptions.questionCount, 5);
  assert.equal(exam.effectiveOptions.sourceLimited, true);
  assert.match(exam.prompt, /Generate up to 5 questions/);
});

test("grounding verifier rejects fabricated named facts even when a real quote is attached", () => {
  const sourceText = `${THIN_SOURCE_FACTS.join(". ")}.`;
  const output = __studyMaterialsTestables.normalizeGroundedQaOutput(
    DOCUMENT_GENERATION_TYPES.flashcards,
    [
      ...makeThinGroundedFlashcards().slice(0, 1),
      {
        front: "What does RuBisCO catalyze in the Calvin cycle?",
        back: "RuBisCO catalyzes carbon fixation.",
        sourceQuote: THIN_SOURCE_FACTS[3],
      },
      {
        front: "What does photosynthesis convert?",
        back: "Photosynthesis converts light energy.",
        sourceQuote: "This supporting quote does not appear in the source",
      },
    ],
    sourceText,
  );

  assert.equal(output.output.cards.length, 1);
  assert.equal(output.grounding.rejectedCount, 2);
  assert.equal(output.grounding.rejectedItems[0].reason, "distinctive_term_absent_from_source");
  assert.deepEqual(output.grounding.rejectedItems[0].unsupportedDistinctiveTerms, ["RuBisCO"]);
  assert.equal(output.grounding.rejectedItems[1].reason, "missing_or_nonverbatim_source_quote");
});

test("numbered source citations resolve into exact supporting quotes without copying brittle PDF text", () => {
  const sourceText = `${THIN_SOURCE_FACTS.join(". ")}.`;
  const output = __studyMaterialsTestables.normalizeGroundedQaOutput(
    DOCUMENT_GENERATION_TYPES.flashcards,
    [
      {
        front: "What does the Calvin cycle fix?",
        back: "The Calvin cycle fixes carbon dioxide.",
        sourceId: "S004",
      },
      {
        front: "What does RuBisCO do in the Calvin cycle?",
        back: "RuBisCO fixes carbon dioxide.",
        sourceId: "S004",
      },
      {
        front: "What does chlorophyll absorb?",
        back: "Chlorophyll absorbs photons.",
        sourceId: "S099",
      },
    ],
    sourceText,
  );

  assert.equal(output.output.cards.length, 1);
  assert.equal(output.grounding.items[0].sourceId, "S004");
  assert.equal(output.grounding.items[0].sourceQuote, THIN_SOURCE_FACTS[3]);
  assert.equal(output.grounding.items[0].sourceQuoteIsVerbatim, true);
  assert.equal(output.grounding.rejectedItems[0].reason, "distinctive_term_absent_from_source");
  assert.equal(output.grounding.rejectedItems[1].reason, "missing_or_nonverbatim_source_quote");
});

test("thin repeated source succeeds with five verified cards instead of fabricating the long-source target", async () => {
  const calls = [];
  const cards = makeThinGroundedFlashcards();
  const responses = [
    makeQaResponse(cards, 100),
    makeQaResponse(cards, 120),
  ];
  __studyMaterialsTestables.setOpenAiClientForTests({
    chat: {
      completions: {
        async create(params) {
          calls.push(params);
          return responses.shift();
        },
      },
    },
  });

  try {
    const result = await generateStudyMaterialFromExcerpts({
      generationType: DOCUMENT_GENERATION_TYPES.flashcards,
      excerpts: makeRepeatedThinSourceExcerpts(),
      language: "english",
      options: { includeExplanations: false },
      plan: "premium",
      modelRoutingResolver: async () => ({ model: "gpt-4.1-mini", reasoningEffort: null }),
    });

    assert.equal(calls.length, 2);
    assert.equal(result.effectiveOptions.requestedCardCount, 48);
    assert.equal(result.effectiveOptions.cardCount, 5);
    assert.equal(result.effectiveOptions.sourceLimited, true);
    assert.equal(result.output.cards.length, 5);
    assert.equal(result.grounding.items.length, 5);
    assert.ok(result.grounding.items.every((item) => item.grounded && item.sourceQuoteIsVerbatim));
    assert.ok(result.output.cards.every((card) => !("sourceQuote" in card)));
  } finally {
    __studyMaterialsTestables.setOpenAiClientForTests(null);
  }
});

test("thin repeated source succeeds with five verified exam questions instead of fabricating 25", async () => {
  const calls = [];
  const questions = makeThinGroundedExamQuestions();
  const responses = [
    makeQaResponse({ questions }, 100),
    makeQaResponse({ questions }, 120),
  ];
  __studyMaterialsTestables.setOpenAiClientForTests({
    chat: {
      completions: {
        async create(params) {
          calls.push(params);
          return responses.shift();
        },
      },
    },
  });

  try {
    const result = await generateStudyMaterialFromExcerpts({
      generationType: DOCUMENT_GENERATION_TYPES.exam,
      excerpts: makeRepeatedThinSourceExcerpts(),
      language: "english",
      options: { questionCount: 15 },
      plan: "premium",
      modelRoutingResolver: async () => ({ model: "gpt-5.4-mini", reasoningEffort: "low" }),
    });

    assert.equal(calls.length, 2);
    assert.equal(result.effectiveOptions.requestedQuestionCount, 25);
    assert.equal(result.effectiveOptions.questionCount, 5);
    assert.equal(result.effectiveOptions.sourceLimited, true);
    assert.equal(result.output.questions.length, 5);
    assert.equal(result.grounding.items.length, 5);
    assert.ok(result.grounding.items.every((item) => item.grounded && item.sourceQuoteIsVerbatim));
    assert.ok(result.output.questions.every((question) => !("sourceQuote" in question)));
  } finally {
    __studyMaterialsTestables.setOpenAiClientForTests(null);
  }
});

test("flashcard prompt treats the target as a source-grounded upper bound without explanations", () => {
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
  assert.match(prompt, /Generate up to 30 flashcards/);
  assert.match(prompt, /Do not use outside knowledge/);
  assert.match(prompt, /return fewer cards and stop/);
  assert.match(prompt, /Never pad the set with fabricated/);
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

test("flashcard QA prompt requires source evidence and never invents to fill its upper bound", () => {
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
  assert.match(prompt, /Return at most 16 cards/);
  assert.match(prompt, /sourceId/);
  assert.match(prompt, /\[S001\]/);
  assert.match(prompt, /return the smaller supported set/);
});

test("flashcard QA preserves verified items and requests only the missing grounded card", async () => {
  const calls = [];
  const responses = [
    makeQaResponse(makeFlashcards(2), 20),
    makeQaResponse(makeFlashcards(3).slice(2), 30),
  ];
  __studyMaterialsTestables.setOpenAiClientForTests({
    chat: {
      completions: {
        async create(params) {
          calls.push(params);
          return responses.shift();
        },
      },
    },
  });

  try {
    const result = await __studyMaterialsTestables.validateAndImproveFlashcards({
      cards: makeFlashcards(3),
      language: "english",
      sourceText: makeQaSource(),
      targetCount: 3,
      model: "gpt-5.4-mini",
      reasoningEffort: "low",
    });

    assert.equal(calls.length, 2);
    assert.match(calls[1].messages[1].content, /COUNT REPAIR REQUIRED/);
    assert.match(calls[1].messages[1].content, /returned 2 source-verified flashcards/);
    assert.match(calls[1].messages[1].content, /Return exactly 1 ADDITIONAL source-grounded flashcards/);
    assert.equal(result.output.cards.length, 3);
    assert.deepEqual(result.output.cards.map((card) => card.question), [
      "Question 1?",
      "Question 2?",
      "Question 3?",
    ]);
    assert.deepEqual(result.usage, {
      prompt_tokens: 50,
      completion_tokens: 25,
      total_tokens: 75,
    });
  } finally {
    __studyMaterialsTestables.setOpenAiClientForTests(null);
  }
});

test("flashcard QA fails clearly when count repair is still short", async () => {
  __studyMaterialsTestables.setOpenAiClientForTests({
    chat: {
      completions: {
        async create() {
          return makeQaResponse(makeFlashcards(2), 20);
        },
      },
    },
  });

  try {
    await assert.rejects(
      () => __studyMaterialsTestables.validateAndImproveFlashcards({
        cards: makeFlashcards(3),
        language: "english",
        sourceText: makeQaSource(),
        targetCount: 3,
        model: "gpt-4.1-mini",
      }),
      (error) => error?.code === "qa_item_count_mismatch"
        && error.actualCount === 2
        && error.targetCount === 3,
    );
  } finally {
    __studyMaterialsTestables.setOpenAiClientForTests(null);
  }
});

test("flashcard QA rejects wholly unverified output instead of persisting fabricated cards", async () => {
  __studyMaterialsTestables.setOpenAiClientForTests({
    chat: {
      completions: {
        async create() {
          return makeQaResponse([
            {
              front: "What does RuBisCO catalyze?",
              back: "RuBisCO catalyzes carbon fixation.",
              sourceQuote: "RuBisCO catalyzes carbon fixation",
            },
          ], 20);
        },
      },
    },
  });

  try {
    await assert.rejects(
      () => __studyMaterialsTestables.validateAndImproveFlashcards({
        cards: makeThinGroundedFlashcards(),
        language: "english",
        sourceText: `${THIN_SOURCE_FACTS.join(". ")}.`,
        targetCount: 5,
        model: "gpt-4.1-mini",
      }),
      (error) => error?.code === "ungrounded_generation_output" && error.rejectedCount === 1,
    );
  } finally {
    __studyMaterialsTestables.setOpenAiClientForTests(null);
  }
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
  assert.match(prompt, /Generate up to 20 questions/);
  assert.match(prompt, /Do not use outside knowledge/);
  assert.match(prompt, /return fewer questions and stop/);
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
  assert.match(prompt, /Return at most 10 questions/);
  assert.match(prompt, /sourceId/);
  assert.match(prompt, /\[S001\]/);
  assert.match(prompt, /return the smaller supported set/);
  assert.doesNotMatch(prompt, /Use model: gpt-4o/);
});

test("exam QA preserves verified questions and requests only the missing grounded item", async () => {
  const calls = [];
  const responses = [
    makeQaResponse({ questions: makeExamQuestions(3) }, 40),
    makeQaResponse({ questions: makeExamQuestions(4).slice(3) }, 60),
  ];
  __studyMaterialsTestables.setOpenAiClientForTests({
    chat: {
      completions: {
        async create(params) {
          calls.push(params);
          return responses.shift();
        },
      },
    },
  });

  try {
    const result = await __studyMaterialsTestables.validateAndImproveExam({
      questions: makeExamQuestions(4),
      language: "english",
      sourceText: makeQaSource(),
      targetCount: 4,
      model: "gpt-5.4-mini",
      reasoningEffort: "low",
    });

    assert.equal(calls.length, 2);
    assert.match(calls[1].messages[1].content, /COUNT REPAIR REQUIRED/);
    assert.match(calls[1].messages[1].content, /returned 3 source-verified questions/);
    assert.match(calls[1].messages[1].content, /Return exactly 1 ADDITIONAL source-grounded questions/);
    assert.equal(result.output.questions.length, 4);
  } finally {
    __studyMaterialsTestables.setOpenAiClientForTests(null);
  }
});

test("exam QA fails clearly when the count-repair response is still short", async () => {
  __studyMaterialsTestables.setOpenAiClientForTests({
    chat: {
      completions: {
        async create() {
          return makeQaResponse({ questions: makeExamQuestions(3) }, 40);
        },
      },
    },
  });

  try {
    await assert.rejects(
      () => __studyMaterialsTestables.validateAndImproveExam({
        questions: makeExamQuestions(4),
        language: "english",
        sourceText: makeQaSource(),
        targetCount: 4,
        model: "gpt-5.4-mini",
        reasoningEffort: "low",
      }),
      (error) => error?.code === "qa_item_count_mismatch"
        && error.actualCount === 3
        && error.targetCount === 4,
    );
  } finally {
    __studyMaterialsTestables.setOpenAiClientForTests(null);
  }
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
