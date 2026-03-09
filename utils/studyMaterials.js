import OpenAI from "openai";

import {
  DOCUMENT_GENERATION_TYPES,
  normalizeExamQuestion,
  normalizeFlashcard,
  normalizeGenerationOptions,
  sortGenerationExcerpts,
  isUsableGenerationExcerpt,
} from "./documentGeneration.js";
import { captureSentryException } from "./sentry.js";

let client;

export const MODEL_NAME = "gpt-4o-mini";

const ESTIMATED_CHARS_PER_TOKEN = 4;
const INPUT_TOKEN_LIMITS = {
  [DOCUMENT_GENERATION_TYPES.summary]: 12_000,
  [DOCUMENT_GENERATION_TYPES.flashcards]: 10_000,
  [DOCUMENT_GENERATION_TYPES.exam]: 10_000,
};
const OUTPUT_TOKEN_LIMITS = {
  [DOCUMENT_GENERATION_TYPES.summary]: 1_200,
  [DOCUMENT_GENERATION_TYPES.flashcards]: 1_600,
  [DOCUMENT_GENERATION_TYPES.exam]: 2_200,
};

function getClient() {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error("OPENAI_API_KEY is required for study material generation");
    error.code = "generation_config_missing";
    throw error;
  }

  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  return client;
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function estimateTokenCountFromChars(charCount) {
  return Math.max(1, Math.ceil(Math.max(0, Number(charCount) || 0) / ESTIMATED_CHARS_PER_TOKEN));
}

export function estimateTokenCountFromText(text = "") {
  return estimateTokenCountFromChars(normalizeString(text).length);
}

function getSourceSizeTier(estimatedInputTokens) {
  if (estimatedInputTokens <= 1_000) {
    return "short";
  }

  if (estimatedInputTokens <= 3_000) {
    return "medium";
  }

  return "long";
}

function getExcerptLabel(excerpt) {
  const pageLabel = Number.isFinite(Number(excerpt?.slideOrPage))
    ? `Page ${Number(excerpt.slideOrPage)}`
    : "Page ?";
  const typeLabel = normalizeString(excerpt?.excerptType).replaceAll("_", " ") || "excerpt";

  return `[${pageLabel} | ${typeLabel}]`;
}

function buildExcerptBlock(excerpt, maxContentChars = Infinity) {
  const content = normalizeString(excerpt?.content).slice(0, maxContentChars);
  return `${getExcerptLabel(excerpt)}\n${content}`;
}

function dedupeIndices(indices) {
  return [...new Set(indices)].sort((left, right) => left - right);
}

function pickCoverageSampleIndices(count, targetCount) {
  if (count <= targetCount) {
    return Array.from({ length: count }, (_, index) => index);
  }

  if (targetCount <= 1) {
    return [0];
  }

  const indices = [];
  for (let index = 0; index < targetCount; index += 1) {
    const nextIndex = Math.round((index * (count - 1)) / (targetCount - 1));
    indices.push(nextIndex);
  }

  return dedupeIndices(indices);
}

export function prepareGenerationSourceMaterial(excerpts, generationType) {
  const usableExcerpts = sortGenerationExcerpts(excerpts).filter(isUsableGenerationExcerpt);
  const maxChars = INPUT_TOKEN_LIMITS[generationType] * ESTIMATED_CHARS_PER_TOKEN;

  if (usableExcerpts.length === 0) {
    const error = new Error("No usable excerpts available for generation");
    error.code = "no_usable_excerpts";
    throw error;
  }

  const fullText = usableExcerpts.map((excerpt) => buildExcerptBlock(excerpt)).join("\n\n");
  if (fullText.length <= maxChars) {
    return {
      text: fullText,
      sampled: false,
      totalExcerptCount: usableExcerpts.length,
      selectedExcerptCount: usableExcerpts.length,
      estimatedInputTokens: estimateTokenCountFromText(fullText),
    };
  }

  const targetSampleCount = Math.min(
    usableExcerpts.length,
    Math.max(4, Math.floor(maxChars / 1_400)),
  );
  const sampleIndices = pickCoverageSampleIndices(usableExcerpts.length, targetSampleCount);
  const sampledExcerpts = sampleIndices.map((index) => usableExcerpts[index]);
  const reservedChars = sampledExcerpts.reduce(
    (total, excerpt) => total + getExcerptLabel(excerpt).length + 2,
    0,
  ) + ((sampledExcerpts.length - 1) * 2);
  const perExcerptChars = Math.max(
    250,
    Math.floor((maxChars - reservedChars) / Math.max(1, sampledExcerpts.length)),
  );
  const sampledText = sampledExcerpts
    .map((excerpt) => buildExcerptBlock(excerpt, perExcerptChars))
    .join("\n\n")
    .slice(0, maxChars);

  return {
    text: sampledText,
    sampled: true,
    totalExcerptCount: usableExcerpts.length,
    selectedExcerptCount: sampledExcerpts.length,
    estimatedInputTokens: estimateTokenCountFromText(sampledText),
  };
}

function getSummaryWordTarget(length, sizeTier) {
  const targets = {
    short: { short: 120, medium: 180, long: 260 },
    medium: { short: 220, medium: 350, long: 500 },
    long: { short: 320, medium: 500, long: 750 },
  };

  return targets[length][sizeTier];
}

function getFlashcardTargetCount(sizeTier) {
  if (sizeTier === "short") {
    return 6;
  }

  if (sizeTier === "medium") {
    return 10;
  }

  return 15;
}

function getExamMaxCount(sizeTier) {
  if (sizeTier === "short") {
    return 5;
  }

  if (sizeTier === "medium") {
    return 10;
  }

  return 15;
}

function buildSystemPrompt(generationType) {
  if (generationType === DOCUMENT_GENERATION_TYPES.summary) {
    return "You produce concise study summaries as strict JSON. Return valid JSON only.";
  }

  if (generationType === DOCUMENT_GENERATION_TYPES.flashcards) {
    return "You produce high-quality study flashcards as strict JSON. Return valid JSON only.";
  }

  return "You produce study exams as strict JSON. Return valid JSON only.";
}

function buildSummaryPrompt(text, language, options, sourceTier, sampled) {
  const languageName = language === "arabic" ? "Arabic" : "English";
  const targetWords = getSummaryWordTarget(options.length, sourceTier);

  return `Create a study summary in ${languageName}.

Return valid JSON only with this shape:
{"text":"..."}

Rules:
- Focus on the most important ideas, definitions, processes, and takeaways.
- Keep the summary around ${targetWords} words.
- Use concise prose with short paragraphs or bullet-like sentences inside the text.
- Do not add markdown fences.
- If the source is partial, say only what is supported by the text.

Source note: ${sampled ? "This is a representative coverage sample across the document." : "This is the full usable extracted text."}

Study material:
"""
${text}
"""`;
}

function buildFlashcardsPrompt(text, language, options, sourceTier, sampled) {
  const languageName = language === "arabic" ? "Arabic" : "English";
  const cardCount = getFlashcardTargetCount(sourceTier);

  return `Create study flashcards in ${languageName}.

Return valid JSON only with this shape:
{"cards":[{"question":"...","answer":"..."}]}

Rules:
- Generate exactly ${cardCount} flashcards.
- Each flashcard must have a precise question and a concise answer.
- ${options.includeExplanations ? 'Also include "explanation" with 1 short sentence per card.' : 'Do not include explanations.'}
- Cover concepts across the document instead of repeating the same point.
- Do not add markdown fences.

Source note: ${sampled ? "This is a representative coverage sample across the document." : "This is the full usable extracted text."}

Study material:
"""
${text}
"""`;
}

function buildExamPrompt(text, language, questionCount, sampled) {
  const languageName = language === "arabic" ? "Arabic" : "English";

  return `Create a study exam in ${languageName}.

Return valid JSON only with this shape:
{"questions":[{"type":"mcq","question":"...","options":["..."],"correctAnswer":"...","explanation":"..."},{"type":"true_false","question":"...","correctAnswer":"True","explanation":"..."},{"type":"short","question":"...","correctAnswer":"...","explanation":"..."}]}

Rules:
- Generate exactly ${questionCount} questions.
- Include a balanced mix of "mcq", "true_false", and "short" when the source supports it.
- MCQ items must have exactly 4 options, and correctAnswer must match one option exactly.
- Every question must include an explanation.
- Do not add markdown fences.

Source note: ${sampled ? "This is a representative coverage sample across the document." : "This is the full usable extracted text."}

Study material:
"""
${text}
"""`;
}

function cleanJsonResponse(raw) {
  return normalizeString(raw)
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
}

function normalizeSummaryOutput(parsed) {
  const text = normalizeString(parsed?.text ?? parsed?.summary);
  return { text };
}

function normalizeFlashcardsOutput(parsed) {
  const cards = Array.isArray(parsed?.cards)
    ? parsed.cards.map(normalizeFlashcard).filter(Boolean)
    : [];

  return { cards };
}

function normalizeExamOutput(parsed) {
  const questions = Array.isArray(parsed?.questions)
    ? parsed.questions.map(normalizeExamQuestion).filter(Boolean)
    : [];

  return { questions };
}

function normalizeGenerationModelOutput(generationType, parsed) {
  if (generationType === DOCUMENT_GENERATION_TYPES.summary) {
    return normalizeSummaryOutput(parsed);
  }

  if (generationType === DOCUMENT_GENERATION_TYPES.flashcards) {
    return normalizeFlashcardsOutput(parsed);
  }

  return normalizeExamOutput(parsed);
}

function assertNonEmptyGenerationOutput(generationType, output) {
  if (generationType === DOCUMENT_GENERATION_TYPES.summary && output.text) {
    return;
  }

  if (generationType === DOCUMENT_GENERATION_TYPES.flashcards && output.cards.length > 0) {
    return;
  }

  if (generationType === DOCUMENT_GENERATION_TYPES.exam && output.questions.length > 0) {
    return;
  }

  const error = new Error("Model response did not contain usable generation output");
  error.code = "invalid_generation_output";
  throw error;
}

function buildPromptForGeneration({ generationType, language, options, sourceText, sourceTier, sampled }) {
  if (generationType === DOCUMENT_GENERATION_TYPES.summary) {
    return {
      prompt: buildSummaryPrompt(sourceText, language, options, sourceTier, sampled),
      effectiveOptions: options,
    };
  }

  if (generationType === DOCUMENT_GENERATION_TYPES.flashcards) {
    return {
      prompt: buildFlashcardsPrompt(sourceText, language, options, sourceTier, sampled),
      effectiveOptions: {
        ...options,
        cardCount: getFlashcardTargetCount(sourceTier),
      },
    };
  }

  const effectiveQuestionCount = Math.min(options.questionCount, getExamMaxCount(sourceTier));
  return {
    prompt: buildExamPrompt(sourceText, language, effectiveQuestionCount, sampled),
    effectiveOptions: {
      ...options,
      questionCount: effectiveQuestionCount,
    },
  };
}

export async function generateStudyMaterialFromExcerpts({
  generationType,
  excerpts,
  language = "english",
  options = {},
}) {
  const normalizedOptions = normalizeGenerationOptions(generationType, options);
  const sourceMaterial = prepareGenerationSourceMaterial(excerpts, generationType);
  const sourceTier = getSourceSizeTier(sourceMaterial.estimatedInputTokens);
  const { prompt, effectiveOptions } = buildPromptForGeneration({
    generationType,
    language,
    options: normalizedOptions,
    sourceText: sourceMaterial.text,
    sourceTier,
    sampled: sourceMaterial.sampled,
  });

  try {
    const openai = getClient();
    const response = await openai.chat.completions.create({
      model: MODEL_NAME,
      temperature: 0.3,
      max_tokens: OUTPUT_TOKEN_LIMITS[generationType],
      messages: [
        { role: "system", content: buildSystemPrompt(generationType) },
        { role: "user", content: prompt },
      ],
    });

    const raw = response.choices?.[0]?.message?.content;
    if (!raw) {
      throw new Error("OpenAI returned an empty generation response");
    }

    const parsed = JSON.parse(cleanJsonResponse(raw));
    const output = normalizeGenerationModelOutput(generationType, parsed);
    assertNonEmptyGenerationOutput(generationType, output);

    return {
      output,
      modelUsed: response?.model || MODEL_NAME,
      usage: response?.usage || null,
      estimatedInputTokens: sourceMaterial.estimatedInputTokens,
      selectedExcerptCount: sourceMaterial.selectedExcerptCount,
      totalExcerptCount: sourceMaterial.totalExcerptCount,
      sampled: sourceMaterial.sampled,
      effectiveOptions,
    };
  } catch (error) {
    captureSentryException(error, {
      tags: {
        ai_phase: "generate_study_material",
        generationType,
      },
    });
    throw error;
  }
}
