import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDailyAdminDigestDetails,
  collectDailyAdminDigest,
  getDailyAdminDigestSeverity,
} from "./adminDigest.js";

function createDigestPrisma() {
  const calls = [];
  return {
    calls,
    user: {
      async count(args) {
        calls.push(["user.count", args]);
        return 2;
      },
    },
    document: {
      async count(args) {
        calls.push(["document.count", args]);
        return 5;
      },
    },
    job: {
      async count(args) {
        calls.push(["job.count", args]);
        if (args.where.status === "failed") return 1;
        if (args.where.status === "running") return 3;
        return 4;
      },
    },
    usageEvent: {
      async aggregate(args) {
        calls.push(["usageEvent.aggregate", args]);
        return {
          _sum: {
            estimatedCostUsd: "1.2345",
            inputTokens: 100,
            outputTokens: 50,
          },
        };
      },
    },
    costAnomalyAlert: {
      async count(args) {
        calls.push(["costAnomalyAlert.count", args]);
        return 1;
      },
    },
  };
}

test("collectDailyAdminDigest returns safe operational counts", async () => {
  const prisma = createDigestPrisma();
  const now = new Date("2026-04-30T12:00:00.000Z");
  const summary = await collectDailyAdminDigest(prisma, { now });

  assert.equal(summary.since, "2026-04-29T12:00:00.000Z");
  assert.equal(summary.until, "2026-04-30T12:00:00.000Z");
  assert.equal(summary.newUsers, 2);
  assert.equal(summary.documentsCreated, 5);
  assert.equal(summary.generationJobsCreated, 4);
  assert.equal(summary.failedJobs, 1);
  assert.equal(summary.staleRunningJobs, 3);
  assert.equal(summary.estimatedUsageCostUsd, 1.2345);
  assert.equal(summary.usageTokens, 150);
  assert.equal(summary.unresolvedCostAnomalies, 1);
  assert.ok(prisma.calls.some(([name]) => name === "usageEvent.aggregate"));
});

test("buildDailyAdminDigestDetails stays compact and severity warns on failures", () => {
  const summary = {
    newUsers: 2,
    documentsCreated: 5,
    generationJobsCreated: 4,
    failedJobs: 1,
    staleRunningJobs: 3,
    estimatedUsageCostUsd: 1.2345,
    usageTokens: 150,
    unresolvedCostAnomalies: 1,
  };

  const details = buildDailyAdminDigestDetails(summary);

  assert.match(details, /New users: 2/);
  assert.match(details, /Documents: 5/);
  assert.match(details, /Generation jobs: 4/);
  assert.match(details, /Failed jobs: 1/);
  assert.match(details, /Stale\/overdue jobs: 3/);
  assert.match(details, /Usage cost: \$1\.2345/);
  assert.match(details, /Tokens: 150/);
  assert.match(details, /Unresolved anomalies: 1/);
  assert.equal(getDailyAdminDigestSeverity(summary), "warning");
});

test("getDailyAdminDigestSeverity is info without failures or anomalies", () => {
  assert.equal(getDailyAdminDigestSeverity({
    failedJobs: 0,
    unresolvedCostAnomalies: 0,
  }), "info");
});
