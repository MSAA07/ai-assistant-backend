-- Phase 5: persisted admin alert delivery/dedup state.
CREATE TABLE "AdminAlert" (
    "id" TEXT NOT NULL,
    "alertType" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "targetType" TEXT,
    "targetId" TEXT,
    "userId" TEXT,
    "documentId" TEXT,
    "jobId" TEXT,
    "thresholdUsd" DECIMAL(12,8),
    "actualUsd" DECIMAL(12,8),
    "thresholdCount" INTEGER,
    "actualCount" INTEGER,
    "dedupKey" TEXT NOT NULL,
    "emailTo" TEXT,
    "emailSubject" TEXT,
    "emailStatus" TEXT NOT NULL DEFAULT 'pending',
    "providerMessageId" TEXT,
    "errorMessage" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAlert_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminAlert_alertType_createdAt_idx" ON "AdminAlert"("alertType", "createdAt");
CREATE INDEX "AdminAlert_dedupKey_createdAt_idx" ON "AdminAlert"("dedupKey", "createdAt");
CREATE INDEX "AdminAlert_emailStatus_createdAt_idx" ON "AdminAlert"("emailStatus", "createdAt");
CREATE INDEX "AdminAlert_userId_createdAt_idx" ON "AdminAlert"("userId", "createdAt");
CREATE INDEX "AdminAlert_jobId_idx" ON "AdminAlert"("jobId");

ALTER TABLE "AdminAlert"
ADD CONSTRAINT "AdminAlert_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
