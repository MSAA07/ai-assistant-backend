import os from "os";

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
import { backfillDocumentProcessingState } from "./utils/documentStatus.js";
import { captureSentryException, flushSentry, initSentry } from "./utils/sentry.js";
import { assertStorageConfiguredForRuntime } from "./utils/storage.js";

const prisma = new PrismaClient();
const WORKER_ID = `${os.hostname()}-${process.pid}`;
const POLL_INTERVAL_MS = 2000;
const SCHEMA_WAIT_INTERVAL_MS = 5000;
const SCHEMA_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const JOB_TIMEOUTS = {
  extract_document: 60_000,
  [GENERATION_JOB_TYPES.summary]: 90_000,
  [GENERATION_JOB_TYPES.flashcards]: 90_000,
  [GENERATION_JOB_TYPES.exam]: 90_000,
  export_pdf: 30_000,
};
const JOB_PROCESSORS = {
  extract_document: processExtraction,
  [GENERATION_JOB_TYPES.summary]: processGeneration,
  [GENERATION_JOB_TYPES.flashcards]: processGeneration,
  [GENERATION_JOB_TYPES.exam]: processGeneration,
};

let fatalWorkerShutdownStarted = false;

initSentry({ serviceName: "worker", disableProcessHandlers: true });

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

      const timeout = JOB_TIMEOUTS[job.jobType] || 60_000;
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
