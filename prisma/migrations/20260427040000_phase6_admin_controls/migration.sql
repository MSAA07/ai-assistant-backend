-- Phase 6: record the admin actor that last updated each global usage cap config.
ALTER TABLE "UsageCapConfig"
ADD COLUMN "updatedBy" TEXT;
