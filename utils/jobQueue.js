import { DOCUMENT_PROCESSING_STATUS } from "./documentStatus.js";
import {
  DOCUMENT_GENERATION_STATUS,
  getGenerationTypeForJobType,
  getMirrorFieldForGenerationType,
  isGenerationJobType,
  normalizeGenerationOutput,
} from "./documentGeneration.js";
import { upsertCanonicalGenerationRecord } from "./phase2Backfill.js";

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const JOB_LEASE_DURATION_MS = 120_000;
export const STALE_JOB_SWEEP_INTERVAL_MS = 15_000;

function getLeaseExpiryDate(now = new Date()) {
  return new Date(now.getTime() + JOB_LEASE_DURATION_MS);
}

function isExtractionJob(job) {
  return job?.jobType === "extract_document";
}

async function markQueuedJobRunning(tx, job) {
  if (isExtractionJob(job) && job.documentId) {
    await tx.document.updateMany({
      where: {
        id: job.documentId,
        OR: [
          { processingJobId: job.id },
          { processingJobId: null },
        ],
      },
      data: {
        processingStatus: DOCUMENT_PROCESSING_STATUS.processing,
        processingJobId: job.id,
        processingError: null,
      },
    });
    return;
  }

  if (isGenerationJobType(job?.jobType)) {
    await tx.documentGeneration.updateMany({
      where: { jobId: job.id },
      data: {
        status: DOCUMENT_GENERATION_STATUS.running,
        errorMessage: null,
      },
    });
  }
}

async function requeueExtractionJob(tx, job, errorMessage) {
  if (!job.documentId) {
    return;
  }

  await tx.document.updateMany({
    where: {
      id: job.documentId,
      OR: [
        { processingJobId: job.id },
        { processingJobId: null },
      ],
    },
    data: {
      processingStatus: DOCUMENT_PROCESSING_STATUS.queued,
      processingJobId: job.id,
      processingError: null,
      processedAt: null,
    },
  });
}

async function requeueGenerationJob(tx, job, errorMessage) {
  await tx.documentGeneration.updateMany({
    where: { jobId: job.id },
    data: {
      status: DOCUMENT_GENERATION_STATUS.queued,
      errorMessage,
    },
  });
}

async function failExtractionJob(tx, job, errorMessage) {
  if (!job.documentId) {
    return;
  }

  await tx.document.updateMany({
    where: {
      id: job.documentId,
      OR: [
        { processingJobId: job.id },
        { processingJobId: null },
      ],
    },
    data: {
      processingStatus: DOCUMENT_PROCESSING_STATUS.failed,
      processingJobId: null,
      processingError: errorMessage,
      processedAt: null,
    },
  });
}

async function failGenerationJob(tx, job, errorMessage) {
  await tx.documentGeneration.updateMany({
    where: { jobId: job.id },
    data: {
      status: DOCUMENT_GENERATION_STATUS.failed,
      errorMessage,
    },
  });
}

async function completeExtractionJob(tx, job, result, completedAt) {
  const documentUpdate = await tx.document.updateMany({
    where: {
      id: job.documentId,
      OR: [
        { processingJobId: job.id },
        { processingJobId: null },
      ],
    },
    data: {
      processingStatus: DOCUMENT_PROCESSING_STATUS.complete,
      processingJobId: null,
      processingError: null,
      processedAt: completedAt,
    },
  });

  if (documentUpdate.count === 0) {
    const completionError = new Error(`Document ${job.documentId} could not be completed`);
    completionError.code = "document_completion_conflict";
    throw completionError;
  }
}

async function completeGenerationJob(tx, job, result, completedAt) {
  const generationType = getGenerationTypeForJobType(job.jobType);
  const normalizedOutput = normalizeGenerationOutput(generationType, result?.output);
  const generationId = typeof result?.generationId === "string" ? result.generationId : null;
  const documentUpdateData = {};
  const mirrorField = getMirrorFieldForGenerationType(generationType);

  if (mirrorField === "summary") {
    documentUpdateData.summary = normalizedOutput.text;
  } else if (mirrorField === "flashcards") {
    documentUpdateData.flashcards = normalizedOutput.cards;
  } else {
    documentUpdateData.examQuestions = normalizedOutput.questions;
  }

  const generationUpdate = await tx.documentGeneration.updateMany({
    where: { jobId: job.id },
    data: {
      status: DOCUMENT_GENERATION_STATUS.complete,
      output: normalizedOutput,
      errorMessage: null,
      generatedAt: completedAt,
    },
  });

  if (generationUpdate.count === 0) {
    const completionError = new Error(`Generation job ${job.id} is missing its DocumentGeneration row`);
    completionError.code = "generation_completion_conflict";
    throw completionError;
  }

  if (job.documentId && (generationType === "flashcards" || generationType === "exam")) {
    const generation = await tx.documentGeneration.findFirst({
      where: { jobId: job.id },
      select: {
        id: true,
        documentId: true,
        isLatest: true,
      },
      orderBy: { createdAt: "desc" },
    });

    if (generation?.documentId) {
      await upsertCanonicalGenerationRecord(tx, {
        generationType,
        documentId: generation.documentId,
        generationId: generationId || generation.id,
        options: result?.effectiveOptions ?? result?.options ?? {},
        output: normalizedOutput,
        isLatest: Boolean(generation.isLatest),
      });
    }
  }

  if (job.documentId) {
    await tx.document.update({
      where: { id: job.documentId },
      data: documentUpdateData,
    });
  }
}

function getRetryDecision(job, error, shouldRetry = true) {
  const nextRetryCount = (job.retryCount || 0) + 1;

  return {
    nextRetryCount,
    shouldRetry: shouldRetry && nextRetryCount < job.maxRetries,
    errorMessage: error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Job failed",
  };
}

export async function getJobById(prisma, jobId) {
  return prisma.job.findUnique({ where: { id: jobId } });
}

export async function updateJob(prisma, jobId, data) {
  return prisma.job.update({
    where: { id: jobId },
    data,
  });
}

export async function updateJobProgress(prisma, jobId, workerId, progressPct) {
  return prisma.job.updateMany({
    where: {
      id: jobId,
      status: "running",
      workerId,
    },
    data: { progressPct },
  });
}

export async function claimNextQueuedJob(prisma, workerId) {
  return prisma.$transaction(async (tx) => {
    const claimCandidates = await tx.$queryRaw`
      SELECT "id"
      FROM "Job"
      WHERE "status" = 'queued'
      ORDER BY "queuedAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;
    const claimCandidate = claimCandidates[0];

    if (!claimCandidate?.id) {
      return null;
    }

    const now = new Date();
    const claimedJob = await tx.job.update({
      where: { id: claimCandidate.id },
      data: {
        status: "running",
        workerId,
        startedAt: now,
        leaseExpiresAt: getLeaseExpiryDate(now),
        lastHeartbeatAt: now,
        errorMessage: null,
      },
    });

    await markQueuedJobRunning(tx, claimedJob);

    return claimedJob;
  });
}

export async function heartbeatJobLease(prisma, jobId, workerId) {
  const now = new Date();

  return prisma.job.updateMany({
    where: {
      id: jobId,
      status: "running",
      workerId,
    },
    data: {
      leaseExpiresAt: getLeaseExpiryDate(now),
      lastHeartbeatAt: now,
    },
  });
}

export async function requeueJob(prisma, job, error, shouldRetry = true) {
  const retryDecision = getRetryDecision(job, error, shouldRetry);
  const now = new Date();

  if (!retryDecision.shouldRetry) {
    return failJob(prisma, job, error);
  }

  await prisma.$transaction(async (tx) => {
    await tx.job.update({
      where: { id: job.id },
      data: {
        status: "queued",
        retryCount: retryDecision.nextRetryCount,
        progressPct: 0,
        errorMessage: retryDecision.errorMessage,
        startedAt: null,
        completedAt: null,
        workerId: null,
        leaseExpiresAt: null,
        lastHeartbeatAt: null,
        queuedAt: now,
      },
    });

    if (isExtractionJob(job)) {
      await requeueExtractionJob(tx, job, retryDecision.errorMessage);
      return;
    }

    if (isGenerationJobType(job.jobType)) {
      await requeueGenerationJob(tx, job, retryDecision.errorMessage);
    }
  });

  return retryDecision;
}

export async function failJob(prisma, job, error) {
  const retryDecision = getRetryDecision(job, error, true);
  const completedAt = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.job.update({
      where: { id: job.id },
      data: {
        status: "failed",
        retryCount: retryDecision.nextRetryCount,
        errorMessage: retryDecision.errorMessage,
        completedAt,
        workerId: null,
        leaseExpiresAt: null,
        lastHeartbeatAt: completedAt,
      },
    });

    if (isExtractionJob(job)) {
      await failExtractionJob(tx, job, retryDecision.errorMessage);
      return;
    }

    if (isGenerationJobType(job.jobType)) {
      await failGenerationJob(tx, job, retryDecision.errorMessage);
    }
  });

  return retryDecision;
}

export async function completeJob(prisma, job, result) {
  const completedAt = new Date();

  await prisma.$transaction(async (tx) => {
    if (isExtractionJob(job)) {
      await completeExtractionJob(tx, job, result, completedAt);
    } else if (isGenerationJobType(job.jobType)) {
      await completeGenerationJob(tx, job, result, completedAt);
    }

    await tx.job.update({
      where: { id: job.id },
      data: {
        status: "succeeded",
        progressPct: 100,
        result: {
          ...(result || {}),
          generatedAt: result?.generatedAt ?? completedAt,
        },
        errorMessage: null,
        completedAt,
        workerId: null,
        leaseExpiresAt: null,
        lastHeartbeatAt: completedAt,
      },
    });
  });
}

export async function recoverStaleJobs(prisma) {
  const staleJobs = await prisma.job.findMany({
    where: {
      status: "running",
      OR: [
        { leaseExpiresAt: { lt: new Date() } },
        {
          leaseExpiresAt: null,
          startedAt: { lt: new Date(Date.now() - JOB_LEASE_DURATION_MS) },
        },
      ],
    },
    orderBy: { startedAt: "asc" },
    take: 25,
  });

  for (const staleJob of staleJobs) {
    const shouldRetry = (staleJob.retryCount || 0) + 1 < staleJob.maxRetries;
    const staleError = new Error("Job lease expired before completion");

    if (shouldRetry) {
      await requeueJob(prisma, staleJob, staleError, true);
      continue;
    }

    await failJob(prisma, staleJob, staleError);
  }
}
