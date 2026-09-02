import assert from "node:assert/strict";
import test from "node:test";

import { getIssuesFeed, setIncidentStatuses } from "./issuesFeed.js";

const date = new Date("2026-09-02T10:00:00.000Z");

function createFeedPrisma({ failJobs = false, takes = [] } = {}) {
  const job = {
    id: "job_1",
    userId: "user_1",
    documentId: "doc_1",
    jobType: "generate_summary",
    retryCount: 3,
    maxRetries: 3,
    errorMessage: "Provider timeout",
    queuedAt: date,
    startedAt: date,
    completedAt: date,
  };
  const standaloneAlert = {
    id: "alert_cost",
    alertType: "daily_system_cost_threshold",
    severity: "warning",
    jobId: null,
    resolved: false,
    metadata: {},
    createdAt: date,
  };
  return {
    incidentState: { async findMany() { return []; } },
    job: {
      async findMany(args) { if (failJobs) throw new Error("job database unavailable"); takes.push(args.take); return [job]; },
      async count() { if (failJobs) throw new Error("job database unavailable"); return 1; },
    },
    adminAlert: {
      async findMany(args) {
        assert.deepEqual(args.where.NOT, { alertType: "job_failure", jobId: { not: null } });
        takes.push(args.take);
        return [standaloneAlert];
      },
      async count() { return 1; },
    },
    costAnomalyAlert: {
      async findMany(args) { takes.push(args.take); return []; },
      async count() { return 0; },
    },
  };
}

test("incident feed deduplicates the AdminAlert linked to a failed Job", async () => {
  const feed = await getIssuesFeed({
    prismaClient: createFeedPrisma(),
    sentryClient: { async getIssues() { return { items: [], status: "fresh", fetchedAt: date }; } },
  });

  assert.deepEqual(feed.items.map((item) => item.id), ["job:job_1", "alert:alert_cost"]);
  assert.ok(!feed.items.some((item) => item.id === "alert:alert_linked"));
});

test("incident pagination remains query-bounded beyond the first 500 records", async () => {
  const takes = [];
  await getIssuesFeed({
    prismaClient: createFeedPrisma({ takes }),
    sentryClient: { async getIssues() { return { items: [], status: "fresh", fetchedAt: date }; } },
    page: 21,
    limit: 25,
  });

  assert.deepEqual(takes, [525, 525, 525]);
});

test("incident feed isolates a Sentry failure and still returns Job and alert sources", async () => {
  const feed = await getIssuesFeed({
    prismaClient: createFeedPrisma(),
    sentryClient: { async getIssues() { throw new Error("Sentry unavailable"); } },
  });

  assert.equal(feed.sources.sentry.status, "unavailable");
  assert.equal(feed.sources.job.status, "fresh");
  assert.equal(feed.sources.costAlert.status, "fresh");
  assert.equal(feed.items.length, 2);
  assert.equal(feed.partial, true);
});

test("incident feed isolates a Job query failure and keeps the other sources", async () => {
  const feed = await getIssuesFeed({
    prismaClient: createFeedPrisma({ failJobs: true }),
    sentryClient: {
      async getIssues() {
        return {
          items: [{ id: "s1", title: "Sentry issue", message: "boom", severity: "critical", status: "unresolved", createdAt: date, metadata: {} }],
          status: "fresh",
          fetchedAt: date,
        };
      },
    },
  });

  assert.equal(feed.sources.job.status, "unavailable");
  assert.deepEqual(feed.items.map((item) => item.id), ["sentry:s1", "alert:alert_cost"]);
});

test("incident lifecycle supports open to in progress to resolved and reopened", async () => {
  const persisted = [];
  const sourceUpdates = [];
  const prisma = {
    async $transaction(callback) {
      return callback({
        adminAlert: { async update(args) { sourceUpdates.push(args); } },
        costAnomalyAlert: { async update() {} },
        incidentState: {
          async upsert(args) {
            persisted.push(args);
            return { source: args.create.source, sourceId: args.create.sourceId, status: args.update.status };
          },
        },
      });
    },
  };
  const ref = [{ source: "alert", sourceId: "alert_1" }];

  for (const status of ["in_progress", "resolved", "open"]) {
    const states = await setIncidentStatuses(prisma, ref, status, "admin_1", { now: date });
    assert.equal(states[0].status, status);
  }

  assert.deepEqual(sourceUpdates.map((entry) => entry.data.resolved), [false, true, false]);
  assert.equal(persisted[0].update.acknowledgedAt, date);
  assert.equal(persisted[1].update.resolvedAt, date);
  assert.equal(persisted[2].update.reopenedAt, date);
});

test("bulk resolve persists every selected incident in one transaction", async () => {
  let upserts = 0;
  const prisma = {
    async $transaction(callback) {
      return callback({
        job: { async findUnique() { return { id: "job_1" }; } },
        adminAlert: { async update() {} },
        costAnomalyAlert: { async update() {} },
        incidentState: { async upsert(args) { upserts += 1; return args.create; } },
      });
    },
  };
  await setIncidentStatuses(prisma, [
    { source: "sentry", sourceId: "s1" },
    { source: "job", sourceId: "job_1" },
    { source: "cost", sourceId: "cost_1" },
  ], "resolved", "admin_1", { now: date });
  assert.equal(upserts, 3);
});
