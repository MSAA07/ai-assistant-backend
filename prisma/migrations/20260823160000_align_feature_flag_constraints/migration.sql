-- Refuse to add the unique index if duplicate assignments exist. Data cleanup is
-- intentionally kept outside this migration so deploys never delete rows.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "FeatureFlagAssignment"
    GROUP BY "flagId", "entityType", "entityId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'FeatureFlagAssignment contains duplicate (flagId, entityType, entityId) groups';
  END IF;
END $$;

-- CreateEnum
CREATE TYPE "FeatureEntityType" AS ENUM ('user', 'tier');

-- Validate existing text values before converting them to the enum.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "FeatureFlagAssignment"
    WHERE "entityType" NOT IN ('user', 'tier')
  ) OR EXISTS (
    SELECT 1
    FROM "FeatureFlagAuditLog"
    WHERE "entityType" IS NOT NULL
      AND "entityType" NOT IN ('user', 'tier')
  ) THEN
    RAISE EXCEPTION 'Unsupported FeatureEntityType value exists';
  END IF;
END $$;

-- DropForeignKey
ALTER TABLE "FeatureFlagAssignment"
  DROP CONSTRAINT "FeatureFlagAssignment_flagId_fkey";

-- DropForeignKey
ALTER TABLE "FeatureFlagAuditLog"
  DROP CONSTRAINT "FeatureFlagAuditLog_flagId_fkey";

-- DropIndex
DROP INDEX "FeatureFlagAssignment_flagId_entityType_entityId_idx";

-- AlterTable: add and backfill updatedAt without assuming FeatureFlag is empty.
ALTER TABLE "FeatureFlag" ADD COLUMN "updatedAt" TIMESTAMP(3);
UPDATE "FeatureFlag" SET "updatedAt" = "createdAt";
ALTER TABLE "FeatureFlag" ALTER COLUMN "updatedAt" SET NOT NULL;

-- AlterTable: preserve existing values while replacing text with the enum.
ALTER TABLE "FeatureFlagAssignment"
  ALTER COLUMN "entityType" TYPE "FeatureEntityType"
  USING ("entityType"::text::"FeatureEntityType");

ALTER TABLE "FeatureFlagAuditLog"
  ALTER COLUMN "entityType" TYPE "FeatureEntityType"
  USING ("entityType"::text::"FeatureEntityType");

-- CreateIndex
CREATE INDEX "FeatureFlagAssignment_flagId_idx"
  ON "FeatureFlagAssignment"("flagId");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureFlagAssignment_flagId_entityType_entityId_key"
  ON "FeatureFlagAssignment"("flagId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "FeatureFlagAuditLog_flagId_idx"
  ON "FeatureFlagAuditLog"("flagId");

-- CreateIndex
CREATE INDEX "FeatureFlagAuditLog_changedAt_idx"
  ON "FeatureFlagAuditLog"("changedAt");

-- AddForeignKey
ALTER TABLE "FeatureFlagAssignment"
  ADD CONSTRAINT "FeatureFlagAssignment_flagId_fkey"
  FOREIGN KEY ("flagId") REFERENCES "FeatureFlag"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeatureFlagAuditLog"
  ADD CONSTRAINT "FeatureFlagAuditLog_flagId_fkey"
  FOREIGN KEY ("flagId") REFERENCES "FeatureFlag"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
