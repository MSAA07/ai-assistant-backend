export const DOCUMENT_PROCESSING_STATUS = Object.freeze({
  queued: "queued",
  processing: "processing",
  complete: "complete",
  failed: "failed",
});

const DOCUMENT_PROCESSING_STATUS_SET = new Set(Object.values(DOCUMENT_PROCESSING_STATUS));
const DOCUMENT_INCOMPLETE_MESSAGE = "Document processing is incomplete.";

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

function normalizeOptions(value) {
  const uniqueOptions = [];

  for (const option of coerceArray(value)) {
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

  if (normalizedType === "short" || normalizedType === "short_answer" || normalizedType === "shortanswer") {
    return "short";
  }

  return options.length > 1 ? "mcq" : "short";
}

function normalizeFlashcard(flashcard) {
  if (!flashcard || typeof flashcard !== "object") {
    return null;
  }

  const question = normalizeString(flashcard.question ?? flashcard.front);
  const answer = normalizeString(flashcard.answer ?? flashcard.back);

  if (!question || !answer) {
    return null;
  }

  return { question, answer };
}

function normalizeExamQuestion(question) {
  if (!question || typeof question !== "object") {
    return null;
  }

  const options = normalizeOptions(question.options);
  const type = normalizeQuestionType(question.type, options);
  const normalizedQuestion = normalizeString(question.question);
  const correctAnswer = normalizeString(question.correctAnswer);
  const explanation = normalizeString(question.explanation);

  if (!normalizedQuestion || !correctAnswer || !explanation) {
    return null;
  }

  if (type === "mcq" && options.length < 2) {
    return null;
  }

  if (type === "mcq" && !options.includes(correctAnswer)) {
    return null;
  }

  const normalizedExamQuestion = {
    type,
    question: normalizedQuestion,
    correctAnswer,
    explanation,
  };

  if (options.length > 0) {
    normalizedExamQuestion.options = options;
  }

  return normalizedExamQuestion;
}

export function normalizeStudyMaterials(studyMaterials = {}) {
  return {
    summary: normalizeString(studyMaterials.summary),
    flashcards: coerceArray(studyMaterials.flashcards)
      .map(normalizeFlashcard)
      .filter(Boolean),
    examQuestions: coerceArray(studyMaterials.examQuestions)
      .map(normalizeExamQuestion)
      .filter(Boolean),
  };
}

export function getDocumentExcerptCount(document) {
  const explicitExcerptCount = Number(document?.excerptCount);
  if (Number.isFinite(explicitExcerptCount)) {
    return explicitExcerptCount;
  }

  const countFromRelation = Number(document?._count?.excerpts);
  if (Number.isFinite(countFromRelation)) {
    return countFromRelation;
  }

  if (Array.isArray(document?.excerpts)) {
    return document.excerpts.length;
  }

  return 0;
}

export function getStudyMaterialState(studyMaterials = {}, options = {}) {
  const excerptCount = Number.isFinite(Number(options.excerptCount))
    ? Number(options.excerptCount)
    : getDocumentExcerptCount(studyMaterials);
  const normalizedMaterials = normalizeStudyMaterials(studyMaterials);
  const errors = [];

  if (excerptCount <= 0) {
    errors.push("missing_excerpts");
  }

  if (!normalizedMaterials.summary) {
    errors.push("missing_summary");
  }

  if (normalizedMaterials.flashcards.length === 0) {
    errors.push("missing_flashcards");
  }

  if (normalizedMaterials.examQuestions.length === 0) {
    errors.push("missing_exam_questions");
  }

  return {
    ...normalizedMaterials,
    excerptCount,
    flashcardCount: normalizedMaterials.flashcards.length,
    questionCount: normalizedMaterials.examQuestions.length,
    errors,
    isComplete: errors.length === 0,
  };
}

export function hasReadyStudyMaterials(document, options = {}) {
  return getStudyMaterialState(document, options).isComplete;
}

export function normalizeDocumentProcessingStatus(status) {
  const normalizedStatus = normalizeString(status).toLowerCase();

  if (DOCUMENT_PROCESSING_STATUS_SET.has(normalizedStatus)) {
    return normalizedStatus;
  }

  return DOCUMENT_PROCESSING_STATUS.failed;
}

export function serializeDocument(document, options = {}) {
  const excerptCount = Number.isFinite(Number(options.excerptCount))
    ? Number(options.excerptCount)
    : getDocumentExcerptCount(document);
  const studyMaterialState = getStudyMaterialState(document, { excerptCount });
  let processingStatus = normalizeDocumentProcessingStatus(document?.processingStatus);

  if (processingStatus === DOCUMENT_PROCESSING_STATUS.complete && !studyMaterialState.isComplete) {
    processingStatus = DOCUMENT_PROCESSING_STATUS.failed;
  }

  const canExposeContent = processingStatus === DOCUMENT_PROCESSING_STATUS.complete
    && studyMaterialState.isComplete;
  const processingError = processingStatus === DOCUMENT_PROCESSING_STATUS.failed
    ? normalizeString(document?.processingError) || DOCUMENT_INCOMPLETE_MESSAGE
    : null;

  return {
    id: document.id,
    userId: document.userId,
    filename: document.filename,
    originalName: document.originalName,
    fileType: document.fileType,
    fileSize: document.fileSize,
    language: document.language,
    uploadDate: document.uploadDate,
    processedAt: processingStatus === DOCUMENT_PROCESSING_STATUS.complete
      ? document.processedAt ?? null
      : null,
    processingStatus,
    processingJobId: document.processingJobId ?? null,
    processingError,
    summary: canExposeContent ? studyMaterialState.summary : "",
    flashcards: canExposeContent ? studyMaterialState.flashcards : [],
    examQuestions: canExposeContent ? studyMaterialState.examQuestions : [],
    flashcardCount: canExposeContent ? studyMaterialState.flashcardCount : 0,
    questionCount: canExposeContent ? studyMaterialState.questionCount : 0,
  };
}

function pickActiveJobByDocumentId(jobs) {
  const jobsByDocumentId = new Map();

  for (const job of jobs) {
    if (!job.documentId) {
      continue;
    }

    const existingJob = jobsByDocumentId.get(job.documentId);
    if (!existingJob) {
      jobsByDocumentId.set(job.documentId, job);
      continue;
    }

    const existingPriority = existingJob.status === "running" ? 2 : 1;
    const nextPriority = job.status === "running" ? 2 : 1;

    if (nextPriority > existingPriority) {
      jobsByDocumentId.set(job.documentId, job);
      continue;
    }

    if (nextPriority === existingPriority && job.queuedAt > existingJob.queuedAt) {
      jobsByDocumentId.set(job.documentId, job);
    }
  }

  return jobsByDocumentId;
}

export async function backfillDocumentProcessingState(prisma) {
  await prisma.$executeRaw`
    UPDATE "Job"
    SET "documentId" = payload->>'documentId'
    WHERE "jobType" = 'extract_document'
      AND "documentId" IS NULL
      AND payload ? 'documentId'
  `;

  const [documents, activeJobs] = await Promise.all([
    prisma.document.findMany({
      include: {
        _count: {
          select: { excerpts: true },
        },
      },
    }),
    prisma.job.findMany({
      where: {
        jobType: "extract_document",
        status: { in: ["queued", "running"] },
      },
      orderBy: [{ queuedAt: "desc" }],
    }),
  ]);

  const activeJobsByDocumentId = pickActiveJobByDocumentId(activeJobs);

  for (const document of documents) {
    const materialState = getStudyMaterialState(document, {
      excerptCount: document._count?.excerpts ?? 0,
    });
    const activeJob = activeJobsByDocumentId.get(document.id);
    const nextStatus = materialState.isComplete
      ? DOCUMENT_PROCESSING_STATUS.complete
      : activeJob?.status === "running"
        ? DOCUMENT_PROCESSING_STATUS.processing
        : activeJob?.status === "queued"
          ? DOCUMENT_PROCESSING_STATUS.queued
          : DOCUMENT_PROCESSING_STATUS.failed;
    const nextProcessingJobId = activeJob?.id ?? null;
    const nextProcessingError = nextStatus === DOCUMENT_PROCESSING_STATUS.failed
      ? normalizeString(document.processingError) || DOCUMENT_INCOMPLETE_MESSAGE
      : null;
    const nextProcessedAt = nextStatus === DOCUMENT_PROCESSING_STATUS.complete
      ? document.processedAt ?? null
      : null;

    const hasChanges = normalizeDocumentProcessingStatus(document.processingStatus) !== nextStatus
      || (document.processingJobId ?? null) !== nextProcessingJobId
      || (document.processingError ?? null) !== nextProcessingError
      || ((document.processedAt?.toISOString?.() ?? null) !== (nextProcessedAt?.toISOString?.() ?? null));

    if (!hasChanges) {
      continue;
    }

    await prisma.document.update({
      where: { id: document.id },
      data: {
        processingStatus: nextStatus,
        processingJobId: nextProcessingJobId,
        processingError: nextProcessingError,
        processedAt: nextProcessedAt,
      },
    });
  }
}
