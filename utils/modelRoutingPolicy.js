import { DOCUMENT_GENERATION_TYPES } from "./documentGeneration.js";

export const DEFAULT_GENERATION_MODEL = "gpt-4o-mini";
export const GPT55_SUMMARY_MODEL = "gpt-5.5";
export const FLASHCARD_GENERATION_MODEL = "gpt-4o";
export const EXAM_GENERATION_MODEL = "gpt-4o";
export const USE_GPT55_SUMMARY_FLAG = "USE_GPT55_SUMMARY";

function normalizeFlagValue(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isGpt55SummaryEnabledForEnvironment() {
  const value = normalizeFlagValue(process.env[USE_GPT55_SUMMARY_FLAG]);
  return !["0", "false", "off", "disabled", "no"].includes(value);
}

export function shouldUseGpt55Summary({ generationType, useGpt55Summary = true } = {}) {
  return generationType === DOCUMENT_GENERATION_TYPES.summary
    && useGpt55Summary
    && isGpt55SummaryEnabledForEnvironment();
}

export function resolveModelForGeneration({ generationType, useGpt55Summary = true } = {}) {
  if (shouldUseGpt55Summary({ generationType, useGpt55Summary })) {
    return GPT55_SUMMARY_MODEL;
  }

  if (generationType === DOCUMENT_GENERATION_TYPES.flashcards) {
    return FLASHCARD_GENERATION_MODEL;
  }

  if (generationType === DOCUMENT_GENERATION_TYPES.exam) {
    return EXAM_GENERATION_MODEL;
  }

  return DEFAULT_GENERATION_MODEL;
}
