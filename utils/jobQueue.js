import { DOCUMENT_PROCESSING_STATUS } from "./documentStatus.js";

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const JOB_LEASE_DURATION_MS = 120_000;
export const STALE_JOB_SWEEP_INTERVAL_MS = 15_000;

function getLeaseExpiryDate(now = new Date()) {
  return new Date(now.getTime() + JOB_LEASE_DURATION_MS);
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

    if (claimedJob.documentId) {
      await tx.document.updateMany({
        where: {
          id: claimedJob.documentId,
          OR: [
            { processingJobId: claimedJob.id },
            { processingJobId: null },
          ],
        },
        data: {
          processingStatus: DOCUMENT_PROCESSING_STATUS.processing,
          processingJobId: claimedJob.id,
          processingError: null,
        },
      });
    }

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

    if (job.documentId) {
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

    if (job.documentId) {
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
          processingJobId: job.id,
          processingError: retryDecision.errorMessage,
          processedAt: null,
        },
      });
    }
  });

  return retryDecision;
}

export async function completeJob(prisma, job, result, studyMaterials) {
  const completedAt = new Date();

  await prisma.$transaction(async (tx) => {
    const documentUpdate = await tx.document.updateMany({
      where: {
        id: job.documentId,
        OR: [
          { processingJobId: job.id },
          { processingJobId: null },
        ],
      },
      data: {
        summary: studyMaterials.summary,
        flashcards: studyMaterials.flashcards,
        examQuestions: studyMaterials.examQuestions,
        processingStatus: DOCUMENT_PROCESSING_STATUS.complete,
        processingJobId: job.id,
        processingError: null,
        processedAt: completedAt,
      },
    });

    if (documentUpdate.count === 0) {
      const completionError = new Error(`Document ${job.documentId} could not be completed`);
      completionError.code = "document_completion_conflict";
      throw completionError;
    }

    await tx.job.update({
      where: { id: job.id },
      data: {
        status: "succeeded",
        progressPct: 100,
        result,
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
