CREATE TABLE "IncidentState" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "updatedByAdminId" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "reopenedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IncidentState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IncidentState_source_sourceId_key" ON "IncidentState"("source", "sourceId");
CREATE INDEX "IncidentState_status_updatedAt_idx" ON "IncidentState"("status", "updatedAt");
