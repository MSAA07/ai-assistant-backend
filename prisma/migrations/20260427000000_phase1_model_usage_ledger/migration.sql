-- Phase 1: durable per-model-call usage ledger.

CREATE TABLE "ModelUsageEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documentId" TEXT,
    "generationId" TEXT,
    "jobId" TEXT,
    "featureKey" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostUsd" DECIMAL(12,8) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "pricingVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "billable" BOOLEAN NOT NULL DEFAULT true,
    "requestId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "jobRetryCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelUsageEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ModelUsageEvent_idempotencyKey_key" ON "ModelUsageEvent"("idempotencyKey");
CREATE INDEX "ModelUsageEvent_userId_createdAt_idx" ON "ModelUsageEvent"("userId", "createdAt");
CREATE INDEX "ModelUsageEvent_featureKey_createdAt_idx" ON "ModelUsageEvent"("featureKey", "createdAt");
CREATE INDEX "ModelUsageEvent_model_createdAt_idx" ON "ModelUsageEvent"("model", "createdAt");
CREATE INDEX "ModelUsageEvent_documentId_idx" ON "ModelUsageEvent"("documentId");
CREATE INDEX "ModelUsageEvent_generationId_idx" ON "ModelUsageEvent"("generationId");
CREATE INDEX "ModelUsageEvent_jobId_idx" ON "ModelUsageEvent"("jobId");
CREATE INDEX "ModelUsageEvent_status_idx" ON "ModelUsageEvent"("status");

ALTER TABLE "ModelUsageEvent" ADD CONSTRAINT "ModelUsageEvent_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ModelUsageEvent" ADD CONSTRAINT "ModelUsageEvent_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ModelUsageEvent" ADD CONSTRAINT "ModelUsageEvent_generationId_fkey"
  FOREIGN KEY ("generationId") REFERENCES "DocumentGeneration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ModelUsageEvent" ADD CONSTRAINT "ModelUsageEvent_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
