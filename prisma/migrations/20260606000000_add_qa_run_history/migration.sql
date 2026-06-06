-- CreateTable
CREATE TABLE "QaRun" (
    "id" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "ranAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalDurationMs" INTEGER NOT NULL,
    "passed" INTEGER NOT NULL,
    "failed" INTEGER NOT NULL,
    "skipped" INTEGER NOT NULL,
    "estimatedCostUsd" DOUBLE PRECISION NOT NULL,
    "triggeredBy" TEXT NOT NULL,

    CONSTRAINT "QaRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QaRunResult" (
    "id" TEXT NOT NULL,
    "qaRunId" TEXT NOT NULL,
    "testName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "order" INTEGER NOT NULL,

    CONSTRAINT "QaRunResult_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "QaRunResult" ADD CONSTRAINT "QaRunResult_qaRunId_fkey" FOREIGN KEY ("qaRunId") REFERENCES "QaRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
