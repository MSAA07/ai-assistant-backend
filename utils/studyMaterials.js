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
  [DOCUMENT_GENERATION_TYPES.summary]: 2_000,
  [DOCUMENT_GENERATION_TYPES.flashcards]: 1_600,
  [DOCUMENT_GENERATION_TYPES.exam]: 2_200,
};
const REGENERATION_REASON_LABELS = Object.freeze({
  missing_parts: "Missing parts",
  not_comprehensive_enough: "Not comprehensive enough",
  too_short: "Too short",
  too_generic: "Too generic",
});

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

function buildFlashcardsPrompt(text, language, options, sourceTier, sampled) {
  const languageName = language === "arabic" ? "Arabic" : "English";
  const cardCount = getFlashcardTargetCount(sourceTier);
  const guidancePrompt = buildRegenerationGuidancePrompt(options);

  return `Create study flashcards in ${languageName}.

Return valid JSON only with this shape:
{"cards":[{"question":"...","answer":"..."}]}

Rules:
- Generate exactly ${cardCount} flashcards.
- Each flashcard must have a precise question and a concise answer.
- ${options.includeExplanations ? 'Also include "explanation" with 1 short sentence per card.' : 'Do not include explanations.'}
- Cover concepts across the document instead of repeating the same point.
- Do not add markdown fences.
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
