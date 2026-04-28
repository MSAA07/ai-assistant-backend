-- Phase 2: dynamic caps, per-user overrides, and global plan defaults.

ALTER TABLE "UserLimit"
  ADD COLUMN "documentCapOverride" INTEGER,
  ADD COLUMN "costCapUsdOverride" DECIMAL(10,4),
  ADD COLUMN "tokenCapOverride" INTEGER,
  ADD COLUMN "featureCapsOverride" JSONB NOT NULL DEFAULT '{}';

CREATE TABLE "UsageCapConfig" (
    "id" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "documentCap" INTEGER,
    "costCapUsd" DECIMAL(10,4),
    "tokenCap" INTEGER,
    "featureCaps" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageCapConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UsageCapConfig_plan_key" ON "UsageCapConfig"("plan");

INSERT INTO "UsageCapConfig" ("id", "plan", "documentCap", "costCapUsd", "tokenCap", "featureCaps", "createdAt", "updatedAt")
VALUES
  ('usage_cap_free_default', 'free', 5, 1.5000, NULL, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('usage_cap_premium_default', 'premium', 100, NULL, NULL, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("plan") DO NOTHING;

INSERT INTO "UserLimit" ("userId", "documentCapOverride", "overrideBy")
SELECT
  "id",
  "monthlyLimit",
  'legacy_monthlyLimit_backfill'
FROM "user"
WHERE
  ("plan" = 'premium' AND "monthlyLimit" <> 100)
  OR (COALESCE("plan", 'free') <> 'premium' AND "monthlyLimit" <> 5)
ON CONFLICT ("userId") DO UPDATE
SET
  "documentCapOverride" = COALESCE("UserLimit"."documentCapOverride", EXCLUDED."documentCapOverride"),
  "overrideBy" = COALESCE("UserLimit"."overrideBy", EXCLUDED."overrideBy");
