-- AlterTable
ALTER TABLE "Document"
ADD COLUMN "processingStatus" TEXT NOT NULL DEFAULT 'queued',
ADD COLUMN "processingJobId" TEXT,
ADD COLUMN "processingError" TEXT,
ADD COLUMN "processedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Job"
ADD COLUMN "documentId" TEXT,
ADD COLUMN "workerId" TEXT,
ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
ADD COLUMN "lastHeartbeatAt" TIMESTAMP(3);

-- Backfill document ownership onto extraction jobs
UPDATE "Job"
SET "documentId" = payload->>'documentId'
WHERE "jobType" = 'extract_document'
  AND "documentId" IS NULL
  AND payload ? 'documentId';

-- CreateIndex
CREATE INDEX "Document_userId_processingStatus_idx" ON "Document"("userId", "processingStatus");

-- CreateIndex
CREATE INDEX "Document_processingJobId_idx" ON "Document"("processingJobId");

-- CreateIndex
CREATE INDEX "Job_status_queuedAt_idx" ON "Job"("status", "queuedAt");

-- CreateIndex
CREATE INDEX "Job_status_leaseExpiresAt_idx" ON "Job"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "Job_documentId_jobType_queuedAt_idx" ON "Job"("documentId", "jobType", "queuedAt");
