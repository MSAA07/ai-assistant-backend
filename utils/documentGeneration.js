const EXCERPT_TYPE_PRIORITY = Object.freeze({
  slide_text: 0,
  speaker_note: 1,
  image_flag: 2,
});

export const DOCUMENT_GENERATION_TYPES = Object.freeze({
  summary: "summary",
  flashcards: "flashcards",
  exam: "exam",
});

export const DOCUMENT_GENERATION_STATUS = Object.freeze({
  notRequested: "not_requested",
  queued: "queued",
  running: "running",
  complete: "complete",
  failed: "failed",
});

export const GENERATION_JOB_TYPES = Object.freeze({
  summary: "generate_summary",
  flashcards: "generate_flashcards",
  exam: "generate_exam",
});

export const GENERATION_FEATURE_KEYS = Object.freeze({
  summary: "document_summary",
  flashcards: "flashcards",
  exam: "exam",
});

export const GENERATION_USAGE_EVENT_TYPES = Object.freeze({
  summary: "summary_generated",
  flashcards: "flashcards_generated",
  exam: "exam_generated",
});

const DOCUMENT_GENERATION_TYPE_SET = new Set(Object.values(DOCUMENT_GENERATION_TYPES));
const DOCUMENT_GENERATION_STATUS_SET = new Set(Object.values(DOCUMENT_GENERATION_STATUS));
const SUMMARY_LENGTH_SET = new Set(["short", "medium", "long"]);
const EXAM_QUESTION_COUNT_SET = new Set([5, 10, 15]);
const REGENERATION_REASON_KEY_SET = new Set([
  "missing_parts",
  "not_comprehensive_enough",
  "too_short",
  "too_generic",
]);

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseJsonValue(value) {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function coerceArray(value) {
  const parsedValue = parseJsonValue(value);
  return Array.isArray(parsedValue) ? parsedValue : [];
}

function normalizeOptions(options) {
  const uniqueOptions = [];

  for (const option of coerceArray(options)) {
    const normalizedOption = normalizeString(option);
    if (!normalizedOption || uniqueOptions.includes(normalizedOption)) {
      continue;
    }

    uniqueOptions.push(normalizedOption);
  }

  return uniqueOptions;
}

function normalizeQuestionType(type, options) {
  const normalizedType = normalizeString(type).toLowerCase();

  if (normalizedType === "mcq" || normalizedType === "multiple_choice") {
    return "mcq";
  }

  if (normalizedType === "true_false" || normalizedType === "truefalse") {
    return "true_false";
  }

  return options.length > 1 ? "mcq" : "";
}

function normalizeRegenerationGuidance(value) {
  const parsed = parseJsonValue(value);
  const source = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed
    : null;

  if (!source) {
    return null;
  }

  const reasonKey = normalizeString(source.reasonKey).toLowerCase();
  const customInstruction = normalizeString(source.customInstruction).slice(0, 500);
  const hasReasonKey = REGENERATION_REASON_KEY_SET.has(reasonKey);
  const hasCustomInstruction = customInstruction.length > 0;

  if (!hasReasonKey && !hasCustomInstruction) {
    return null;
  }

  const normalized = {};
  if (hasReasonKey) {
    normalized.reasonKey = reasonKey;
  }
  if (hasCustomInstruction) {
    normalized.customInstruction = customInstruction;
  }

  return normalized;
}

function createValidationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = "invalid_generation_request";
  return error;
}

export function normalizeGenerationType(value) {
  const normalizedValue = normalizeString(value).toLowerCase();

  if (DOCUMENT_GENERATION_TYPE_SET.has(normalizedValue)) {
    return normalizedValue;
  }

  throw createValidationError("Invalid generation type");
}

export function normalizeGenerationStatus(status) {
  const normalizedStatus = normalizeString(status).toLowerCase();

  if (DOCUMENT_GENERATION_STATUS_SET.has(normalizedStatus)) {
    return normalizedStatus;
  }

  return DOCUMENT_GENERATION_STATUS.notRequested;
}

export function normalizeFlashcard(flashcard) {
  if (!flashcard || typeof flashcard !== "object") {
    return null;
  }

  const question = normalizeString(flashcard.question ?? flashcard.front);
  const answer = normalizeString(flashcard.answer ?? flashcard.back);
  const explanation = normalizeString(flashcard.explanation);

  if (!question || !answer) {
    return null;
  }

  return explanation
    ? { question, answer, explanation }
    : { question, answer };
}

export function normalizeExamQuestion(question) {
  if (!question || typeof question !== "object") {
    return null;
  }

  const options = normalizeOptions(question.options);
  const type = normalizeQuestionType(question.type ?? question.questionType, options);
  const normalizedQuestion = normalizeString(question.question);
  const correctAnswer = normalizeString(question.correctAnswer);
  const explanation = normalizeString(question.explanation);

  if (!type || !normalizedQuestion || !correctAnswer || !explanation) {
    return null;
  }

  if (type === "mcq" && options.length < 2) {
    return null;
  }

  if (type === "mcq" && !options.includes(correctAnswer)) {
    return null;
  }

  if (type === "true_false") {
    const normalizedAnswer = correctAnswer.toLowerCase();
    if (normalizedAnswer !== "true" && normalizedAnswer !== "false") {
      return null;
    }
  }

  const normalizedExamQuestion = {
    type,
    question: normalizedQuestion,
    correctAnswer: type === "true_false"
      ? (correctAnswer.toLowerCase() === "true" ? "True" : "False")
      : correctAnswer,
    explanation,
  };

  if (options.length > 0) {
    normalizedExamQuestion.options = options;
  }

  return normalizedExamQuestion;
}

export function normalizeGenerationOptions(type, options = {}) {
  const generationType = normalizeGenerationType(type);
  const parsedOptions = parseJsonValue(options);
  const sourceOptions = parsedOptions && typeof parsedOptions === "object" && !Array.isArray(parsedOptions)
    ? parsedOptions
    : {};
  const regenerationGuidance = normalizeRegenerationGuidance(sourceOptions.regenerationGuidance);

  if (generationType === DOCUMENT_GENERATION_TYPES.summary) {
    const length = normalizeString(sourceOptions.length || "medium").toLowerCase();

    if (!SUMMARY_LENGTH_SET.has(length)) {
      throw createValidationError("Invalid summary length");
    }

    const normalizedOptions = { length };
    if (regenerationGuidance) {
      normalizedOptions.regenerationGuidance = regenerationGuidance;
    }
    return normalizedOptions;
  }

  if (generationType === DOCUMENT_GENERATION_TYPES.flashcards) {
    const normalizedOptions = {
      includeExplanations: Boolean(sourceOptions.includeExplanations),
    };
    if (regenerationGuidance) {
      normalizedOptions.regenerationGuidance = regenerationGuidance;
    }
    return normalizedOptions;
  }

  const rawQuestionCount = Number(sourceOptions.questionCount ?? 10);
  if (!EXAM_QUESTION_COUNT_SET.has(rawQuestionCount)) {
    throw createValidationError("Invalid exam question count");
  }

  const normalizedOptions = { questionCount: rawQuestionCount };
  if (regenerationGuidance) {
    normalizedOptions.regenerationGuidance = regenerationGuidance;
  }

  return normalizedOptions;
}

export function areGenerationOptionsEqual(type, left, right) {
  return JSON.stringify(normalizeGenerationOptions(type, left))
    === JSON.stringify(normalizeGenerationOptions(type, right));
}

export function normalizeGenerationOutput(type, output) {
  const generationType = normalizeGenerationType(type);
  const parsedOutput = parseJsonValue(output);

  if (generationType === DOCUMENT_GENERATION_TYPES.summary) {
    const text = typeof parsedOutput === "string"
      ? parsedOutput.trim()
      : normalizeString(parsedOutput?.text ?? parsedOutput?.summary);

    return { text };
  }

  if (generationType === DOCUMENT_GENERATION_TYPES.flashcards) {
    const cards = coerceArray(parsedOutput?.cards ?? parsedOutput)
      .map(normalizeFlashcard)
      .filter(Boolean);

    return { cards };
  }

  const questions = coerceArray(parsedOutput?.questions ?? parsedOutput)
    .map(normalizeExamQuestion)
    .filter(Boolean);

  return { questions };
}

export function normalizeDocumentMirrorMaterials(document = {}) {
  return {
    summary: normalizeString(document.summary),
    flashcards: coerceArray(document.flashcards)
      .map(normalizeFlashcard)
      .filter(Boolean),
    examQuestions: coerceArray(document.examQuestions)
      .map(normalizeExamQuestion)
      .filter(Boolean),
  };
}

export function getJobTypeForGenerationType(type) {
  return GENERATION_JOB_TYPES[normalizeGenerationType(type)];
}

export function getGenerationTypeForJobType(jobType) {
  const normalizedJobType = normalizeString(jobType).toLowerCase();

  for (const [generationType, mappedJobType] of Object.entries(GENERATION_JOB_TYPES)) {
    if (mappedJobType === normalizedJobType) {
      return generationType;
    }
  }

  return null;
}

export function getFeatureKeyForGenerationType(type) {
  return GENERATION_FEATURE_KEYS[normalizeGenerationType(type)];
}

export function getUsageEventTypeForGenerationType(type) {
  return GENERATION_USAGE_EVENT_TYPES[normalizeGenerationType(type)];
}

export function getMirrorFieldForGenerationType(type) {
  const generationType = normalizeGenerationType(type);

  if (generationType === DOCUMENT_GENERATION_TYPES.summary) {
    return "summary";
  }

  if (generationType === DOCUMENT_GENERATION_TYPES.flashcards) {
    return "flashcards";
  }

  return "examQuestions";
}

export function isGenerationJobType(jobType) {
  return Boolean(getGenerationTypeForJobType(jobType));
}

export function isUsableGenerationExcerpt(excerpt) {
  return normalizeString(excerpt?.content).length > 0
    && normalizeString(excerpt?.excerptType).toLowerCase() !== "image_flag";
}

export function sortGenerationExcerpts(excerpts = []) {
  return [...excerpts].sort((left, right) => {
    const pageDelta = Number(left?.slideOrPage || 0) - Number(right?.slideOrPage || 0);
    if (pageDelta !== 0) {
      return pageDelta;
    }

    const leftTypePriority = EXCERPT_TYPE_PRIORITY[normalizeString(left?.excerptType).toLowerCase()] ?? 99;
    const rightTypePriority = EXCERPT_TYPE_PRIORITY[normalizeString(right?.excerptType).toLowerCase()] ?? 99;
    if (leftTypePriority !== rightTypePriority) {
      return leftTypePriority - rightTypePriority;
    }

    const offsetDelta = Number(left?.charOffset || 0) - Number(right?.charOffset || 0);
    if (offsetDelta !== 0) {
      return offsetDelta;
    }

    return new Date(left?.createdAt || 0).getTime() - new Date(right?.createdAt || 0).getTime();
  });
}

export function serializeDocumentGeneration(generation) {
  if (!generation) {
    return null;
  }

  const generationType = normalizeGenerationType(generation.generationType);
  const status = normalizeGenerationStatus(generation.status);
  const output = status === DOCUMENT_GENERATION_STATUS.complete
    ? normalizeGenerationOutput(generationType, generation.output)
    : null;
  const hasContent = generationType === DOCUMENT_GENERATION_TYPES.summary
    ? Boolean(output?.text)
    : generationType === DOCUMENT_GENERATION_TYPES.flashcards
      ? Array.isArray(output?.cards) && output.cards.length > 0
      : Array.isArray(output?.questions) && output.questions.length > 0;

  return {
    id: generation.id,
    type: generationType,
    status,
    jobId: generation.jobId ?? null,
    options: normalizeGenerationOptions(generationType, generation.options),
    errorMessage: status === DOCUMENT_GENERATION_STATUS.failed
      ? normalizeString(generation.errorMessage) || null
      : null,
    generatedAt: status === DOCUMENT_GENERATION_STATUS.complete
      ? generation.generatedAt ?? null
      : null,
    output,
    isLatest: Boolean(generation.isLatest),
    createdAt: generation.createdAt ?? null,
    updatedAt: generation.updatedAt ?? null,
    hasContent,
  };
}

function createEmptyGenerationState(type) {
  return {
    id: null,
    type,
    status: DOCUMENT_GENERATION_STATUS.notRequested,
    jobId: null,
    options: normalizeGenerationOptions(type, {}),
    errorMessage: null,
    generatedAt: null,
    output: null,
    isLatest: false,
    createdAt: null,
    updatedAt: null,
    hasContent: false,
  };
}

export function buildDocumentGenerationState(generations = []) {
  const state = {
    summary: createEmptyGenerationState(DOCUMENT_GENERATION_TYPES.summary),
    flashcards: createEmptyGenerationState(DOCUMENT_GENERATION_TYPES.flashcards),
    exam: createEmptyGenerationState(DOCUMENT_GENERATION_TYPES.exam),
  };

  for (const generation of generations) {
    if (!generation?.isLatest) {
      continue;
    }

    const serializedGeneration = serializeDocumentGeneration(generation);
    if (!serializedGeneration) {
      continue;
    }

    state[serializedGeneration.type] = serializedGeneration;
  }

  return state;
}

export async function ensureDocumentGenerationSchema(prisma) {
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "DocumentGeneration_latest_unique_idx"
    ON "DocumentGeneration" ("documentId", "generationType")
    WHERE "isLatest" = true
  `);
}

export async function getUsableExcerptCount(prisma, documentId) {
  const rows = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS "usableExcerptCount"
    FROM "DocumentExcerpt"
    WHERE "documentId" = ${documentId}
      AND "excerptType" <> 'image_flag'
      AND NULLIF(BTRIM("content"), '') IS NOT NULL
  `;

  return Number(rows?.[0]?.usableExcerptCount || 0);
}
