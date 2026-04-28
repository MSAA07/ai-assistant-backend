-- Phase 3: per-job stage timing and observability.

CREATE TABLE "JobStageEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "stageName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "errorSummary" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobStageEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "JobStageEvent_jobId_startedAt_idx" ON "JobStageEvent"("jobId", "startedAt");
CREATE INDEX "JobStageEvent_jobId_stageName_attemptNumber_idx" ON "JobStageEvent"("jobId", "stageName", "attemptNumber");
CREATE INDEX "JobStageEvent_status_startedAt_idx" ON "JobStageEvent"("status", "startedAt");
CREATE INDEX "JobStageEvent_stageName_startedAt_idx" ON "JobStageEvent"("stageName", "startedAt");

ALTER TABLE "JobStageEvent" ADD CONSTRAINT "JobStageEvent_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "JobStageEvent" (
  "id",
  "jobId",
  "stageName",
  "status",
  "attemptNumber",
  "startedAt",
  "endedAt",
  "durationMs",
  "metadata",
  "createdAt"
)
SELECT
  'job_stage_queued_' || "id",
  "id",
  'queued',
  CASE WHEN "startedAt" IS NULL AND "status" = 'queued' THEN 'running' ELSE 'succeeded' END,
  1,
  "queuedAt",
  "startedAt",
  CASE
    WHEN "startedAt" IS NULL THEN NULL
    ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ("startedAt" - "queuedAt")) * 1000)::INTEGER)
  END,
  '{}',
  "queuedAt"
FROM "Job"
WHERE "queuedAt" IS NOT NULL
ON CONFLICT ("id") DO NOTHING;
