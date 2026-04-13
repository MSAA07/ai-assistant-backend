CREATE TABLE "DocumentGeneration" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "generationType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "jobId" TEXT,
    "options" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB,
    "errorMessage" TEXT,
    "generatedAt" TIMESTAMP(3),
    "isLatest" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentGeneration_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DocumentGeneration_documentId_generationType_isLatest_idx"
ON "DocumentGeneration"("documentId", "generationType", "isLatest");

CREATE INDEX "DocumentGeneration_jobId_idx"
ON "DocumentGeneration"("jobId");

CREATE UNIQUE INDEX "DocumentGeneration_latest_unique_idx"
ON "DocumentGeneration"("documentId", "generationType")
WHERE "isLatest" = true;

ALTER TABLE "DocumentGeneration"
ADD CONSTRAINT "DocumentGeneration_documentId_fkey"
FOREIGN KEY ("documentId") REFERENCES "Document"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
