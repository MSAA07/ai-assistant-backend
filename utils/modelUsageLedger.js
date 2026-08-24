import crypto from "crypto";

import {
  estimateCostUsdString,
  MODEL_PRICING_VERSION,
  resolvePricingModelKey,
} from "./modelPricing.js";
import {
  evaluateSystemUsageAlerts,
  evaluateUsageAlertsForUser,
} from "./adminAlerts.js";

export const MODEL_USAGE_PROVIDER = "openai";
export const MODEL_USAGE_EVENT_TYPE = "model_call";
export const MODEL_USAGE_STATUS = Object.freeze({
  succeeded: "succeeded",
  failed: "failed",
});

function normalizeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : fallback;
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeTokenUsage(usage = {}) {
  const inputTokens = normalizeInteger(usage?.prompt_tokens ?? usage?.input_tokens);
  const outputTokens = normalizeInteger(usage?.completion_tokens ?? usage?.output_tokens);
  const providedTotal = normalizeInteger(usage?.total_tokens);
  const totalTokens = providedTotal > 0 ? providedTotal : inputTokens + outputTokens;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

function getHeaderValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") {
    return headers.get(name) || headers.get(name.toLowerCase()) || null;
  }

  return headers[name] || headers[name.toLowerCase()] || null;
}

function getRequestId(source) {
  return normalizeString(
    source?._request_id
    ?? source?.request_id
    ?? source?.requestId
    ?? source?.headers?.["x-request-id"]
    ?? getHeaderValue(source?.headers, "x-request-id")
    ?? getHeaderValue(source?.response?.headers, "x-request-id"),
  ) || null;
}

function extractUsageFromError(error) {
  return error?.usage
    ?? error?.response?.usage
    ?? error?.error?.usage
    ?? error?.body?.usage
    ?? error?.response?.data?.usage
    ?? null;
}

function getErrorCode(error) {
  return normalizeString(
    error?.code
    ?? error?.error?.code
    ?? error?.type
    ?? error?.status
    ?? error?.response?.status,
  ) || null;
}

function stableHash(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

export function buildModelUsageIdempotencyKey(context = {}) {
  const keyParts = {
    provider: context.provider ?? MODEL_USAGE_PROVIDER,
    userId: context.userId,
    documentId: context.documentId ?? null,
    generationId: context.generationId ?? null,
    jobId: context.jobId ?? null,
    featureKey: context.featureKey,
    eventType: context.eventType ?? MODEL_USAGE_EVENT_TYPE,
    aiPhase: context.aiPhase ?? null,
    callKey: context.callKey ?? context.aiPhase ?? null,
    attemptNumber: normalizeInteger(context.attemptNumber, 1),
    jobRetryCount: normalizeInteger(context.jobRetryCount, 0),
  };

  return `model-call:${stableHash(keyParts)}`;
}

function buildLedgerMetadata(context = {}, extra = {}) {
  return {
    ...(context.metadata && typeof context.metadata === "object" ? context.metadata : {}),
    ...(context.aiPhase ? { aiPhase: context.aiPhase } : {}),
    ...(context.callKey ? { callKey: context.callKey } : {}),
    ...(extra && typeof extra === "object" ? extra : {}),
  };
}

export async function recordModelUsageEvent(prisma, {
  userId,
  documentId = null,
  generationId = null,
  jobId = null,
  featureKey,
  eventType = MODEL_USAGE_EVENT_TYPE,
  provider = MODEL_USAGE_PROVIDER,
  model,
  usage = {},
  status = MODEL_USAGE_STATUS.succeeded,
  billable,
  requestId = null,
  idempotencyKey,
  attemptNumber = 1,
  jobRetryCount = 0,
  errorCode = null,
  metadata = {},
  pricingVersion = MODEL_PRICING_VERSION,
} = {}) {
  if (!prisma?.modelUsageEvent) {
    throw new Error("Prisma client does not expose modelUsageEvent");
  }

  if (!userId || !featureKey) {
    throw new Error("userId and featureKey are required to record model usage");
  }

  const modelName = normalizeString(model) || resolvePricingModelKey(model);
  const { inputTokens, outputTokens, totalTokens } = normalizeTokenUsage(usage);
  const safeAttemptNumber = normalizeInteger(attemptNumber, 1);
  const safeJobRetryCount = normalizeInteger(jobRetryCount, 0);
  const shouldBill = billable ?? totalTokens > 0;
  const key = idempotencyKey ?? buildModelUsageIdempotencyKey({
    provider,
    userId,
    documentId,
    generationId,
    jobId,
    featureKey,
    eventType,
    aiPhase: metadata?.aiPhase,
    callKey: metadata?.callKey,
    attemptNumber: safeAttemptNumber,
    jobRetryCount: safeJobRetryCount,
  });

  return prisma.modelUsageEvent.upsert({
    where: { idempotencyKey: key },
    update: {},
    create: {
      userId,
      documentId,
      generationId,
      jobId,
      featureKey,
      eventType,
      provider,
      model: modelName,
      inputTokens,
      outputTokens,
      totalTokens,
      estimatedCostUsd: shouldBill
        ? estimateCostUsdString(modelName, inputTokens, outputTokens)
        : "0.00000000",
      currency: "USD",
      pricingVersion,
      status,
      billable: shouldBill,
      requestId,
      idempotencyKey: key,
      attemptNumber: safeAttemptNumber,
      jobRetryCount: safeJobRetryCount,
      errorCode,
      metadata,
    },
  });
}

export async function safelyRecordModelUsageEvent(prisma, payload) {
  try {
    const record = await recordModelUsageEvent(prisma, payload);

    if (record?.billable && record?.userId) {
      void Promise.all([
        evaluateUsageAlertsForUser(prisma, record.userId, {
          metadata: {
            sourceModelUsageEventId: record.id,
            documentId: record.documentId,
            generationId: record.generationId,
            jobId: record.jobId,
          },
        }),
        evaluateSystemUsageAlerts(prisma, {
          metadata: {
            sourceModelUsageEventId: record.id,
          },
        }),
      ]).catch((error) => {
        console.error("[modelUsageLedger] usage alert checks failed:", error);
      });
    }

    return record;
  } catch (error) {
    console.error("[modelUsageLedger] failed to persist model usage:", error);
    return null;
  }
}

export async function createTrackedChatCompletion({
  prisma,
  openai,
  params,
  requestOptions,
  context = {},
}) {
  const startedAt = Date.now();

  try {
    const response = await openai.chat.completions.create(params, requestOptions);
    const usage = response?.usage ?? {};
    const { totalTokens } = normalizeTokenUsage(usage);

    await safelyRecordModelUsageEvent(prisma, {
      ...context,
      provider: context.provider ?? MODEL_USAGE_PROVIDER,
      model: response?.model || params?.model,
      usage,
      status: MODEL_USAGE_STATUS.succeeded,
      billable: totalTokens > 0,
      requestId: getRequestId(response),
      idempotencyKey: context.idempotencyKey ?? buildModelUsageIdempotencyKey(context),
      metadata: buildLedgerMetadata(context, {
        requestedModel: params?.model,
        durationMs: Date.now() - startedAt,
        usageMissing: totalTokens === 0,
      }),
    });

    return response;
  } catch (error) {
    const usage = extractUsageFromError(error) ?? {};
    const { totalTokens } = normalizeTokenUsage(usage);

    await safelyRecordModelUsageEvent(prisma, {
      ...context,
      provider: context.provider ?? MODEL_USAGE_PROVIDER,
      model: error?.model || params?.model,
      usage,
      status: MODEL_USAGE_STATUS.failed,
      billable: totalTokens > 0,
      requestId: getRequestId(error),
      idempotencyKey: context.idempotencyKey ?? buildModelUsageIdempotencyKey(context),
      errorCode: getErrorCode(error),
      metadata: buildLedgerMetadata(context, {
        requestedModel: params?.model,
        durationMs: Date.now() - startedAt,
        usageMissing: totalTokens === 0,
      }),
    });

    throw error;
  }
}
