import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_ALERT_TYPES,
  alertJobFailure,
  alertModelPricingMissing,
  evaluateDailySystemCostThreshold,
  evaluateFailedJobSpike,
  evaluateSystemCostSpike,
  evaluateUserCostThreshold,
  getAdminAlertConfig,
  recordAdminAlert,
  sendAdminAlertEmail,
} from "./adminAlerts.js";

function createAlertPrisma() {
  const alerts = [];

  return {
    alerts,
    adminAlert: {
      async findFirst(args) {
        const dedupKey = args.where.dedupKey;
        const since = args.where.createdAt.gte;
        return alerts
          .filter((alert) => alert.dedupKey === dedupKey && alert.createdAt >= since)
          .sort((left, right) => right.createdAt - left.createdAt)[0] || null;
      },
      async create(args) {
        const alert = {
          id: `alert_${alerts.length + 1}`,
          ...args.data,
        };
        alerts.push(alert);
        return alert;
      },
      async update(args) {
        const alert = alerts.find((item) => item.id === args.where.id);
        Object.assign(alert, args.data);
        return alert;
      },
    },
  };
}

function createCostThresholdPrisma() {
  const prisma = createAlertPrisma();
  Object.assign(prisma, {
    user: {
      async findUnique() {
        return {
          id: "user_1",
          email: "learner@example.com",
          name: "Learner",
          plan: "free",
          role: "user",
          userLimit: null,
        };
      },
    },
    usageCapConfig: {
      async findUnique() {
        return {
          plan: "free",
          documentCap: 5,
          costCapUsd: "1.50",
          tokenCap: null,
          featureCaps: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
    },
    document: {
      async count() {
        return 2;
      },
    },
    modelUsageEvent: {
      async aggregate() {
        return {
          _sum: {
            estimatedCostUsd: "1.30",
            inputTokens: 1000,
            outputTokens: 500,
            totalTokens: 1500,
          },
        };
      },
    },
  });
  return prisma;
}

const configuredEnv = Object.freeze({
  ALERTS_ENABLED: "true",
  RESEND_API_KEY: "re_test",
  ADMIN_ALERT_EMAIL: "admin@example.com",
  ALERT_FROM_EMAIL: "alerts@example.com",
  AUTH_EMAIL_APP_URL: "https://studymaxing.com",
});

test("getAdminAlertConfig applies safe defaults and env overrides", () => {
  const config = getAdminAlertConfig({
    ALERTS_ENABLED: "false",
    ALERT_FAILED_JOB_THRESHOLD: "5",
    ALERT_DEDUP_WINDOW_MINUTES: "15",
  });

  assert.equal(config.enabled, false);
  assert.equal(config.dailyCostThresholdUsd, 10);
  assert.equal(config.failedJobThreshold, 5);
  assert.equal(config.dedupWindowMinutes, 15);
});

test("sendAdminAlertEmail posts to Resend when enabled and configured", async () => {
  const calls = [];
  const result = await sendAdminAlertEmail({
    alertType: ADMIN_ALERT_TYPES.jobFailure,
    severity: "error",
    jobId: "job_1",
    adminPath: "/admin?tab=jobs",
  }, {
    env: configuredEnv,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        async text() {
          return JSON.stringify({ id: "email_123" });
        },
      };
    },
  });

  assert.equal(result.status, "sent");
  assert.equal(result.providerMessageId, "email_123");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.match(calls[0].options.body, /job_1/);
});

test("recordAdminAlert deduplicates the same type and target inside the window", async () => {
  const prisma = createAlertPrisma();
  let sends = 0;
  const fetchImpl = async () => {
    sends += 1;
    return {
      ok: true,
      async text() {
        return JSON.stringify({ id: `email_${sends}` });
      },
    };
  };

  const first = await recordAdminAlert(prisma, {
    alertType: ADMIN_ALERT_TYPES.dailySystemCostThreshold,
    severity: "warning",
    targetType: "system",
    targetId: "daily-cost",
    thresholdUsd: 10,
    actualUsd: 12,
  }, {
    env: { ...configuredEnv, ALERT_DEDUP_WINDOW_MINUTES: "60" },
    fetchImpl,
  });
  const second = await recordAdminAlert(prisma, {
    alertType: ADMIN_ALERT_TYPES.dailySystemCostThreshold,
    severity: "warning",
    targetType: "system",
    targetId: "daily-cost",
    thresholdUsd: 10,
    actualUsd: 13,
  }, {
    env: { ...configuredEnv, ALERT_DEDUP_WINDOW_MINUTES: "60" },
    fetchImpl,
  });

  assert.equal(first.status, "sent");
  assert.equal(second.status, "deduped");
  assert.equal(prisma.alerts.length, 1);
  assert.equal(sends, 1);
});

test("alertModelPricingMissing records a deduplicated error anomaly for the model", async () => {
  const prisma = createAlertPrisma();
  const error = Object.assign(new Error("No pricing configured for model: gpt-future"), {
    code: "model_pricing_missing",
  });
  const options = {
    model: "gpt-future",
    pricingVersion: "pricing-test-v1",
    env: { ALERTS_ENABLED: "false" },
    metadata: { source: "test" },
  };

  const first = await alertModelPricingMissing(prisma, error, options);
  const second = await alertModelPricingMissing(prisma, error, options);

  assert.equal(first.status, "disabled");
  assert.equal(second.status, "deduped");
  assert.equal(prisma.alerts.length, 1);
  assert.equal(prisma.alerts[0].alertType, ADMIN_ALERT_TYPES.modelPricingMissing);
  assert.equal(prisma.alerts[0].severity, "error");
  assert.equal(prisma.alerts[0].targetType, "model");
  assert.equal(prisma.alerts[0].targetId, "gpt-future");
  assert.equal(prisma.alerts[0].metadata.pricingVersion, "pricing-test-v1");
  assert.equal(prisma.alerts[0].metadata.source, "test");
});

test("evaluateUserCostThreshold sends when spend crosses 80 percent of cap", async () => {
  const prisma = createCostThresholdPrisma();
  let sends = 0;
  const result = await evaluateUserCostThreshold(prisma, "user_1", {
    env: configuredEnv,
    fetchImpl: async () => {
      sends += 1;
      return {
        ok: true,
        async text() {
          return JSON.stringify({ id: "email_user_cost" });
        },
      };
    },
  });

  assert.equal(result.status, "sent");
  assert.equal(sends, 1);
  assert.equal(prisma.alerts[0].alertType, ADMIN_ALERT_TYPES.userCostThreshold);
  assert.equal(prisma.alerts[0].thresholdUsd, "1.20000000");
  assert.equal(prisma.alerts[0].actualUsd, "1.30000000");
});

test("evaluateDailySystemCostThreshold sends when today's system spend crosses threshold", async () => {
  const prisma = createAlertPrisma();
  Object.assign(prisma, {
    modelUsageEvent: {
      async aggregate() {
        return { _sum: { estimatedCostUsd: "12.00" } };
      },
    },
  });

  const result = await evaluateDailySystemCostThreshold(prisma, {
    env: { ...configuredEnv, ALERT_DAILY_COST_THRESHOLD_USD: "10" },
    fetchImpl: async () => ({
      ok: true,
      async text() {
        return JSON.stringify({ id: "email_daily" });
      },
    }),
  });

  assert.equal(result.status, "sent");
  assert.equal(prisma.alerts[0].alertType, ADMIN_ALERT_TYPES.dailySystemCostThreshold);
  assert.equal(prisma.alerts[0].thresholdUsd, "10.00000000");
  assert.equal(prisma.alerts[0].actualUsd, "12.00000000");
});

test("evaluateSystemCostSpike compares current hour to prior hourly baseline", async () => {
  const prisma = createAlertPrisma();
  const costs = ["9.00", "24.00"];
  Object.assign(prisma, {
    modelUsageEvent: {
      async aggregate() {
        return { _sum: { estimatedCostUsd: costs.shift() } };
      },
    },
  });

  const result = await evaluateSystemCostSpike(prisma, {
    env: { ...configuredEnv, ALERT_SPIKE_MULTIPLIER: "3" },
    now: new Date("2026-04-28T10:30:00.000Z"),
    fetchImpl: async () => ({
      ok: true,
      async text() {
        return JSON.stringify({ id: "email_spike" });
      },
    }),
  });

  assert.equal(result.status, "sent");
  assert.equal(prisma.alerts[0].alertType, ADMIN_ALERT_TYPES.systemCostSpike);
  assert.equal(prisma.alerts[0].thresholdUsd, "3.00000000");
  assert.equal(prisma.alerts[0].actualUsd, "9.00000000");
});

test("evaluateFailedJobSpike sends when failed jobs reach the configured window threshold", async () => {
  const prisma = createAlertPrisma();
  Object.assign(prisma, {
    job: {
      async count() {
        return 4;
      },
    },
  });

  const result = await evaluateFailedJobSpike(prisma, {
    env: { ...configuredEnv, ALERT_FAILED_JOB_THRESHOLD: "3" },
    now: new Date("2026-04-28T10:30:00.000Z"),
    fetchImpl: async () => ({
      ok: true,
      async text() {
        return JSON.stringify({ id: "email_failed_jobs" });
      },
    }),
  });

  assert.equal(result.status, "sent");
  assert.equal(prisma.alerts[0].alertType, ADMIN_ALERT_TYPES.failedJobSpike);
  assert.equal(prisma.alerts[0].thresholdCount, 3);
  assert.equal(prisma.alerts[0].actualCount, 4);
});

test("alertJobFailure records disabled delivery without throwing", async () => {
  const prisma = createAlertPrisma();
  const result = await alertJobFailure(prisma, {
    id: "job_failed",
    userId: "user_1",
    documentId: "doc_1",
    jobType: "generate_summary",
    retryCount: 2,
    maxRetries: 3,
  }, new Error("provider unavailable"), {
    env: {
      ...configuredEnv,
      ALERTS_ENABLED: "false",
    },
    fetchImpl: async () => {
      throw new Error("fetch should not be called");
    },
  });

  assert.equal(result.status, "disabled");
  assert.equal(prisma.alerts.length, 1);
  assert.equal(prisma.alerts[0].alertType, ADMIN_ALERT_TYPES.jobFailure);
  assert.equal(prisma.alerts[0].emailStatus, "disabled");
  assert.equal(prisma.alerts[0].jobId, "job_failed");
});

test("recordAdminAlert stores configuration failures instead of throwing", async () => {
  const prisma = createAlertPrisma();
  const result = await recordAdminAlert(prisma, {
    alertType: ADMIN_ALERT_TYPES.systemCostSpike,
    severity: "warning",
    targetType: "system",
    targetId: "hourly-cost-spike",
    thresholdUsd: 2,
    actualUsd: 9,
  }, {
    env: { ALERTS_ENABLED: "true" },
  });

  assert.equal(result.status, "configuration_missing");
  assert.equal(prisma.alerts.length, 1);
  assert.equal(prisma.alerts[0].emailStatus, "configuration_missing");
  assert.match(prisma.alerts[0].errorMessage, /RESEND_API_KEY/);
});
