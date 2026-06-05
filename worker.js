import os from "os";
import fs from "fs/promises";
import path from "path";

import { PrismaClient } from "@prisma/client";

import { processExtraction } from "./utils/extractionPipeline.js";
import { processGeneration } from "./utils/generationPipeline.js";
import {
  ensureDocumentGenerationSchema,
  GENERATION_JOB_TYPES,
} from "./utils/documentGeneration.js";
import {
  claimNextQueuedJob,
  completeJob,
  failJob,
  heartbeatJobLease,
  HEARTBEAT_INTERVAL_MS,
  requeueJob,
  recoverStaleJobs,
  STALE_JOB_SWEEP_INTERVAL_MS,
} from "./utils/jobQueue.js";
import { checkAnomaly } from "./utils/costGuard.js";
import {
  evaluateJobAlertSweeps,
  evaluateSystemUsageAlerts,
  evaluateUsageAlertsForUser,
} from "./utils/adminAlerts.js";
import { backfillDocumentProcessingState, serializeDocument } from "./utils/documentStatus.js";
import { captureSentryException, flushSentry, initSentry } from "./utils/sentry.js";
import {
  assertStorageConfiguredForRuntime,
  safeUnlink,
  uploadFile,
} from "./utils/storage.js";
import {
  buildStudyPdfBuffer,
  buildStudyPdfFileName,
  hasStudyExportContent,
  normalizeStudyExportFeature,
} from "./utils/studyPdf.js";

const prisma = new PrismaClient();
const WORKER_ID = `${os.hostname()}-${process.pid}`;
const POLL_INTERVAL_MS = 2000;
const SCHEMA_WAIT_INTERVAL_MS = 5000;
const SCHEMA_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_JOB_TIMEOUT_MS = 300_000;
const JOB_TIMEOUTS = {
  extract_document: 60_000,
  [GENERATION_JOB_TYPES.summary]: 300_000,
  [GENERATION_JOB_TYPES.flashcards]: 90_000,
  [GENERATION_JOB_TYPES.exam]: 90_000,
  export_pdf: 30_000,
};
const JOB_PROCESSORS = {
  extract_document: processExtraction,
  [GENERATION_JOB_TYPES.summary]: processGeneration,
  [GENERATION_JOB_TYPES.flashcards]: processGeneration,
  [GENERATION_JOB_TYPES.exam]: processGeneration,
  export_pdf: processExportPdf,
};

let fatalWorkerShutdownStarted = false;

initSentry({ serviceName: "worker", disableProcessHandlers: true });

function normalizeExportString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeExportConfig(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function createExportJobError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function getExportErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Export failed";
}

function getExportArtifactIdFromJob(job) {
  const payload = normalizeExportConfig(job?.payload);
  return normalizeExportString(payload.artifactId)
    || normalizeExportString(payload.exportArtifactId)
    || normalizeExportString(payload.exportId);
}

function getExportFeature(artifact) {
  const config = normalizeExportConfig(artifact?.config);
  const configuredFeature = normalizeStudyExportFeature(
    config.feature || config.type || config.exportType || config.contentType,
  );

  if (configuredFeature) {
    return configuredFeature;
  }

  if (artifact?.examRecordId || artifact?.attemptId) {
    return "exam";
  }

  return "";
}

function serializeFlashcardCards(cards = []) {
  return cards.map((card) => ({
    id: card.id,
    position: card.position,
    question: card.question,
    answer: card.answer,
    explanation: card.explanation,
    sourceRefs: card.sourceRefs,
  }));
}

function serializeExamQuestions(questions = []) {
  return questions.map((question) => ({
    id: question.id,
    position: question.position,
    questionType: question.questionType,
    type: question.questionType,
    question: question.question,
    options: question.options,
    correctAnswer: question.correctAnswer,
    explanation: question.explanation,
    sourceRefs: question.sourceRefs,
  }));
}

async function findExportArtifactForJob(prismaClient, job) {
  const artifactId = getExportArtifactIdFromJob(job);
  const matchers = [{ jobId: job.id }];
  if (artifactId) {
    matchers.unshift({ id: artifactId });
  }

  return prismaClient.exportArtifact.findFirst({
    where: { OR: matchers },
    include: {
      document: {
        include: {
          generations: {
            where: { isLatest: true },
            orderBy: [{ generationType: "asc" }, { createdAt: "desc" }],
          },
        },
      },
      examRecord: {
        include: {
          questions: {
            orderBy: [{ position: "asc" }],
          },
        },
      },
    },
  });
}

async function getFlashcardsForExport(prismaClient, artifact) {
  const config = normalizeExportConfig(artifact.config);
  const configuredSetId = normalizeExportString(config.flashcardSetId || config.setId);
  const baseWhere = { documentId: artifact.documentId };
  let flashcardSet = await prismaClient.flashcardSet.findFirst({
    where: configuredSetId
      ? { ...baseWhere, id: configuredSetId }
      : { ...baseWhere, isLatest: true },
    orderBy: [{ createdAt: "desc" }],
    include: {
      cards: {
        where: { isDeleted: false },
        orderBy: [{ position: "asc" }],
      },
    },
  });

  if (!flashcardSet && !configuredSetId) {
    flashcardSet = await prismaClient.flashcardSet.findFirst({
      where: baseWhere,
      orderBy: [{ createdAt: "desc" }],
      include: {
        cards: {
          where: { isDeleted: false },
          orderBy: [{ position: "asc" }],
        },
      },
    });
  }

  return flashcardSet ? serializeFlashcardCards(flashcardSet.cards) : [];
}

async function getExamQuestionsForExport(prismaClient, artifact) {
  const config = normalizeExportConfig(artifact.config);
  const configuredExamId = normalizeExportString(config.examId || config.examRecordId);
  let examRecord = artifact.examRecord;

  if (!examRecord && configuredExamId) {
    examRecord = await prismaClient.examRecord.findFirst({
      where: {
        id: configuredExamId,
        documentId: artifact.documentId,
      },
      include: {
        questions: {
          orderBy: [{ position: "asc" }],
        },
      },
    });
  }

  if (!examRecord && artifact.attemptId) {
    const attempt = await prismaClient.examAttempt.findFirst({
      where: {
        id: artifact.attemptId,
        userId: artifact.userId,
        documentId: artifact.documentId,
      },
      include: {
        examRecord: {
          include: {
            questions: {
              orderBy: [{ position: "asc" }],
            },
          },
        },
      },
    });
    examRecord = attempt?.examRecord ?? null;
  }

  if (!examRecord) {
    examRecord = await prismaClient.examRecord.findFirst({
      where: { documentId: artifact.documentId, isLatest: true },
      include: {
        questions: {
          orderBy: [{ position: "asc" }],
        },
      },
    });
  }

  if (!examRecord) {
    examRecord = await prismaClient.examRecord.findFirst({
      where: { documentId: artifact.documentId },
      orderBy: [{ createdAt: "desc" }],
      include: {
        questions: {
          orderBy: [{ position: "asc" }],
        },
      },
    });
  }

  return examRecord ? serializeExamQuestions(examRecord.questions) : [];
}

async function buildExportDocument(prismaClient, artifact, feature) {
  const serializedDocument = serializeDocument(artifact.document);

  if (serializedDocument.processingStatus !== "complete") {
    throw createExportJobError("Document content is not ready for export", "document_not_ready");
  }

  if (feature === "flashcards") {
    const flashcards = await getFlashcardsForExport(prismaClient, artifact);
    if (flashcards.length > 0) {
      return { ...serializedDocument, flashcards };
    }
  }

  if (feature === "exam") {
    const examQuestions = await getExamQuestionsForExport(prismaClient, artifact);
    if (examQuestions.length > 0) {
      return { ...serializedDocument, examQuestions };
    }
  }

  return serializedDocument;
}

async function markExportArtifactFailed(prismaClient, artifactId, error) {
  await prismaClient.exportArtifact.update({
    where: { id: artifactId },
    data: {
      status: "failed",
      errorMessage: getExportErrorMessage(error),
    },
  });
}

async function processExportPdf(prismaClient, job) {
  let artifactId = getExportArtifactIdFromJob(job);
  let tmpPath = "";
  let uploadedKey = "";

  try {
    const artifact = await findExportArtifactForJob(prismaClient, job);
    if (!artifact) {
      throw createExportJobError("Export artifact not found", "export_artifact_not_found");
    }

    artifactId = artifact.id;
    await prismaClient.exportArtifact.update({
      where: { id: artifact.id },
      data: {
        status: "running",
        jobId: job.id,
        errorMessage: null,
      },
    });

    const feature = getExportFeature(artifact);
    if (!feature) {
      throw createExportJobError("Export artifact does not specify a PDF feature", "invalid_export_job");
    }

    const exportDocument = await buildExportDocument(prismaClient, artifact, feature);
    if (!hasStudyExportContent(exportDocument, feature)) {
      throw createExportJobError("Selected study content is not ready for export", "export_not_ready");
    }

    const pdfBuffer = await buildStudyPdfBuffer(exportDocument, feature);
    const fileName = buildStudyPdfFileName(exportDocument, feature);
    tmpPath = path.join(os.tmpdir(), `${job.id}-${Date.now()}-${path.basename(fileName)}`);
    await fs.writeFile(tmpPath, pdfBuffer);

    const upload = await uploadFile(tmpPath, artifact.userId, fileName, "application/pdf");
    uploadedKey = upload.key;

    const completedArtifact = await prismaClient.exportArtifact.update({
      where: { id: artifact.id },
      data: {
        status: "complete",
        storageKey: uploadedKey,
        fileName,
        mimeType: "application/pdf",
        fileSize: pdfBuffer.length,
        errorMessage: null,
        readyAt: new Date(),
      },
    });

    return {
      artifactId: completedArtifact.id,
      storageKey: completedArtifact.storageKey,
      fileName: completedArtifact.fileName,
      fileSize: completedArtifact.fileSize,
      mimeType: completedArtifact.mimeType,
      feature,
    };
  } catch (error) {
    if (artifactId) {
      await markExportArtifactFailed(prismaClient, artifactId, error).catch((updateError) => {
        console.error("[worker] failed to mark export artifact failed:", updateError);
      });
    }
    throw error;
  } finally {
    if (tmpPath && (!uploadedKey || !path.isAbsolute(uploadedKey))) {
      await safeUnlink(tmpPath);
    }
  }
}

async function runWorker() {
  console.log(`[worker] started as ${WORKER_ID}, polling every 2s`);

  assertStorageConfiguredForRuntime();
  await waitForRequiredSchema(prisma);
  await ensureDocumentGenerationSchema(prisma);
  await backfillDocumentProcessingState(prisma);
  await recoverStaleJobs(prisma);

  setInterval(() => {
    void recoverStaleJobs(prisma).catch((error) => {
      console.error("[worker] stale job sweep failed:", error);
      captureSentryException(error, {
        tags: { worker_phase: "recover_stale_jobs" },
      });
    });
  }, STALE_JOB_SWEEP_INTERVAL_MS);

  setInterval(async () => {
    try {
      await Promise.all([
        evaluateSystemUsageAlerts(prisma),
        evaluateJobAlertSweeps(prisma),
      ]);

      const recentUsers = await prisma.modelUsageEvent.findMany({
        where: {
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
          billable: true,
        },
        select: { userId: true },
        distinct: ["userId"],
      });

      for (const { userId } of recentUsers) {
        await evaluateUsageAlertsForUser(prisma, userId).catch((error) => {
          console.error("[admin-alerts] user alert sweep failed:", error);
          captureSentryException(error, {
            tags: { worker_phase: "admin_alert_user_sweep" },
            extra: { userId },
            user: { id: userId },
          });
        });

        await checkAnomaly(userId).catch((error) => {
          console.error("[anomaly]", error);
          captureSentryException(error, {
            tags: { worker_phase: "anomaly_check" },
            extra: { userId },
            user: { id: userId },
          });
        });
      }
    } catch (error) {
      console.error("[anomaly] sweep failed:", error);
      captureSentryException(error, {
        tags: { worker_phase: "anomaly_sweep" },
      });
    }
  }, 15 * 60 * 1000);

  while (true) {
    try {
      const job = await claimNextQueuedJob(prisma, WORKER_ID);

      if (!job) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      console.log(`[worker] processing job ${job.id} type=${job.jobType}`);

      const processor = JOB_PROCESSORS[job.jobType];
      if (!processor) {
        const unsupportedJobError = new Error(`Unsupported job type: ${job.jobType}`);
        unsupportedJobError.code = "unsupported_job_type";
        await failJob(prisma, job, unsupportedJobError);
        continue;
      }

      const timeout = JOB_TIMEOUTS[job.jobType] || DEFAULT_JOB_TIMEOUT_MS;
      const heartbeatHandle = startLeaseHeartbeat(job.id);

      try {
        const jobResult = await withTimeout(
          processor(prisma, job, WORKER_ID),
          timeout,
        );
        clearInterval(heartbeatHandle);

        await completeJob(prisma, job, jobResult?.result ?? jobResult);
        console.log(`[worker] job ${job.id} succeeded`);
      } catch (error) {
        clearInterval(heartbeatHandle);

        const nextRetryCount = (job.retryCount || 0) + 1;
        const shouldRetry = !isNonRetryableJobError(error) && nextRetryCount < job.maxRetries;

        if (shouldRetry) {
          await requeueJob(prisma, job, error, true);
          console.log(
            `[worker] job ${job.id} failed, retrying (${nextRetryCount}/${job.maxRetries})`,
          );
        } else {
          await failJob(prisma, job, error);
          console.error(
            `[worker] job ${job.id} permanently failed:`,
            error instanceof Error ? error.message : error,
          );
          captureSentryException(error, {
            tags: {
              worker_phase: "job_failed",
              jobType: job.jobType,
            },
            extra: {
              jobId: job.id,
              retryCount: nextRetryCount,
              maxRetries: job.maxRetries,
            },
            user: job.userId ? { id: job.userId } : undefined,
          });
        }
      }
    } catch (error) {
      console.error("[worker] poll error:", error);
      captureSentryException(error, {
        tags: { worker_phase: "poll" },
      });
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

function startLeaseHeartbeat(jobId) {
  return setInterval(() => {
    void heartbeatJobLease(prisma, jobId, WORKER_ID).catch((error) => {
      console.error("[worker] failed to heartbeat job lease:", error);
      captureSentryException(error, {
        tags: { worker_phase: "heartbeat" },
        extra: { jobId },
      });
    });
  }, HEARTBEAT_INTERVAL_MS);
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Job timed out after ${ms}ms`)), ms);
    }),
  ]);
}

function isNonRetryableJobError(error) {
  return error?.code === "doc_cap_hit"
    || error?.code === "token_cap_hit"
    || error?.code === "document_not_found"
    || error?.code === "no_extractable_content"
    || error?.code === "document_completion_conflict"
    || error?.code === "document_not_ready"
    || error?.code === "no_usable_excerpts"
    || error?.code === "generation_not_found"
    || error?.code === "generation_completion_conflict"
    || error?.code === "invalid_generation_request"
    || error?.code === "invalid_generation_job"
    || error?.code === "generation_config_missing"
    || error?.code === "export_artifact_not_found"
    || error?.code === "invalid_export_job"
    || error?.code === "export_not_ready"
    || error?.code === "unsupported_job_type";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRequiredSchema(prisma) {
  const startedAt = Date.now();

  while (true) {
    const schemaReady = await hasRequiredSchema(prisma);

    if (schemaReady) {
      return;
    }

    if (Date.now() - startedAt >= SCHEMA_WAIT_TIMEOUT_MS) {
      throw new Error("Required worker schema was not ready before startup timeout");
    }

    console.warn("[worker] waiting for required schema to become available");
    await sleep(SCHEMA_WAIT_INTERVAL_MS);
  }
}

async function hasRequiredSchema(prisma) {
  const [documentColumns, jobColumns, generationColumns, stageTable] = await Promise.all([
    prisma.$queryRaw`
      SELECT "column_name"
      FROM "information_schema"."columns"
      WHERE "table_schema" = 'public'
        AND "table_name" = 'Document'
        AND "column_name" IN ('processingStatus', 'processingJobId', 'processingError', 'processedAt')
    `,
    prisma.$queryRaw`
      SELECT "column_name"
      FROM "information_schema"."columns"
      WHERE "table_schema" = 'public'
        AND "table_name" = 'Job'
        AND "column_name" IN ('documentId', 'workerId', 'leaseExpiresAt', 'lastHeartbeatAt')
    `,
    prisma.$queryRaw`
      SELECT "column_name"
      FROM "information_schema"."columns"
      WHERE "table_schema" = 'public'
        AND "table_name" = 'DocumentGeneration'
        AND "column_name" IN ('documentId', 'generationType', 'status', 'jobId', 'isLatest')
    `,
    prisma.$queryRaw`
      SELECT "table_name"
      FROM "information_schema"."tables"
      WHERE "table_schema" = 'public'
        AND "table_name" = 'JobStageEvent'
    `,
  ]);

  return documentColumns.length === 4
    && jobColumns.length === 4
    && generationColumns.length === 5
    && stageTable.length === 1;
}

function normalizeFatalWorkerError(error, fallbackMessage) {
  if (error instanceof Error) {
    return error;
  }

  if (error && typeof error === "object") {
    const normalizedError = new Error(error.message || fallbackMessage);
    Object.assign(normalizedError, error);
    return normalizedError;
  }

  return new Error(typeof error === "string" ? error : fallbackMessage);
}

async function shutdownWorkerAfterFatalError(origin, error) {
  const normalizedError = normalizeFatalWorkerError(error, `[worker] ${origin}`);

  if (fatalWorkerShutdownStarted) {
    return;
  }

  fatalWorkerShutdownStarted = true;
  console.error(`[worker] ${origin}:`, normalizedError);

  captureSentryException(normalizedError, {
    level: "fatal",
    tags: {
      worker_phase: "process",
      origin,
    },
  });

  await flushSentry(2000).catch(() => false);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
}

process.on("uncaughtException", (error) => {
  void shutdownWorkerAfterFatalError("uncaughtException", error);
});

process.on("unhandledRejection", (reason) => {
  void shutdownWorkerAfterFatalError("unhandledRejection", reason);
});

runWorker().catch((error) => {
  console.error("[worker] fatal error:", error);
  captureSentryException(error, {
    level: "fatal",
    tags: { worker_phase: "startup" },
  });
  flushSentry(2000)
    .catch(() => false)
    .finally(async () => {
      await prisma.$disconnect().catch(() => {});
      process.exit(1);
    });
});
