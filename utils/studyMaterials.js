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
  DEFAULT_GENERATION_MODEL,
  resolveModelForGeneration,
} from "./modelRoutingPolicy.js";
import { captureSentryException } from "./sentry.js";

let client;
const summaryStudyGuideAnalysisCache = new Map();

export const MODEL_NAME = DEFAULT_GENERATION_MODEL;

const ESTIMATED_CHARS_PER_TOKEN = 4;
const SUMMARY_SIGNAL_CHUNK_TOKEN_LIMIT = 2_500;
const SUMMARY_ANALYSIS_OUTPUT_TOKEN_LIMIT = 2_200;
const SUMMARY_STUDY_GUIDE_OUTPUT_TOKEN_LIMIT = 3_600;
const GPT55_SUMMARY_OUTPUT_TOKEN_LIMIT = 4_500;
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
  [DOCUMENT_GENERATION_TYPES.exam]: 2_200,
};
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
    return "You generate high-quality exam-ready flashcards. Return only a valid JSON array.";
  }

  return "You produce study exams as strict JSON. Return valid JSON only.";
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

function buildFlashcardsPrompt(text, language, options, sourceTier, sampled) {
  const languageName = language === "arabic" ? "Arabic" : "English";
  const cardCount = getFlashcardTargetCount(sourceTier);
  const guidancePrompt = buildRegenerationGuidancePrompt(options);

  return `Create clear, accurate, exam-ready flashcards in ${languageName} from the provided source material.

Return ONLY valid JSON.
Return a JSON array of flashcards.

Each flashcard must have exactly this shape:
{"front":"question or prompt","back":"clear, concise answer"}

Core rules:
- Generate exactly ${cardCount} flashcards.
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

function buildExamPrompt(text, language, questionCount, options, sampled) {
  const languageName = language === "arabic" ? "Arabic" : "English";
  const guidancePrompt = buildRegenerationGuidancePrompt(options);

  return `Create a study exam in ${languageName}.

Return valid JSON only with this shape:
{"questions":[{"type":"mcq","question":"...","options":["..."],"correctAnswer":"...","explanation":"..."},{"type":"true_false","question":"...","correctAnswer":"True","explanation":"..."}]}

Rules:
- Generate exactly ${questionCount} questions.
- Only use "mcq" and "true_false" question types.
- Include a balanced mix of "mcq" and "true_false" when the source supports it.
- MCQ items must have exactly 4 options, and correctAnswer must match one option exactly.
- True/false items must use "True" or "False" exactly as correctAnswer.
- Every question must include an explanation.
- Do not add markdown fences.
${guidancePrompt}

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

function parseJsonResponse(raw) {
  return JSON.parse(cleanJsonResponse(raw));
}

async function createJsonCompletion({
  aiPhase,
  model = MODEL_NAME,
  systemPrompt,
  userPrompt,
  maxTokens,
  temperature = 0.25,
}) {
  const openai = getClient();
  const response = await openai.chat.completions.create({
    model,
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

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
  const takeawayCount = (takeawaysMatch?.[0]?.match(/^\s*[-*]\s+/gm) || []).length;
  if (takeawayCount < 3) {
    const error = new Error("Summary study guide must include at least 3 exam-level takeaways");
    error.code = "invalid_generation_output";
    throw error;
  }
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
      prompt: buildStrictSummaryPrompt(sourceText, language, options, sourceTier, sampled),
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
    prompt: buildExamPrompt(sourceText, language, effectiveQuestionCount, options, sampled),
    effectiveOptions: {
      ...options,
      questionCount: effectiveQuestionCount,
    },
  };
}

async function extractStudyGuideSignals({ chunks, language }) {
  const signalMaps = [];
  let usage = null;
  let modelUsed = MODEL_NAME;

  for (let index = 0; index < chunks.length; index += 1) {
    const result = await createJsonCompletion({
      aiPhase: "summary_signal_extraction",
      systemPrompt: "You extract structured exam-study signals as strict JSON. Return valid JSON only.",
      userPrompt: buildStudyGuideSignalExtractionPrompt(chunks[index], language, index, chunks.length),
      maxTokens: 1_400,
      temperature: 0.1,
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

async function analyzeStudyGuideChapterMap({ signalMap, language }) {
  const result = await createJsonCompletion({
    aiPhase: "summary_chapter_map_analysis",
    systemPrompt: "You produce global chapter maps for exam study guides as strict JSON. Return valid JSON only.",
    userPrompt: buildChapterMapPrompt(signalMap, language),
    maxTokens: SUMMARY_ANALYSIS_OUTPUT_TOKEN_LIMIT,
    temperature: 0.15,
  });

  return {
    chapterMap: normalizeChapterMap(result.parsed),
    usage: result.usage,
    modelUsed: result.modelUsed,
  };
}

async function synthesizeStudyGuideDraft({ chapterMap, language, options, sourceTier, generationType }) {
  const result = await createJsonCompletion({
    aiPhase: "summary_structured_synthesis",
    systemPrompt: "You generate exam study guides as strict JSON. Return valid JSON only.",
    userPrompt: buildStudyGuideSynthesisPrompt(chapterMap, language, options, sourceTier),
    maxTokens: SUMMARY_STUDY_GUIDE_OUTPUT_TOKEN_LIMIT,
    temperature: 0.3,
  });

  const output = normalizeSummaryOutput(result.parsed);
  assertNonEmptyGenerationOutput(generationType, output);

  return {
    text: output.text,
    usage: result.usage,
    modelUsed: result.modelUsed,
  };
}

async function optimizeStudyGuideForExams({ draftText, chapterMap, language, generationType }) {
  const result = await createJsonCompletion({
    aiPhase: "summary_exam_optimization",
    systemPrompt: "You optimize exam study guides as strict JSON. Return valid JSON only.",
    userPrompt: buildStudyGuideOptimizationPrompt(draftText, chapterMap, language),
    maxTokens: SUMMARY_STUDY_GUIDE_OUTPUT_TOKEN_LIMIT,
    temperature: 0.2,
  });

  const output = normalizeSummaryOutput(result.parsed);
  assertNonEmptyGenerationOutput(generationType, output);

  return {
    text: output.text,
    usage: result.usage,
    modelUsed: result.modelUsed,
  };
}

async function enforceStudyGuideFormat({ optimizedText, language, generationType }) {
  const result = await createJsonCompletion({
    aiPhase: "summary_format_enforcement",
    systemPrompt: "You enforce markdown format for exam study guides as strict JSON. Return valid JSON only.",
    userPrompt: buildStudyGuideFormatPrompt(optimizedText, language),
    maxTokens: SUMMARY_STUDY_GUIDE_OUTPUT_TOKEN_LIMIT,
    temperature: 0.1,
  });

  const output = normalizeSummaryOutput(result.parsed);
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
}) {
  const sourceMaterial = buildStudyGuideAnalysisChunks(excerpts);
  if (sourceMaterial.chunks.length === 0) {
    const error = new Error("No usable excerpts available for generation");
    error.code = "no_usable_excerpts";
    throw error;
  }

  const sourceTier = getSourceSizeTier(sourceMaterial.estimatedInputTokens);
  let usage = null;
  let modelUsed = MODEL_NAME;
  const analysisCacheKey = getSummaryStudyGuideAnalysisCacheKey(excerpts);
  const cachedChapterMap = options.regenerationGuidance
    ? getCachedSummaryStudyGuideAnalysis(analysisCacheKey)
    : null;
  let chapterMap = cachedChapterMap;

  if (!chapterMap) {
    const extractedSignals = await extractStudyGuideSignals({
      chunks: sourceMaterial.chunks,
      language,
    });
    usage = mergeTokenUsage(usage, extractedSignals.usage);
    modelUsed = extractedSignals.modelUsed || modelUsed;

    const analysis = await analyzeStudyGuideChapterMap({
      signalMap: extractedSignals.signalMap,
      language,
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
  });
  usage = mergeTokenUsage(usage, draft.usage);
  modelUsed = draft.modelUsed || modelUsed;

  const optimized = await optimizeStudyGuideForExams({
    draftText: draft.text,
    chapterMap,
    language,
    generationType,
  });
  usage = mergeTokenUsage(usage, optimized.usage);
  modelUsed = optimized.modelUsed || modelUsed;

  const formatted = await enforceStudyGuideFormat({
    optimizedText: optimized.text,
    language,
    generationType,
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
  useGpt55Summary = true,
}) {
  const sourceMaterial = prepareGpt55SummarySourceMaterial(excerpts);
  const model = resolveModelForGeneration({ generationType, useGpt55Summary });
  const regenerationGuidancePrompt = buildRegenerationGuidancePrompt(options);
  const messages = [
    { role: "user", content: SUMMARY_GENERATION_PROMPT },
  ];
  if (regenerationGuidancePrompt) {
    messages.push({ role: "user", content: regenerationGuidancePrompt });
  }
  messages.push({ role: "user", content: sourceMaterial.text });

  const openai = getClient();
  const response = await openai.chat.completions.create({
    model,
    max_completion_tokens: GPT55_SUMMARY_OUTPUT_TOKEN_LIMIT,
    messages,
  });

  const text = cleanSummaryText(response.choices?.[0]?.message?.content);
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

export async function generateStudyMaterialFromExcerpts({
  generationType,
  excerpts,
  language = "english",
  options = {},
  useGpt55Summary = true,
}) {
  const normalizedOptions = normalizeGenerationOptions(generationType, options);
  if (generationType === DOCUMENT_GENERATION_TYPES.summary) {
    try {
      return await generateSummaryFromExcerptsWithCleanPrompt({
        generationType,
        excerpts,
        options: normalizedOptions,
        useGpt55Summary,
      });
    } catch (error) {
      captureSentryException(error, {
        tags: {
          ai_phase: "generate_clean_summary",
          generationType,
        },
      });
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
  const model = resolveModelForGeneration({ generationType, useGpt55Summary });

  try {
    const openai = getClient();
    const response = await openai.chat.completions.create({
      model,
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

    const parsed = parseJsonResponse(raw);
    const output = normalizeGenerationModelOutput(generationType, parsed);
    assertNonEmptyGenerationOutput(generationType, output);

    return {
      output,
      modelUsed: response?.model || model,
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

export const __studyMaterialsTestables = {
  cleanSummaryText,
  buildFlashcardsPrompt,
  getFlashcardTargetCount,
};
