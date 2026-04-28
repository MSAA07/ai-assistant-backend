import assert from "node:assert/strict";
import test from "node:test";

import {
  finishRunningJobStages,
  JOB_STAGE_STATUS,
  recordJobStage,
  startJobStage,
  withJobStage,
} from "./jobStageEvents.js";

function createMockPrisma() {
  const stages = [];

  return {
    stages,
    jobStageEvent: {
      async create({ data }) {
        const record = {
          id: `stage_${stages.length + 1}`,
          createdAt: new Date("2026-04-27T00:00:00.000Z"),
          ...data,
        };
        stages.push(record);
        return record;
      },
      async update({ where, data }) {
        const record = stages.find((stage) => stage.id === where.id);
        Object.assign(record, data);
        return record;
      },
      async findMany({ where }) {
        return stages.filter((stage) => {
          if (where.jobId && stage.jobId !== where.jobId) return false;
          if (where.status && stage.status !== where.status) return false;
          if (where.endedAt === null && stage.endedAt !== undefined && stage.endedAt !== null) return false;
          return true;
        });
      },
    },
  };
}

test("recordJobStage stores duration for completed stage events", async () => {
  const prisma = createMockPrisma();
  const stage = await recordJobStage(prisma, {
    jobId: "job_1",
    stageName: "queued",
    startedAt: new Date("2026-04-27T00:00:00.000Z"),
    endedAt: new Date("2026-04-27T00:00:01.250Z"),
  });

  assert.equal(stage.durationMs, 1250);
  assert.equal(stage.status, JOB_STAGE_STATUS.succeeded);
});

test("withJobStage closes successful and failed stages", async () => {
  const prisma = createMockPrisma();
  const result = await withJobStage(
    prisma,
    { id: "job_1", retryCount: 1 },
    "text_extraction",
    async () => "ok",
  );

  assert.equal(result, "ok");
  assert.equal(prisma.stages[0].attemptNumber, 2);
  assert.equal(prisma.stages[0].status, JOB_STAGE_STATUS.succeeded);
  assert.ok(prisma.stages[0].endedAt);

  await assert.rejects(() => withJobStage(
    prisma,
    { id: "job_1", retryCount: 1 },
    "model_call",
    async () => {
      throw new Error("model failed");
    },
  ), /model failed/);

  assert.equal(prisma.stages[1].status, JOB_STAGE_STATUS.failed);
  assert.equal(prisma.stages[1].errorSummary, "model failed");
});

test("finishRunningJobStages closes open stages for a job", async () => {
  const prisma = createMockPrisma();
  await startJobStage(prisma, {
    jobId: "job_1",
    stageName: "claimed_running",
  });
  await startJobStage(prisma, {
    jobId: "job_2",
    stageName: "claimed_running",
  });

  const result = await finishRunningJobStages(prisma, "job_1", {
    status: JOB_STAGE_STATUS.failed,
    error: new Error("lease expired"),
  });

  assert.equal(result.count, 1);
  assert.equal(prisma.stages[0].status, JOB_STAGE_STATUS.failed);
  assert.equal(prisma.stages[0].errorSummary, "lease expired");
  assert.equal(prisma.stages[1].status, JOB_STAGE_STATUS.running);
});
