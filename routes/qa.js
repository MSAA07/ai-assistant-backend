import express from "express";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { listFiles } from "../utils/storage.js";
import { sendTelegramRawNotification } from "../utils/telegramNotify.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const QA_TESTS_DIR = path.resolve(__dirname, "../tests");
const QA_EMAIL = process.env.QA_ACCOUNT_EMAIL || "qa@studymaxing.com";
const QA_PASSWORD = process.env.QA_ACCOUNT_PASSWORD || "tester123";
const QA_SCHEDULE_FREQUENCIES = new Set([30, 60, 180, 360, 720, 1440]);
const QA_RATE_LIMITS_MS = Object.freeze({
  health: 1 * 60 * 1000,
  pipeline: 3 * 60 * 1000,
  full: 5 * 60 * 1000,
});
const QA_TARGET = "staging";
const QA_STAGING_SERVICE_NAME = "studymaxing-backend-staging";

const QA_ACCOUNT = Object.freeze({
  email: QA_EMAIL,
  password: QA_PASSWORD,
});

const HEALTH_TEST_NAMES = Object.freeze({
  backendAlive: "Backend alive",
  databaseReachable: "Database reachable",
  storageReachable: "R2 storage reachable",
  openAiKeyValid: "OpenAI API key valid",
  mistralKeyValid: "Mistral API key valid",
  resendKeyValid: "Resend API key valid",
  authEndpointResponding: "Auth endpoint responding",
  adminEndpointsResponding: "Admin endpoints responding",
});

const PIPELINE_TEST_NAMES = Object.freeze({
  health: "Health check",
  signIn: "Sign in as QA account",
  uploadPdf: "Upload pipeline test PDF",
  extraction: "Wait for extraction",
  generation: "Wait for generation",
  exportPdf: "PDF export",
  deleteDocument: "Delete document",
  signOut: "Sign out QA account",
});

const FULL_TEST_NAMES = Object.freeze({
  health: "Health check",
  signIn: "Sign in as QA account",
  uploadEnglishPdf: "Upload English PDF",
  extractEnglishPdf: "Wait for English PDF extraction",
  generateEnglishPdf: "Wait for English PDF generation",
  uploadEnglishDocx: "Upload English DOCX",
  processEnglishDocx: "Wait for DOCX extraction and generation",
  uploadEnglishPptx: "Upload English PPTX",
  processEnglishPptx: "Wait for PPTX extraction and generation",
  uploadArabicPdf: "Upload Arabic PDF",
  processArabicPdf: "Wait for Arabic PDF extraction and generation",
  uploadArabicPptx: "Upload Arabic PPTX",
  processArabicPptx: "Wait for Arabic PPTX extraction and generation",
  oversizedRejection: "Oversized file rejection",
  corruptGracefulFailure: "Corrupt file graceful failure",
  exportPdf: "PDF export",
  adminHealth: "Admin endpoints health",
  signOut: "Sign out QA account",
});

const TIER_TEST_SEQUENCES = Object.freeze({
  health: Object.freeze([
    HEALTH_TEST_NAMES.backendAlive,
    HEALTH_TEST_NAMES.databaseReachable,
    HEALTH_TEST_NAMES.storageReachable,
    HEALTH_TEST_NAMES.openAiKeyValid,
    HEALTH_TEST_NAMES.mistralKeyValid,
    HEALTH_TEST_NAMES.resendKeyValid,
    HEALTH_TEST_NAMES.authEndpointResponding,
    HEALTH_TEST_NAMES.adminEndpointsResponding,
  ]),
  pipeline: Object.freeze([
    PIPELINE_TEST_NAMES.health,
    PIPELINE_TEST_NAMES.signIn,
    PIPELINE_TEST_NAMES.uploadPdf,
    PIPELINE_TEST_NAMES.extraction,
    PIPELINE_TEST_NAMES.generation,
    PIPELINE_TEST_NAMES.exportPdf,
    PIPELINE_TEST_NAMES.deleteDocument,
    PIPELINE_TEST_NAMES.signOut,
  ]),
  optimized: Object.freeze([
    FULL_TEST_NAMES.health,
    FULL_TEST_NAMES.signIn,
    FULL_TEST_NAMES.uploadEnglishPdf,
    FULL_TEST_NAMES.extractEnglishPdf,
    FULL_TEST_NAMES.generateEnglishPdf,
    FULL_TEST_NAMES.uploadEnglishDocx,
    FULL_TEST_NAMES.processEnglishDocx,
    FULL_TEST_NAMES.uploadEnglishPptx,
    FULL_TEST_NAMES.processEnglishPptx,
    FULL_TEST_NAMES.uploadArabicPdf,
    FULL_TEST_NAMES.processArabicPdf,
    FULL_TEST_NAMES.uploadArabicPptx,
    FULL_TEST_NAMES.processArabicPptx,
    FULL_TEST_NAMES.oversizedRejection,
    FULL_TEST_NAMES.corruptGracefulFailure,
    FULL_TEST_NAMES.exportPdf,
    FULL_TEST_NAMES.adminHealth,
    FULL_TEST_NAMES.signOut,
  ]),
  full: Object.freeze([
    FULL_TEST_NAMES.health,
    FULL_TEST_NAMES.signIn,
    FULL_TEST_NAMES.uploadEnglishPdf,
    FULL_TEST_NAMES.extractEnglishPdf,
    FULL_TEST_NAMES.generateEnglishPdf,
    FULL_TEST_NAMES.uploadEnglishDocx,
    FULL_TEST_NAMES.processEnglishDocx,
    FULL_TEST_NAMES.uploadEnglishPptx,
    FULL_TEST_NAMES.processEnglishPptx,
    FULL_TEST_NAMES.uploadArabicPdf,
    FULL_TEST_NAMES.processArabicPdf,
    FULL_TEST_NAMES.uploadArabicPptx,
    FULL_TEST_NAMES.processArabicPptx,
    FULL_TEST_NAMES.oversizedRejection,
    FULL_TEST_NAMES.corruptGracefulFailure,
    FULL_TEST_NAMES.exportPdf,
    FULL_TEST_NAMES.adminHealth,
    FULL_TEST_NAMES.signOut,
  ]),
});

const TEST_INDEX_BY_TIER = new Map(
  Object.entries(TIER_TEST_SEQUENCES).map(([tier, sequence]) => [
    tier,
    new Map(sequence.map((name, index) => [name, index + 1])),
  ]),
);

const BASELINE_TEST_DURATIONS_MS = Object.freeze({
  [HEALTH_TEST_NAMES.backendAlive]: 500,
  [HEALTH_TEST_NAMES.databaseReachable]: 500,
  [HEALTH_TEST_NAMES.storageReachable]: 1_000,
  [HEALTH_TEST_NAMES.openAiKeyValid]: 2_000,
  [HEALTH_TEST_NAMES.mistralKeyValid]: 2_000,
  [HEALTH_TEST_NAMES.resendKeyValid]: 2_000,
  [HEALTH_TEST_NAMES.authEndpointResponding]: 500,
  [HEALTH_TEST_NAMES.adminEndpointsResponding]: 500,
  [PIPELINE_TEST_NAMES.health]: 500,
  [PIPELINE_TEST_NAMES.signIn]: 1_500,
  [PIPELINE_TEST_NAMES.uploadPdf]: 3_000,
  [PIPELINE_TEST_NAMES.extraction]: 15_000,
  [PIPELINE_TEST_NAMES.generation]: 60_000,
  [PIPELINE_TEST_NAMES.exportPdf]: 3_000,
  [PIPELINE_TEST_NAMES.deleteDocument]: 3_000,
  [PIPELINE_TEST_NAMES.signOut]: 1_000,
  [FULL_TEST_NAMES.health]: 500,
  [FULL_TEST_NAMES.signIn]: 1_500,
  [FULL_TEST_NAMES.uploadEnglishPdf]: 3_000,
  [FULL_TEST_NAMES.extractEnglishPdf]: 20_000,
  [FULL_TEST_NAMES.generateEnglishPdf]: 67_000,
  [FULL_TEST_NAMES.uploadEnglishDocx]: 5_000,
  [FULL_TEST_NAMES.processEnglishDocx]: 55_000,
  [FULL_TEST_NAMES.uploadEnglishPptx]: 5_000,
  [FULL_TEST_NAMES.processEnglishPptx]: 55_000,
  [FULL_TEST_NAMES.uploadArabicPdf]: 5_000,
  [FULL_TEST_NAMES.processArabicPdf]: 115_000,
  [FULL_TEST_NAMES.uploadArabicPptx]: 5_000,
  [FULL_TEST_NAMES.processArabicPptx]: 55_000,
  [FULL_TEST_NAMES.oversizedRejection]: 5_000,
  [FULL_TEST_NAMES.corruptGracefulFailure]: 15_000,
  [FULL_TEST_NAMES.exportPdf]: 28_000,
  [FULL_TEST_NAMES.adminHealth]: 1_000,
  [FULL_TEST_NAMES.signOut]: 1_000,
});

const QA_FIXTURES = Object.freeze({
  pipelinePdf: {
    path: path.join(QA_TESTS_DIR, "qa-pipeline-test.pdf"),
    filename: "qa-pipeline-test.pdf",
    mimeType: "application/pdf",
    label: "Pipeline test PDF",
  },
  englishPdf: {
    path: path.join(QA_TESTS_DIR, "qa-pipeline-test.pdf"),
    filename: "qa-pipeline-test.pdf",
    mimeType: "application/pdf",
    label: "English PDF",
  },
  englishDocx: {
    path: path.join(QA_TESTS_DIR, "qa-test-english.docx"),
    filename: "qa-test-english.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    label: "English DOCX",
  },
  englishPptx: {
    path: path.join(QA_TESTS_DIR, "extraction_test_ENGLISH.pptx"),
    filename: "extraction_test_ENGLISH.pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    label: "English PPTX",
  },
  arabicPdf: {
    path: path.join(QA_TESTS_DIR, "arabic.pdf"),
    filename: "arabic.pdf",
    mimeType: "application/pdf",
    label: "Arabic scanned PDF - tests Mistral OCR path",
  },
  arabicPptx: {
    path: path.join(QA_TESTS_DIR, "extraction_test_ARABIC.pptx"),
    filename: "extraction_test_ARABIC.pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    label: "Arabic PPTX",
  },
  oversizedPdf: {
    path: path.join(QA_TESTS_DIR, "qa-test-oversized.pdf"),
    filename: "qa-test-oversized.pdf",
    mimeType: "application/pdf",
    label: "Oversized PDF",
  },
  corruptPdf: {
    path: path.join(QA_TESTS_DIR, "qa-test-corrupt.pdf"),
    filename: "qa-test-corrupt.pdf",
    mimeType: "application/pdf",
    label: "Corrupt PDF",
  },
});

const FULL_QUALITY_THRESHOLDS = Object.freeze({
  optimized: Object.freeze({
    summaryMinChars: 80,
    flashcardMinCount: 2,
    examMinCount: 2,
  }),
  full: Object.freeze({
    summaryMinChars: 100,
    flashcardMinCount: 3,
    examMinCount: 3,
  }),
});

const PIPELINE_EXISTENCE_THRESHOLDS = Object.freeze({
  summaryMinChars: 1,
  flashcardMinCount: 1,
  examMinCount: 1,
});

const qaRunRateLimit = new Map();
let currentQaProgress = null;
let qaScheduleTimer = null;
let qaScheduleContext = null;

function normalizeTarget(value) {
  const target = typeof value === "string" ? value.trim().toLowerCase() : "";
  return target === QA_TARGET ? target : "";
}

function normalizeFullMode(value) {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  return mode === "optimized" || mode === "full" ? mode : "";
}

function normalizeBaseUrl(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function getStagingBaseUrl(env = process.env) {
  const baseUrl = normalizeBaseUrl(env.QA_STAGING_API_BASE_URL);
  if (!baseUrl) {
    const error = new Error("QA_STAGING_API_BASE_URL is required to run QA; no fallback target is allowed");
    error.status = 503;
    throw error;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    const error = new Error("QA_STAGING_API_BASE_URL must be a valid staging URL");
    error.status = 503;
    throw error;
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  const hasStagingMarker = /(^|[.-])stag(e|ing)([.-]|$)/.test(hostname);
  const hasProductionMarker = /(^|[.-])prod(uction)?([.-]|$)/.test(hostname);
  if (parsedUrl.protocol !== "https:" || !hasStagingMarker || hasProductionMarker) {
    const error = new Error("QA_STAGING_API_BASE_URL must be an HTTPS staging host and must not identify production");
    error.status = 503;
    throw error;
  }

  return baseUrl;
}

function assertQaServiceIsStaging(env = process.env) {
  const serviceName = typeof env.RAILWAY_SERVICE_NAME === "string"
    ? env.RAILWAY_SERVICE_NAME.trim()
    : "";
  if (serviceName !== QA_STAGING_SERVICE_NAME) {
    const error = new Error(`QA routes are available only on ${QA_STAGING_SERVICE_NAME}`);
    error.status = 503;
    throw error;
  }
  return serviceName;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function elapsedSince(startedAt) {
  return Math.max(0, Date.now() - startedAt);
}

function getTierLabel(tier) {
  if (tier === "health") return "Health Check";
  if (tier === "pipeline") return "Pipeline Check";
  if (tier === "optimized") return "Full QA (Optimized)";
  if (tier === "full") return "Full QA (Full)";
  return "QA";
}

function getTestSequence(tier) {
  return TIER_TEST_SEQUENCES[tier] || TIER_TEST_SEQUENCES.full;
}

function getTestOrder(tier, testName) {
  const tierIndex = TEST_INDEX_BY_TIER.get(tier);
  return tierIndex?.get(testName) || getTestSequence(tier).length;
}

function getSkippedCount(results) {
  return results.filter((result) => result.status === "skip").length;
}

function getSpeedVerdict(durationMs, thresholdMs) {
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) {
    return "fast";
  }
  if (durationMs <= thresholdMs) {
    return "fast";
  }
  if (durationMs <= thresholdMs * 2) {
    return "slow";
  }
  return "very_slow";
}

function createResult(tier, name, status, message, durationMs = 0, thresholdMs = BASELINE_TEST_DURATIONS_MS[name] || 1_000) {
  const roundedDuration = Math.max(0, Math.round(durationMs));
  return {
    name,
    status,
    message,
    durationMs: roundedDuration,
    thresholdMs,
    speedVerdict: getSpeedVerdict(roundedDuration, thresholdMs),
    order: getTestOrder(tier, name),
  };
}

function serializeQaRun(qaRun) {
  return {
    id: qaRun.id,
    target: qaRun.target,
    tier: qaRun.tier || "full",
    tierLabel: getTierLabel(qaRun.tier || "full"),
    ranAt: qaRun.ranAt,
    totalDurationMs: qaRun.totalDurationMs,
    passed: qaRun.passed,
    failed: qaRun.failed,
    skipped: qaRun.skipped,
    estimatedCostUsd: qaRun.estimatedCostUsd,
    triggeredBy: qaRun.triggeredBy,
    failureReport: qaRun.failureReport || null,
    results: (qaRun.results || [])
      .slice()
      .sort((left, right) => left.order - right.order)
      .map((result) => ({
        id: result.id,
        qaRunId: result.qaRunId,
        name: result.testName,
        testName: result.testName,
        status: result.status,
        message: result.message,
        durationMs: result.durationMs,
        thresholdMs: result.thresholdMs || BASELINE_TEST_DURATIONS_MS[result.testName] || 1_000,
        speedVerdict: result.speedVerdict || getSpeedVerdict(result.durationMs, BASELINE_TEST_DURATIONS_MS[result.testName] || 1_000),
        order: result.order,
      })),
  };
}

async function getQaDurationEstimates(prisma, tier) {
  const estimates = {};
  const sequence = getTestSequence(tier);
  for (const name of sequence) {
    estimates[name] = BASELINE_TEST_DURATIONS_MS[name] || 1_000;
  }

  try {
    const groups = await prisma.qaRunResult.groupBy({
      by: ["testName"],
      where: {
        qaRun: { tier },
      },
      _avg: { durationMs: true },
    });

    for (const group of groups) {
      const average = Number(group._avg?.durationMs);
      if (sequence.includes(group.testName) && Number.isFinite(average) && average > 0) {
        estimates[group.testName] = Math.round(average);
      }
    }
  } catch (error) {
    console.error("[qa] Failed to load QA duration estimates:", error);
  }

  return estimates;
}

function beginQaProgress({ target, tier, triggeredBy, estimates }) {
  currentQaProgress = {
    inProgress: true,
    target,
    tier,
    tierLabel: getTierLabel(tier),
    triggeredBy,
    startedAtMs: Date.now(),
    currentTest: "",
    currentTestIndex: 0,
    currentTestStartedAtMs: null,
    completedResults: [],
    estimates,
    testSequence: getTestSequence(tier),
  };
}

function setCurrentQaTest(testName) {
  if (!currentQaProgress?.inProgress) return;
  currentQaProgress.currentTest = testName;
  currentQaProgress.currentTestIndex = getTestOrder(currentQaProgress.tier, testName);
  currentQaProgress.currentTestStartedAtMs = Date.now();
}

function recordQaProgressResult(result) {
  if (!currentQaProgress?.inProgress) return;
  currentQaProgress.completedResults.push({
    name: result.name,
    status: result.status,
    durationMs: result.durationMs,
  });
}

function clearQaProgress() {
  currentQaProgress = null;
}

function getProgressSnapshot() {
  if (!currentQaProgress?.inProgress) {
    return { inProgress: false };
  }

  const now = Date.now();
  const sequence = currentQaProgress.testSequence || getTestSequence(currentQaProgress.tier);
  const totalTests = sequence.length;
  const elapsedMs = elapsedSince(currentQaProgress.startedAtMs);
  const estimates = currentQaProgress.estimates || BASELINE_TEST_DURATIONS_MS;
  const currentTestIndex = currentQaProgress.currentTestIndex || Math.min(currentQaProgress.completedResults.length + 1, totalTests);
  const currentTest = currentQaProgress.currentTest || sequence[currentTestIndex - 1] || "";
  const currentTestStartedAtMs = currentQaProgress.currentTestStartedAtMs || now;
  const currentTestElapsedMs = Math.max(0, now - currentTestStartedAtMs);
  const currentEstimateMs = estimates[currentTest] || BASELINE_TEST_DURATIONS_MS[currentTest] || 1_000;
  const completedEstimateMs = currentQaProgress.completedResults.reduce((sum, result) => {
    return sum + (estimates[result.name] || BASELINE_TEST_DURATIONS_MS[result.name] || result.durationMs || 0);
  }, 0);
  const currentProgressMs = currentTest ? Math.min(currentTestElapsedMs, currentEstimateMs) : 0;
  const totalEstimatedMs = sequence.reduce((sum, name) => {
    return sum + (estimates[name] || BASELINE_TEST_DURATIONS_MS[name] || 0);
  }, 0);
  const remainingAfterCurrentMs = sequence
    .slice(Math.max(currentTestIndex, 0))
    .reduce((sum, name) => sum + (estimates[name] || BASELINE_TEST_DURATIONS_MS[name] || 0), 0);
  const estimatedRemainingMs = Math.max(0, currentEstimateMs - currentTestElapsedMs) + remainingAfterCurrentMs;
  const percentComplete = totalEstimatedMs > 0
    ? Math.max(0, Math.min(99, Math.round(((completedEstimateMs + currentProgressMs) / totalEstimatedMs) * 100)))
    : 0;

  return {
    inProgress: true,
    target: currentQaProgress.target,
    tier: currentQaProgress.tier,
    tierLabel: currentQaProgress.tierLabel,
    currentTest,
    currentTestIndex,
    totalTests,
    elapsedMs,
    estimatedRemainingMs,
    percentComplete,
  };
}

function getAdminSessionKey(req) {
  return req.session?.session?.id
    || req.session?.session?.token
    || req.session?.user?.id
    || req.ip
    || "unknown";
}

function pruneRateLimits(now = Date.now()) {
  for (const [key, timestamp] of qaRunRateLimit.entries()) {
    if (now - timestamp > Math.max(...Object.values(QA_RATE_LIMITS_MS))) {
      qaRunRateLimit.delete(key);
    }
  }
}

function getRateLimitTier(tier) {
  return tier === "optimized" ? "full" : tier;
}

function getRateLimitLabel(tier) {
  const rateLimitTier = getRateLimitTier(tier);
  if (rateLimitTier === "health") return "Health check";
  if (rateLimitTier === "pipeline") return "Pipeline check";
  return "Full QA";
}

function getRateLimitState(req, tier) {
  const now = Date.now();
  pruneRateLimits(now);
  const rateLimitTier = getRateLimitTier(tier);
  const cooldownMs = QA_RATE_LIMITS_MS[rateLimitTier] || QA_RATE_LIMITS_MS.full;
  const key = `${getAdminSessionKey(req)}:${rateLimitTier}`;
  const lastRunAt = qaRunRateLimit.get(key) || 0;
  const elapsedMs = now - lastRunAt;

  if (lastRunAt && elapsedMs < cooldownMs) {
    return {
      limited: true,
      key,
      retryAfterMs: cooldownMs - elapsedMs,
    };
  }

  qaRunRateLimit.set(key, now);
  return {
    limited: false,
    key,
    retryAfterMs: 0,
  };
}

function splitSetCookieHeader(value) {
  if (!value) return [];
  const headers = [];
  let current = "";
  let inExpires = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const nextExpires = value.slice(index, index + 8).toLowerCase() === "expires=";
    if (nextExpires) inExpires = true;

    if (char === "," && !inExpires) {
      if (current.trim()) headers.push(current.trim());
      current = "";
      continue;
    }

    current += char;
    if (inExpires && char === ";") {
      inExpires = false;
    }
  }

  if (current.trim()) headers.push(current.trim());
  return headers;
}

function getSetCookieHeaders(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  if (typeof headers.get === "function") return splitSetCookieHeader(headers.get("set-cookie") || "");
  return [];
}

function buildCookieHeaderFromSetCookie(headers) {
  return getSetCookieHeaders(headers)
    .map((cookie) => cookie.split(";")[0]?.trim())
    .filter(Boolean)
    .join("; ");
}

function buildCookieHeaders(cookieHeader, extraHeaders = {}) {
  return {
    ...extraHeaders,
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function getResponseMessage(data, fallback) {
  return data?.error || data?.message || data?.raw || fallback;
}

async function fetchJson(url, options = {}, timeoutMs = 15_000, fallback = "Request failed") {
  const response = await fetchWithTimeout(url, options, timeoutMs);
  const data = await readJson(response);

  if (!response.ok) {
    const error = new Error(getResponseMessage(data, `${fallback} (${response.status})`));
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return { response, data };
}

function getDocumentFromResponse(data) {
  return data?.document || data;
}

function getGeneratedMaterialStats(document) {
  const summary = typeof document?.summary === "string" ? document.summary.trim() : "";
  const flashcards = Array.isArray(document?.flashcards) ? document.flashcards : [];
  const examQuestions = Array.isArray(document?.examQuestions) ? document.examQuestions : [];
  const flashcardCount = Math.max(Number(document?.flashcardCount) || 0, flashcards.length);
  const questionCount = Math.max(Number(document?.questionCount) || 0, examQuestions.length);

  return {
    summaryLength: summary.length,
    flashcardCount,
    questionCount,
  };
}

function pluralize(count, singular, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

function getQualityFailures(document, thresholds) {
  const stats = getGeneratedMaterialStats(document);
  const failures = [];

  if (stats.summaryLength < thresholds.summaryMinChars) {
    failures.push(`Summary too short (${stats.summaryLength} chars)`);
  }

  if (stats.flashcardCount < thresholds.flashcardMinCount) {
    failures.push(`Only ${stats.flashcardCount} ${pluralize(stats.flashcardCount, "flashcard")} generated`);
  }

  if (stats.questionCount < thresholds.examMinCount) {
    failures.push(`Only ${stats.questionCount} exam ${pluralize(stats.questionCount, "question")} generated`);
  }

  return failures;
}

function formatQualityPassMessage(document) {
  const stats = getGeneratedMaterialStats(document);
  return `Generated summary (${stats.summaryLength} chars), ${stats.flashcardCount} flashcards, and ${stats.questionCount} exam questions`;
}

async function signInQaAccount(auth) {
  const result = await auth.api.signInEmail({
    body: {
      email: QA_ACCOUNT.email,
      password: QA_ACCOUNT.password,
      rememberMe: false,
    },
    headers: new Headers(),
    returnHeaders: true,
    returnStatus: true,
  });

  const sessionToken = result?.response?.token;
  const cookieHeader = buildCookieHeaderFromSetCookie(result?.headers);
  const userId = result?.response?.user?.id;

  if (!sessionToken || !cookieHeader || !userId) {
    throw new Error("QA account sign-in did not return a usable session");
  }

  return {
    cookieHeader,
    sessionToken,
    userId,
  };
}

async function uploadFixtureRaw(baseUrl, cookieHeader, fixture, timeoutMs = 30_000) {
  const fileBuffer = await fs.readFile(fixture.path);
  const formData = new FormData();
  formData.append("file", new Blob([fileBuffer], { type: fixture.mimeType }), fixture.filename);

  const response = await fetchWithTimeout(`${baseUrl}/api/upload`, {
    method: "POST",
    headers: buildCookieHeaders(cookieHeader),
    body: formData,
  }, timeoutMs);
  const data = await readJson(response);

  return { response, data };
}

async function uploadTestFile(baseUrl, cookieHeader, fixture) {
  const { response, data } = await uploadFixtureRaw(baseUrl, cookieHeader, fixture);

  if (!response.ok) {
    const error = new Error(getResponseMessage(data, `${fixture.label} upload failed (${response.status})`));
    error.status = response.status;
    error.data = data;
    throw error;
  }

  if (!data?.documentId || !data?.jobId) {
    throw new Error("Upload did not return both a document ID and job ID");
  }

  return {
    documentId: data.documentId,
    jobId: data.jobId,
  };
}

async function getJob(baseUrl, cookieHeader, jobId) {
  const { data } = await fetchJson(`${baseUrl}/api/jobs/${encodeURIComponent(jobId)}`, {
    method: "GET",
    headers: buildCookieHeaders(cookieHeader),
  }, 12_000, "Job status request failed");
  return data;
}

async function getDocument(baseUrl, cookieHeader, documentId) {
  const { data } = await fetchJson(`${baseUrl}/api/document/${encodeURIComponent(documentId)}`, {
    method: "GET",
    headers: buildCookieHeaders(cookieHeader),
  }, 12_000, "Document request failed");
  return getDocumentFromResponse(data);
}

async function waitForExtraction(baseUrl, cookieHeader, documentId, jobId, {
  timeoutMs = 60_000,
  pollMs = 3_000,
} = {}) {
  const startedAt = Date.now();

  while (elapsedSince(startedAt) < timeoutMs) {
    const job = await getJob(baseUrl, cookieHeader, jobId);

    if (job.status === "failed") {
      throw new Error(job.errorMessage || "Extraction job failed");
    }

    if (job.status === "succeeded") {
      const document = await getDocument(baseUrl, cookieHeader, documentId);
      if (document?.processingStatus === "complete") return;
      if (document?.processingStatus === "failed") {
        throw new Error(document.processingError || "Document extraction failed");
      }
    }

    await sleep(pollMs);
  }

  throw new Error(`Extraction timed out after ${Math.round(timeoutMs / 1000)}s`);
}

async function queueGeneration(baseUrl, cookieHeader, documentId, generationType) {
  const { data } = await fetchJson(`${baseUrl}/api/document/${encodeURIComponent(documentId)}/generations`, {
    method: "POST",
    headers: buildCookieHeaders(cookieHeader, { "Content-Type": "application/json" }),
    body: JSON.stringify({ type: generationType }),
  }, 20_000, `${generationType} generation request failed`);

  return {
    generationType,
    jobId: data?.jobId || null,
    generationId: data?.generationId || null,
    status: data?.generationStatus || data?.generation?.status || "",
  };
}

async function waitForGenerationQuality(baseUrl, cookieHeader, documentId, state, {
  timeoutMs = 120_000,
  pollMs = 5_000,
  thresholds = FULL_QUALITY_THRESHOLDS.full,
} = {}) {
  const queuedGenerations = [];

  for (const generationType of ["summary", "flashcards", "exam"]) {
    const queuedGeneration = await queueGeneration(baseUrl, cookieHeader, documentId, generationType);
    queuedGenerations.push(queuedGeneration);
    if (queuedGeneration.jobId) {
      state.generationJobIds.push(queuedGeneration.jobId);
    }
  }

  const startedAt = Date.now();

  while (elapsedSince(startedAt) < timeoutMs) {
    const document = await getDocument(baseUrl, cookieHeader, documentId);
    const qualityFailures = getQualityFailures(document, thresholds);

    if (qualityFailures.length === 0) {
      return document;
    }

    const activeJobIds = queuedGenerations.map((generation) => generation.jobId).filter(Boolean);
    for (const activeJobId of activeJobIds) {
      const job = await getJob(baseUrl, cookieHeader, activeJobId);
      if (job.status === "failed") {
        throw new Error(job.errorMessage || `Generation job ${activeJobId} failed`);
      }
    }

    await sleep(pollMs);
  }

  const document = await getDocument(baseUrl, cookieHeader, documentId).catch(() => null);
  const qualityFailures = getQualityFailures(document, thresholds);
  throw new Error(
    qualityFailures.length > 0
      ? `Generation quality check failed: ${qualityFailures.join("; ")}`
      : `Generation timed out after ${Math.round(timeoutMs / 1000)}s`,
  );
}

async function requestPdfExport(baseUrl, cookieHeader, documentId, timeoutMs = 30_000) {
  const response = await fetchWithTimeout(`${baseUrl}/api/document/${encodeURIComponent(documentId)}/export-pdf?feature=summary`, {
    method: "GET",
    headers: buildCookieHeaders(cookieHeader),
  }, timeoutMs);

  if (!response.ok) {
    const data = await readJson(response);
    throw new Error(getResponseMessage(data, `PDF export failed with ${response.status}`));
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/pdf")) {
    throw new Error(`PDF export returned ${contentType || "no content type"}`);
  }

  const file = await response.arrayBuffer();
  if (file.byteLength <= 0) {
    throw new Error("PDF export returned an empty file");
  }
}

async function checkAdminEndpoints(baseUrl, adminCookieHeader) {
  const adminHeaders = buildCookieHeaders(adminCookieHeader);
  const endpoints = ["/api/admin/users", "/api/admin/jobs", "/api/admin/usage"];

  for (const endpoint of endpoints) {
    const response = await fetchWithTimeout(`${baseUrl}${endpoint}`, {
      method: "GET",
      headers: adminHeaders,
    }, 15_000);

    if (!response.ok) {
      const data = await readJson(response);
      throw new Error(`${endpoint} returned ${response.status}: ${getResponseMessage(data, "Request failed")}`);
    }

    await response.text();
  }
}

async function cleanupDocument(baseUrl, cookieHeader, documentId) {
  if (!documentId || !cookieHeader) return;

  try {
    await fetchJson(`${baseUrl}/api/document/${encodeURIComponent(documentId)}`, {
      method: "DELETE",
      headers: buildCookieHeaders(cookieHeader),
    }, 30_000, "QA document cleanup failed");
  } catch (error) {
    console.error("[qa] Failed to clean up QA document:", error);
  }
}

function rememberQaDocument(state, key, upload) {
  state.documents.set(key, {
    documentId: upload.documentId,
    jobId: upload.jobId,
  });
}

function getQaDocument(state, key) {
  const document = state.documents.get(key);
  if (!document?.documentId || !document?.jobId) {
    throw new Error("Required QA document was not uploaded");
  }
  return document;
}

async function cleanupQaDocument(state, key) {
  const document = state.documents.get(key);
  if (!document?.documentId) return;
  await cleanupDocument(state.baseUrl, state.qaCookieHeader, document.documentId);
  state.documents.delete(key);
}

async function cleanupAllQaDocuments(state) {
  const keys = [...state.documents.keys()];
  for (const key of keys) {
    await cleanupQaDocument(state, key);
  }
}

async function uploadFixtureForRun(state, key) {
  const fixture = QA_FIXTURES[key];
  const upload = await uploadTestFile(state.baseUrl, state.qaCookieHeader, fixture);
  rememberQaDocument(state, key, upload);
  return upload;
}

async function waitForFixtureExtractionAndQuality(state, key, {
  totalTimeoutMs = null,
  extractionTimeoutMs,
  extractionPollMs = 5_000,
  generationTimeoutMs,
  generationPollMs = 5_000,
  thresholds = FULL_QUALITY_THRESHOLDS.full,
}) {
  const document = getQaDocument(state, key);
  const startedAt = Date.now();

  try {
    await waitForExtraction(state.baseUrl, state.qaCookieHeader, document.documentId, document.jobId, {
      timeoutMs: extractionTimeoutMs || totalTimeoutMs || 60_000,
      pollMs: extractionPollMs,
    });
    const remainingTimeoutMs = totalTimeoutMs
      ? Math.max(1_000, totalTimeoutMs - elapsedSince(startedAt))
      : null;
    const generatedDocument = await waitForGenerationQuality(state.baseUrl, state.qaCookieHeader, document.documentId, state, {
      timeoutMs: generationTimeoutMs || remainingTimeoutMs || 120_000,
      pollMs: generationPollMs,
      thresholds,
    });
    return formatQualityPassMessage(generatedDocument);
  } finally {
    await cleanupQaDocument(state, key);
  }
}

function skipTests(ctx, testNames, message) {
  for (const testName of testNames) {
    skipStep(ctx, testName, message);
  }
}

function isOversizedRejection(response, data) {
  const message = getResponseMessage(data, "").toLowerCase();
  return data?.code === "document_too_long"
    || response.status === 400
    || response.status === 422
    || message.includes("too many pages")
    || message.includes("too long");
}

async function assertOversizedFileRejected(state) {
  const { response, data } = await uploadFixtureRaw(state.baseUrl, state.qaCookieHeader, QA_FIXTURES.oversizedPdf, 45_000);

  if (!response.ok) {
    if (isOversizedRejection(response, data)) {
      return `Oversized file rejected with ${response.status}: ${getResponseMessage(data, "document_too_long")}`;
    }
    throw new Error(`Oversized file returned unexpected ${response.status}: ${getResponseMessage(data, "Request failed")}`);
  }

  if (data?.documentId) {
    await cleanupDocument(state.baseUrl, state.qaCookieHeader, data.documentId);
  }

  throw new Error("Oversized file was accepted when it should have been rejected");
}

async function waitForCorruptFileFailure(state, documentId, jobId) {
  const startedAt = Date.now();

  while (elapsedSince(startedAt) < 30_000) {
    const [job, document] = await Promise.all([
      getJob(state.baseUrl, state.qaCookieHeader, jobId).catch(() => null),
      getDocument(state.baseUrl, state.qaCookieHeader, documentId).catch(() => null),
    ]);

    if (job?.status === "failed") {
      return job.errorMessage || "Corrupt file extraction job failed gracefully";
    }

    if (document?.processingStatus === "failed") {
      return document.processingError || "Corrupt file failed gracefully";
    }

    if (job?.status === "succeeded" || document?.processingStatus === "complete") {
      throw new Error("Corrupt file was processed successfully when it should have failed");
    }

    await sleep(3_000);
  }

  throw new Error("Corrupt file did not reach failed status within 30s");
}

async function assertCorruptFileFailsGracefully(state) {
  const { response, data } = await uploadFixtureRaw(state.baseUrl, state.qaCookieHeader, QA_FIXTURES.corruptPdf, 30_000);

  if (!response.ok) {
    const message = getResponseMessage(data, "");
    if (response.status >= 400 && response.status < 500 && message) {
      return `Corrupt file rejected gracefully with ${response.status}: ${message}`;
    }
    throw new Error(`Corrupt file returned ${response.status}: ${message || "no useful message"}`);
  }

  if (!data?.documentId || !data?.jobId) {
    throw new Error("Corrupt file upload did not return both a document ID and job ID");
  }

  try {
    const failureMessage = await waitForCorruptFileFailure(state, data.documentId, data.jobId);
    return `Corrupt file failed gracefully: ${failureMessage}`;
  } finally {
    await cleanupDocument(state.baseUrl, state.qaCookieHeader, data.documentId);
  }
}

async function signOutQaAccount(auth, cookieHeader) {
  if (!cookieHeader) {
    throw new Error("No QA session was available to sign out");
  }

  const headers = new Headers({ cookie: cookieHeader });
  await auth.api.signOut({ headers });
  const session = await auth.api.getSession({ headers }).catch(() => null);

  if (session) {
    throw new Error("QA session is still active after sign out");
  }
}

async function calculateEstimatedCost(prisma, state, runStartedAt) {
  if (!state.qaUserId) return 0;

  try {
    const aggregate = await prisma.modelUsageEvent.aggregate({
      where: {
        userId: state.qaUserId,
        createdAt: { gte: runStartedAt },
      },
      _sum: {
        estimatedCostUsd: true,
      },
    });
    return Number(aggregate._sum?.estimatedCostUsd || 0);
  } catch (error) {
    console.error("[qa] Failed to calculate QA cost:", error);
    return 0;
  }
}

async function getTriggeredBy(prisma, req) {
  const sessionEmail = req.session?.user?.email;
  if (typeof sessionEmail === "string" && sessionEmail.trim()) {
    return sessionEmail.trim().toLowerCase();
  }

  const userId = req.session?.user?.id;
  if (!userId) return "unknown";

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    return user?.email || userId;
  } catch (error) {
    console.error("[qa] Failed to resolve admin trigger email:", error);
    return userId;
  }
}

function formatReportTimestamp(value) {
  return value.toISOString().replace("T", " ").slice(0, 19);
}

function buildFailureReport({ tier, target, ranAt, passed, failed, results }) {
  const failures = results.filter((result) => result.status === "fail");
  const bottlenecks = results.filter((result) => result.status === "pass" && result.speedVerdict !== "fast");

  if (failures.length === 0 && bottlenecks.length === 0) {
    return null;
  }

  const lines = [
    `QA FAILURE REPORT \u2014 ${formatReportTimestamp(ranAt)}`,
    `Tier: ${tier}`,
    `Environment: ${target}`,
    `Result: ${passed} passed, ${failed} failed`,
    "",
    "FAILURES:",
  ];

  if (failures.length === 0) {
    lines.push("- None");
  } else {
    for (const failure of failures) {
      lines.push(`- ${failure.name}`);
      lines.push(`  Message: ${failure.message}`);
      lines.push(`  Duration: ${failure.durationMs}ms`);
      lines.push(`  Speed: ${failure.speedVerdict}`);
    }
  }

  lines.push("");
  lines.push("BOTTLENECKS (slow but passing):");

  if (bottlenecks.length === 0) {
    lines.push("- None");
  } else {
    for (const bottleneck of bottlenecks) {
      lines.push(`- ${bottleneck.name}: ${bottleneck.durationMs}ms (threshold: ${bottleneck.thresholdMs}ms)`);
    }
  }

  return lines.join("\n");
}

async function saveQaRun(prisma, {
  target,
  tier,
  ranAt,
  totalDurationMs,
  passed,
  failed,
  skipped,
  estimatedCostUsd,
  triggeredBy,
  failureReport,
  results,
}) {
  try {
    return await prisma.qaRun.create({
      data: {
        target,
        tier,
        ranAt,
        totalDurationMs,
        passed,
        failed,
        skipped,
        estimatedCostUsd,
        triggeredBy,
        failureReport,
        results: {
          create: results.map((result, index) => ({
            testName: result.name,
            status: result.status,
            message: result.message,
            durationMs: result.durationMs,
            thresholdMs: result.thresholdMs,
            speedVerdict: result.speedVerdict,
            order: result.order || getTestOrder(tier, result.name) || index + 1,
          })),
        },
      },
      include: {
        results: {
          orderBy: { order: "asc" },
        },
      },
    });
  } catch (error) {
    console.error("[qa] Failed to save QA run history:", error);
    return null;
  }
}

async function runStep(ctx, name, fn, thresholdMs = BASELINE_TEST_DURATIONS_MS[name] || 1_000) {
  const startedAt = Date.now();
  setCurrentQaTest(name);

  try {
    const message = await fn();
    const result = createResult(ctx.tier, name, "pass", message || `${name} passed`, elapsedSince(startedAt), thresholdMs);
    ctx.results.push(result);
    recordQaProgressResult(result);
    return true;
  } catch (error) {
    const message = error?.message || `${name} failed`;
    const result = createResult(ctx.tier, name, "fail", message, elapsedSince(startedAt), thresholdMs);
    ctx.results.push(result);
    recordQaProgressResult(result);
    return false;
  }
}

function skipStep(ctx, name, message) {
  const result = createResult(ctx.tier, name, "skip", message);
  ctx.results.push(result);
  recordQaProgressResult(result);
}

async function assertBackendAlive(baseUrl) {
  const response = await fetchWithTimeout(`${baseUrl}/api/health`, { method: "GET" }, 2_000);
  if (!response.ok) {
    throw new Error(`Health check returned ${response.status}`);
  }
  return "Health endpoint returned 200";
}

async function assertStorageReachable() {
  await listFiles("", 1);
  return "R2 list operation completed";
}

async function assertApiKeyValid({ name, envKey, url }) {
  const apiKey = process.env[envKey];
  if (!apiKey) {
    throw new Error(`${name} API key is not configured`);
  }

  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  }, 5_000);

  if (response.status === 401 || response.status === 403) {
    let body = null;
    try {
      body = await response.json();
    } catch {
      // response wasn't JSON, fall through to generic handling below
    }

    const errorType = body?.name || body?.error?.name;

    if (errorType === "restricted_api_key") {
      // Key is valid but scoped to send-only access, which is all this app
      // needs. Not a failure.
      return `${name} API key is valid (send-only scope)`;
    }

    throw new Error(`${name} API key is invalid`);
  }

  if (!response.ok) {
    throw new Error(`${name} models endpoint returned ${response.status}`);
  }

  await response.text();
  return `${name} API key was accepted`;
}

async function runHealthChecks(ctx, { includeAll = true } = {}) {
  await runStep(ctx, includeAll ? HEALTH_TEST_NAMES.backendAlive : PIPELINE_TEST_NAMES.health, async () => {
    return assertBackendAlive(ctx.state.baseUrl);
  }, 500);

  if (!includeAll) return;

  await runStep(ctx, HEALTH_TEST_NAMES.databaseReachable, async () => {
    const count = await ctx.prisma.user.count();
    if (!Number.isFinite(count)) {
      throw new Error("User count did not return a number");
    }
    return `Database query succeeded (${count} users)`;
  }, 500);

  await runStep(ctx, HEALTH_TEST_NAMES.storageReachable, async () => {
    return assertStorageReachable();
  }, 1_000);

  await runStep(ctx, HEALTH_TEST_NAMES.openAiKeyValid, async () => {
    return assertApiKeyValid({
      name: "OpenAI",
      envKey: "OPENAI_API_KEY",
      url: "https://api.openai.com/v1/models",
    });
  }, 2_000);

  await runStep(ctx, HEALTH_TEST_NAMES.mistralKeyValid, async () => {
    return assertApiKeyValid({
      name: "Mistral",
      envKey: "MISTRAL_API_KEY",
      url: "https://api.mistral.ai/v1/models",
    });
  }, 2_000);

  await runStep(ctx, HEALTH_TEST_NAMES.resendKeyValid, async () => {
    return assertApiKeyValid({
      name: "Resend",
      envKey: "RESEND_API_KEY",
      url: "https://api.resend.com/domains",
    });
  }, 2_000);

  await runStep(ctx, HEALTH_TEST_NAMES.authEndpointResponding, async () => {
    const response = await fetchWithTimeout(`${ctx.state.baseUrl}/api/auth/get-session`, {
      method: "POST",
      headers: buildCookieHeaders(ctx.adminCookieHeader, { "Content-Type": "application/json" }),
      body: JSON.stringify({}),
    }, 5_000);
    if (response.status >= 500) {
      throw new Error(`Auth endpoint returned ${response.status}`);
    }
    await response.text();
    return `Auth endpoint responded with ${response.status}`;
  }, 500);

  await runStep(ctx, HEALTH_TEST_NAMES.adminEndpointsResponding, async () => {
    const response = await fetchWithTimeout(`${ctx.state.baseUrl}/api/admin/users`, {
      method: "GET",
      headers: buildCookieHeaders(ctx.adminCookieHeader),
    }, 5_000);
    if (!response.ok) {
      const data = await readJson(response);
      throw new Error(`/api/admin/users returned ${response.status}: ${getResponseMessage(data, "Request failed")}`);
    }
    await response.text();
    return "Admin users endpoint returned 200";
  }, 500);
}

async function runPipelineChecks(ctx) {
  await runHealthChecks(ctx, { includeAll: false });

  let uploaded = null;

  const signInOk = await runStep(ctx, PIPELINE_TEST_NAMES.signIn, async () => {
    const session = await signInQaAccount(ctx.auth);
    ctx.state.qaCookieHeader = session.cookieHeader;
    ctx.state.qaUserId = session.userId;
    return "QA account signed in and returned a session token";
  });

  if (!signInOk) {
    skipTests(ctx, TIER_TEST_SEQUENCES.pipeline.slice(2), "Skipped because QA sign-in failed");
    return;
  }

  const uploadOk = await runStep(ctx, PIPELINE_TEST_NAMES.uploadPdf, async () => {
    uploaded = await uploadFixtureForRun(ctx.state, "pipelinePdf");
    return "Pipeline test PDF uploaded and extraction job was created";
  });

  if (!uploadOk) {
    skipTests(ctx, TIER_TEST_SEQUENCES.pipeline.slice(3, 7), "Skipped because pipeline PDF upload failed");
    if (ctx.state.qaCookieHeader) {
      await runStep(ctx, PIPELINE_TEST_NAMES.signOut, async () => {
        await signOutQaAccount(ctx.auth, ctx.state.qaCookieHeader);
        return "QA session was signed out";
      });
    }
    return;
  }

  const extractionOk = await runStep(ctx, PIPELINE_TEST_NAMES.extraction, async () => {
    await waitForExtraction(ctx.state.baseUrl, ctx.state.qaCookieHeader, uploaded.documentId, uploaded.jobId, {
      timeoutMs: 45_000,
      pollMs: 3_000,
    });
    return "Pipeline PDF extraction completed";
  }, 15_000);

  if (!extractionOk) {
    skipTests(ctx, TIER_TEST_SEQUENCES.pipeline.slice(4, 7), "Skipped because extraction failed");
    if (ctx.state.qaCookieHeader) {
      await runStep(ctx, PIPELINE_TEST_NAMES.signOut, async () => {
        await signOutQaAccount(ctx.auth, ctx.state.qaCookieHeader);
        return "QA session was signed out";
      });
    }
    return;
  }

  const generationOk = await runStep(ctx, PIPELINE_TEST_NAMES.generation, async () => {
    const generatedDocument = await waitForGenerationQuality(
      ctx.state.baseUrl,
      ctx.state.qaCookieHeader,
      uploaded.documentId,
      ctx.state,
      { timeoutMs: 90_000, pollMs: 5_000, thresholds: PIPELINE_EXISTENCE_THRESHOLDS },
    );
    return formatQualityPassMessage(generatedDocument);
  }, 60_000);

  if (!generationOk) {
    skipStep(ctx, PIPELINE_TEST_NAMES.exportPdf, "Skipped because generation failed");
  } else {
    await runStep(ctx, PIPELINE_TEST_NAMES.exportPdf, async () => {
      await requestPdfExport(ctx.state.baseUrl, ctx.state.qaCookieHeader, uploaded.documentId, 12_000);
      return "Generated summary exported as application/pdf";
    }, 3_000);
  }

  await runStep(ctx, PIPELINE_TEST_NAMES.deleteDocument, async () => {
    await cleanupQaDocument(ctx.state, "pipelinePdf");
    return "Pipeline test document deleted";
  }, 3_000);

  if (ctx.state.qaCookieHeader) {
    await runStep(ctx, PIPELINE_TEST_NAMES.signOut, async () => {
      await signOutQaAccount(ctx.auth, ctx.state.qaCookieHeader);
      return "QA session was signed out";
    });
  }
}

async function runFullChecks(ctx) {
  const thresholds = FULL_QUALITY_THRESHOLDS[ctx.tier] || FULL_QUALITY_THRESHOLDS.full;
  let canRunAuthenticatedTests = true;

  const healthOk = await runStep(ctx, FULL_TEST_NAMES.health, async () => {
    return assertBackendAlive(ctx.state.baseUrl);
  }, 500);

  if (!healthOk) {
    skipTests(ctx, TIER_TEST_SEQUENCES[ctx.tier].slice(1), "Skipped because the health check failed");
    canRunAuthenticatedTests = false;
  }

  if (canRunAuthenticatedTests) {
    const signInOk = await runStep(ctx, FULL_TEST_NAMES.signIn, async () => {
      const session = await signInQaAccount(ctx.auth);
      ctx.state.qaCookieHeader = session.cookieHeader;
      ctx.state.qaUserId = session.userId;
      return "QA account signed in and returned a session token";
    });

    if (!signInOk) {
      skipTests(ctx, TIER_TEST_SEQUENCES[ctx.tier].slice(2), "Skipped because QA sign-in failed");
      canRunAuthenticatedTests = false;
    }
  }

  if (!canRunAuthenticatedTests) return;

  const runUploadAndProcess = async ({
    key,
    uploadTestName,
    processTestName,
    totalTimeoutMs,
    uploadMessage,
  }) => {
    const uploaded = await runStep(ctx, uploadTestName, async () => {
      await uploadFixtureForRun(ctx.state, key);
      return uploadMessage || `${QA_FIXTURES[key].label} uploaded and extraction job was created`;
    });

    if (!uploaded) {
      await cleanupQaDocument(ctx.state, key);
      skipStep(ctx, processTestName, `Skipped because ${QA_FIXTURES[key].label} upload failed`);
      return;
    }

    await runStep(ctx, processTestName, async () => {
      return waitForFixtureExtractionAndQuality(ctx.state, key, {
        totalTimeoutMs,
        extractionPollMs: 5_000,
        generationPollMs: 5_000,
        thresholds,
      });
    });
  };

  const englishPdfUploaded = await runStep(ctx, FULL_TEST_NAMES.uploadEnglishPdf, async () => {
    const upload = await uploadFixtureForRun(ctx.state, "englishPdf");
    ctx.state.documentId = upload.documentId;
    ctx.state.jobId = upload.jobId;
    return "English PDF uploaded and extraction job was created";
  });

  if (!englishPdfUploaded) {
    skipStep(ctx, FULL_TEST_NAMES.extractEnglishPdf, "Skipped because English PDF upload failed");
    skipStep(ctx, FULL_TEST_NAMES.generateEnglishPdf, "Skipped because English PDF upload failed");
  } else {
    let englishPdfExtracted = false;
    const extractionOk = await runStep(ctx, FULL_TEST_NAMES.extractEnglishPdf, async () => {
      const document = getQaDocument(ctx.state, "englishPdf");
      try {
        await waitForExtraction(ctx.state.baseUrl, ctx.state.qaCookieHeader, document.documentId, document.jobId, {
          timeoutMs: 60_000,
          pollMs: 3_000,
        });
        englishPdfExtracted = true;
        return "English PDF extraction completed";
      } finally {
        if (!englishPdfExtracted) {
          await cleanupQaDocument(ctx.state, "englishPdf");
        }
      }
    });

    if (!extractionOk) {
      skipStep(ctx, FULL_TEST_NAMES.generateEnglishPdf, "Skipped because English PDF extraction failed");
    } else {
      await runStep(ctx, FULL_TEST_NAMES.generateEnglishPdf, async () => {
        const document = getQaDocument(ctx.state, "englishPdf");
        try {
          const generatedDocument = await waitForGenerationQuality(
            ctx.state.baseUrl,
            ctx.state.qaCookieHeader,
            document.documentId,
            ctx.state,
            { timeoutMs: 120_000, pollMs: 5_000, thresholds },
          );
          return formatQualityPassMessage(generatedDocument);
        } finally {
          await cleanupQaDocument(ctx.state, "englishPdf");
        }
      });
    }
  }

  await runUploadAndProcess({
    key: "englishDocx",
    uploadTestName: FULL_TEST_NAMES.uploadEnglishDocx,
    processTestName: FULL_TEST_NAMES.processEnglishDocx,
    totalTimeoutMs: 180_000,
  });

  await runUploadAndProcess({
    key: "englishPptx",
    uploadTestName: FULL_TEST_NAMES.uploadEnglishPptx,
    processTestName: FULL_TEST_NAMES.processEnglishPptx,
    totalTimeoutMs: 180_000,
  });

  await runUploadAndProcess({
    key: "arabicPdf",
    uploadTestName: FULL_TEST_NAMES.uploadArabicPdf,
    processTestName: FULL_TEST_NAMES.processArabicPdf,
    totalTimeoutMs: 240_000,
    uploadMessage: "Arabic scanned PDF - tests Mistral OCR path uploaded and extraction job was created",
  });

  await runUploadAndProcess({
    key: "arabicPptx",
    uploadTestName: FULL_TEST_NAMES.uploadArabicPptx,
    processTestName: FULL_TEST_NAMES.processArabicPptx,
    totalTimeoutMs: 180_000,
  });

  await runStep(ctx, FULL_TEST_NAMES.oversizedRejection, async () => {
    return assertOversizedFileRejected(ctx.state);
  });

  await runStep(ctx, FULL_TEST_NAMES.corruptGracefulFailure, async () => {
    return assertCorruptFileFailsGracefully(ctx.state);
  });

  await runStep(ctx, FULL_TEST_NAMES.exportPdf, async () => {
    let exportDocument = null;
    try {
      exportDocument = await uploadTestFile(ctx.state.baseUrl, ctx.state.qaCookieHeader, QA_FIXTURES.englishPdf);
      await waitForExtraction(ctx.state.baseUrl, ctx.state.qaCookieHeader, exportDocument.documentId, exportDocument.jobId, {
        timeoutMs: 60_000,
        pollMs: 3_000,
      });
      await waitForGenerationQuality(ctx.state.baseUrl, ctx.state.qaCookieHeader, exportDocument.documentId, ctx.state, {
        timeoutMs: 120_000,
        pollMs: 5_000,
        thresholds,
      });
      await requestPdfExport(ctx.state.baseUrl, ctx.state.qaCookieHeader, exportDocument.documentId);
      return "Fresh English PDF generated and exported as application/pdf";
    } finally {
      if (exportDocument?.documentId) {
        await cleanupDocument(ctx.state.baseUrl, ctx.state.qaCookieHeader, exportDocument.documentId);
      }
    }
  });

  await runStep(ctx, FULL_TEST_NAMES.adminHealth, async () => {
    await checkAdminEndpoints(ctx.state.baseUrl, ctx.adminCookieHeader);
    return "Users, jobs, and usage admin endpoints returned 200";
  });

  if (ctx.state.qaCookieHeader && !ctx.results.some((result) => result.name === FULL_TEST_NAMES.signOut)) {
    await runStep(ctx, FULL_TEST_NAMES.signOut, async () => {
      await signOutQaAccount(ctx.auth, ctx.state.qaCookieHeader);
      return "QA session was signed out";
    });
  }
}

async function runQaTier({
  prisma,
  auth,
  tier,
  baseUrl,
  adminCookieHeader = "",
  triggeredBy = "unknown",
}) {
  const target = QA_TARGET;
  const runStartedAt = new Date();
  const runStartedMs = Date.now();
  const durationEstimates = await getQaDurationEstimates(prisma, tier);
  const state = {
    baseUrl,
    qaCookieHeader: "",
    qaUserId: "",
    documentId: "",
    jobId: "",
    generationJobIds: [],
    documents: new Map(),
  };
  const ctx = {
    prisma,
    auth,
    tier,
    target,
    adminCookieHeader,
    triggeredBy,
    state,
    results: [],
  };

  beginQaProgress({ target, tier, triggeredBy, estimates: durationEstimates });
  const progressStartedAtMs = currentQaProgress?.startedAtMs;

  try {
    if (tier === "health") {
      await runHealthChecks(ctx, { includeAll: true });
    } else if (tier === "pipeline") {
      await runPipelineChecks(ctx);
    } else {
      await runFullChecks(ctx);
    }
  } finally {
    await cleanupAllQaDocuments(state);
  }

  const estimatedCostUsd = await calculateEstimatedCost(prisma, state, runStartedAt);
  const totalDurationMs = elapsedSince(runStartedMs);
  const passed = ctx.results.filter((result) => result.status === "pass").length;
  const failed = ctx.results.filter((result) => result.status === "fail").length;
  const skipped = getSkippedCount(ctx.results);
  const failureReport = buildFailureReport({
    tier,
    target,
    ranAt: runStartedAt,
    passed,
    failed,
    results: ctx.results,
  });
  const savedRun = await saveQaRun(prisma, {
    target,
    tier,
    ranAt: runStartedAt,
    totalDurationMs,
    passed,
    failed,
    skipped,
    estimatedCostUsd,
    triggeredBy,
    failureReport,
    results: ctx.results,
  });

  const finalResult = {
    id: savedRun?.id || null,
    target,
    tier,
    tierLabel: getTierLabel(tier),
    ranAt: runStartedAt.toISOString(),
    totalDurationMs,
    passed,
    failed,
    skipped,
    results: ctx.results,
    estimatedCostUsd,
    triggeredBy,
    failureReport,
  };

  console.info("[qa] QA run completed", {
    id: finalResult.id,
    target,
    tier,
    passed,
    failed,
    skipped,
    totalDurationMs,
  });

  if (currentQaProgress?.startedAtMs === progressStartedAtMs) {
    clearQaProgress();
  }

  return finalResult;
}

function startQaRunInBackground(options) {
  void runQaTier(options).catch((error) => {
    console.error("[qa] QA run failed unexpectedly:", error);
    clearQaProgress();
  });
}

async function getScheduleConfig(prisma) {
  const existing = await prisma.qaScheduleConfig.findFirst({
    orderBy: { updatedAt: "desc" },
  });

  if (existing) {
    return existing;
  }

  return prisma.qaScheduleConfig.create({
    data: {
      enabled: false,
      frequencyMins: 60,
      tier: "health",
    },
  });
}

function serializeScheduleConfig(config) {
  return {
    enabled: Boolean(config?.enabled),
    frequencyMins: Number(config?.frequencyMins || 60),
    tier: config?.tier || "health",
  };
}

async function updateScheduleConfig(prisma, body = {}) {
  const enabled = Boolean(body.enabled);
  const frequencyMins = Number(body.frequencyMins || 60);
  const tier = typeof body.tier === "string" && body.tier.trim() ? body.tier.trim().toLowerCase() : "health";

  if (!QA_SCHEDULE_FREQUENCIES.has(frequencyMins)) {
    const error = new Error("frequencyMins must be one of 30, 60, 180, 360, 720, 1440");
    error.status = 400;
    throw error;
  }

  if (tier !== "health") {
    const error = new Error("Only the health tier can be scheduled");
    error.status = 400;
    throw error;
  }

  const existing = await getScheduleConfig(prisma);
  return prisma.qaScheduleConfig.update({
    where: { id: existing.id },
    data: {
      enabled,
      frequencyMins,
      tier,
    },
  });
}

function buildHealthFailureTelegramMessage(failure) {
  return [
    "\u{1F6A8} Health Check Failed \u2014 Studymaxing Staging",
    `Failed: ${failure.name}`,
    `Reason: ${failure.message}`,
    `Time: ${new Date().toISOString()}`,
    "",
    "Run QA at: https://stage.studymaxing.com/#/admin",
  ].join("\n");
}

async function runScheduledHealthCheck() {
  if (!qaScheduleContext) return;
  if (currentQaProgress?.inProgress) {
    console.info("[qa] Skipping scheduled health check because another QA run is active");
    return;
  }

  const result = await runQaTier({
    ...qaScheduleContext,
    tier: "health",
    baseUrl: getStagingBaseUrl(),
    adminCookieHeader: "",
    triggeredBy: "auto",
  });
  const firstFailure = result.results.find((item) => item.status === "fail");

  if (firstFailure) {
    await sendTelegramRawNotification({
      text: buildHealthFailureTelegramMessage(firstFailure),
    });
  }
}

async function restartQaScheduleInterval() {
  if (!qaScheduleContext) return;

  if (qaScheduleTimer) {
    clearInterval(qaScheduleTimer);
    qaScheduleTimer = null;
  }

  const config = await getScheduleConfig(qaScheduleContext.prisma);
  if (!config.enabled) return;

  qaScheduleTimer = setInterval(() => {
    void runScheduledHealthCheck().catch((error) => {
      console.error("[qa] Scheduled health check failed:", error);
    });
  }, config.frequencyMins * 60 * 1000);
}

export async function initializeQaScheduler({ prisma, auth }) {
  try {
    assertQaServiceIsStaging();
    qaScheduleContext = { prisma, auth };
    await restartQaScheduleInterval();
  } catch (error) {
    qaScheduleContext = null;
    console.error("[qa] Failed to initialize QA scheduler:", error);
  }
}

function ensureRunCanStart(req, res, tier) {
  if (currentQaProgress?.inProgress) {
    res.status(409).json({ error: "A QA run is already in progress" });
    return false;
  }

  const rateLimitState = getRateLimitState(req, tier);
  if (rateLimitState.limited) {
    const retryAfterSeconds = Math.max(1, Math.ceil(rateLimitState.retryAfterMs / 1000));
    res.setHeader("Retry-After", String(retryAfterSeconds));
    res.status(429).json({
      error: `${getRateLimitLabel(tier)} was run recently. Please wait ${Math.max(1, Math.ceil(retryAfterSeconds / 60))} minutes before running again.`,
      retryAfterSeconds,
      retryAfterMinutes: Math.max(1, Math.ceil(retryAfterSeconds / 60)),
    });
    return false;
  }

  return true;
}

export const createQaRouter = ({ prisma, auth, env = process.env }) => {
  const router = express.Router();

  router.use((_req, res, next) => {
    try {
      assertQaServiceIsStaging(env);
      next();
    } catch (error) {
      return res.status(error.status || 503).json({ error: error.message });
    }
  });

  router.get("/history", async (_req, res) => {
    try {
      const runs = await prisma.qaRun.findMany({
        orderBy: { ranAt: "desc" },
        include: {
          results: {
            orderBy: { order: "asc" },
          },
        },
      });

      return res.json({ runs: runs.map(serializeQaRun) });
    } catch (error) {
      console.error("[qa] Failed to fetch QA history:", error);
      return res.status(500).json({ error: "Failed to fetch QA history" });
    }
  });

  router.get("/progress", (_req, res) => {
    return res.json(getProgressSnapshot());
  });

  router.get("/schedule", async (_req, res) => {
    try {
      const config = await getScheduleConfig(prisma);
      return res.json(serializeScheduleConfig(config));
    } catch (error) {
      console.error("[qa] Failed to fetch QA schedule config:", error);
      return res.status(500).json({ error: "Failed to fetch QA schedule config" });
    }
  });

  router.post("/schedule", async (req, res) => {
    try {
      const config = await updateScheduleConfig(prisma, req.body);
      await restartQaScheduleInterval();
      return res.json(serializeScheduleConfig(config));
    } catch (error) {
      console.error("[qa] Failed to update QA schedule config:", error);
      return res.status(error.status || 500).json({ error: error.message || "Failed to update QA schedule config" });
    }
  });

  async function handleTierRun(req, res, tier) {
    const requestedTarget = req.body?.target;
    if (requestedTarget !== undefined && !normalizeTarget(requestedTarget)) {
      return res.status(400).json({ error: "target must be staging" });
    }

    let baseUrl;
    try {
      baseUrl = getStagingBaseUrl();
    } catch (error) {
      console.error("[qa] Staging target configuration is invalid:", error.message);
      return res.status(error.status || 503).json({ error: error.message });
    }

    if (!ensureRunCanStart(req, res, tier)) {
      return null;
    }

    const triggeredBy = await getTriggeredBy(prisma, req);
    startQaRunInBackground({
      prisma,
      auth,
      tier,
      baseUrl,
      adminCookieHeader: req.headers.cookie || "",
      triggeredBy,
    });

    return res.status(202).json({
      started: true,
      target: QA_TARGET,
      tier,
      tierLabel: getTierLabel(tier),
      totalTests: getTestSequence(tier).length,
    });
  }

  router.post("/health", async (req, res) => {
    return handleTierRun(req, res, "health");
  });

  router.post("/pipeline", async (req, res) => {
    return handleTierRun(req, res, "pipeline");
  });

  router.post("/full", async (req, res) => {
    const mode = normalizeFullMode(req.body?.mode);
    if (!mode) {
      return res.status(400).json({ error: "mode must be optimized or full" });
    }

    return handleTierRun(req, res, mode);
  });

  return router;
};

export const __qaTestables = Object.freeze({
  assertQaServiceIsStaging,
  getStagingBaseUrl,
  normalizeTarget,
});
