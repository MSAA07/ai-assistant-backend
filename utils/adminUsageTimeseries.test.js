import assert from "node:assert/strict";
import test from "node:test";

import { buildUsageTimeSeries } from "../routes/admin.js";

function createTimeseriesPrisma(events) {
  return {
    calls: [],
    modelUsageEvent: {
      async findMany(args) {
        this.calls.push(args);
        const startIndex = args.cursor
          ? events.findIndex((event) => event.id === args.cursor.id) + 1
          : 0;
        return events.slice(startIndex, startIndex + args.take);
      },
      calls: [],
    },
  };
}

test("buildUsageTimeSeries paginates all ledger rows instead of truncating large ranges", async () => {
  const events = Array.from({ length: 2505 }, (_, index) => ({
    id: `usage_${String(index).padStart(4, "0")}`,
    createdAt: new Date("2026-04-27T12:00:00.000Z"),
    inputTokens: 2,
    outputTokens: 3,
    totalTokens: 5,
    estimatedCostUsd: "0.00010000",
  }));
  const prisma = createTimeseriesPrisma(events);

  const series = await buildUsageTimeSeries(prisma, {}, "day", 3.75);

  assert.equal(series.length, 1);
  assert.equal(series[0].events, 2505);
  assert.equal(series[0].inputTokens, 5010);
  assert.equal(series[0].outputTokens, 7515);
  assert.equal(series[0].totalTokens, 12525);
  assert.equal(Number(series[0].costUsd.toFixed(4)), 0.2505);
  assert.equal(prisma.modelUsageEvent.calls.length, 3);
});

test("buildUsageTimeSeries starts weekly buckets on Monday UTC", async () => {
  const prisma = createTimeseriesPrisma([
    {
      id: "usage_1",
      createdAt: new Date("2026-04-26T18:00:00.000Z"),
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      estimatedCostUsd: "0.01000000",
    },
  ]);

  const series = await buildUsageTimeSeries(prisma, {}, "week", 3.75);

  assert.equal(series[0].bucketStart, "2026-04-20T00:00:00.000Z");
  assert.equal(series[0].costSar, 0.0375);
});
