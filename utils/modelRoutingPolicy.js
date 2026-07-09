import { PrismaClient } from "@prisma/client";

import { DOCUMENT_GENERATION_TYPES } from "./documentGeneration.js";
import { captureSentryException } from "./sentry.js";

export const DEFAULT_GENERATION_MODEL = "gpt-4o-mini";
export const FLASHCARD_GENERATION_MODEL = "gpt-4o";
export const EXAM_GENERATION_MODEL = "gpt-4o";
export const ALLOWED_MODELS = [
  { id: "gpt-4o-mini", label: "GPT-4o mini", supportsReasoningEffort: false },
  { id: "gpt-4o", label: "GPT-4o", supportsReasoningEffort: false },
  { id: "gpt-4.1-nano", label: "GPT-4.1 nano", supportsReasoningEffort: false },
  { id: "gpt-4.1-mini", label: "GPT-4.1 mini", supportsReasoningEffort: false },
  { id: "gpt-4.1", label: "GPT-4.1", supportsReasoningEffort: false },
  { id: "gpt-5.4-nano", label: "GPT-5.4 nano", supportsReasoningEffort: true },
  { id: "gpt-5.4-mini", label: "GPT-5.4 mini", supportsReasoningEffort: true },
  { id: "gpt-5.4", label: "GPT-5.4", supportsReasoningEffort: true },
  { id: "gpt-5.5", label: "GPT-5.5", supportsReasoningEffort: true },
];
export const VALID_FEATURES = ["summary", "flashcards", "exam"];
export const VALID_PLANS = ["free", "premium"];
export const VALID_REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh"];

const prisma = new PrismaClient();
const CACHE_TTL_MS = 5 * 60 * 1000;

let routingCache = null;
let cacheLoadedAt = 0;

function getFallbackModelForGeneration(generationType) {
  if (generationType === DOCUMENT_GENERATION_TYPES.flashcards) {
    return FLASHCARD_GENERATION_MODEL;
  }

  if (generationType === DOCUMENT_GENERATION_TYPES.exam) {
    return EXAM_GENERATION_MODEL;
  }

  return DEFAULT_GENERATION_MODEL;
}

function getFallbackRoutingResult(generationType) {
  return {
    model: getFallbackModelForGeneration(generationType),
    reasoningEffort: null,
  };
}

async function loadRoutingCache() {
  try {
    const rows = await prisma.modelRoutingConfig.findMany({
      select: {
        feature: true,
        plan: true,
        model: true,
        reasoningEffort: true,
      },
    });
    const nextCache = {};
    for (const row of rows) {
      nextCache[`${row.feature}:${row.plan}`] = {
        model: row.model,
        reasoningEffort: row.reasoningEffort,
      };
    }
    routingCache = nextCache;
    cacheLoadedAt = Date.now();
  } catch (error) {
    console.warn("[modelRoutingPolicy] failed to load routing config; using stale cache or hardcoded fallback");
    captureSentryException(error, {
      level: "warning",
      tags: { util: "model_routing_policy", phase: "load_cache" },
    });
  }
}

export async function invalidateRoutingCache() {
  routingCache = null;
  cacheLoadedAt = 0;
}

export async function resolveModelForGeneration({ generationType, plan } = {}) {
  const now = Date.now();
  if (!routingCache || now - cacheLoadedAt > CACHE_TTL_MS) {
    await loadRoutingCache();
  }

  const key = `${generationType}:${plan}`;
  const configured = routingCache?.[key];
  if (configured?.model) {
    return {
      model: configured.model,
      reasoningEffort: configured.reasoningEffort ?? null,
    };
  }

  const fallback = getFallbackRoutingResult(generationType);
  const fallbackError = new Error("Model routing config missing; using hardcoded fallback");
  console.warn("[modelRoutingPolicy] missing routing config; using hardcoded fallback", {
    generationType,
    plan,
    fallbackModel: fallback.model,
  });
  captureSentryException(fallbackError, {
    level: "warning",
    tags: { util: "model_routing_policy", phase: "fallback" },
    extra: {
      generationType,
      plan,
      fallbackModel: fallback.model,
    },
  });

  return fallback;
}
