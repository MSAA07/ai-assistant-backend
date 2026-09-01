import OpenAI from "openai";
import crypto from "crypto";

import {
  DOCUMENT_GENERATION_TYPES,
  normalizeExamQuestion,
  normalizeFlashcard,
  normalizeGenerationOptions,
  sortGenerationExcerpts,
  isUsableGenerationExcerpt,
} from "./documentGeneration.js";
import {
  resolveModelForGeneration,
} from "./modelRoutingPolicy.js";
import { createTrackedChatCompletion } from "./modelUsageLedger.js";
import { withJobStage } from "./jobStageEvents.js";
import { captureSentryException } from "./sentry.js";

let client;
const summaryStudyGuideAnalysisCache = new Map();

function setOpenAiClientForTests(nextClient) {
  client = nextClient;
}

const ESTIMATED_CHARS_PER_TOKEN = 4;
const SUMMARY_SIGNAL_CHUNK_TOKEN_LIMIT = 2_500;
const SUMMARY_ANALYSIS_OUTPUT_TOKEN_LIMIT = 2_200;
const SUMMARY_STUDY_GUIDE_OUTPUT_TOKEN_LIMIT = 3_600;
const GPT55_SUMMARY_OUTPUT_TOKEN_LIMIT = 7_000;
const SUMMARY_ANALYSIS_CACHE_TTL_MS = 30 * 60 * 1000;
const SUMMARY_ANALYSIS_CACHE_MAX_ENTRIES = 50;
const INPUT_TOKEN_LIMITS = {
  [DOCUMENT_GENERATION_TYPES.summary]: 12_000,
  [DOCUMENT_GENERATION_TYPES.flashcards]: 10_000,
  [DOCUMENT_GENERATION_TYPES.exam]: 10_000,
};
const OUTPUT_TOKEN_LIMITS = {
  [DOCUMENT_GENERATION_TYPES.summary]: 2_000,
  [DOCUMENT_GENERATION_TYPES.flashcards]: 3_800,
  [DOCUMENT_GENERATION_TYPES.exam]: 6_000,
};
const QA_OUTPUT_TOKEN_LIMITS = {
  [DOCUMENT_GENERATION_TYPES.flashcards]: 5_200,
  [DOCUMENT_GENERATION_TYPES.exam]: 7_500,
};
const MAX_QA_COUNT_REPAIR_ATTEMPTS = 3;
const MAX_FLASHCARD_ADAPTIVE_REPAIR_ATTEMPTS = 2;
const MAX_EXTRACTIVE_FLASHCARD_ANSWER_WORDS = 18;
const MAX_PERSISTED_GROUNDING_REJECTIONS = 50;
const MIN_SOURCE_EVIDENCE_WORDS = 3;
const SOURCE_STATEMENT_STOP_WORDS = new Set([
  "about", "according", "answer", "because", "being", "between", "both", "does", "each",
  "false", "following", "from", "have", "into", "more", "most", "only", "other", "source",
  "statement", "that", "their", "them", "there", "these", "they", "this", "those", "through",
  "true", "what", "when", "where", "which", "while", "with", "would",
]);
const SOURCE_GROUNDING_STOP_WORDS = new Set([
  ...SOURCE_STATEMENT_STOP_WORDS,
  "a", "after", "again", "all", "also", "among", "an", "and", "another", "any", "are", "as",
  "at", "be", "been", "before", "but", "by", "can", "could", "did", "do", "during", "either",
  "every", "for", "had", "has", "having", "here", "how", "if", "in", "is", "it", "its",
  "itself", "just", "many", "may", "might", "must", "neither", "of", "on", "once", "one",
  "or", "our", "out", "over", "same", "should", "since", "so", "some", "such", "than",
  "the", "then", "to", "too", "under", "until", "upon", "very", "was", "were", "whether",
  "who", "whom", "why", "will", "within", "yet", "you", "your",
]);
const SUMMARY_STUDY_GUIDE_SECTIONS = Object.freeze([
  "Title",
  "Big Picture",
  "Learning Outcomes",
  "Core Concepts",
  "Main Models / Frameworks",
  "Comparisons",
  "Processes / Mechanisms",
  "Key Distinctions",
  "Exam-Level Takeaways",
  "Common Pitfalls",
  "What to Memorize",
  "One-Page Summary",
]);
const CHAPTER_MAP_ARRAY_KEYS = Object.freeze([
  "topics",
  "models",
  "definitions",
  "relationships",
  "important_examples",
  "likely_exam_points",
  "comparisons",
  "processes",
  "pitfalls",
  "memory_triggers",
]);
const CHAPTER_MAP_ITEM_LIMITS = Object.freeze({
  topics: 40,
  models: 25,
  definitions: 45,
  relationships: 35,
  important_examples: 25,
  likely_exam_points: 45,
  comparisons: 25,
  processes: 25,
  pitfalls: 25,
  memory_triggers: 25,
});
const REGENERATION_REASON_LABELS = Object.freeze({
  missing_parts: "Missing parts",
  not_comprehensive_enough: "Not comprehensive enough",
  too_short: "Too short",
  too_generic: "Too generic",
});
const SUMMARY_GENERATION_PROMPT = `Create a concise, high-quality study summary from the provided source material.

Your goal is to produce a compact study guide, not a long textbook rewrite.

Read the source material carefully and extract only the highest-value learning content:

* core ideas
* definitions
* models/frameworks
* formulas/methods if present
* key comparisons
* examples that clarify important concepts
* common mistakes
* what the user should remember

Do not include practice questions, quizzes, or Q&A sections.

Do not over-explain obvious points.

Do not repeat the same idea in multiple sections.

Do not add invented examples unless they clearly help explain a difficult concept.

Length target:

* Normal lecture/chapter: 1,800–2,800 words
* Short material: 800–1,500 words
* Very large material: summarize proportionally, but avoid excessive detail
* Never produce a bloated output that reads like a full rewritten textbook

Use EXACTLY these section titles as clean markdown headings, in this order:

Big Picture: What This Material Is Really About
Learning Outcomes
Core Concepts
Main Models / Frameworks
Key Comparisons
Examples
Common Mistakes
What to Memorize
Final Quick Review

Section rules:

* Big Picture: What This Material Is Really About: 1-3 short paragraphs explaining the main idea simply.
* Learning Outcomes: 3-6 bullets maximum.
* Core Concepts: define only important terms with concise explanations.
* Main Models / Frameworks: include only source-present models, frameworks, formulas, or methods; explain purpose, components, and why they matter.
* Key Comparisons: use compact comparison tables for concepts students may confuse.
* Examples: include only high-value source examples or very helpful clarifying examples; keep them short.
* Common Mistakes: short bullets focused on likely confusion.
* What to Memorize: concise bullet list of exam-memory points.
* Final Quick Review: 3-6 high-value recap lines only.

Subject adaptation:

* Math: focus on formulas, when to use them, steps, common errors, and interpretation.
* Science: focus on concepts, mechanisms, processes, cause/effect, and definitions.
* Business: focus on frameworks, stakeholders, decisions, processes, and comparisons.
* Technical material: focus on architecture, components, flows, constraints, APIs, and dependencies.
* Humanities/social science: focus on arguments, theories, themes, evidence, and implications.

Formatting rules:

* Use clean markdown headings.
* Use bullets and tables, but only when they improve readability.
* Avoid excessive nested bullets.
* Avoid markdown horizontal rules.
* Avoid code blocks unless the source is technical/code-based.
* Do not number the section headings.
* Use only the exact section headings listed above.
* Keep paragraphs short.
* Keep sections visually tight with no large empty gaps.
* Keep the output visually clean inside the app.

Quality bar:
The summary should feel like a polished study guide made by an excellent tutor:

* clear
* compact
* complete enough for revision
* not generic
* not bloated
* not a raw slide-by-slide rewrite
* readable in 5-10 minutes

Return only the summary content.`;
const SUMMARY_SECTION_TITLES = Object.freeze([
  "Big Picture: What This Material Is Really About",
  "Learning Outcomes",
  "Core Concepts",
  "Main Models / Frameworks",
  "Key Comparisons",
  "Examples",
  "Common Mistakes",
  "What to Memorize",
  "Final Quick Review",
]);
const SUMMARY_SECTION_TITLE_MAP = new Map(
  SUMMARY_SECTION_TITLES.map((title) => [title.toLowerCase(), title]),
);

function getClient() {
  if (client) {
    return client;
  }

  if (!process.env.OPENAI_API_KEY) {
    const error = new Error("OPENAI_API_KEY is required for study material generation");
    error.code = "generation_config_missing";
    throw error;
  }

  client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  return client;
}

function withUsageLedgerCallContext(usageLedgerContext, {
  aiPhase,
  callKey = aiPhase,
  metadata = {},
} = {}) {
  if (!usageLedgerContext) {
    return null;
  }

  return {
    ...usageLedgerContext,
    aiPhase,
    callKey,
    metadata: {
      ...(usageLedgerContext.metadata ?? {}),
      ...metadata,
    },
  };
}

async function createChatCompletion(openai, params, usageLedgerContext) {
  const abortSignal = usageLedgerContext?.abortSignal;
  const requestOptions = abortSignal ? { signal: abortSignal } : undefined;

  if (!usageLedgerContext?.prisma) {
    return openai.chat.completions.create(params, requestOptions);
  }

  const { prisma, abortSignal: _abortSignal, ...ledgerContext } = usageLedgerContext;
  const aiPhase = ledgerContext.aiPhase || ledgerContext.callKey || "model_call";
  const isQaCall = /(^|_)qa($|_)|:qa\b/i.test(aiPhase) || /(^|_)qa($|_)|:qa\b/i.test(ledgerContext.callKey || "");
  const stageName = isQaCall ? `qa_call:${aiPhase}` : `model_call:${aiPhase}`;

  return withJobStage(prisma, ledgerContext, stageName, () => createTrackedChatCompletion({
    prisma,
    openai,
    params,
    requestOptions,
    context: ledgerContext,
  }), {
    metadata: {
      provider: "openai",
      requestedModel: params?.model,
    },
  });
}

function getChatMessageTextContent(message) {
  const content = message?.content;
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (typeof part?.text === "string") {
          return part.text;
        }
        if (typeof part?.content === "string") {
          return part.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

function previewForDiagnostics(value, maxChars = 240) {
  return normalizeString(value)
    .replace(/\s+/g, " ")
    .slice(0, maxChars);
}

function buildSummaryResponseDiagnostics(response, rawContent) {
  const choice = response?.choices?.[0] ?? null;
  const message = choice?.message ?? null;
  const usage = response?.usage ?? {};
  const completionDetails = usage?.completion_tokens_details ?? {};

  return {
    model: response?.model ?? null,
    finishReason: choice?.finish_reason ?? null,
    contentLength: rawContent.length,
    contentPreview: previewForDiagnostics(rawContent),
    messageKeys: message ? Object.keys(message) : [],
    hasRefusal: Boolean(message?.refusal),
    refusalPreview: previewForDiagnostics(message?.refusal ?? ""),
    usage: {
      promptTokens: Number(usage?.prompt_tokens ?? 0),
      completionTokens: Number(usage?.completion_tokens ?? 0),
      totalTokens: Number(usage?.total_tokens ?? 0),
      reasoningTokens: Number(completionDetails?.reasoning_tokens ?? 0),
    },
  };
}

function createEmptySummaryOutputError(response, rawContent) {
  const error = new Error("GPT-5.5 summary returned no usable visible content");
  error.code = "empty_summary_output";
  error.diagnostics = buildSummaryResponseDiagnostics(response, rawContent);
  return error;
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSourceEvidence(value) {
  return normalizeString(value)
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase();
}

function getGroundingTokens(value, stopWords = SOURCE_GROUNDING_STOP_WORDS) {
  return normalizeSourceEvidence(value)
    .match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu)
    ?.filter((token) => token.length >= 3 && !stopWords.has(token)) ?? [];
}

function stemGroundingToken(token) {
  return token
    .replace(/(?:izations?|ational|ations?|ments?|ingly|edly|ing|ers?|ies|ied|ed|es|s)$/u, "")
    .slice(0, 18);
}

function inspectSourceGrounding(sourceText) {
  const statements = new Map();
  const source = normalizeString(sourceText)
    .replace(/^\[[^\]]+\]\s*/gmu, "")
    .split(/[.!?؟;؛\n•▪]+/u);

  for (const statement of source) {
    const normalizedStatement = normalizeSourceEvidence(statement)
      .replace(/\d+/gu, "#")
      .replace(/[^\p{L}\p{N}#\s-]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();

    if (
      normalizedStatement.length < 18
      || getGroundingTokens(normalizedStatement, SOURCE_STATEMENT_STOP_WORDS).length < 3
      || /^(?:iteration|repeat|repetition|pass|run)\s+#(?:\s|$)/u.test(normalizedStatement)
    ) {
      continue;
    }

    if (!statements.has(normalizedStatement)) {
      statements.set(normalizedStatement, normalizeString(statement));
    }
  }

  return {
    distinctStatementCount: statements.size,
    statements: [...statements.values()].map((text, index) => ({
      id: `S${String(index + 1).padStart(3, "0")}`,
      text,
    })),
    sourceText: normalizeString(sourceText),
  };
}

function formatSourceEvidenceCatalog(sourceGrounding) {
  return sourceGrounding.statements
    .map((statement) => `[${statement.id}] ${statement.text}`)
    .join("\n");
}

function selectRelevantSourceQuote(statement, factualContent, answerContent = factualContent) {
  const words = normalizeString(statement).split(/\s+/u).filter(Boolean);
  if (words.length <= 24) {
    return words.join(" ");
  }

  const factualRoots = new Set(getGroundingTokens(factualContent).map(stemGroundingToken));
  const answerRoots = new Set(getGroundingTokens(answerContent).map(stemGroundingToken));
  let bestStart = 0;
  let bestScore = -1;

  for (let start = 0; start < words.length; start += 1) {
    const candidate = words.slice(start, start + 18).join(" ");
    const candidateRoots = getGroundingTokens(candidate).map(stemGroundingToken);
    const score = candidateRoots.filter((token) => factualRoots.has(token)).length
      + candidateRoots.filter((token) => answerRoots.has(token)).length * 3;
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }

  return words.slice(bestStart, bestStart + 18).join(" ");
}

function resolveGroundedTargetCount(requestedCount, sourceGrounding) {
  const normalizedRequestedCount = Math.max(1, Number(requestedCount) || 1);
  const distinctStatementCount = Number(sourceGrounding?.distinctStatementCount || 0);

  if (distinctStatementCount <= 0) {
    return normalizedRequestedCount;
  }

  return Math.min(normalizedRequestedCount, distinctStatementCount);
}

function isHeadingOnlySourceEvidence(value) {
  const sourceEvidence = normalizeString(value);
  if (!sourceEvidence) {
    return false;
  }

  if (/^(?:key\s+(?:term|concept)|important\s+(?:term|concept)|learning\s+(?:outcomes?|objectives?)|chapter|section|unit|lesson|topic)\s*[:\-–—]/iu.test(sourceEvidence)) {
    return true;
  }

  if (/[.!?؟;؛]|\d/u.test(sourceEvidence)) {
    return false;
  }

  const words = sourceEvidence.match(/[\p{L}]+(?:[-'][\p{L}]+)*/gu) ?? [];
  return words.length >= 2
    && words.length <= 8
    && words.every((word) => SOURCE_GROUNDING_STOP_WORDS.has(word.toLocaleLowerCase())
      || /^\p{Lu}/u.test(word));
}

function isIncompleteSourceEvidence(value) {
  return /\b(?:a|an|the)\s*$/iu.test(normalizeString(value));
}

function assessItemSourceEvidence({
  generationType,
  rawItem,
  normalizedItem,
  sourceText,
  index,
  sourceStatementsById = null,
}) {
  const factualContent = generationType === DOCUMENT_GENERATION_TYPES.flashcards
    ? `${normalizedItem.question} ${normalizedItem.answer}`
    : `${normalizedItem.question} ${normalizedItem.correctAnswer} ${normalizedItem.explanation || ""}`;
  const answerContent = generationType === DOCUMENT_GENERATION_TYPES.flashcards
    ? normalizedItem.answer
    : normalizedItem.type === "true_false"
      ? normalizedItem.explanation
      : normalizedItem.correctAnswer;
  const sourceId = normalizeString(rawItem?.sourceId ?? rawItem?.sourceStatementId).toUpperCase();
  const citedStatement = sourceStatementsById?.get(sourceId) ?? null;
  const sourceQuote = citedStatement
    ? selectRelevantSourceQuote(citedStatement.text, factualContent, answerContent)
    : normalizeString(rawItem?.sourceQuote);
  const normalizedQuote = normalizeSourceEvidence(sourceQuote);
  const normalizedSource = normalizeSourceEvidence(sourceText);
  const quoteTokens = getGroundingTokens(sourceQuote);
  const sourceQuoteIsVerbatim = quoteTokens.length >= MIN_SOURCE_EVIDENCE_WORDS
    && normalizedSource.includes(normalizedQuote);
  const evidenceRoots = new Set(quoteTokens.map(stemGroundingToken));
  const factualRoots = getGroundingTokens(factualContent).map(stemGroundingToken);
  const sharedEvidenceTerms = [...new Set(factualRoots.filter((token) => evidenceRoots.has(token)))];
  const answerRoots = [...new Set(getGroundingTokens(answerContent).map(stemGroundingToken))];
  const sharedAnswerEvidenceTerms = answerRoots.filter((token) => evidenceRoots.has(token));
  const requiredAnswerEvidenceTerms = Math.min(2, answerRoots.length);
  const questionRoots = new Set(getGroundingTokens(normalizedItem.question).map(stemGroundingToken));
  const answerSpecificRoots = answerRoots.filter((token) => !questionRoots.has(token));
  const sharedAnswerSpecificEvidenceTerms = answerSpecificRoots.filter((token) => evidenceRoots.has(token));
  const requiredAnswerSpecificEvidenceTerms = generationType === DOCUMENT_GENERATION_TYPES.exam
    && normalizedItem.type === "true_false"
    ? 0
    : Math.min(
      answerSpecificRoots.length,
      Math.max(2, Math.ceil(answerSpecificRoots.length * 0.5)),
    );
  const sourceQuoteIsHeading = isHeadingOnlySourceEvidence(citedStatement?.text ?? sourceQuote);
  const sourceQuoteIsIncomplete = isIncompleteSourceEvidence(citedStatement?.text ?? sourceQuote);
  const hasRelevantEvidence = !sourceQuoteIsHeading
    && !sourceQuoteIsIncomplete
    && answerRoots.length > 0
    && sharedEvidenceTerms.length >= Math.min(2, new Set(factualRoots).size)
    && sharedAnswerEvidenceTerms.length >= requiredAnswerEvidenceTerms
    && sharedAnswerSpecificEvidenceTerms.length >= requiredAnswerSpecificEvidenceTerms;
  const sourceRoots = new Set((normalizeSourceEvidence(sourceText)
    .match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) ?? [])
    .filter((token) => token.length >= 2)
    .map(stemGroundingToken));
  const distinctiveContent = generationType === DOCUMENT_GENERATION_TYPES.exam
    ? `${factualContent} ${(normalizedItem.options ?? []).join(" ")}`
    : factualContent;
  const distinctiveTerms = distinctiveContent.match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) ?? [];
  const unsupportedDistinctiveTerms = [...new Set(distinctiveTerms.filter((term) => {
    const compactTerm = term.replace(/[-']/gu, "");
    const isDistinctive = /[\p{Ll}][\p{Lu}]/u.test(compactTerm)
      || /\p{L}\p{N}|\p{N}\p{L}/u.test(compactTerm)
      || /^[\p{Lu}]{2,}$/u.test(compactTerm);
    return isDistinctive && !sourceRoots.has(stemGroundingToken(term.toLocaleLowerCase()));
  }))];
  const grounded = sourceQuoteIsVerbatim && hasRelevantEvidence && unsupportedDistinctiveTerms.length === 0;

  return {
    index,
    grounded,
    verdict: grounded ? "source_traceable" : "appears_invented_or_unverifiable",
    sourceId: citedStatement?.id ?? null,
    sourceQuote,
    sourceQuoteIsVerbatim,
    sourceQuoteIsHeading,
    sourceQuoteIsIncomplete,
    sharedEvidenceTerms,
    sharedAnswerEvidenceTerms,
    requiredAnswerEvidenceTerms,
    answerSpecificEvidenceTerms: answerSpecificRoots,
    sharedAnswerSpecificEvidenceTerms,
    requiredAnswerSpecificEvidenceTerms,
    unsupportedDistinctiveTerms,
    reason: grounded
      ? null
      : !sourceQuoteIsVerbatim
        ? "missing_or_nonverbatim_source_quote"
        : unsupportedDistinctiveTerms.length > 0
          ? "distinctive_term_absent_from_source"
          : sourceQuoteIsHeading
            ? "source_quote_is_heading_only"
            : sourceQuoteIsIncomplete
              ? "source_quote_is_incomplete"
              : "source_quote_does_not_support_item",
  };
}

function normalizeGroundedQaOutput(generationType, parsed, sourceText) {
  const sourceGrounding = inspectSourceGrounding(sourceText);
  const sourceStatementsById = new Map(
    sourceGrounding.statements.map((statement) => [statement.id, statement]),
  );
  const isFlashcards = generationType === DOCUMENT_GENERATION_TYPES.flashcards;
  const rawItems = isFlashcards
    ? Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.cards)
        ? parsed.cards
        : []
    : Array.isArray(parsed?.questions)
      ? parsed.questions
      : [];
  const acceptedItems = [];
  const acceptedEvidence = [];
  const rejectedEvidence = [];

  for (const [index, rawItem] of rawItems.entries()) {
    const normalizedItem = isFlashcards
      ? normalizeFlashcard(rawItem)
      : normalizeExamQuestion(rawItem);

    if (!normalizedItem) {
      rejectedEvidence.push({
        index,
        grounded: false,
        verdict: "appears_invented_or_unverifiable",
        sourceId: normalizeString(rawItem?.sourceId ?? rawItem?.sourceStatementId) || null,
        sourceQuote: normalizeString(rawItem?.sourceQuote),
        sourceQuoteIsVerbatim: false,
        sharedEvidenceTerms: [],
        unsupportedDistinctiveTerms: [],
        reason: "invalid_item_shape",
      });
      continue;
    }

    const evidence = assessItemSourceEvidence({
      generationType,
      rawItem,
      normalizedItem,
      sourceText,
      index,
      sourceStatementsById,
    });

    if (!evidence.grounded) {
      rejectedEvidence.push(evidence);
      continue;
    }

    acceptedItems.push(normalizedItem);
    acceptedEvidence.push({ ...evidence, index: acceptedItems.length - 1 });
  }

  return {
    output: isFlashcards ? { cards: acceptedItems } : { questions: acceptedItems },
    grounding: {
      items: acceptedEvidence,
      rejectedItems: rejectedEvidence,
      rejectedCount: rejectedEvidence.length,
    },
  };
}

function estimateTokenCountFromChars(charCount) {
  return Math.max(1, Math.ceil(Math.max(0, Number(charCount) || 0) / ESTIMATED_CHARS_PER_TOKEN));
}

export function estimateTokenCountFromText(text = "") {
  return estimateTokenCountFromChars(normalizeString(text).length);
}

export function isSummaryStudyGuidePipelineEnabled() {
  const value = normalizeString(process.env.GENERATION_PIPELINE_V2).toLowerCase();
  return value === "1" || value === "true" || value === "enabled" || value === "on";
}

function coerceTextArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (typeof item === "string") {
        return normalizeString(item);
      }

      if (!item || typeof item !== "object") {
        return "";
      }

      return normalizeString(
        item.name
        ?? item.term
        ?? item.title
        ?? item.concept
        ?? item.point
        ?? item.description
        ?? JSON.stringify(item),
      );
    })
    .filter(Boolean);
}

function normalizeChapterMap(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const normalized = {};

  for (const key of CHAPTER_MAP_ARRAY_KEYS) {
    normalized[key] = coerceTextArray(source[key]);
  }

  return normalized;
}

function mergeUniqueTextItems(existingItems, nextItems, limit) {
  const seen = new Set(existingItems.map((item) => item.toLowerCase()));
  const merged = [...existingItems];

  for (const item of nextItems) {
    const normalizedItem = normalizeString(item);
    const dedupeKey = normalizedItem.toLowerCase();
    if (!normalizedItem || seen.has(dedupeKey)) {
      continue;
    }

    merged.push(normalizedItem);
    seen.add(dedupeKey);
    if (merged.length >= limit) {
      break;
    }
  }

  return merged;
}

function compactChapterMap(maps = []) {
  const compacted = normalizeChapterMap();

  for (const map of maps) {
    const normalizedMap = normalizeChapterMap(map);
    for (const key of CHAPTER_MAP_ARRAY_KEYS) {
      compacted[key] = mergeUniqueTextItems(
        compacted[key],
        normalizedMap[key],
        CHAPTER_MAP_ITEM_LIMITS[key] ?? 30,
      );
    }
  }

  return compacted;
}

function mergeTokenUsage(left = null, right = null) {
  if (!right) {
    return left;
  }

  const merged = { ...(left || {}) };
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
    const nextValue = Number(right?.[key] ?? 0);
    if (nextValue > 0) {
      merged[key] = Number(merged[key] ?? 0) + nextValue;
    }
  }

  return Object.keys(merged).length > 0 ? merged : null;
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

function buildStudyGuideAnalysisChunks(excerpts) {
  const usableExcerpts = sortGenerationExcerpts(excerpts).filter(isUsableGenerationExcerpt);
  const maxChars = SUMMARY_SIGNAL_CHUNK_TOKEN_LIMIT * ESTIMATED_CHARS_PER_TOKEN;
  const chunks = [];
  let currentBlocks = [];
  let currentLength = 0;

  for (const excerpt of usableExcerpts) {
    const label = getExcerptLabel(excerpt);
    const content = normalizeString(excerpt?.content);
    const maxContentChars = Math.max(500, maxChars - label.length - 12);

    for (let offset = 0; offset < content.length; offset += maxContentChars) {
      const contentSlice = content.slice(offset, offset + maxContentChars);
      const block = offset === 0 && content.length <= maxContentChars
        ? `${label}\n${contentSlice}`
        : `${label} | part ${Math.floor(offset / maxContentChars) + 1}\n${contentSlice}`;
      const blockLength = block.length + 2;

      if (currentBlocks.length > 0 && currentLength + blockLength > maxChars) {
        chunks.push(currentBlocks.join("\n\n"));
        currentBlocks = [];
        currentLength = 0;
      }

      currentBlocks.push(block);
      currentLength += blockLength;
    }
  }

  if (currentBlocks.length > 0) {
    chunks.push(currentBlocks.join("\n\n"));
  }

  return {
    chunks,
    totalExcerptCount: usableExcerpts.length,
    selectedExcerptCount: usableExcerpts.length,
    estimatedInputTokens: estimateTokenCountFromText(chunks.join("\n\n")),
  };
}

export function prepareSummaryStudyGuideSourceMaterial(excerpts) {
  const sourceMaterial = buildStudyGuideAnalysisChunks(excerpts);
  return {
    text: sourceMaterial.chunks.join("\n\n"),
    sampled: false,
    totalExcerptCount: sourceMaterial.totalExcerptCount,
    selectedExcerptCount: sourceMaterial.selectedExcerptCount,
    estimatedInputTokens: sourceMaterial.estimatedInputTokens,
  };
}

export function prepareGpt55SummarySourceMaterial(excerpts) {
  const usableExcerpts = sortGenerationExcerpts(excerpts).filter(isUsableGenerationExcerpt);

  if (usableExcerpts.length === 0) {
    const error = new Error("No usable excerpts available for generation");
    error.code = "no_usable_excerpts";
    throw error;
  }

  const fullText = usableExcerpts.map((excerpt) => buildExcerptBlock(excerpt)).join("\n\n");
  return {
    text: fullText,
    sampled: false,
    totalExcerptCount: usableExcerpts.length,
    selectedExcerptCount: usableExcerpts.length,
    estimatedInputTokens: estimateTokenCountFromText(fullText),
  };
}

function getSummaryStudyGuideAnalysisCacheKey(excerpts) {
  const hash = crypto.createHash("sha256");
  const usableExcerpts = sortGenerationExcerpts(excerpts).filter(isUsableGenerationExcerpt);

  for (const excerpt of usableExcerpts) {
    hash.update(getExcerptLabel(excerpt));
    hash.update("\n");
    hash.update(normalizeString(excerpt?.content));
    hash.update("\n---\n");
  }

  return hash.digest("hex");
}

function pruneSummaryStudyGuideAnalysisCache() {
  const now = Date.now();
  for (const [key, value] of summaryStudyGuideAnalysisCache.entries()) {
    if (!value || value.expiresAt <= now) {
      summaryStudyGuideAnalysisCache.delete(key);
    }
  }

  while (summaryStudyGuideAnalysisCache.size > SUMMARY_ANALYSIS_CACHE_MAX_ENTRIES) {
    const oldestKey = summaryStudyGuideAnalysisCache.keys().next().value;
    if (!oldestKey) {
      break;
    }

    summaryStudyGuideAnalysisCache.delete(oldestKey);
  }
}

function getCachedSummaryStudyGuideAnalysis(cacheKey) {
  pruneSummaryStudyGuideAnalysisCache();
  const cached = summaryStudyGuideAnalysisCache.get(cacheKey);
  if (!cached || cached.expiresAt <= Date.now()) {
    summaryStudyGuideAnalysisCache.delete(cacheKey);
    return null;
  }

  return cached.chapterMap;
}

function setCachedSummaryStudyGuideAnalysis(cacheKey, chapterMap) {
  pruneSummaryStudyGuideAnalysisCache();
  summaryStudyGuideAnalysisCache.set(cacheKey, {
    chapterMap: normalizeChapterMap(chapterMap),
    expiresAt: Date.now() + SUMMARY_ANALYSIS_CACHE_TTL_MS,
  });
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
    return 16;
  }

  if (sizeTier === "medium") {
    return 30;
  }

  return 48;
}

function getExamMaxCount(sizeTier) {
  if (sizeTier === "short") {
    return 15;
  }

  if (sizeTier === "medium") {
    return 25;
  }

  return 40;
}

function getExamMinCount(sizeTier) {
  if (sizeTier === "short") {
    return 10;
  }

  if (sizeTier === "medium") {
    return 15;
  }

  return 25;
}

function getExamTargetCount(sizeTier, requestedCount) {
  const requested = Number.isFinite(Number(requestedCount)) ? Number(requestedCount) : getExamMinCount(sizeTier);
  return Math.max(getExamMinCount(sizeTier), Math.min(requested, getExamMaxCount(sizeTier)));
}

function buildSystemPrompt(generationType) {
  if (generationType === DOCUMENT_GENERATION_TYPES.summary) {
    return "You produce concise study summaries as strict JSON. Return valid JSON only.";
  }

  if (generationType === DOCUMENT_GENERATION_TYPES.flashcards) {
    return "You generate high-quality exam-ready flashcards. Return only a valid JSON array.";
  }

  return "You generate high-quality mock exams. Return only a valid JSON object.";
}

function buildRegenerationGuidancePrompt(options = {}) {
  const guidance = options?.regenerationGuidance;
  if (!guidance || typeof guidance !== "object") {
    return "";
  }

  const reasonKey = normalizeString(guidance.reasonKey).toLowerCase();
  const reasonLabel = REGENERATION_REASON_LABELS[reasonKey] || "";
  const customInstruction = normalizeString(guidance.customInstruction);
  const notes = [];

  if (reasonLabel) {
    notes.push(`- Improve area: ${reasonLabel}.`);
  }

  if (customInstruction) {
    notes.push(`- Additional instruction: ${customInstruction}`);
  }

  if (notes.length === 0) {
    return "";
  }

  return `\nRegeneration guidance:\n${notes.join("\n")}\n- Keep all claims grounded in the provided study material.\n`;
}

function buildSummaryPrompt(text, language, options, sourceTier, sampled) {
  const languageName = language === "arabic" ? "Arabic" : "English";
  const targetWords = getSummaryWordTarget(options.length, sourceTier);
  const guidancePrompt = buildRegenerationGuidancePrompt(options);

  return `You are generating an EXAM-READY STUDY SUMMARY in ${languageName}.

This is NOT a general summary.
This is a structured, high-density, exam-optimized output.

Your priority is:
1) FULL COVERAGE of the source
2) CLEAR STRUCTURE
3) EXAM-LEVEL USEFULNESS

----------------------------------
OUTPUT STRUCTURE (MANDATORY)
----------------------------------

# 1. MAIN TITLE
- Use the topic name only

# 2. CORE DEFINITION
- 1–3 bullets
- Must be precise and exam-usable

----------------------------------

# 3. KEY MODELS / FRAMEWORKS (MANDATORY IF PRESENT)

For each model/framework:

## [Model Name]

🔹 What it is
- 1–2 lines max

🔹 Components
- Bullet list
- Each component = 1 short line

👉 Exam Insight (ONLY if important)
- Focus on what is commonly tested

----------------------------------

# 4. MAIN TOPIC SECTIONS (MANDATORY — FULL COVERAGE)

You MUST cover ALL major topic groups in the source.

For each section:

## [Section Title]

🔹 Definition
- 1–2 lines

🔹 Key Points
- 5–7 bullets max
- Each bullet = ONE idea only

🔹 Named Elements (IF PRESENT)
- Reproduce exact lists from the source
- Examples:
  - stages
  - factors
  - roles
  - categories

🔹 Example (ONLY if useful)
- 1 short real-world example

👉 Exam Tip (ONLY if relevant)
- 1 line

----------------------------------

# 5. PROCESSES / STAGES (MANDATORY IF PRESENT)

## [Process Name]

List all steps exactly:

1. Step name
- 1 line explanation

(Must be complete and ordered)

----------------------------------

# 6. CLASSIFICATIONS / CATEGORIES (MANDATORY IF PRESENT)

- Bullet list
- Include percentages or distinctions if available
- Each item = 1 line only

----------------------------------

# 7. COMPARISONS (IF PRESENT)

Use this format:

Aspect → A vs B

(No tables. Keep UI-safe.)

----------------------------------

# 8. FINAL REVISION SECTION (MANDATORY)

## ✅ Must-Know Concepts
- 6–10 bullets
- Only high-yield exam points

## ⚠️ Common Pitfalls
- 3–6 bullets
- Focus on typical student mistakes

----------------------------------
CRITICAL COVERAGE RULES
----------------------------------

- You MUST cover the ENTIRE source, not just the beginning
- If multiple major themes exist, include ALL of them
- Do NOT produce a front-heavy summary
- Do NOT skip sections even if they appear later in the content

----------------------------------
ANTI-FLUFF RULES (STRICT)
----------------------------------

DO NOT use vague phrases such as:
- "this chapter explores"
- "helps understand"
- "is important"
- "is significant"

Every bullet must contain a concrete, testable idea.

----------------------------------
CLARITY RULES
----------------------------------

- NO long paragraphs
- Short bullets only
- Each bullet = ONE idea
- No repetition
- Use simple language
- Keep spacing tight and consistent

----------------------------------
DEPTH BALANCE RULE
----------------------------------

Be concise per sentence, but NOT shallow in coverage.

Do NOT sacrifice important topics just to keep the output short.

Target length guideline: around ${targetWords} words when the source supports it, but prioritize coverage and structure over brevity.

----------------------------------
WEAK CONTENT RULE
----------------------------------

If the source is weak:
- reduce detail
- DO NOT invent or hallucinate

----------------------------------
OUTPUT FORMAT (MANDATORY)
----------------------------------

Return ONLY valid JSON:

{
  "text": "<structured summary content>"
}
${guidancePrompt}

Source note: ${sampled ? "This is a representative coverage sample across the document." : "This is the full usable extracted text."}

Study material:
"""
${text}
"""`;
}

function buildStrictSummaryPrompt(text, language, options, sourceTier, sampled) {
  const languageName = language === "arabic" ? "Arabic" : "English";
  const targetWords = getSummaryWordTarget(options.length, sourceTier);
  const guidancePrompt = buildRegenerationGuidancePrompt(options);

  return `Create an exam-ready study summary in ${languageName}.

This is not a general overview. The output must be useful for revision, dense with source-specific material, and balanced across the full source.

Coverage requirements:
- Cover all major topic groups from the beginning, middle, and end of the source.
- Do not focus mostly on the first part of the source.
- Later sections must receive meaningful treatment, not a token final bullet.
- Preserve important details needed for exams instead of over-compressing the material.
- If the source includes both consumer buyer behavior and business buyer behavior, cover both clearly.
- If the source includes personal factors, psychological factors, Maslow, buyer decision process, adoption process, business buying situations, buying center, or e-procurement, include them explicitly.
- For buyer-behavior sources, source-present high-yield labels must appear literally in the final summary text, including Maslow, Buyer Decision Process, Adoption Process, Business Buying Situations, Buying Center, E-Procurement, Personal Factors, and Psychological Factors.
- Keep every claim grounded in the provided text. If evidence is partial or thin, stay explicit and do not invent missing content.

Named-source requirements:
- When the source includes named factors, stages, categories, roles, classifications, frameworks, models, or processes, include those names explicitly.
- Do not replace named source material with vague paraphrases.
- When order matters, keep the original sequence.
- When distinctions or contrasts are stated, make them explicit.
- When the source includes stages, factors, categories, roles, or processes, include them explicitly as lists.

Internal coverage check before final JSON:
- Before writing the final JSON, silently verify that every major source topic and every named model, framework, process, category, role, factor group, classification, stage, and comparison found in the source is represented in the summary.
- If a named high-yield item is present in the source but missing from the draft summary, add it before finalizing.
- This internal check must especially look for major factor groups, named models and frameworks, ordered processes and stages, classifications and categories, decision roles, comparisons, adoption sections, e-procurement sections, and business-buying sections when present.
- Apply a source-triggered named-item audit: if the source contains a named high-yield term, the final summary must include that term by name or a direct source-equivalent label.
- For marketing or buyer-behavior material, this audit must catch source-present items such as Maslow, buyer decision process, adoption process, business buying situations, buying center, e-procurement, personal factors, and psychological factors.
- Do not output this checklist or mention that you performed it.

Structure requirements for the summary content inside "text":
- Use plain text only.
- Do not use markdown formatting such as **bold**, *italic*, or # headings.
- Use plain text labels only:
  Title:
  Core Definition:
  Main Sections:
  Processes:
  Classifications:
  Key Distinctions:
  Quick Revision:
  Common Pitfalls:
- Keep those labels in that order when the source supports them.
- If a label has no supported content, omit only that label except Title, Core Definition, Main Sections, Quick Revision, and Common Pitfalls.
- Do not use labels such as Key Themes, Overview, Assessment Areas, Interview Structure, or Conclusion.
- Use short dash bullets inside sections.
- Use numbered steps only for ordered processes, stages, or sequences from the source.
- End with Quick Revision and Common Pitfalls.

Depth requirements:
- Each major section must include enough detail for exam revision, not one-line shallow coverage.
- Include definitions, key components, conditions, examples, roles, stages, factors, categories, and named source items when available.
- Main Sections must cover every major topic group. For each group, include a clear subsection line ending with ":" followed by concrete bullets.
- If the source contains named models or frameworks, include a natural subsection under Main Sections named "Named Models and Frameworks:" with each source-present model named explicitly, such as Maslow when present.
- Processes must include complete ordered steps for any decision process, adoption process, workflow, lifecycle, or staged model.
- Classifications must include source categories, types, situations, roles, or factors with defining features.
- Key Distinctions must include common comparisons and likely tested contrasts, such as consumer vs business behavior, personal vs psychological factors, need recognition vs information search, evaluation vs purchase decision, straight rebuy vs modified rebuy vs new task, or buying center roles when supported by the source.

Exam-usefulness requirements:
- Phrase bullets so they are answerable in exam language.
- Include likely tested distinctions, contrasts, and comparisons when the source supports them.
- Explain why named steps, roles, categories, or factors differ from each other.
- Prefer concrete recall points over vague descriptive prose.
- Avoid filler such as "this chapter explores", "helps understand", "is important", or "plays a role" unless the sentence states the specific tested idea.

Ending section requirements:
- Quick Revision must contain 6 to 10 concrete high-yield recall points when the source has enough content.
- Quick Revision must summarize testable source facts from across the full material, including later sections when present.
- Common Pitfalls must contain 3 to 6 likely student confusions grounded in the source.
- Common Pitfalls must focus on similar concepts, stages, roles, categories, or factors, not generic study advice.

Concision requirements:
- Target around ${targetWords} words when the source supports it.
- Short bullets are preferred.
- The summary should be compact but not shallow.
- Every bullet must carry a concrete, testable idea.
${guidancePrompt}

OUTPUT FORMAT IS STRICT AND NON-NEGOTIABLE.
Return ONLY valid JSON.
Do not include text before or after the JSON.
Do not use markdown code fences.
Do not add explanations.

Required shape:
{
  "text": "<structured summary>"
}

The "text" value must be a single string containing the full formatted summary.

Source note: ${sampled ? "This is a representative coverage sample across the document." : "This is the full usable extracted text."}

Study material:
"""
${text}
"""`;
}

function buildStudyGuideSignalExtractionPrompt(chunkText, language, chunkIndex, chunkCount) {
  const languageName = language === "arabic" ? "Arabic" : "English";

  return `You are performing Stage 1 signal extraction for an exam study guide in ${languageName}.
This is NOT summarization. Extract only reusable study signals from this source chunk.

Return valid JSON only with this shape:
{
  "topics": ["major topic or subtopic"],
  "models": ["model/framework name + what it explains"],
  "definitions": ["term: precise definition"],
  "relationships": ["concept A relates to concept B because ..."],
  "important_examples": ["example + what concept it illustrates"],
  "likely_exam_points": ["testable idea students must know"],
  "comparisons": ["A vs B: exact distinction"],
  "processes": ["process name: ordered mechanism"],
  "pitfalls": ["common confusion + correction"],
  "memory_triggers": ["short recall phrase -> meaning"]
}

Extraction rules:
- Extract signals only; do not write paragraphs or a summary.
- Preserve technical meaning and named concepts.
- Explain why relationships matter when the source supports it.
- Do not repeat input text verbatim unless it is a term or short definition.
- Keep every item compact but specific.
- If a category is not supported, return an empty array for that category.
- Do not add markdown fences.

Chunk ${chunkIndex + 1} of ${chunkCount}:
"""
${chunkText}
"""`;
}

function buildChapterMapPrompt(compactedSignals, language) {
  const languageName = language === "arabic" ? "Arabic" : "English";

  return `You are performing Stage 1 global content analysis for an exam study guide in ${languageName}.
Analyze the extracted signals across the entire document and produce a structured chapter map.

Return valid JSON only with this shape:
{
  "topics": ["main topic -> key subtopics"],
  "models": ["model/framework -> purpose, components, interpretation"],
  "definitions": ["term -> exam-precise definition"],
  "relationships": ["relationship -> why it matters"],
  "important_examples": ["example -> concept illustrated"],
  "likely_exam_points": ["exam-relevant point"],
  "comparisons": ["comparison -> difference students must not confuse"],
  "processes": ["process/mechanism -> ordered logic"],
  "pitfalls": ["pitfall -> correction"],
  "memory_triggers": ["trigger phrase -> recall target"]
}

Analysis rules:
- Build a global view, not a chunk-by-chunk summary.
- Merge duplicates and group related ideas.
- Identify relationships between concepts and why those relationships matter.
- Include comparisons whenever the document gives multiple models, concepts, stages, roles, causes, or outcomes.
- Include likely exam points that are specific, testable, and grounded in the signals.
- Do not invent unsupported facts.
- Do not add markdown fences.

Extracted signals:
${JSON.stringify(compactedSignals, null, 2)}`;
}

function buildStudyGuideSynthesisPrompt(chapterMap, language, options, sourceTier) {
  const languageName = language === "arabic" ? "Arabic" : "English";
  const targetWords = getSummaryWordTarget(options.length, sourceTier);
  const guidancePrompt = buildRegenerationGuidancePrompt(options);

  return `You are generating an exam study guide, not a summary.
Use the chapter map to synthesize a high-quality exam study document in ${languageName}.

Return valid JSON only with this shape:
{"text":"..."}

MANDATORY output structure inside "text" exactly in this order:
1. Title
2. Big Picture
3. Learning Outcomes
4. Core Concepts
5. Main Models / Frameworks
6. Comparisons
7. Processes / Mechanisms
8. Key Distinctions
9. Exam-Level Takeaways
10. Common Pitfalls
11. What to Memorize
12. One-Page Summary

Quality rules:
- Explain why concepts matter, not just what they are.
- Core Concepts must include clear definitions.
- Main Models / Frameworks must include explanation, components, and interpretation.
- Comparisons must include at least one markdown table. If the document has no obvious named models to compare, compare the most confusable concepts, stages, causes, or outcomes.
- Exam-Level Takeaways must include at least 3 short, sharp, testable statements.
- What to Memorize must include memory triggers: short phrase -> what it unlocks.
- Processes / Mechanisms should include ordered steps when applicable; if no process exists, state the closest supported mechanism or reasoning chain.
- Common Pitfalls must correct likely student misunderstandings.
- One-Page Summary must be compact and study-ready.
- No generic phrases, filler, motivational text, or repetition of the input.
- Ground every claim in the chapter map. Do not invent facts.
- Use markdown headings, tight spacing, aligned bullets, and compact tables.
- Do not create large empty gaps or broken hierarchy.
- Target length guideline: around ${targetWords} words, but prioritize exam usefulness and complete structure over brevity.
- Do not add markdown fences.
${guidancePrompt}

Chapter map:
${JSON.stringify(chapterMap, null, 2)}`;
}

function buildStudyGuideOptimizationPrompt(draftText, chapterMap, language) {
  const languageName = language === "arabic" ? "Arabic" : "English";

  return `You are performing Stage 3 exam optimization on an exam study guide in ${languageName}.
Improve recall, understanding, and exam readiness without adding unsupported facts.

Return valid JSON only with this shape:
{"text":"..."}

Optimization rules:
- Keep all 12 mandatory sections present and in the same order.
- Strengthen exam-level takeaway statements.
- Add or sharpen memory triggers in "What to Memorize".
- Simplify complex ideas without making them inaccurate.
- Clarify distinctions students are likely to confuse.
- Remove generic phrasing, filler, and repeated ideas.
- Preserve at least one markdown comparison table.
- Do not add markdown fences.

Chapter map:
${JSON.stringify(chapterMap, null, 2)}

Draft study guide:
"""
${draftText}
"""`;
}

function buildStudyGuideFormatPrompt(optimizedText, language) {
  const languageName = language === "arabic" ? "Arabic" : "English";

  return `You are performing Stage 4 format enforcement for an exam study guide in ${languageName}.
Enforce the required structure and clean markdown formatting. Do not change grounded meaning.

Return valid JSON only with this shape:
{"text":"..."}

Format requirements:
- All 12 mandatory sections must be present in this exact order:
${SUMMARY_STUDY_GUIDE_SECTIONS.map((section, index) => `${index + 1}. ${section}`).join("\n")}
- Use markdown section headings.
- Use consistent spacing: one blank line between sections, no large empty gaps.
- Use aligned bullets.
- Comparisons must contain at least one markdown table.
- Main Models / Frameworks must show explanation, components, and interpretation.
- Exam-Level Takeaways must include at least 3 bullets.
- What to Memorize must contain memory triggers.
- Do not add markdown fences.

Study guide:
"""
${optimizedText}
"""`;
}

function buildFlashcardsPrompt(
  text,
  language,
  options,
  sourceTier,
  sampled,
  targetCount = null,
  distinctSourceStatementCount = null,
) {
  const languageName = language === "arabic" ? "Arabic" : "English";
  const cardCount = targetCount ?? getFlashcardTargetCount(sourceTier);
  const guidancePrompt = buildRegenerationGuidancePrompt(options);

  return `Create clear, accurate, exam-ready flashcards in ${languageName} from the provided source material.

Return ONLY valid JSON.
Return a JSON array of flashcards.

Each flashcard must have exactly this shape:
{"front":"question or prompt","back":"clear, concise answer"}

Core rules:
- Generate up to ${cardCount} flashcards. This is a maximum, not permission to invent content.
- The document contains ${distinctSourceStatementCount ?? "multiple"} distinct source statements. When at least ${cardCount} distinct source-supported concepts are available, produce all ${cardCount} cards rather than stopping early.
- Every question, answer, technical term, named entity, relationship, and example must be directly supported by the provided source excerpts.
- Do not use outside knowledge, fill in missing steps, infer unstated facts, or introduce familiar topic details that the document does not actually state.
- If fewer than ${cardCount} distinct, meaningful source-supported concepts exist, return fewer cards and stop. Never pad the set with fabricated, speculative, duplicate, or trivial content.
- Test one concept per card.
- Keep each answer short: 1-3 lines maximum.
- Prefer clear question styles such as "What is...", "Define...", "Explain briefly...", "What is the difference between...", or "What does X model state..."
- Avoid vague prompts.
- Do not repeat the same concept.
- Merge overlapping ideas.
- Include high-value definitions, models, frameworks, key distinctions, cause/effect relationships, and important lists split across cards.
- Exclude trivial details, filler content, and obvious statements.
- Split complex ideas into multiple cards.
- Use precise academic wording in simple language.
- Do not include markdown.
- Do not include bullets unless the answer is an extremely short list.
- Do not include explanations or any fields other than "front" and "back".
- Before returning, silently reject and fix output if the JSON is invalid, answers are too long, questions are vague, or cards overlap.
${guidancePrompt}

Source note: ${sampled ? "This is a representative coverage sample across the document." : "This is the full usable extracted text."}

Study material:
"""
${text}
"""`;
}

function buildExamPrompt(text, language, questionCount, options, sampled, distinctSourceStatementCount = null) {
  const languageName = language === "arabic" ? "Arabic" : "English";
  const guidancePrompt = buildRegenerationGuidancePrompt(options);
  const mcqMin = Math.ceil(questionCount * 0.7);
  const mcqMax = Math.max(mcqMin, Math.floor(questionCount * 0.8));
  const trueFalseMin = questionCount - mcqMax;
  const trueFalseMax = questionCount - mcqMin;

  return `Create a high-quality mock exam in ${languageName} from the provided source material.

Return ONLY valid JSON.
No markdown.
No extra text.

Return exactly this JSON object shape:
{"questions":[{"type":"mcq","question":"string","options":["option A text","option B text","option C text","option D text"],"correctAnswer":"exact correct option text","explanation":"short explanation"},{"type":"true_false","question":"string","correctAnswer":true,"explanation":"short explanation"}]}

Rules:
- Generate up to ${questionCount} questions. This is a maximum, not permission to invent content.
- The document contains ${distinctSourceStatementCount ?? "multiple"} distinct source statements. When at least ${questionCount} distinct source-supported concepts are available, produce all ${questionCount} questions rather than stopping early.
- Every tested claim, correct answer, explanation, named entity, process, number, and example must be directly supported by the provided source excerpts.
- Do not use outside knowledge, infer unstated facts, or introduce familiar details that are absent from the document.
- If fewer than ${questionCount} distinct, meaningful source-supported concepts exist, return fewer questions and stop. Never pad the exam with fabricated, speculative, duplicate, or trivial questions.
- Question distribution must be 70-80% MCQ and 20-30% True/False.
- When all ${questionCount} source-grounded questions are possible, produce ${mcqMin}-${mcqMax} MCQs and ${trueFalseMin}-${trueFalseMax} True/False questions. Apply the same proportions approximately if source limitations require a smaller exam.
- Cover definitions, models/frameworks, key distinctions, cause/effect relationships, and important processes.
- Test real understanding, not memorization only.
- Mix basic recall, understanding, and light application.
- Questions must be clear, fair, unambiguous, specific, and testable.
- Do not repeat the same concept in multiple questions.

MCQ quality:
- Each MCQ must have exactly 4 answer options.
- Each MCQ must have only one correct answer.
- The correctAnswer must exactly match the full text of the correct option.
- Include 3 plausible distractors.
- Distractors may be deliberately incorrect alternatives, but must use concepts or wording present in the source; do not introduce outside facts, terminology, or invented historical details.

True/False quality:
- True/False questions must test meaningful understanding.
- Avoid obvious statements.
- Avoid trick questions.
- The correctAnswer must be a JSON boolean true or false.

Avoid weak questions:
- Do not create trivial questions.
- Do not copy-paste definitions as questions.
- Do not create obvious True/False questions.
- Do not use ambiguous wording.

Explanation rules:
- Each explanation must be 1-2 lines max.
- Explain why the answer is correct.
- Do not repeat the question.
${guidancePrompt}

Source note: ${sampled ? "This is a representative coverage sample across the document." : "This is the full usable extracted text."}

Study material:
"""
${text}
"""`;
}

function toFlashcardQaInput(cards = []) {
  return cards
    .map((card) => {
      const normalized = normalizeFlashcard(card);
      if (!normalized) {
        return null;
      }
      const sourceId = normalizeString(card?.sourceId);
      return sourceId ? { ...normalized, sourceId } : normalized;
    })
    .filter(Boolean)
    .map((card) => ({
      front: card.question,
      back: card.answer,
      ...(card.sourceId ? { sourceId: card.sourceId } : {}),
    }));
}

function buildFlashcardQaPrompt(cards, language, sourceText, targetCount) {
  const languageName = language === "arabic" ? "Arabic" : "English";
  const qaInput = JSON.stringify(toFlashcardQaInput(cards), null, 2);
  const sourceGrounding = inspectSourceGrounding(sourceText);
  const evidenceCatalog = formatSourceEvidenceCatalog(sourceGrounding);

  return `You are performing strict QA validation for flashcards in ${languageName}.

Use model behavior optimized for production-quality flashcards.

INPUT FLASHCARDS:
${qaInput}

NUMBERED SOURCE STATEMENTS FOR CORRECTNESS AND COVERAGE:
"""
${evidenceCatalog}
"""

OBJECTIVE:
Validate AND improve flashcards until they meet production quality.
You must FIX issues, not just report them.

Validation rules:
- Grounding is the highest-priority invariant: every question and answer must be directly supported by the provided excerpts, with no outside knowledge or invented topic details.
- Cite a complete factual statement that directly supports the ANSWER itself, not merely the question topic. Never cite a section heading, label, bare title, incomplete sentence, or unrelated statement; the supporting statement must share meaningful answer facts beyond terms already repeated in the question.
- Every material answer detail must be asserted by that one cited statement. Keep answers concise, reuse the statement's factual language, and never append claims found only in a different statement.
- Remove unsupported cards instead of rescuing them with guessed facts.
- One concept per card: each card tests ONE idea only. If multiple ideas appear, split them into multiple cards.
- Answer length: max 1-2 lines. No paragraphs. No long explanations.
- Question clarity: each front must be specific and testable.
- No redundancy: remove duplicates and merge overlapping concepts.
- High-value only: remove trivial or obvious cards and keep exam-relevant concepts.
- Coverage check: ensure cards cover definitions, models/frameworks, key distinctions, cause/effect relationships, and important lists from the source material.
- If high-value coverage is missing, add cards.
- Formatting: plain text only, no markdown, no symbols, clean JSON.
- Return at most ${targetCount} cards. Reach ${targetCount} only if that many distinct, meaningful, source-supported concepts exist.
- The source catalog contains ${sourceGrounding.distinctStatementCount} distinct statements. If it supports ${targetCount} distinct high-value cards, return all ${targetCount}; do not stop early merely because the input draft was short.
- If the source is exhausted, return the smaller supported set; never invent, duplicate, or add trivial cards to fill the count.
- Every returned card must include "sourceId": the exact identifier of one numbered source statement that directly supports its question and answer, for example "S012". Never cite an unrelated statement.

Process:
1. Analyze the flashcards.
2. Identify all issues.
3. Fix weak cards, split complex cards, remove duplicates, and add missing high-value cards.
4. Re-check again.
5. Repeat until high quality.

Stop only when cards are concise, non-redundant, clear, testable, and exam-ready.

Output:
Return ONLY the improved JSON array.
Each item must be exactly:
{"front":"question or prompt","back":"clear, concise answer","sourceId":"S012"}
No explanations. No markdown. No extra text.`;
}

function toExamQaInput(questions = []) {
  return questions
    .map((question) => {
      const normalized = normalizeExamQuestion(question);
      if (!normalized) {
        return null;
      }
      const sourceId = normalizeString(question?.sourceId);
      return sourceId ? { ...normalized, sourceId } : normalized;
    })
    .filter(Boolean)
    .map((question) => {
      const baseQuestion = {
        type: question.type,
        question: question.question,
        correctAnswer: question.correctAnswer,
        explanation: question.explanation,
        ...(question.sourceId ? { sourceId: question.sourceId } : {}),
      };

      if (question.type === "true_false") {
        return {
          ...baseQuestion,
          correctAnswer: String(question.correctAnswer).toLowerCase() === "true",
        };
      }

      return {
        ...baseQuestion,
        options: question.options,
      };
    });
}

function buildExamQaPrompt(questions, language, sourceText, targetCount) {
  const languageName = language === "arabic" ? "Arabic" : "English";
  const qaInput = JSON.stringify({ questions: toExamQaInput(questions) }, null, 2);
  const sourceGrounding = inspectSourceGrounding(sourceText);
  const evidenceCatalog = formatSourceEvidenceCatalog(sourceGrounding);
  const mcqMin = Math.ceil(targetCount * 0.7);
  const mcqMax = Math.max(mcqMin, Math.floor(targetCount * 0.8));
  const trueFalseMin = targetCount - mcqMax;
  const trueFalseMax = targetCount - mcqMin;

  return `You are performing strict QA validation for a mock exam in ${languageName}.

MOCK EXAM JSON:
${qaInput}

NUMBERED SOURCE STATEMENTS FOR CORRECTNESS AND COVERAGE:
"""
${evidenceCatalog}
"""

OBJECTIVE:
Fix the exam until it reaches production quality.
You must detect problems, fix them, and improve quality.

Validation rules:
- Grounding is the highest-priority invariant: every tested claim, correct answer, and explanation must be directly supported by the provided excerpts, with no outside knowledge or invented topic details.
- Cite a complete factual statement that directly supports the correct ANSWER or true/false explanation itself, not merely the question topic. Never cite a section heading, label, bare title, incomplete sentence, or unrelated statement; the supporting statement must share meaningful answer facts beyond terms already repeated in the question.
- Every material answer detail must be asserted by that one cited statement. Keep answers concise, reuse the statement's factual language, and never append claims found only in a different statement.
- Remove unsupported questions instead of rescuing them with guessed facts.
- Correctness: ensure every correct answer is actually correct according to the source material. Fix any wrong answers immediately.
- MCQ quality: ensure every MCQ has exactly 4 options, only one correct answer, and realistic topic-related distractors.
- Clarity: remove ambiguity and improve wording.
- Difficulty: avoid questions that are too easy, too obvious, or purely copied definitions. Improve depth slightly where needed.
- True/False quality: remove trivial statements and ensure each one evaluates meaningful understanding.
- Redundancy: remove duplicate or overlapping questions.
- Coverage: ensure the exam includes definitions, models, comparisons, and key concepts from the source material. Add missing questions if needed.
- Explanation quality: explanations must be short, 1-2 lines, and explain the reasoning.
- Return at most ${targetCount} questions. Reach ${targetCount} only if that many distinct, meaningful, source-supported concepts exist.
- The source catalog contains ${sourceGrounding.distinctStatementCount} distinct statements. If it supports ${targetCount} distinct high-value questions, return all ${targetCount}; do not stop early merely because the input draft was short.
- If the source is exhausted, return the smaller supported set; never invent, duplicate, or add trivial questions to fill the count.
- Every returned question must include "sourceId": the exact identifier of one numbered source statement that directly supports its correct answer and explanation, for example "S012". Never cite an unrelated statement.
- Distribution target when all ${targetCount} grounded questions are possible: ${mcqMin}-${mcqMax} MCQs and ${trueFalseMin}-${trueFalseMax} True/False questions.

Process:
1. Analyze all questions.
2. Fix issues.
3. Improve quality.
4. Re-check.
5. Repeat until high quality.

Stop only when all questions are correct, distractors are strong, no ambiguity exists, coverage is good, and difficulty is balanced.

Output:
Return ONLY the improved JSON object.
Use exactly this shape:
{"questions":[{"type":"mcq","question":"string","options":["A","B","C","D"],"correctAnswer":"exact correct option text","explanation":"short explanation","sourceId":"S012"},{"type":"true_false","question":"string","correctAnswer":true,"explanation":"short explanation","sourceId":"S034"}]}
No markdown. No extra text.`;
}

function cleanJsonResponse(raw) {
  return normalizeString(raw)
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
}

function parseJsonResponse(raw) {
  return JSON.parse(cleanJsonResponse(raw));
}

async function createJsonCompletion({
  aiPhase,
  model,
  reasoningEffort = null,
  systemPrompt,
  userPrompt,
  maxTokens,
  temperature = 0.25,
  usageLedgerContext = null,
}) {
  const openai = getClient();
  const params = buildModelCompletionParams({
    model,
    reasoningEffort,
    maxTokens,
    temperature,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });
  const response = await createChatCompletion(openai, params, withUsageLedgerCallContext(usageLedgerContext, {
    aiPhase,
    callKey: usageLedgerContext?.callKey ?? aiPhase,
    metadata: {
      maxTokens,
      temperature: reasoningEffort ? null : temperature,
      reasoningEffort,
    },
  }));

  const raw = response.choices?.[0]?.message?.content;
  if (!raw) {
    throw new Error(`OpenAI returned an empty ${aiPhase} response`);
  }

  return {
    parsed: parseJsonResponse(raw),
    modelUsed: response?.model || model,
    usage: response?.usage || null,
  };
}

function assertSummaryStudyGuideStructure(text) {
  const normalizedText = normalizeString(text);
  const lowerText = normalizedText.toLowerCase();
  const missingSections = SUMMARY_STUDY_GUIDE_SECTIONS.filter(
    (section) => !lowerText.includes(section.toLowerCase()),
  );

  if (missingSections.length > 0) {
    const error = new Error(`Summary study guide is missing required sections: ${missingSections.join(", ")}`);
    error.code = "invalid_generation_output";
    throw error;
  }

  if (!/\|[^\n]+\|[^\n]*\n\|[\s:-]+\|/.test(normalizedText)) {
    const error = new Error("Summary study guide is missing a markdown comparison table");
    error.code = "invalid_generation_output";
    throw error;
  }

  const takeawaysMatch = normalizedText.match(/exam-level takeaways[\s\S]*?(common pitfalls|what to memorize)/i);
  const takeawayCount = (takeawaysMatch?.[0]?.match(/^\s*[-*•]\s+/gm) || []).length;
  if (takeawayCount < 3) {
    const error = new Error("Summary study guide must include at least 3 exam-level takeaways");
    error.code = "invalid_generation_output";
    throw error;
  }
}

function ensureSummaryStudyGuideTitle(text) {
  const normalizedText = normalizeString(text);
  if (!normalizedText) {
    return "";
  }

  if (/^#{1,6}\s+title\b/im.test(normalizedText)) {
    return normalizedText;
  }

  return `## Title\nStudy Guide\n\n${normalizedText}`;
}

function normalizeSummaryHeading(line) {
  const trimmed = normalizeString(line);
  if (!trimmed) {
    return "";
  }

  const withoutMarkdown = trimmed.replace(/^#{1,6}\s+/, "");
  const withoutNumber = withoutMarkdown.replace(/^\d+[\.)]\s+/, "");
  const withoutTrailingColon = withoutNumber.replace(/:+\s*$/, "");
  const exactTitle = SUMMARY_SECTION_TITLE_MAP.get(withoutTrailingColon.toLowerCase());
  if (exactTitle) {
    return `## ${exactTitle}`;
  }

  if (/^#{1,6}\s+/.test(trimmed)) {
    return `## ${withoutMarkdown}`;
  }

  return line.trimEnd();
}

function normalizeSummaryBullet(line) {
  const bulletMatch = line.match(/^(\s*)[-*•]\s+(.*)$/);
  if (!bulletMatch) {
    return line;
  }

  const indent = bulletMatch[1].length > 0 ? "  " : "";
  return `${indent}• ${bulletMatch[2].trim()}`;
}

function normalizeSummarySpacing(lines) {
  const cleaned = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const previous = cleaned[cleaned.length - 1] ?? "";
    const previousIsHeading = /^##\s+/.test(previous);
    const nextIsBlank = trimmed === "";

    if (nextIsBlank) {
      if (cleaned.length === 0 || previous === "" || previousIsHeading) {
        continue;
      }
      cleaned.push("");
      continue;
    }

    if (/^##\s+/.test(trimmed) && previous !== "" && cleaned.length > 0) {
      cleaned.push("");
    }

    cleaned.push(line.trimEnd());
  }

  return cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function cleanSummaryText(value) {
  const lines = normalizeString(value)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => normalizeSummaryHeading(line))
    .filter((line) => !/^\s*[-*_]{3,}\s*$/.test(line))
    .map((line) => normalizeSummaryBullet(line));

  return normalizeSummarySpacing(lines);
}

function normalizeSummaryOutput(parsed) {
  const text = cleanSummaryText(parsed?.text ?? parsed?.summary);
  return { text };
}

function normalizeFlashcardsOutput(parsed) {
  const sourceCards = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.cards)
      ? parsed.cards
      : [];
  const cards = sourceCards.length > 0
    ? sourceCards.map(normalizeFlashcard).filter(Boolean)
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

function combineUsage(...usageRecords) {
  const records = usageRecords.filter(Boolean);
  if (records.length === 0) {
    return null;
  }

  return records.reduce((combined, usage) => ({
    prompt_tokens: (combined.prompt_tokens || 0) + Number(usage.prompt_tokens || usage.input_tokens || 0),
    completion_tokens: (combined.completion_tokens || 0) + Number(usage.completion_tokens || usage.output_tokens || 0),
    total_tokens: (combined.total_tokens || 0) + Number(usage.total_tokens || 0),
  }), {});
}

function createQaItemCountMismatchError(generationType, targetCount, actualCount) {
  const error = new Error(
    `${generationType} QA returned ${actualCount} source-verified items; expected ${targetCount} supported items after count repair`,
  );
  error.code = "qa_item_count_mismatch";
  error.generationType = generationType;
  error.targetCount = targetCount;
  error.actualCount = actualCount;
  return error;
}

function createUngroundedGenerationOutputError(generationType, rejectedCount) {
  const error = new Error(
    `${generationType} QA did not return any items with a valid, relevant source citation (${rejectedCount} rejected)`,
  );
  error.code = "ungrounded_generation_output";
  error.generationType = generationType;
  error.rejectedCount = rejectedCount;
  return error;
}

function isUsefulFlashcardRepairStatement(statement) {
  const sourceText = normalizeString(statement?.text);
  const words = sourceText.split(/\s+/u).filter(Boolean);

  return words.length >= 6
    && !isHeadingOnlySourceEvidence(sourceText)
    && !isIncompleteSourceEvidence(sourceText)
    && !/\blearning\s+(?:outcomes?|objectives?)\b|^\s*(?:understand|become\s+familiar|identify|describe|figure|table|chapter|key\s+term)\b|\(e\s*$/iu.test(sourceText);
}

function scoreFlashcardRepairStatement(statement) {
  const sourceText = normalizeString(statement?.text);
  const wordCount = sourceText.split(/\s+/u).filter(Boolean).length;
  const hasFactualClause = /\b(?:is|are|was|were|has|have|includes?|involves?|requires?|represents?|contains?|provides?|supports?|defines?|describes?|allows?|helps?|creates?|connects?|consists?|comprises?|affects?|identifies?)\b/iu.test(sourceText);
  const startsAmbiguously = /^\s*(?:this|these|those|it|they|their|there|which|that|and|or|but|also)\b/iu.test(sourceText);

  return Math.min(wordCount, 28)
    + (wordCount >= 8 && wordCount <= 35 ? 20 : 0)
    + (hasFactualClause ? 15 : 0)
    - (startsAmbiguously ? 20 : 0);
}

function getAvailableFlashcardRepairStatements(sourceGrounding, usedSourceIds, attemptedSourceIds = new Set()) {
  const availableStatements = sourceGrounding.statements
    .filter((statement) => !usedSourceIds.has(statement.id)
      && isUsefulFlashcardRepairStatement(statement))
    .sort((left, right) => scoreFlashcardRepairStatement(right) - scoreFlashcardRepairStatement(left));
  const freshStatements = availableStatements.filter((statement) => !attemptedSourceIds.has(statement.id));
  const previouslyAttemptedStatements = availableStatements.filter((statement) => attemptedSourceIds.has(statement.id));

  return [...freshStatements, ...previouslyAttemptedStatements];
}

function enrichFlashcardRejectionDiagnostics(groundedResult, rawItems) {
  groundedResult.grounding.rejectedItems = groundedResult.grounding.rejectedItems.map((evidence) => {
    const rawItem = rawItems[evidence.index];
    const normalizedItem = normalizeFlashcard(rawItem);

    return {
      ...evidence,
      question: normalizedItem?.question ?? null,
      answer: normalizedItem?.answer ?? null,
    };
  });

  return groundedResult;
}

function recoverFlashcardSourceCitations({
  groundedResult,
  rawItems,
  sourceText,
  sourceGrounding,
  existingSourceIds = [],
}) {
  const sourceStatementsById = new Map(
    sourceGrounding.statements.map((statement) => [statement.id, statement]),
  );
  const statementRootsById = new Map(
    sourceGrounding.statements.map((statement) => [
      statement.id,
      new Set(getGroundingTokens(statement.text).map(stemGroundingToken)),
    ]),
  );
  const usedSourceIds = new Set([
    ...existingSourceIds,
    ...groundedResult.grounding.items.map((item) => item.sourceId).filter(Boolean),
  ]);
  let recoveredCount = 0;

  for (const rejection of groundedResult.grounding.rejectedItems) {
    const rawItem = rawItems[rejection.index];
    const normalizedItem = normalizeFlashcard(rawItem);
    if (!normalizedItem || rejection.reason === "distinctive_term_absent_from_source") {
      continue;
    }

    const answerRoots = [...new Set(
      getGroundingTokens(normalizedItem.answer).map(stemGroundingToken),
    )];
    const candidateStatements = sourceGrounding.statements
      .filter((statement) => !usedSourceIds.has(statement.id)
        && statement.id !== rejection.sourceId
        && !isHeadingOnlySourceEvidence(statement.text)
        && !isIncompleteSourceEvidence(statement.text))
      .map((statement) => ({
        statement,
        overlap: answerRoots.filter((root) => statementRootsById.get(statement.id)?.has(root)).length,
      }))
      .filter((candidate) => candidate.overlap > 0)
      .sort((left, right) => right.overlap - left.overlap);

    for (const { statement } of candidateStatements) {
      const evidence = assessItemSourceEvidence({
        generationType: DOCUMENT_GENERATION_TYPES.flashcards,
        rawItem: { ...rawItem, sourceId: statement.id },
        normalizedItem,
        sourceText,
        index: groundedResult.output.cards.length,
        sourceStatementsById,
      });

      const missingAnswerSpecificEvidence = evidence.answerSpecificEvidenceTerms
        ?.filter((term) => !evidence.sharedAnswerSpecificEvidenceTerms?.includes(term)) ?? [];
      if (!evidence.grounded || missingAnswerSpecificEvidence.length > 0) {
        continue;
      }

      groundedResult.output.cards.push(normalizedItem);
      groundedResult.grounding.items.push({
        ...evidence,
        repairMethod: "citation_relinked",
        originalSourceId: rejection.sourceId,
      });
      usedSourceIds.add(statement.id);
      recoveredCount += 1;
      break;
    }
  }

  return recoveredCount;
}

function buildExtractiveFlashcard(statement) {
  const words = normalizeString(statement.text).split(/\s+/u).filter(Boolean);
  const subjectMatch = statement.text.match(
    /^(.{8,85}?)\s+(?:is|are|was|were|has|have|adapts?|improves?|includes?|involves?|requires?|represents?|contains?|provides?|supports?|defines?|describes?|allows?|helps?|creates?|connects?|consists?|comprises?|affects?|identifies?)\b/iu,
  );
  const subjectWords = normalizeString(subjectMatch?.[1] ?? "").split(/\s+/u).filter(Boolean);
  const topicWords = subjectWords.length >= 2 && subjectWords.length <= 8
    ? subjectWords
    : words.slice(0, Math.min(6, Math.max(3, Math.floor(words.length / 3))));
  const topic = topicWords.join(" ").replace(/[,:;]+$/u, "");
  let answer = words.slice(0, MAX_EXTRACTIVE_FLASHCARD_ANSWER_WORDS).join(" ");

  if (words.length > MAX_EXTRACTIVE_FLASHCARD_ANSWER_WORDS) {
    const finalClauseBoundary = Math.max(answer.lastIndexOf(","), answer.lastIndexOf(";"));
    const completeClauses = finalClauseBoundary > 0
      ? answer.slice(0, finalClauseBoundary).trim()
      : "";
    if (completeClauses.split(/\s+/u).filter(Boolean).length >= 6) {
      answer = completeClauses;
    }
  }

  answer = answer.replace(/(?:\s+(?:a|an|the|and|or|to|of|for|with|in|on|at|by|as))+$/iu, "");
  answer = answer.replace(/[,:;]+$/u, "");

  return {
    front: `According to the source, what is stated about ${topic}?`,
    back: answer,
    sourceId: statement.id,
  };
}

function appendExtractiveGroundedFlashcards({
  currentResult,
  sourceText,
  sourceGrounding,
  targetCount,
}) {
  const sourceStatementsById = new Map(
    sourceGrounding.statements.map((statement) => [statement.id, statement]),
  );
  const usedSourceIds = new Set(currentResult.grounding.items.map((item) => item.sourceId).filter(Boolean));
  const usedQuestions = new Set(
    currentResult.output.cards.map((item) => normalizeSourceEvidence(item.question)),
  );
  let appendedCount = 0;

  for (const statement of getAvailableFlashcardRepairStatements(sourceGrounding, usedSourceIds)) {
    if (currentResult.output.cards.length >= targetCount) {
      break;
    }

    const rawItem = buildExtractiveFlashcard(statement);
    const normalizedItem = normalizeFlashcard(rawItem);
    const questionKey = normalizeSourceEvidence(normalizedItem?.question);
    if (!normalizedItem || usedQuestions.has(questionKey)) {
      continue;
    }

    const evidence = assessItemSourceEvidence({
      generationType: DOCUMENT_GENERATION_TYPES.flashcards,
      rawItem,
      normalizedItem,
      sourceText,
      index: currentResult.output.cards.length,
      sourceStatementsById,
    });
    if (!evidence.grounded) {
      continue;
    }

    currentResult.output.cards.push(normalizedItem);
    currentResult.grounding.items.push({
      ...evidence,
      repairMethod: "extractive_source_fallback",
    });
    usedQuestions.add(questionKey);
    usedSourceIds.add(statement.id);
    appendedCount += 1;
  }

  return appendedCount;
}

function buildFlashcardCountRepairPrompt({
  targetCount,
  actualCount,
  existingCards,
  existingSourceIds,
  availableSourceStatements,
  recentRejections,
  attempt,
}) {
  const missingCount = targetCount - actualCount;
  const rejectionExamples = recentRejections.slice(-8)
    .map((item) => `- ${item.sourceId ?? "missing sourceId"}: ${item.reason}; question: ${item.question ?? "unavailable"}; answer: ${item.answer ?? "unavailable"}`)
    .join("\n");

  return `COUNT REPAIR REQUIRED (adaptive attempt ${attempt}):
The previous QA response returned ${actualCount} source-verified flashcards. Those cards are already preserved.
Return exactly ${missingCount} ADDITIONAL source-grounded flashcards, not the full set.

Create one flashcard per distinct numbered source statement below. Write a specific question and a concise answer of no more than 18 words. Every factual answer detail must appear in its ONE cited statement; copy the statement's factual wording. Never cite a heading, an incomplete fragment, or a statement that only names the question topic.

still-unused, directly citable source statements:
${availableSourceStatements.map((statement) => `[${statement.id}] ${statement.text}`).join("\n")}

Do not reuse these source identifiers: ${existingSourceIds.join(", ") || "none"}.
Do not repeat these existing questions:
${existingCards.map((card) => `- ${card.question}`).join("\n")}
${rejectionExamples ? `\nRecent rejected candidates and exact failure reasons:\n${rejectionExamples}\n` : ""}
Return ONLY a valid JSON array of exactly ${missingCount} objects shaped {"front":"specific question","back":"brief factual answer","sourceId":"S001"}.`;
}

function buildFlashcardGroundingDiagnostics({
  targetCount,
  sourceGrounding,
  grounding,
  acceptedCount,
  firstPassAccepted,
  firstPassAfterCitationRecovery,
  repairAttempts,
  citationRecoveryCount,
  extractiveFallbackCount,
}) {
  const rejectedItems = grounding.rejectedItems.slice(-MAX_PERSISTED_GROUNDING_REJECTIONS);
  const rejectionReasons = {};
  for (const rejection of grounding.rejectedItems) {
    const reason = rejection.reason ?? "unknown";
    rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
  }

  return {
    generationType: DOCUMENT_GENERATION_TYPES.flashcards,
    targetCount,
    acceptedCount,
    firstPassAccepted,
    firstPassAfterCitationRecovery,
    sourceStatementCount: sourceGrounding.distinctStatementCount,
    usableSourceStatementCount: sourceGrounding.statements.filter(isUsefulFlashcardRepairStatement).length,
    rejectedCount: grounding.totalRejectedCount ?? grounding.rejectedCount,
    rejectionReasons,
    rejectedItems,
    repairAttempts,
    citationRecoveryCount,
    extractiveFallbackCount,
  };
}

async function persistFlashcardGroundingDiagnostics(usageLedgerContext, diagnostics) {
  if (!usageLedgerContext?.jobId || !usageLedgerContext?.prisma?.job?.updateMany) {
    return;
  }

  try {
    await usageLedgerContext.prisma.job.updateMany({
      where: {
        id: usageLedgerContext.jobId,
        status: "running",
      },
      data: {
        result: { failureDiagnostics: diagnostics },
      },
    });
  } catch (error) {
    console.warn("[studyMaterials] failed to persist grounding diagnostics:", error);
  }
}

function buildQaCountRepairInstruction(
  generationType,
  targetCount,
  actualCount,
  existingSourceIds = [],
  availableSourceStatements = [],
) {
  const itemLabel = generationType === DOCUMENT_GENERATION_TYPES.flashcards
    ? "flashcards"
    : "questions";
  const missingCount = targetCount - actualCount;

  if (missingCount > 0) {
    return `\n\nCOUNT REPAIR REQUIRED:
The previous QA response returned ${actualCount} source-verified ${itemLabel}, while this source has capacity for ${targetCount}.
Those ${actualCount} verified items are already preserved. Return exactly ${missingCount} ADDITIONAL source-grounded ${itemLabel}, not the full set.
Find ${missingCount} distinct, meaningful concepts from numbered source statements that are not already covered by the input items.${existingSourceIds.length > 0 ? ` Do not reuse these existing source identifiers: ${existingSourceIds.join(", ")}.` : ""}
Every additional item must include its directly supporting "sourceId". Never repeat an existing question, invent facts, add outside knowledge, or duplicate concepts merely to meet a number.${availableSourceStatements.length > 0 ? `
Select your additional concepts from these still-unused, directly citable source statements:
${availableSourceStatements.map((statement) => `[${statement.id}] ${statement.text}`).join("\n")}` : ""}`;
  }

  return `\n\nCOUNT REPAIR REQUIRED:
The previous QA response returned ${actualCount} source-verified ${itemLabel}, while this source has capacity for up to ${targetCount}.
Preserve the strongest supported items and add only distinct concepts explicitly present in the source excerpts until there are ${targetCount} ${itemLabel}.
Every item must include the "sourceId" of the numbered source statement that directly supports it. If the source truly cannot support the target, return the smaller supported set; never invent facts, add outside knowledge, or duplicate concepts merely to meet a number.`;
}

function mergeGroundedQaResults(generationType, currentResult, additionalResult, targetCount) {
  const itemKey = generationType === DOCUMENT_GENERATION_TYPES.flashcards ? "cards" : "questions";
  const currentItems = currentResult.output[itemKey];
  const mergedItems = [...currentItems];
  const mergedEvidence = currentResult.grounding.items.map((item, index) => ({ ...item, index }));
  const seenQuestions = new Set(currentItems.map((item) => normalizeSourceEvidence(item.question)));
  const usedSourceIds = new Set(mergedEvidence.map((item) => item.sourceId).filter(Boolean));

  for (const [index, item] of additionalResult.output[itemKey].entries()) {
    if (mergedItems.length >= targetCount) {
      break;
    }

    const evidence = additionalResult.grounding.items[index];
    const questionKey = normalizeSourceEvidence(item.question);
    if (seenQuestions.has(questionKey) || (evidence?.sourceId && usedSourceIds.has(evidence.sourceId))) {
      continue;
    }

    mergedItems.push(item);
    mergedEvidence.push({ ...evidence, index: mergedItems.length - 1 });
    seenQuestions.add(questionKey);
    if (evidence?.sourceId) {
      usedSourceIds.add(evidence.sourceId);
    }
  }

  return {
    output: { [itemKey]: mergedItems },
    grounding: {
      items: mergedEvidence,
      rejectedItems: [
        ...currentResult.grounding.rejectedItems,
        ...additionalResult.grounding.rejectedItems,
      ],
      rejectedCount: currentResult.grounding.rejectedCount + additionalResult.grounding.rejectedCount,
      totalRejectedCount: currentResult.grounding.rejectedCount + additionalResult.grounding.rejectedCount,
    },
  };
}

function buildModelCompletionParams({
  model,
  messages,
  maxTokens,
  temperature,
  reasoningEffort = null,
}) {
  const params = { model, messages };
  if (reasoningEffort) {
    params.reasoning_effort = reasoningEffort;
    params.max_completion_tokens = maxTokens;
  } else {
    params.temperature = temperature;
    params.max_tokens = maxTokens;
  }
  return params;
}

async function validateAndImproveFlashcards({
  cards,
  language,
  sourceText,
  targetCount,
  model,
  reasoningEffort = null,
  usageLedgerContext = null,
}) {
  const output = { cards };
  assertNonEmptyGenerationOutput(DOCUMENT_GENERATION_TYPES.flashcards, output);

  const openai = getClient();
  const sourceGrounding = inspectSourceGrounding(sourceText);
  await persistFlashcardGroundingDiagnostics(usageLedgerContext, buildFlashcardGroundingDiagnostics({
    targetCount,
    sourceGrounding,
    grounding: { rejectedItems: [], rejectedCount: 0 },
    acceptedCount: 0,
    firstPassAccepted: null,
    firstPassAfterCitationRecovery: null,
    repairAttempts: [],
    citationRecoveryCount: 0,
    extractiveFallbackCount: 0,
  }));
  const runQaCall = async ({ inputCards, countRepair = null }) => {
    const repairTarget = countRepair && countRepair.actualCount < targetCount
      ? targetCount - countRepair.actualCount
      : targetCount;
    const maxTokens = countRepair
      ? Math.min(
        QA_OUTPUT_TOKEN_LIMITS[DOCUMENT_GENERATION_TYPES.flashcards],
        Math.max(450, repairTarget * 110),
      )
      : QA_OUTPUT_TOKEN_LIMITS[DOCUMENT_GENERATION_TYPES.flashcards];
    const prompt = countRepair
      ? buildFlashcardCountRepairPrompt({
        targetCount,
        actualCount: countRepair.actualCount,
        existingCards: inputCards,
        existingSourceIds: countRepair.existingSourceIds,
        availableSourceStatements: countRepair.availableSourceStatements,
        recentRejections: countRepair.recentRejections,
        attempt: countRepair.attempt,
      })
      : buildFlashcardQaPrompt(inputCards, language, sourceText, repairTarget);
    const params = buildModelCompletionParams({
      model,
      reasoningEffort,
      temperature: 0.15,
      maxTokens,
      messages: [
        {
          role: "system",
          content: "You validate source-grounded flashcards. Return only a valid JSON array of {front,back,sourceId} objects; never invent unsupported facts.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    });
    const response = await createChatCompletion(openai, params, withUsageLedgerCallContext(usageLedgerContext, {
      aiPhase: countRepair ? "flashcards_qa_count_repair" : "flashcards_qa",
      callKey: countRepair
        ? `flashcards:qa-count-repair:${countRepair.attempt ?? 1}`
        : "flashcards:qa",
      metadata: {
        targetCount,
        previousCount: countRepair?.actualCount ?? null,
        requestedAdditionalCount: countRepair && countRepair.actualCount < targetCount
          ? targetCount - countRepair.actualCount
          : null,
        repairAttempt: countRepair?.attempt ?? null,
        repairStrategy: countRepair ? "source_anchored_adaptive" : null,
        candidateSourceCount: countRepair?.availableSourceStatements.length ?? null,
        maxTokens,
        temperature: reasoningEffort ? null : 0.15,
        reasoningEffort,
      },
    }));

    const raw = response.choices?.[0]?.message?.content;
    if (!raw) {
      throw new Error("OpenAI returned an empty flashcard QA response");
    }

    const parsed = parseJsonResponse(raw);
    const rawItems = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.cards)
        ? parsed.cards
        : [];
    const groundedResult = enrichFlashcardRejectionDiagnostics(normalizeGroundedQaOutput(
      DOCUMENT_GENERATION_TYPES.flashcards,
      parsed,
      sourceText,
    ), rawItems);
    const verifiedBeforeRecovery = groundedResult.output.cards.length;
    const recoveredCount = recoverFlashcardSourceCitations({
      groundedResult,
      rawItems,
      sourceText,
      sourceGrounding,
      existingSourceIds: countRepair?.existingSourceIds,
    });

    return {
      response,
      ...groundedResult,
      rawItemCount: rawItems.length,
      verifiedBeforeRecovery,
      recoveredCount,
    };
  };

  const firstQa = await runQaCall({ inputCards: cards });
  let improvedOutput = firstQa.output;
  let grounding = firstQa.grounding;
  const responses = [firstQa.response];
  const repairAttempts = [];
  const attemptedSourceIds = new Set();
  const firstPassAccepted = firstQa.verifiedBeforeRecovery;
  const firstPassAfterCitationRecovery = improvedOutput.cards.length;
  let citationRecoveryCount = firstQa.recoveredCount;
  let extractiveFallbackCount = 0;
  const getDiagnostics = () => buildFlashcardGroundingDiagnostics({
    targetCount,
    sourceGrounding,
    grounding,
    acceptedCount: improvedOutput.cards.length,
    firstPassAccepted,
    firstPassAfterCitationRecovery,
    repairAttempts,
    citationRecoveryCount,
    extractiveFallbackCount,
  });

  await persistFlashcardGroundingDiagnostics(usageLedgerContext, getDiagnostics());

  if (improvedOutput.cards.length === 0 && grounding.rejectedCount > 0) {
    const error = createUngroundedGenerationOutputError(
      DOCUMENT_GENERATION_TYPES.flashcards,
      grounding.rejectedCount,
    );
    error.groundingDiagnostics = getDiagnostics();
    throw error;
  }

  for (
    let repairAttempt = 1;
    improvedOutput.cards.length < targetCount
      && repairAttempt <= MAX_FLASHCARD_ADAPTIVE_REPAIR_ATTEMPTS;
    repairAttempt += 1
  ) {
    const previousCount = improvedOutput.cards.length;
    const previousResult = { output: improvedOutput, grounding };
    const existingSourceIds = grounding.items.map((item) => item.sourceId).filter(Boolean);
    const usedSourceIds = new Set(existingSourceIds);
    const missingCount = Math.max(1, targetCount - previousCount);
    const availableSourceStatements = getAvailableFlashcardRepairStatements(
      sourceGrounding,
      usedSourceIds,
      attemptedSourceIds,
    ).slice(0, Math.max(12, missingCount * 2));
    for (const statement of availableSourceStatements) {
      attemptedSourceIds.add(statement.id);
    }
    const inputCards = improvedOutput.cards.length > 0
      ? improvedOutput.cards.map((card, index) => ({
        ...card,
        ...(grounding.items[index]?.sourceId ? { sourceId: grounding.items[index].sourceId } : {}),
      }))
      : cards;
    const repairedQa = await runQaCall({
      inputCards,
      countRepair: {
        actualCount: previousCount,
        existingSourceIds,
        availableSourceStatements,
        recentRejections: grounding.rejectedItems,
        attempt: repairAttempt,
      },
    });
    const repairedResult = improvedOutput.cards.length < targetCount && improvedOutput.cards.length > 0
      ? mergeGroundedQaResults(
        DOCUMENT_GENERATION_TYPES.flashcards,
        previousResult,
        repairedQa,
        targetCount,
      )
      : {
        output: repairedQa.output,
        grounding: {
          ...repairedQa.grounding,
          totalRejectedCount: (grounding.totalRejectedCount ?? grounding.rejectedCount)
            + repairedQa.grounding.rejectedCount,
        },
      };
    improvedOutput = repairedResult.output;
    grounding = repairedResult.grounding;
    responses.push(repairedQa.response);
    citationRecoveryCount += repairedQa.recoveredCount;
    repairAttempts.push({
      attempt: repairAttempt,
      requestedCount: missingCount,
      acceptedBefore: previousCount,
      acceptedAfter: improvedOutput.cards.length,
      rawCandidateCount: repairedQa.rawItemCount,
      initiallyGroundedCount: repairedQa.verifiedBeforeRecovery,
      citationRecoveryCount: repairedQa.recoveredCount,
      rejectedCount: repairedQa.grounding.rejectedCount,
      offeredSourceIds: availableSourceStatements.map((statement) => statement.id),
    });
    await persistFlashcardGroundingDiagnostics(usageLedgerContext, getDiagnostics());
  }

  if (improvedOutput.cards.length > 0
    && improvedOutput.cards.length < targetCount
    && sourceGrounding.distinctStatementCount >= targetCount) {
    extractiveFallbackCount = appendExtractiveGroundedFlashcards({
      currentResult: { output: improvedOutput, grounding },
      sourceText,
      sourceGrounding,
      targetCount,
    });
    await persistFlashcardGroundingDiagnostics(usageLedgerContext, getDiagnostics());
  }

  if (improvedOutput.cards.length !== targetCount) {
    const error = createQaItemCountMismatchError(
      DOCUMENT_GENERATION_TYPES.flashcards,
      targetCount,
      improvedOutput.cards.length,
    );
    error.groundingDiagnostics = getDiagnostics();
    throw error;
  }

  const finalResponse = responses.at(-1);

  return {
    output: improvedOutput,
    grounding: {
      ...grounding,
      repairSummary: {
        firstPassAccepted,
        firstPassAfterCitationRecovery,
        modelRepairAttempts: repairAttempts,
        citationRecoveryCount,
        extractiveFallbackCount,
        usableSourceStatementCount: sourceGrounding.statements.filter(isUsefulFlashcardRepairStatement).length,
      },
    },
    modelUsed: finalResponse?.model || model,
    usage: combineUsage(...responses.map((response) => response?.usage)),
  };
}

async function validateAndImproveExam({
  questions,
  language,
  sourceText,
  targetCount,
  model,
  reasoningEffort = null,
  usageLedgerContext = null,
}) {
  const output = { questions };
  assertNonEmptyGenerationOutput(DOCUMENT_GENERATION_TYPES.exam, output);

  const openai = getClient();
  const runQaCall = async ({ inputQuestions, countRepair = null }) => {
    const repairTarget = countRepair && countRepair.actualCount < targetCount
      ? targetCount - countRepair.actualCount
      : targetCount;
    const basePrompt = buildExamQaPrompt(inputQuestions, language, sourceText, repairTarget);
    const params = buildModelCompletionParams({
      model,
      reasoningEffort,
      temperature: 0.15,
      maxTokens: QA_OUTPUT_TOKEN_LIMITS[DOCUMENT_GENERATION_TYPES.exam],
      messages: [
        {
          role: "system",
          content: "You validate source-grounded mock exams. Return only a valid JSON object with questions that each cite a numbered sourceId; never invent unsupported facts.",
        },
        {
          role: "user",
          content: countRepair
            ? `${basePrompt}${buildQaCountRepairInstruction(
              DOCUMENT_GENERATION_TYPES.exam,
              targetCount,
              countRepair.actualCount,
              countRepair.existingSourceIds,
              countRepair.availableSourceStatements,
            )}`
            : basePrompt,
        },
      ],
    });
    const response = await createChatCompletion(openai, params, withUsageLedgerCallContext(usageLedgerContext, {
      aiPhase: countRepair ? "exam_qa_count_repair" : "exam_qa",
      callKey: countRepair
        ? `exam:qa-count-repair:${countRepair.attempt ?? 1}`
        : "exam:qa",
      metadata: {
        targetCount,
        previousCount: countRepair?.actualCount ?? null,
        requestedAdditionalCount: countRepair && countRepair.actualCount < targetCount
          ? targetCount - countRepair.actualCount
          : null,
        repairAttempt: countRepair?.attempt ?? null,
        maxTokens: QA_OUTPUT_TOKEN_LIMITS[DOCUMENT_GENERATION_TYPES.exam],
        temperature: reasoningEffort ? null : 0.15,
        reasoningEffort,
      },
    }));

    const raw = response.choices?.[0]?.message?.content;
    if (!raw) {
      throw new Error("OpenAI returned an empty exam QA response");
    }

    const groundedResult = normalizeGroundedQaOutput(
      DOCUMENT_GENERATION_TYPES.exam,
      parseJsonResponse(raw),
      sourceText,
    );
    return { response, ...groundedResult };
  };

  const firstQa = await runQaCall({ inputQuestions: questions });
  let improvedOutput = firstQa.output;
  let grounding = firstQa.grounding;
  const responses = [firstQa.response];

  for (
    let repairAttempt = 1;
    improvedOutput.questions.length !== targetCount && repairAttempt <= MAX_QA_COUNT_REPAIR_ATTEMPTS;
    repairAttempt += 1
  ) {
    const previousCount = improvedOutput.questions.length;
    const previousResult = { output: improvedOutput, grounding };
    const existingSourceIds = grounding.items.map((item) => item.sourceId).filter(Boolean);
    const usedSourceIds = new Set(existingSourceIds);
    const missingCount = Math.max(1, targetCount - previousCount);
    const availableSourceStatements = inspectSourceGrounding(sourceText).statements
      .filter((statement) => !usedSourceIds.has(statement.id)
        && !isHeadingOnlySourceEvidence(statement.text)
        && !isIncompleteSourceEvidence(statement.text))
      .slice(0, Math.max(12, missingCount * 3));
    const inputQuestions = improvedOutput.questions.length > 0
      ? improvedOutput.questions.map((question, index) => ({
        ...question,
        ...(grounding.items[index]?.sourceId ? { sourceId: grounding.items[index].sourceId } : {}),
      }))
      : questions;
    const repairedQa = await runQaCall({
      inputQuestions,
      countRepair: {
        actualCount: previousCount,
        existingSourceIds,
        availableSourceStatements,
        attempt: repairAttempt,
      },
    });
    const repairedResult = improvedOutput.questions.length < targetCount && improvedOutput.questions.length > 0
      ? mergeGroundedQaResults(
        DOCUMENT_GENERATION_TYPES.exam,
        previousResult,
        repairedQa,
        targetCount,
      )
      : {
        output: repairedQa.output,
        grounding: {
          ...repairedQa.grounding,
          totalRejectedCount: (grounding.totalRejectedCount ?? grounding.rejectedCount)
            + repairedQa.grounding.rejectedCount,
        },
      };
    improvedOutput = repairedResult.output;
    grounding = repairedResult.grounding;
    responses.push(repairedQa.response);

    if (improvedOutput.questions.length <= previousCount) {
      break;
    }
  }

  if (improvedOutput.questions.length === 0 && grounding.rejectedCount > 0) {
    throw createUngroundedGenerationOutputError(
      DOCUMENT_GENERATION_TYPES.exam,
      grounding.rejectedCount,
    );
  }

  if (improvedOutput.questions.length !== targetCount) {
    throw createQaItemCountMismatchError(
      DOCUMENT_GENERATION_TYPES.exam,
      targetCount,
      improvedOutput.questions.length,
    );
  }

  const finalResponse = responses.at(-1);

  return {
    output: improvedOutput,
    grounding,
    modelUsed: finalResponse?.model || model,
    usage: combineUsage(...responses.map((response) => response?.usage)),
  };
}

function buildPromptForGeneration({ generationType, language, options, sourceText, sourceTier, sampled }) {
  if (generationType === DOCUMENT_GENERATION_TYPES.summary) {
    return {
      prompt: buildStrictSummaryPrompt(sourceText, language, options, sourceTier, sampled),
      effectiveOptions: options,
    };
  }

  const sourceGrounding = inspectSourceGrounding(sourceText);

  if (generationType === DOCUMENT_GENERATION_TYPES.flashcards) {
    const requestedCardCount = getFlashcardTargetCount(sourceTier);
    const groundedCardCount = resolveGroundedTargetCount(requestedCardCount, sourceGrounding);
    return {
      prompt: buildFlashcardsPrompt(
        sourceText,
        language,
        options,
        sourceTier,
        sampled,
        groundedCardCount,
        sourceGrounding.distinctStatementCount,
      ),
      effectiveOptions: {
        ...options,
        cardCount: groundedCardCount,
        requestedCardCount,
        distinctSourceStatementCount: sourceGrounding.distinctStatementCount,
        sourceLimited: groundedCardCount < requestedCardCount,
      },
    };
  }

  const requestedQuestionCount = getExamTargetCount(sourceTier, options.questionCount);
  const effectiveQuestionCount = resolveGroundedTargetCount(requestedQuestionCount, sourceGrounding);
  return {
    prompt: buildExamPrompt(
      sourceText,
      language,
      effectiveQuestionCount,
      options,
      sampled,
      sourceGrounding.distinctStatementCount,
    ),
    effectiveOptions: {
      ...options,
      questionCount: effectiveQuestionCount,
      requestedQuestionCount,
      distinctSourceStatementCount: sourceGrounding.distinctStatementCount,
      sourceLimited: effectiveQuestionCount < requestedQuestionCount,
    },
  };
}

async function extractStudyGuideSignals({
  chunks,
  language,
  model,
  reasoningEffort,
  usageLedgerContext = null,
}) {
  const signalMaps = [];
  let usage = null;
  let modelUsed = model;

  for (let index = 0; index < chunks.length; index += 1) {
    const result = await createJsonCompletion({
      aiPhase: "summary_signal_extraction",
      model,
      reasoningEffort,
      systemPrompt: "You extract structured exam-study signals as strict JSON. Return valid JSON only.",
      userPrompt: buildStudyGuideSignalExtractionPrompt(chunks[index], language, index, chunks.length),
      maxTokens: 1_400,
      temperature: 0.1,
      usageLedgerContext: withUsageLedgerCallContext(usageLedgerContext, {
        aiPhase: "summary_signal_extraction",
        callKey: `summary_signal_extraction:${index + 1}`,
        metadata: {
          chunkIndex: index,
          chunkCount: chunks.length,
        },
      }),
    });

    signalMaps.push(normalizeChapterMap(result.parsed));
    usage = mergeTokenUsage(usage, result.usage);
    modelUsed = result.modelUsed || modelUsed;
  }

  return {
    signalMap: compactChapterMap(signalMaps),
    usage,
    modelUsed,
  };
}

async function analyzeStudyGuideChapterMap({
  signalMap,
  language,
  model,
  reasoningEffort,
  usageLedgerContext = null,
}) {
  const result = await createJsonCompletion({
    aiPhase: "summary_chapter_map_analysis",
    model,
    reasoningEffort,
    systemPrompt: "You produce global chapter maps for exam study guides as strict JSON. Return valid JSON only.",
    userPrompt: buildChapterMapPrompt(signalMap, language),
    maxTokens: SUMMARY_ANALYSIS_OUTPUT_TOKEN_LIMIT,
    temperature: 0.15,
    usageLedgerContext: withUsageLedgerCallContext(usageLedgerContext, {
      aiPhase: "summary_chapter_map_analysis",
      callKey: "summary:chapter-map-analysis",
    }),
  });

  return {
    chapterMap: normalizeChapterMap(result.parsed),
    usage: result.usage,
    modelUsed: result.modelUsed,
  };
}

async function synthesizeStudyGuideDraft({
  chapterMap,
  language,
  options,
  sourceTier,
  generationType,
  model,
  reasoningEffort,
  usageLedgerContext = null,
}) {
  const result = await createJsonCompletion({
    aiPhase: "summary_structured_synthesis",
    model,
    reasoningEffort,
    systemPrompt: "You generate exam study guides as strict JSON. Return valid JSON only.",
    userPrompt: buildStudyGuideSynthesisPrompt(chapterMap, language, options, sourceTier),
    maxTokens: SUMMARY_STUDY_GUIDE_OUTPUT_TOKEN_LIMIT,
    temperature: 0.3,
    usageLedgerContext: withUsageLedgerCallContext(usageLedgerContext, {
      aiPhase: "summary_structured_synthesis",
      callKey: "summary:structured-synthesis",
      metadata: { sourceTier },
    }),
  });

  const output = normalizeSummaryOutput(result.parsed);
  assertNonEmptyGenerationOutput(generationType, output);

  return {
    text: output.text,
    usage: result.usage,
    modelUsed: result.modelUsed,
  };
}

async function optimizeStudyGuideForExams({
  draftText,
  chapterMap,
  language,
  generationType,
  model,
  reasoningEffort,
  usageLedgerContext = null,
}) {
  const result = await createJsonCompletion({
    aiPhase: "summary_exam_optimization",
    model,
    reasoningEffort,
    systemPrompt: "You optimize exam study guides as strict JSON. Return valid JSON only.",
    userPrompt: buildStudyGuideOptimizationPrompt(draftText, chapterMap, language),
    maxTokens: SUMMARY_STUDY_GUIDE_OUTPUT_TOKEN_LIMIT,
    temperature: 0.2,
    usageLedgerContext: withUsageLedgerCallContext(usageLedgerContext, {
      aiPhase: "summary_exam_optimization",
      callKey: "summary:exam-optimization",
    }),
  });

  const output = normalizeSummaryOutput(result.parsed);
  assertNonEmptyGenerationOutput(generationType, output);

  return {
    text: output.text,
    usage: result.usage,
    modelUsed: result.modelUsed,
  };
}

async function enforceStudyGuideFormat({
  optimizedText,
  language,
  generationType,
  model,
  reasoningEffort,
  usageLedgerContext = null,
}) {
  const result = await createJsonCompletion({
    aiPhase: "summary_format_enforcement",
    model,
    reasoningEffort,
    systemPrompt: "You enforce markdown format for exam study guides as strict JSON. Return valid JSON only.",
    userPrompt: buildStudyGuideFormatPrompt(optimizedText, language),
    maxTokens: SUMMARY_STUDY_GUIDE_OUTPUT_TOKEN_LIMIT,
    temperature: 0.1,
    usageLedgerContext: withUsageLedgerCallContext(usageLedgerContext, {
      aiPhase: "summary_format_enforcement",
      callKey: "summary:format-enforcement",
    }),
  });

  const output = normalizeSummaryOutput(result.parsed);
  output.text = ensureSummaryStudyGuideTitle(output.text);
  assertNonEmptyGenerationOutput(generationType, output);
  assertSummaryStudyGuideStructure(output.text);

  return {
    text: output.text,
    usage: result.usage,
    modelUsed: result.modelUsed,
  };
}

async function generateSummaryStudyGuideFromExcerptsV2({
  generationType,
  excerpts,
  language,
  options,
  model,
  reasoningEffort,
  usageLedgerContext = null,
}) {
  const sourceMaterial = buildStudyGuideAnalysisChunks(excerpts);
  if (sourceMaterial.chunks.length === 0) {
    const error = new Error("No usable excerpts available for generation");
    error.code = "no_usable_excerpts";
    throw error;
  }

  const sourceTier = getSourceSizeTier(sourceMaterial.estimatedInputTokens);
  let usage = null;
  let modelUsed = model;
  const analysisCacheKey = getSummaryStudyGuideAnalysisCacheKey(excerpts);
  const cachedChapterMap = options.regenerationGuidance
    ? getCachedSummaryStudyGuideAnalysis(analysisCacheKey)
    : null;
  let chapterMap = cachedChapterMap;

  if (!chapterMap) {
    const extractedSignals = await extractStudyGuideSignals({
      chunks: sourceMaterial.chunks,
      language,
      model,
      reasoningEffort,
      usageLedgerContext,
    });
    usage = mergeTokenUsage(usage, extractedSignals.usage);
    modelUsed = extractedSignals.modelUsed || modelUsed;

    const analysis = await analyzeStudyGuideChapterMap({
      signalMap: extractedSignals.signalMap,
      language,
      model,
      reasoningEffort,
      usageLedgerContext,
    });
    usage = mergeTokenUsage(usage, analysis.usage);
    modelUsed = analysis.modelUsed || modelUsed;
    chapterMap = analysis.chapterMap;
    setCachedSummaryStudyGuideAnalysis(analysisCacheKey, chapterMap);
  }

  const draft = await synthesizeStudyGuideDraft({
    chapterMap,
    language,
    options,
    sourceTier,
    generationType,
    model,
    reasoningEffort,
    usageLedgerContext,
  });
  usage = mergeTokenUsage(usage, draft.usage);
  modelUsed = draft.modelUsed || modelUsed;

  const optimized = await optimizeStudyGuideForExams({
    draftText: draft.text,
    chapterMap,
    language,
    generationType,
    model,
    reasoningEffort,
    usageLedgerContext,
  });
  usage = mergeTokenUsage(usage, optimized.usage);
  modelUsed = optimized.modelUsed || modelUsed;

  const formatted = await enforceStudyGuideFormat({
    optimizedText: optimized.text,
    language,
    generationType,
    model,
    reasoningEffort,
    usageLedgerContext,
  });
  usage = mergeTokenUsage(usage, formatted.usage);
  modelUsed = formatted.modelUsed || modelUsed;

  return {
    output: { text: formatted.text },
    modelUsed,
    usage,
    estimatedInputTokens: sourceMaterial.estimatedInputTokens,
    selectedExcerptCount: sourceMaterial.selectedExcerptCount,
    totalExcerptCount: sourceMaterial.totalExcerptCount,
    sampled: false,
    effectiveOptions: options,
  };
}

async function generateSummaryFromExcerptsWithCleanPrompt({
  generationType,
  excerpts,
  options,
  model,
  reasoningEffort,
  usageLedgerContext = null,
}) {
  const sourceMaterial = prepareGpt55SummarySourceMaterial(excerpts);
  const regenerationGuidancePrompt = buildRegenerationGuidancePrompt(options);
  const messages = [
    { role: "user", content: SUMMARY_GENERATION_PROMPT },
  ];
  if (regenerationGuidancePrompt) {
    messages.push({ role: "user", content: regenerationGuidancePrompt });
  }
  messages.push({ role: "user", content: sourceMaterial.text });
  const summaryParams = {
    model,
    max_completion_tokens: GPT55_SUMMARY_OUTPUT_TOKEN_LIMIT,
    messages,
  };
  if (reasoningEffort) {
    summaryParams.reasoning_effort = reasoningEffort;
  }

  const openai = getClient();
  const response = await createChatCompletion(openai, summaryParams, withUsageLedgerCallContext(usageLedgerContext, {
    aiPhase: "generate_clean_summary",
    callKey: "summary:clean",
    metadata: {
      maxCompletionTokens: GPT55_SUMMARY_OUTPUT_TOKEN_LIMIT,
      reasoningEffort,
      selectedExcerptCount: sourceMaterial.selectedExcerptCount,
      totalExcerptCount: sourceMaterial.totalExcerptCount,
    },
  }));

  const rawContent = getChatMessageTextContent(response.choices?.[0]?.message);
  const text = cleanSummaryText(rawContent);
  if (!text) {
    const emptyOutputError = createEmptySummaryOutputError(response, rawContent);
    console.warn("[summary] model returned no usable visible content", emptyOutputError.diagnostics);
    throw emptyOutputError;
  }

  const output = { text };
  assertNonEmptyGenerationOutput(generationType, output);

  return {
    output,
    modelUsed: response?.model || model,
    usage: response?.usage || null,
    estimatedInputTokens: sourceMaterial.estimatedInputTokens,
    selectedExcerptCount: sourceMaterial.selectedExcerptCount,
    totalExcerptCount: sourceMaterial.totalExcerptCount,
    sampled: false,
    effectiveOptions: options,
  };
}

async function resolveGenerationPlan({ plan, usageLedgerContext }) {
  if (typeof plan === "string" && plan.trim()) {
    return plan.trim().toLowerCase();
  }

  const prisma = usageLedgerContext?.prisma;
  const userId = usageLedgerContext?.userId;
  if (!prisma?.user || !userId) {
    return "free";
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { plan: true },
    });
    return user?.plan || "free";
  } catch (error) {
    captureSentryException(error, {
      level: "warning",
      tags: {
        util: "study_materials",
        phase: "resolve_generation_plan",
      },
      user: { id: userId },
    });
    return "free";
  }
}

export async function generateStudyMaterialFromExcerpts({
  generationType,
  excerpts,
  language = "english",
  options = {},
  plan,
  usageLedgerContext = null,
  modelRoutingResolver = resolveModelForGeneration,
}) {
  const normalizedOptions = normalizeGenerationOptions(generationType, options);
  const generationPlan = await resolveGenerationPlan({ plan, usageLedgerContext });
  if (generationType === DOCUMENT_GENERATION_TYPES.summary) {
    const { model, reasoningEffort } = await modelRoutingResolver({
      generationType,
      plan: generationPlan,
    });
    try {
      return await generateSummaryFromExcerptsWithCleanPrompt({
        generationType,
        excerpts,
        options: normalizedOptions,
        model,
        reasoningEffort,
        usageLedgerContext,
      });
    } catch (error) {
      captureSentryException(error, {
        tags: {
          ai_phase: "generate_clean_summary",
          generationType,
        },
      });
      if (error?.code === "empty_summary_output") {
        console.warn("[summary] Falling back to structured summary pipeline after empty summary output", {
          diagnostics: error.diagnostics ?? null,
        });
        const fallbackResult = await generateSummaryStudyGuideFromExcerptsV2({
          generationType,
          excerpts,
          language,
          options: normalizedOptions,
          model,
          reasoningEffort,
          usageLedgerContext,
        });
        return {
          ...fallbackResult,
          effectiveOptions: {
            ...fallbackResult.effectiveOptions,
            summaryPipeline: "structured_fallback",
            fallbackReason: "gpt55_empty_output",
          },
        };
      }
      throw error;
    }
  }

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
  const routing = await modelRoutingResolver({ generationType, plan: generationPlan });
  const { model, reasoningEffort } = routing;
  const completionParams = buildModelCompletionParams({
    model,
    reasoningEffort,
    maxTokens: OUTPUT_TOKEN_LIMITS[generationType],
    temperature: 0.3,
    messages: [
      { role: "system", content: buildSystemPrompt(generationType) },
      { role: "user", content: prompt },
    ],
  });

  try {
    const openai = getClient();
    const response = await createChatCompletion(openai, completionParams, withUsageLedgerCallContext(usageLedgerContext, {
      aiPhase: `${generationType}_initial_generation`,
      callKey: `${generationType}:initial`,
      metadata: {
        sourceTier,
        sampled: sourceMaterial.sampled,
        selectedExcerptCount: sourceMaterial.selectedExcerptCount,
        totalExcerptCount: sourceMaterial.totalExcerptCount,
        maxTokens: OUTPUT_TOKEN_LIMITS[generationType],
        temperature: reasoningEffort ? null : 0.3,
        reasoningEffort,
      },
    }));

    const raw = response.choices?.[0]?.message?.content;
    if (!raw) {
      throw new Error("OpenAI returned an empty generation response");
    }

    const parsed = parseJsonResponse(raw);
    let output = normalizeGenerationModelOutput(generationType, parsed);
    assertNonEmptyGenerationOutput(generationType, output);
    let modelUsed = response?.model || model;
    let usage = response?.usage || null;
    let grounding = null;

    if (generationType === DOCUMENT_GENERATION_TYPES.flashcards) {
      const qaResult = await validateAndImproveFlashcards({
        cards: output.cards,
        language,
        sourceText: sourceMaterial.text,
        targetCount: effectiveOptions.cardCount,
        model,
        reasoningEffort,
        usageLedgerContext,
      });
      output = qaResult.output;
      grounding = qaResult.grounding;
      modelUsed = qaResult.modelUsed || modelUsed;
      usage = combineUsage(usage, qaResult.usage);
    }

    if (generationType === DOCUMENT_GENERATION_TYPES.exam) {
      const qaResult = await validateAndImproveExam({
        questions: output.questions,
        language,
        sourceText: sourceMaterial.text,
        targetCount: effectiveOptions.questionCount,
        model,
        reasoningEffort,
        usageLedgerContext,
      });
      output = qaResult.output;
      grounding = qaResult.grounding;
      modelUsed = qaResult.modelUsed || modelUsed;
      usage = combineUsage(usage, qaResult.usage);
    }

    return {
      output,
      modelUsed,
      usage,
      grounding,
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

export const __studyMaterialsTestables = {
  assessItemSourceEvidence,
  buildExtractiveFlashcard,
  buildPromptForGeneration,
  buildModelCompletionParams,
  cleanSummaryText,
  buildSummaryResponseDiagnostics,
  buildFlashcardsPrompt,
  buildFlashcardQaPrompt,
  buildExamPrompt,
  buildExamQaPrompt,
  createEmptySummaryOutputError,
  ensureSummaryStudyGuideTitle,
  getChatMessageTextContent,
  getExamTargetCount,
  getFlashcardTargetCount,
  inspectSourceGrounding,
  normalizeGroundedQaOutput,
  normalizeFlashcardsOutput,
  persistFlashcardGroundingDiagnostics,
  resolveGroundedTargetCount,
  setOpenAiClientForTests,
  toExamQaInput,
  toFlashcardQaInput,
  validateAndImproveExam,
  validateAndImproveFlashcards,
};
