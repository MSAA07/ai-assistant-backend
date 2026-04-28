export const JOB_STAGE_STATUS = Object.freeze({
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  skipped: "skipped",
});

function normalizeStageName(stageName) {
  return typeof stageName === "string" && stageName.trim()
    ? stageName.trim()
    : "unknown";
}

function normalizeAttemptNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 1;
}

function getAttemptNumber(jobOrAttempt) {
  if (typeof jobOrAttempt === "number") {
    return normalizeAttemptNumber(jobOrAttempt);
  }

  return normalizeAttemptNumber((jobOrAttempt?.retryCount || 0) + 1);
}

function summarizeError(error) {
  if (!error) return null;
  if (error instanceof Error) return error.message.slice(0, 1000);
  if (typeof error === "string") return error.slice(0, 1000);
  return "Stage failed";
}

function durationMs(startedAt, endedAt) {
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }

  return Math.max(0, end - start);
}

export async function startJobStage(prisma, {
  jobId,
  stageName,
  attemptNumber = 1,
  startedAt = new Date(),
  metadata = {},
} = {}) {
  if (!prisma?.jobStageEvent || !jobId) {
    return null;
  }

  try {
    return await prisma.jobStageEvent.create({
      data: {
        jobId,
        stageName: normalizeStageName(stageName),
        status: JOB_STAGE_STATUS.running,
        attemptNumber: normalizeAttemptNumber(attemptNumber),
        startedAt,
        metadata,
      },
    });
  } catch (error) {
    console.error("[jobStageEvents] failed to start job stage:", error);
    return null;
  }
}

export async function finishJobStage(prisma, stageEvent, {
  status = JOB_STAGE_STATUS.succeeded,
  endedAt = new Date(),
  error = null,
  metadata = null,
} = {}) {
  if (!prisma?.jobStageEvent || !stageEvent?.id) {
    return null;
  }

  try {
    return await prisma.jobStageEvent.update({
      where: { id: stageEvent.id },
      data: {
        status,
        endedAt,
        durationMs: durationMs(stageEvent.startedAt, endedAt),
        errorSummary: summarizeError(error),
        ...(metadata && typeof metadata === "object"
          ? { metadata: { ...(stageEvent.metadata ?? {}), ...metadata } }
          : {}),
      },
    });
  } catch (stageError) {
    console.error("[jobStageEvents] failed to finish job stage:", stageError);
    return null;
  }
}

export async function recordJobStage(prisma, {
  jobId,
  stageName,
  attemptNumber = 1,
  startedAt = new Date(),
  endedAt = new Date(),
  status = JOB_STAGE_STATUS.succeeded,
  error = null,
  metadata = {},
} = {}) {
  if (!prisma?.jobStageEvent || !jobId) {
    return null;
  }

  try {
    return await prisma.jobStageEvent.create({
      data: {
        jobId,
        stageName: normalizeStageName(stageName),
        status,
        attemptNumber: normalizeAttemptNumber(attemptNumber),
        startedAt,
        endedAt,
        durationMs: durationMs(startedAt, endedAt),
        errorSummary: summarizeError(error),
        metadata,
      },
    });
  } catch (stageError) {
    console.error("[jobStageEvents] failed to record job stage:", stageError);
    return null;
  }
}

export async function withJobStage(prisma, jobOrContext, stageName, fn, options = {}) {
  const jobId = jobOrContext?.jobId ?? jobOrContext?.id;
  const attemptNumber = options.attemptNumber ?? getAttemptNumber(jobOrContext);
  const stage = await startJobStage(prisma, {
    jobId,
    stageName,
    attemptNumber,
    metadata: options.metadata ?? {},
  });

  try {
    const result = await fn();
    await finishJobStage(prisma, stage, {
      status: options.status ?? JOB_STAGE_STATUS.succeeded,
      metadata: options.finishMetadata,
    });
    return result;
  } catch (error) {
    await finishJobStage(prisma, stage, {
      status: JOB_STAGE_STATUS.failed,
      error,
      metadata: options.finishMetadata,
    });
    throw error;
  }
}

export async function finishRunningJobStages(prisma, jobId, {
  status,
  error = null,
  endedAt = new Date(),
} = {}) {
  if (!prisma?.jobStageEvent || !jobId) {
    return { count: 0 };
  }

  try {
    const runningStages = await prisma.jobStageEvent.findMany({
      where: {
        jobId,
        endedAt: null,
        status: JOB_STAGE_STATUS.running,
      },
    });

    let count = 0;
    for (const stage of runningStages) {
      await finishJobStage(prisma, stage, { status, error, endedAt });
      count += 1;
    }

    return { count };
  } catch (stageError) {
    console.error("[jobStageEvents] failed to finish running job stages:", stageError);
    return { count: 0 };
  }
}

export async function finishActiveJobStagesByName(prisma, jobId, stageName, {
  status = JOB_STAGE_STATUS.succeeded,
  error = null,
  endedAt = new Date(),
} = {}) {
  if (!prisma?.jobStageEvent || !jobId) {
    return { count: 0 };
  }

  try {
    const stages = await prisma.jobStageEvent.findMany({
      where: {
        jobId,
        stageName: normalizeStageName(stageName),
        endedAt: null,
        status: JOB_STAGE_STATUS.running,
      },
    });

    let count = 0;
    for (const stage of stages) {
      await finishJobStage(prisma, stage, { status, error, endedAt });
      count += 1;
    }

    return { count };
  } catch (stageError) {
    console.error("[jobStageEvents] failed to finish active job stages:", stageError);
    return { count: 0 };
  }
}

export function serializeJobStageEvent(stage) {
  return {
    id: stage.id,
    jobId: stage.jobId,
    stageName: stage.stageName,
    status: stage.status,
    attemptNumber: stage.attemptNumber,
    startedAt: stage.startedAt,
    endedAt: stage.endedAt,
    durationMs: stage.durationMs,
    errorSummary: stage.errorSummary,
    metadata: stage.metadata,
    createdAt: stage.createdAt,
  };
}
