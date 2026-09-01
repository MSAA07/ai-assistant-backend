import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCanStartGeneration,
  assertCanUploadDocument,
  getUserAllowance,
} from "./limits.js";

function createMockPrisma({
  user = {},
  userLimit = null,
  documents = 0,
  spendUsd = 0,
  tokens = {},
  capConfig = null,
} = {}) {
  const resolvedUser = {
    id: "user_1",
    role: null,
    plan: "free",
    ...user,
    userLimit,
  };

  return {
    user: {
      async findUnique() {
        return resolvedUser;
      },
    },
    document: {
      async count() {
        return documents;
      },
    },
    usageCapConfig: {
      async findUnique(args) {
        if (!capConfig) return null;
        return {
          id: `cap_${args.where.plan}`,
          plan: args.where.plan,
          documentCap: capConfig.documentCap ?? 5,
          costCapUsd: capConfig.costCapUsd === undefined ? 1.5 : capConfig.costCapUsd,
          tokenCap: capConfig.tokenCap ?? null,
          featureCaps: capConfig.featureCaps ?? {},
          createdAt: new Date("2026-04-27T00:00:00.000Z"),
          updatedAt: new Date("2026-04-27T00:00:00.000Z"),
        };
      },
    },
    modelUsageEvent: {
      async aggregate() {
        return {
          _sum: {
            estimatedCostUsd: spendUsd,
            inputTokens: tokens.inputTokens ?? 0,
            outputTokens: tokens.outputTokens ?? 0,
            totalTokens: tokens.totalTokens ?? 0,
          },
        };
      },
    },
  };
}

test("free users default to 5 documents and $1.50 USD with dynamic remaining allowance", async () => {
  const allowance = await getUserAllowance(createMockPrisma({
    documents: 2,
    spendUsd: 0.75,
    tokens: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
  }), "user_1");

  assert.equal(allowance.caps.documentCap, 5);
  assert.equal(allowance.caps.costCapUsd, 1.5);
  assert.equal(allowance.consumed.documents, 2);
  assert.equal(allowance.consumed.costUsd, 0.75);
  assert.equal(allowance.remaining.documents, 3);
  assert.equal(allowance.remaining.costUsd, 0.75);
  assert.equal(allowance.overLimit.documents, false);
  assert.equal(allowance.overLimit.costUsd, false);
});

test("global cap increases automatically increase remaining allowance", async () => {
  const allowance = await getUserAllowance(createMockPrisma({
    documents: 4,
    spendUsd: 1,
    capConfig: {
      documentCap: 8,
      costCapUsd: 2.5,
    },
  }), "user_1");

  assert.equal(allowance.caps.documentCap, 8);
  assert.equal(allowance.caps.costCapUsd, 2.5);
  assert.equal(allowance.remaining.documents, 4);
  assert.equal(allowance.remaining.costUsd, 1.5);
});

test("per-user overrides supersede global document and cost caps", async () => {
  const allowance = await getUserAllowance(createMockPrisma({
    documents: 4,
    spendUsd: 1,
    userLimit: {
      documentCapOverride: 6,
      costCapUsdOverride: "3.0000",
      tokenCapOverride: null,
      featureCapsOverride: {},
      overrideBy: "admin_1",
    },
  }), "user_1");

  assert.equal(allowance.caps.documentCap, 6);
  assert.equal(allowance.caps.costCapUsd, 3);
  assert.equal(allowance.remaining.documents, 2);
  assert.equal(allowance.remaining.costUsd, 2);
  assert.equal(allowance.source.documentCap, "user_override");
  assert.equal(allowance.source.costCapUsd, "user_override");
});

test("document upload is blocked when current active documents reach the cap", async () => {
  await assert.rejects(() => assertCanUploadDocument(createMockPrisma({
    documents: 5,
    spendUsd: 0,
  }), "user_1"), (error) => {
    assert.equal(error.code, "document_cap_hit");
    assert.equal(error.allowance.remaining.documents, 0);
    return true;
  });
});

test("generation is blocked only when consumed USD reaches the active cap", async () => {
  await assert.doesNotReject(() => assertCanStartGeneration(createMockPrisma({
    documents: 1,
    spendUsd: 1.49,
  }), "user_1"));

  await assert.rejects(() => assertCanStartGeneration(createMockPrisma({
    documents: 1,
    spendUsd: 1.5,
  }), "user_1"), (error) => {
    assert.equal(error.code, "cost_cap_hit");
    assert.equal(error.allowance.remaining.costUsd, 0);
    return true;
  });
});

test("admin users are unlimited but still report consumed usage", async () => {
  const allowance = await getUserAllowance(createMockPrisma({
    user: { role: "admin" },
    documents: 99,
    spendUsd: 42,
  }), "user_1");

  assert.equal(allowance.caps.documentCap, null);
  assert.equal(allowance.caps.costCapUsd, null);
  assert.equal(allowance.remaining.documents, null);
  assert.equal(allowance.remaining.costUsd, null);
  assert.equal(allowance.consumed.costUsd, 42);
  assert.equal(allowance.overLimit.documents, false);
  assert.equal(allowance.overLimit.costUsd, false);
});
