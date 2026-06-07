-- AlterTable
ALTER TABLE "QaRun" ADD COLUMN "tier" TEXT NOT NULL DEFAULT 'full';
ALTER TABLE "QaRun" ADD COLUMN "failureReport" TEXT;

-- AlterTable
ALTER TABLE "QaRunResult" ADD COLUMN "thresholdMs" INTEGER NOT NULL DEFAULT 1000;
ALTER TABLE "QaRunResult" ADD COLUMN "speedVerdict" TEXT NOT NULL DEFAULT 'fast';

-- CreateTable
CREATE TABLE "QaScheduleConfig" (
    "id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "frequencyMins" INTEGER NOT NULL DEFAULT 60,
    "tier" TEXT NOT NULL DEFAULT 'health',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QaScheduleConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QaRun_tier_ranAt_idx" ON "QaRun"("tier", "ranAt");

-- CreateIndex
CREATE INDEX "QaRun_triggeredBy_ranAt_idx" ON "QaRun"("triggeredBy", "ranAt");
