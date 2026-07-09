CREATE TABLE "model_routing_config" (
    "id" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "reasoningEffort" TEXT,
    "updatedByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_routing_config_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "model_routing_config_feature_plan_key" ON "model_routing_config"("feature", "plan");
