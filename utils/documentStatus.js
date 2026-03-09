import {
  buildDocumentGenerationState,
  isUsableGenerationExcerpt,
  normalizeDocumentMirrorMaterials,
} from "./documentGeneration.js";

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

export function normalizeStudyMaterials(studyMaterials = {}) {
  return normalizeDocumentMirrorMaterials(studyMaterials);
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

export function isUsableExcerpt(excerpt) {
  return isUsableGenerationExcerpt(excerpt);
}

export function countUsableExcerpts(excerpts = []) {
  if (!Array.isArray(excerpts)) {
    return 0;
  }

  return excerpts.filter(isUsableExcerpt).length;
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
  const processingStatus = normalizeDocumentProcessingStatus(document?.processingStatus);
  const canExposeContent = processingStatus === DOCUMENT_PROCESSING_STATUS.complete;
  const processingError = processingStatus === DOCUMENT_PROCESSING_STATUS.failed
    ? normalizeString(document?.processingError) || DOCUMENT_INCOMPLETE_MESSAGE
    : null;
  const processingJobId = processingStatus === DOCUMENT_PROCESSING_STATUS.queued
    || processingStatus === DOCUMENT_PROCESSING_STATUS.processing
    ? document.processingJobId ?? null
    : null;
  const generationState = buildDocumentGenerationState(document?.generations ?? []);

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
    processingJobId,
    processingError,
    generationState,
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

async function getUsableExcerptCountsByDocumentId(prisma) {
  const excerptCounts = await prisma.$queryRaw`
    SELECT "documentId", COUNT(*)::int AS "usableExcerptCount"
    FROM "DocumentExcerpt"
    WHERE "excerptType" <> 'image_flag'
      AND NULLIF(BTRIM("content"), '') IS NOT NULL
    GROUP BY "documentId"
  `;

  return new Map(
    excerptCounts.map((row) => [row.documentId, Number(row.usableExcerptCount || 0)]),
  );
}

export async function backfillDocumentProcessingState(prisma) {
  await prisma.$executeRaw`
    UPDATE "Job"
    SET "documentId" = payload->>'documentId'
    WHERE "jobType" = 'extract_document'
      AND "documentId" IS NULL
      AND payload ? 'documentId'
  `;

  const [documents, activeJobs, usableExcerptCountsByDocumentId] = await Promise.all([
    prisma.document.findMany(),
    prisma.job.findMany({
      where: {
        jobType: "extract_document",
        status: { in: ["queued", "running"] },
      },
      orderBy: [{ queuedAt: "desc" }],
    }),
    getUsableExcerptCountsByDocumentId(prisma),
  ]);

  const activeJobsByDocumentId = pickActiveJobByDocumentId(activeJobs);

  for (const document of documents) {
    const activeJob = activeJobsByDocumentId.get(document.id);
    const usableExcerptCount = usableExcerptCountsByDocumentId.get(document.id) ?? 0;
    const nextStatus = activeJob?.status === "running"
      ? DOCUMENT_PROCESSING_STATUS.processing
      : activeJob?.status === "queued"
        ? DOCUMENT_PROCESSING_STATUS.queued
        : usableExcerptCount > 0
          ? DOCUMENT_PROCESSING_STATUS.complete
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
