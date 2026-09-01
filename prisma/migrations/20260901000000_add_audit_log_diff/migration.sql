ALTER TABLE "audit_log"
ADD COLUMN "previousValue" JSONB,
ADD COLUMN "newValue" JSONB;
