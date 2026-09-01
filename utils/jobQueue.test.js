import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateRetryBackoffMs,
  claimNextQueuedJob,
  failJob,
  requeueJob,
  RETRY_BACKOFF_MAX_MS,
} from "./jobQueue.js";

function createClaimMockPrisma(jobs) {
  const state = {
    jobs: jobs.map((job) => ({ ...job })),
    claimedIds: [],
  };

  const tx = {
    async $queryRaw(_strings, eligibleAt) {
      const candidate = state.jobs
        .filter((job) => job.status === "queued" && job.queuedAt <= eligibleAt)
        .sort((left, right) => left.queuedAt - right.queuedAt)[0];
      return candidate ? [{ id: candidate.id }] : [];
    },
    job: {
      async update({ where, data }) {
        const job = state.jobs.find((entry) => entry.id === where.id);
        Object.assign(job, data);
        state.claimedIds.push(where.id);
        return { ...job };
      },
    },
  };

  return {
    state,
    async $transaction(fn) {
      return fn(tx);
    },
  };
}

function createRequeueMockPrisma() {
  const updates = [];
  return {
    updates,
    async $transaction(fn) {
      return fn({
        job: {
          async update(args) {
            updates.push(args);
            return args;
          },
        },
      });
    },
  };
}

test("retry backoff increases and caps", () => {
  const noJitter = () => 0;
  assert.equal(calculateRetryBackoffMs(1, { random: noJitter }), 5_000);
  assert.equal(calculateRetryBackoffMs(2, { random: noJitter }), 10_000);
  assert.equal(calculateRetryBackoffMs(3, { random: noJitter }), 20_000);
  assert.equal(calculateRetryBackoffMs(20, { random: noJitter }), RETRY_BACKOFF_MAX_MS);
});

test("retry backoff applies bounded jitter", () => {
  const low = calculateRetryBackoffMs(2, { random: () => 0 });
  const high = calculateRetryBackoffMs(2, { random: () => 1 });

  assert.equal(low, 10_000);
  assert.equal(high, 12_500);
});

test("requeueJob schedules retry in the future using queuedAt", async () => {
  const prisma = createRequeueMockPrisma();
  const before = Date.now();
  const decision = await requeueJob(prisma, {
    id: "job_1",
    userId: "user_1",
    jobType: "noop",
    status: "running",
    retryCount: 0,
    maxRetries: 3,
  }, new Error("provider unavailable"), true);

  const update = prisma.updates[0];
  assert.equal(update.data.status, "queued");
  assert.equal(update.data.retryCount, 1);
  assert.ok(update.data.queuedAt instanceof Date);
  assert.ok(update.data.queuedAt.getTime() - before >= 5_000);
  assert.ok(decision.retryDelayMs >= 5_000);
});

test("failJob preserves grounding rejection diagnostics on a permanently failed job", async () => {
  const prisma = createRequeueMockPrisma();
  const error = new Error("flashcards QA returned 39 source-verified items; expected 48");
  error.groundingDiagnostics = {
    targetCount: 48,
    acceptedCount: 39,
    rejectionReasons: { source_quote_does_not_support_item: 9 },
  };

  await failJob(prisma, {
    id: "flashcards-job-1",
    userId: "user_1",
    jobType: "noop",
    status: "running",
    retryCount: 0,
    maxRetries: 1,
  }, error);

  assert.equal(prisma.updates[0].data.status, "failed");
  assert.deepEqual(prisma.updates[0].data.result, {
    failureDiagnostics: error.groundingDiagnostics,
  });
});

test("claimNextQueuedJob does not claim delayed retry jobs early", async () => {
  const future = new Date(Date.now() + 60_000);
  const prisma = createClaimMockPrisma([
    {
      id: "job_delayed",
      jobType: "noop",
      status: "queued",
      retryCount: 1,
      queuedAt: future,
    },
  ]);

  const claimed = await claimNextQueuedJob(prisma, "worker_1");

  assert.equal(claimed, null);
  assert.deepEqual(prisma.state.claimedIds, []);
});

test("claimNextQueuedJob claims eligible queued jobs", async () => {
  const past = new Date(Date.now() - 1_000);
  const prisma = createClaimMockPrisma([
    {
      id: "job_ready",
      jobType: "noop",
      status: "queued",
      retryCount: 0,
      queuedAt: past,
    },
  ]);

  const claimed = await claimNextQueuedJob(prisma, "worker_1");

  assert.equal(claimed.id, "job_ready");
  assert.equal(claimed.status, "running");
  assert.deepEqual(prisma.state.claimedIds, ["job_ready"]);
});
