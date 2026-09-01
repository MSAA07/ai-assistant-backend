import assert from "node:assert/strict";
import test from "node:test";

import {
  buildModelUsageIdempotencyKey,
  createTrackedChatCompletion,
  MODEL_USAGE_STATUS,
  normalizeTokenUsage,
  recordModelUsageEvent,
  safelyRecordModelUsageEvent,
} from "./modelUsageLedger.js";
import { convertUsdToSar, getUsdToSarRate } from "./modelPricing.js";
import { runWithAbortableTimeout } from "./jobTimeout.js";

function createMockPrisma() {
  const recordsByKey = new Map();
  const upserts = [];

  return {
    upserts,
    modelUsageEvent: {
      async upsert(args) {
        upserts.push(args);
        const existing = recordsByKey.get(args.where.idempotencyKey);
        if (existing) {
          return existing;
        }

        const record = {
          id: `ledger_${recordsByKey.size + 1}`,
          ...args.create,
        };
        recordsByKey.set(args.where.idempotencyKey, record);
        return record;
      },
    },
  };
}

const baseContext = Object.freeze({
  userId: "user_1",
  documentId: "doc_1",
  generationId: "generation_1",
  jobId: "job_1",
  featureKey: "flashcards",
  eventType: "flashcards_generated",
  attemptNumber: 1,
  jobRetryCount: 0,
});

test("normalizeTokenUsage supports OpenAI chat and responses token fields", () => {
  assert.deepEqual(normalizeTokenUsage({
    prompt_tokens: 12,
    completion_tokens: 8,
    total_tokens: 20,
  }), {
    inputTokens: 12,
    outputTokens: 8,
    totalTokens: 20,
  });

  assert.deepEqual(normalizeTokenUsage({
    input_tokens: 7,
    output_tokens: 3,
  }), {
    inputTokens: 7,
    outputTokens: 3,
    totalTokens: 10,
  });
});

test("recordModelUsageEvent stores exact per-call totals and USD cost", async () => {
  const prisma = createMockPrisma();

  const record = await recordModelUsageEvent(prisma, {
    ...baseContext,
    provider: "openai",
    model: "gpt-4o",
    usage: {
      prompt_tokens: 1_000,
      completion_tokens: 2_000,
      total_tokens: 3_000,
    },
    status: MODEL_USAGE_STATUS.succeeded,
    idempotencyKey: "fixed-success-key",
    metadata: { aiPhase: "flashcards_initial_generation", callKey: "flashcards:initial" },
  });

  assert.equal(record.inputTokens, 1_000);
  assert.equal(record.outputTokens, 2_000);
  assert.equal(record.totalTokens, 3_000);
  assert.equal(record.estimatedCostUsd, "0.02250000");
  assert.equal(record.currency, "USD");
  assert.equal(record.billable, true);
  assert.equal(record.status, MODEL_USAGE_STATUS.succeeded);
});

test("recordModelUsageEvent is idempotent for the same call attempt", async () => {
  const prisma = createMockPrisma();

  const payload = {
    ...baseContext,
    provider: "openai",
    model: "gpt-4o-mini",
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    idempotencyKey: "same-call-attempt",
    metadata: { aiPhase: "summary", callKey: "summary:clean" },
  };

  const first = await recordModelUsageEvent(prisma, payload);
  const second = await recordModelUsageEvent(prisma, payload);

  assert.equal(first.id, second.id);
  assert.equal(prisma.upserts.length, 2);
});

test("safelyRecordModelUsageEvent rethrows missing pricing instead of swallowing it", async () => {
  const prisma = createMockPrisma();

  await assert.rejects(
    () => safelyRecordModelUsageEvent(prisma, {
      ...baseContext,
      model: "gpt-future-unpriced",
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      idempotencyKey: "missing-pricing",
    }),
    (error) => error?.code === "model_pricing_missing",
  );
  assert.equal(prisma.upserts.length, 0);
});

test("createTrackedChatCompletion creates separate rows for generation and QA calls", async () => {
  const prisma = createMockPrisma();
  const openai = {
    chat: {
      completions: {
        async create() {
          return {
            model: "gpt-4o",
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
            choices: [{ message: { content: "[]" } }],
            _request_id: "req_success",
          };
        },
      },
    },
  };

  await createTrackedChatCompletion({
    prisma,
    openai,
    params: { model: "gpt-4o", messages: [] },
    context: {
      ...baseContext,
      aiPhase: "flashcards_initial_generation",
      callKey: "flashcards:initial",
    },
  });

  await createTrackedChatCompletion({
    prisma,
    openai,
    params: { model: "gpt-4o", messages: [] },
    context: {
      ...baseContext,
      aiPhase: "flashcards_qa",
      callKey: "flashcards:qa",
    },
  });

  const [initial, qa] = prisma.upserts.map((entry) => entry.create);
  assert.notEqual(initial.idempotencyKey, qa.idempotencyKey);
  assert.equal(initial.metadata.aiPhase, "flashcards_initial_generation");
  assert.equal(qa.metadata.aiPhase, "flashcards_qa");
  assert.equal(initial.status, MODEL_USAGE_STATUS.succeeded);
  assert.equal(qa.status, MODEL_USAGE_STATUS.succeeded);
});

test("createTrackedChatCompletion records failed calls when usage metadata is available", async () => {
  const prisma = createMockPrisma();
  const providerError = new Error("provider failed after billing");
  providerError.code = "provider_error";
  providerError.usage = { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 };

  const openai = {
    chat: {
      completions: {
        async create() {
          throw providerError;
        },
      },
    },
  };

  await assert.rejects(() => createTrackedChatCompletion({
    prisma,
    openai,
    params: { model: "gpt-4o-mini", messages: [] },
    context: {
      ...baseContext,
      aiPhase: "flashcards_initial_generation",
      callKey: "flashcards:initial",
    },
  }), /provider failed/);

  const failed = prisma.upserts[0].create;
  assert.equal(failed.status, MODEL_USAGE_STATUS.failed);
  assert.equal(failed.errorCode, "provider_error");
  assert.equal(failed.inputTokens, 80);
  assert.equal(failed.outputTokens, 20);
  assert.equal(failed.billable, true);
});

test("createTrackedChatCompletion forwards the worker abort signal to the OpenAI SDK request", async () => {
  const prisma = createMockPrisma();
  const controller = new AbortController();
  let receivedRequestOptions;
  const openai = {
    chat: {
      completions: {
        async create(_params, requestOptions) {
          receivedRequestOptions = requestOptions;
          return {
            model: "gpt-4.1-mini",
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            choices: [{ message: { content: "[]" } }],
          };
        },
      },
    },
  };

  await createTrackedChatCompletion({
    prisma,
    openai,
    params: { model: "gpt-4.1-mini", messages: [] },
    requestOptions: { signal: controller.signal },
    context: {
      ...baseContext,
      aiPhase: "flashcards_initial_generation",
      callKey: "flashcards:initial",
    },
  });

  assert.equal(receivedRequestOptions?.signal, controller.signal);
});

test("a worker timeout aborts a slow tracked OpenAI call instead of orphaning it", async () => {
  const prisma = createMockPrisma();
  let abortObserved = false;
  let providerCompleted = false;
  const openai = {
    chat: {
      completions: {
        async create(_params, requestOptions) {
          return new Promise((resolve, reject) => {
            const providerTimer = setTimeout(() => {
              providerCompleted = true;
              resolve({
                model: "gpt-4.1-mini",
                usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
                choices: [{ message: { content: "late response" } }],
              });
            }, 200);

            requestOptions.signal.addEventListener("abort", () => {
              abortObserved = true;
              clearTimeout(providerTimer);
              const abortError = new Error("OpenAI request aborted");
              abortError.name = "AbortError";
              abortError.code = "request_aborted";
              reject(abortError);
            }, { once: true });
          });
        },
      },
    },
  };

  await assert.rejects(
    () => runWithAbortableTimeout((signal) => createTrackedChatCompletion({
      prisma,
      openai,
      params: { model: "gpt-4.1-mini", messages: [] },
      requestOptions: { signal },
      context: {
        ...baseContext,
        aiPhase: "exam_initial_generation",
        callKey: "exam:initial",
      },
    }), 10),
    (error) => error?.code === "job_timeout",
  );

  assert.equal(abortObserved, true);
  assert.equal(providerCompleted, false);
  assert.equal(prisma.upserts.length, 1);
  assert.equal(prisma.upserts[0].create.status, MODEL_USAGE_STATUS.failed);
  assert.equal(prisma.upserts[0].create.billable, false);
});

test("idempotency key changes across job retry attempts", () => {
  const firstAttemptKey = buildModelUsageIdempotencyKey({
    ...baseContext,
    aiPhase: "exam_initial_generation",
    callKey: "exam:initial",
    attemptNumber: 1,
    jobRetryCount: 0,
  });
  const retryAttemptKey = buildModelUsageIdempotencyKey({
    ...baseContext,
    aiPhase: "exam_initial_generation",
    callKey: "exam:initial",
    attemptNumber: 2,
    jobRetryCount: 1,
  });

  assert.notEqual(firstAttemptKey, retryAttemptKey);
});

test("each grounded count-repair request has its own billable idempotency key", () => {
  for (const feature of ["flashcards", "exam"]) {
    const firstRepairKey = buildModelUsageIdempotencyKey({
      ...baseContext,
      featureKey: feature,
      aiPhase: `${feature}_qa_count_repair`,
      callKey: `${feature}:qa-count-repair:1`,
      attemptNumber: 1,
    });
    const secondRepairKey = buildModelUsageIdempotencyKey({
      ...baseContext,
      featureKey: feature,
      aiPhase: `${feature}_qa_count_repair`,
      callKey: `${feature}:qa-count-repair:2`,
      attemptNumber: 1,
    });

    assert.notEqual(firstRepairKey, secondRepairKey);
  }
});

test("SAR conversion defaults to the configured display rate without affecting ledger USD", () => {
  assert.equal(getUsdToSarRate({}), 3.75);
  assert.equal(getUsdToSarRate({ USD_TO_SAR_RATE: "3.76" }), 3.76);
  assert.equal(convertUsdToSar(2, { USD_TO_SAR_RATE: "3.76" }), 7.52);
});
