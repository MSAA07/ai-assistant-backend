import express from "express";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const QA_TESTS_DIR = path.resolve(__dirname, "../tests");
const QA_RATE_LIMIT_MS = 5 * 60 * 1000;
const QA_EMAIL = "qa@studymaxing.com";
const QA_PASSWORD = "tester123";

// qa@studymaxing.com is a system account used by the QA runner and must not be deleted.
const QA_ACCOUNT = Object.freeze({
  email: QA_EMAIL,
  password: QA_PASSWORD,
});

const DEFAULT_TARGETS = Object.freeze({
  staging: "https://ai-assistant-backend-staging.up.railway.app",
  production: "https://ai-assistant-backend-production-ddf0.up.railway.app",
});

const TEST_NAMES = Object.freeze({
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

const TEST_SEQUENCE = Object.freeze([
  TEST_NAMES.health,
  TEST_NAMES.signIn,
  TEST_NAMES.uploadEnglishPdf,
  TEST_NAMES.extractEnglishPdf,
  TEST_NAMES.generateEnglishPdf,
  TEST_NAMES.uploadEnglishDocx,
  TEST_NAMES.processEnglishDocx,
  TEST_NAMES.uploadEnglishPptx,
  TEST_NAMES.processEnglishPptx,
  TEST_NAMES.uploadArabicPdf,
  TEST_NAMES.processArabicPdf,
  TEST_NAMES.uploadArabicPptx,
  TEST_NAMES.processArabicPptx,
  TEST_NAMES.oversizedRejection,
  TEST_NAMES.corruptGracefulFailure,
  TEST_NAMES.exportPdf,
  TEST_NAMES.adminHealth,
  TEST_NAMES.signOut,
]);

const TEST_INDEX_BY_NAME = new Map(TEST_SEQUENCE.map((name, index) => [name, index + 1]));

const BASELINE_TEST_DURATIONS_MS = Object.freeze({
  [TEST_NAMES.health]: 500,
  [TEST_NAMES.signIn]: 1_500,
  [TEST_NAMES.uploadEnglishPdf]: 3_000,
  [TEST_NAMES.extractEnglishPdf]: 20_000,
  [TEST_NAMES.generateEnglishPdf]: 67_000,
  [TEST_NAMES.uploadEnglishDocx]: 5_000,
  [TEST_NAMES.processEnglishDocx]: 55_000,
  [TEST_NAMES.uploadEnglishPptx]: 5_000,
  [TEST_NAMES.processEnglishPptx]: 55_000,
  [TEST_NAMES.uploadArabicPdf]: 5_000,
  [TEST_NAMES.processArabicPdf]: 115_000,
  [TEST_NAMES.uploadArabicPptx]: 5_000,
  [TEST_NAMES.processArabicPptx]: 55_000,
  [TEST_NAMES.oversizedRejection]: 5_000,
  [TEST_NAMES.corruptGracefulFailure]: 15_000,
  [TEST_NAMES.exportPdf]: 28_000,
  [TEST_NAMES.adminHealth]: 1_000,
  [TEST_NAMES.signOut]: 1_000,
});

const QA_FIXTURES = Object.freeze({
  englishPdf: {
    path: path.join(QA_TESTS_DIR, "qa-test-document.pdf"),
    filename: "qa-test-document.pdf",
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

const qaRunRateLimit = new Map();
let currentQaProgress = null;

function normalizeTarget(value) {
  const target = typeof value === "string" ? value.trim().toLowerCase() : "";
  return target === "staging" || target === "production" ? target : "";
}

function normalizeBaseUrl(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function getTargetBaseUrl(target) {
  const envKey = target === "production"
    ? "QA_PRODUCTION_API_BASE_URL"
    : "QA_STAGING_API_BASE_URL";
  return normalizeBaseUrl(process.env[envKey])
    || normalizeBaseUrl(process.env.QA_API_BASE_URL)
    || DEFAULT_TARGETS[target];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function elapsedSince(startedAt) {
  return Math.max(0, Date.now() - startedAt);
}

function createResult(name, status, message, durationMs = 0) {
  return {
    name,
    status,
    message,
    durationMs: Math.max(0, Math.round(durationMs)),
    order: getTestOrder(name),
  };
}

function getTestOrder(testName) {
  return TEST_INDEX_BY_NAME.get(testName) || TEST_SEQUENCE.length;
}

function getSkippedCount(results) {
  return results.filter((result) => result.status === "skip").length;
}

function serializeQaRun(qaRun) {
  return {
    id: qaRun.id,
    target: qaRun.target,
    ranAt: qaRun.ranAt,
    totalDurationMs: qaRun.totalDurationMs,
    passed: qaRun.passed,
    failed: qaRun.failed,
    skipped: qaRun.skipped,
    estimatedCostUsd: qaRun.estimatedCostUsd,
    triggeredBy: qaRun.triggeredBy,
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
        order: result.order,
      })),
  };
}

async function getQaDurationEstimates(prisma) {
  const estimates = { ...BASELINE_TEST_DURATIONS_MS };

  try {
    const groups = await prisma.qaRunResult.groupBy({
      by: ["testName"],
      _avg: { durationMs: true },
    });

    for (const group of groups) {
      const average = Number(group._avg?.durationMs);
      if (TEST_INDEX_BY_NAME.has(group.testName) && Number.isFinite(average) && average > 0) {
        estimates[group.testName] = Math.round(average);
      }
    }
  } catch (error) {
    console.error("[qa] Failed to load QA duration estimates:", error);
  }

  return estimates;
}

function beginQaProgress({ target, triggeredBy, estimates }) {
  currentQaProgress = {
    inProgress: true,
    target,
    triggeredBy,
    startedAtMs: Date.now(),
    currentTest: "",
    currentTestIndex: 0,
    currentTestStartedAtMs: null,
    completedResults: [],
    estimates,
  };
}

function setCurrentQaTest(testName) {
  if (!currentQaProgress?.inProgress) return;

  currentQaProgress.currentTest = testName;
  currentQaProgress.currentTestIndex = getTestOrder(testName);
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
  const totalTests = TEST_SEQUENCE.length;
  const elapsedMs = elapsedSince(currentQaProgress.startedAtMs);
  const estimates = currentQaProgress.estimates || BASELINE_TEST_DURATIONS_MS;
  const currentTestIndex = currentQaProgress.currentTestIndex || Math.min(currentQaProgress.completedResults.length + 1, totalTests);
  const currentTest = currentQaProgress.currentTest || TEST_SEQUENCE[currentTestIndex - 1] || "";
  const currentTestStartedAtMs = currentQaProgress.currentTestStartedAtMs || now;
  const currentTestElapsedMs = Math.max(0, now - currentTestStartedAtMs);
  const currentEstimateMs = estimates[currentTest] || BASELINE_TEST_DURATIONS_MS[currentTest] || 1_000;
  const completedEstimateMs = currentQaProgress.completedResults.reduce((sum, result) => {
    return sum + (estimates[result.name] || BASELINE_TEST_DURATIONS_MS[result.name] || result.durationMs || 0);
  }, 0);
  const currentProgressMs = currentTest
    ? Math.min(currentTestElapsedMs, currentEstimateMs)
    : 0;
  const totalEstimatedMs = TEST_SEQUENCE.reduce((sum, name) => {
    return sum + (estimates[name] || BASELINE_TEST_DURATIONS_MS[name] || 0);
  }, 0);
  const remainingAfterCurrentMs = TEST_SEQUENCE
    .slice(Math.max(currentTestIndex, 0))
    .reduce((sum, name) => sum + (estimates[name] || BASELINE_TEST_DURATIONS_MS[name] || 0), 0);
  const estimatedRemainingMs = Math.max(0, currentEstimateMs - currentTestElapsedMs) + remainingAfterCurrentMs;
  const percentComplete = totalEstimatedMs > 0
    ? Math.max(0, Math.min(99, Math.round(((completedEstimateMs + currentProgressMs) / totalEstimatedMs) * 100)))
    : 0;

  return {
    inProgress: true,
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
    if (now - timestamp > QA_RATE_LIMIT_MS) {
      qaRunRateLimit.delete(key);
    }
  }
}

function getRateLimitState(req) {
  const now = Date.now();
  pruneRateLimits(now);

  const key = getAdminSessionKey(req);
  const lastRunAt = qaRunRateLimit.get(key) || 0;
  const elapsedMs = now - lastRunAt;

  if (lastRunAt && elapsedMs < QA_RATE_LIMIT_MS) {
    return {
      limited: true,
      key,
      retryAfterMs: QA_RATE_LIMIT_MS - elapsedMs,
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

    if (nextExpires) {
      inExpires = true;
    }

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
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  if (typeof headers.get === "function") {
    return splitSetCookieHeader(headers.get("set-cookie") || "");
  }
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

function getQualityFailures(document) {
  const stats = getGeneratedMaterialStats(document);
  const failures = [];

  if (stats.summaryLength < 100) {
    failures.push(`Summary too short (${stats.summaryLength} chars)`);
  }

  if (stats.flashcardCount < 3) {
    failures.push(`Only ${stats.flashcardCount} ${pluralize(stats.flashcardCount, "flashcard")} generated`);
  }

  if (stats.questionCount < 3) {
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
  formData.append(
    "file",
    new Blob([fileBuffer], { type: fixture.mimeType }),
    fixture.filename,
  );

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
      if (document?.processingStatus === "complete") {
        return;
      }
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
    const qualityFailures = getQualityFailures(document);

    if (qualityFailures.length === 0) {
      return document;
    }

    const activeJobIds = queuedGenerations
      .map((generation) => generation.jobId)
      .filter(Boolean);
    for (const activeJobId of activeJobIds) {
      const job = await getJob(baseUrl, cookieHeader, activeJobId);
      if (job.status === "failed") {
        throw new Error(job.errorMessage || `Generation job ${activeJobId} failed`);
      }
    }

    await sleep(pollMs);
  }

  const document = await getDocument(baseUrl, cookieHeader, documentId).catch(() => null);
  const qualityFailures = getQualityFailures(document);
  throw new Error(
    qualityFailures.length > 0
      ? `Generation quality check failed: ${qualityFailures.join("; ")}`
      : `Generation timed out after ${Math.round(timeoutMs / 1000)}s`,
  );
}

async function requestPdfExport(baseUrl, cookieHeader, documentId) {
  const response = await fetchWithTimeout(`${baseUrl}/api/document/${encodeURIComponent(documentId)}/export-pdf?feature=summary`, {
    method: "GET",
    headers: buildCookieHeaders(cookieHeader),
  }, 30_000);

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
    });
    return formatQualityPassMessage(generatedDocument);
  } finally {
    await cleanupQaDocument(state, key);
  }
}

function skipTests(results, testNames, message) {
  for (const testName of testNames) {
    skipStep(results, testName, message);
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
  if (!userId) {
    return "unknown";
  }

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

async function saveQaRun(prisma, {
  target,
  ranAt,
  totalDurationMs,
  passed,
  failed,
  skipped,
  estimatedCostUsd,
  triggeredBy,
  results,
}) {
  try {
    return await prisma.qaRun.create({
      data: {
        target,
        ranAt,
        totalDurationMs,
        passed,
        failed,
        skipped,
        estimatedCostUsd,
        triggeredBy,
        results: {
          create: results.map((result, index) => ({
            testName: result.name,
            status: result.status,
            message: result.message,
            durationMs: result.durationMs,
            order: getTestOrder(result.name) || index + 1,
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

async function runStep(results, name, fn) {
  const startedAt = Date.now();
  setCurrentQaTest(name);

  try {
    const message = await fn();
    const result = createResult(name, "pass", message || `${name} passed`, elapsedSince(startedAt));
    results.push(result);
    recordQaProgressResult(result);
    return true;
  } catch (error) {
    const message = error?.message || `${name} failed`;
    const result = createResult(name, "fail", message, elapsedSince(startedAt));
    results.push(result);
    recordQaProgressResult(result);
    return false;
  }
}

function skipStep(results, name, message) {
  const result = createResult(name, "skip", message);
  results.push(result);
  recordQaProgressResult(result);
}

export const createQaRouter = ({ prisma, auth }) => {
  const router = express.Router();

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

  router.post("/run", async (req, res) => {
    const target = normalizeTarget(req.body?.target);
    if (!target) {
      return res.status(400).json({ error: "target must be staging or production" });
    }

    if (currentQaProgress?.inProgress) {
      return res.status(409).json({ error: "A QA run is already in progress" });
    }

    const rateLimitState = getRateLimitState(req);
    if (rateLimitState.limited) {
      const retryAfterSeconds = Math.max(1, Math.ceil(rateLimitState.retryAfterMs / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({
        error: "QA was run recently",
        retryAfterSeconds,
        retryAfterMinutes: Math.max(1, Math.ceil(retryAfterSeconds / 60)),
      });
    }

    const adminCookieHeader = req.headers.cookie || "";

    void (async () => {
    const runStartedAt = new Date();
    const runStartedMs = Date.now();
    const results = [];
    const triggeredBy = await getTriggeredBy(prisma, req);
    const durationEstimates = await getQaDurationEstimates(prisma);
    const state = {
      baseUrl: getTargetBaseUrl(target),
      qaCookieHeader: "",
      qaUserId: "",
      documentId: "",
      jobId: "",
      generationJobIds: [],
      documents: new Map(),
    };

    beginQaProgress({ target, triggeredBy, estimates: durationEstimates });
    const progressStartedAtMs = currentQaProgress?.startedAtMs;

    let canRunAuthenticatedTests = true;

    const runUploadAndProcess = async ({
      key,
      uploadTestName,
      processTestName,
      totalTimeoutMs,
      uploadMessage,
    }) => {
      const uploaded = await runStep(results, uploadTestName, async () => {
        await uploadFixtureForRun(state, key);
        return uploadMessage || `${QA_FIXTURES[key].label} uploaded and extraction job was created`;
      });

      if (!uploaded) {
        await cleanupQaDocument(state, key);
        skipStep(results, processTestName, `Skipped because ${QA_FIXTURES[key].label} upload failed`);
        return;
      }

      await runStep(results, processTestName, async () => {
        return await waitForFixtureExtractionAndQuality(state, key, {
          totalTimeoutMs,
          extractionPollMs: 5_000,
          generationPollMs: 5_000,
        });
      });
    };

    const healthOk = await runStep(results, TEST_NAMES.health, async () => {
      const response = await fetchWithTimeout(`${state.baseUrl}/api/health`, { method: "GET" }, 15_000);
      if (!response.ok) {
        throw new Error(`Health check returned ${response.status}`);
      }
      return "Health endpoint returned 200";
    });

    if (!healthOk) {
      skipTests(results, TEST_SEQUENCE.slice(1), "Skipped because the health check failed");
      canRunAuthenticatedTests = false;
    }

    if (canRunAuthenticatedTests) {
      const signInOk = await runStep(results, TEST_NAMES.signIn, async () => {
        const session = await signInQaAccount(auth);
        state.qaCookieHeader = session.cookieHeader;
        state.qaUserId = session.userId;
        return "QA account signed in and returned a session token";
      });

      if (!signInOk) {
        skipTests(results, TEST_SEQUENCE.slice(2), "Skipped because QA sign-in failed");
        canRunAuthenticatedTests = false;
      }
    }

    if (canRunAuthenticatedTests) {
      const englishPdfUploaded = await runStep(results, TEST_NAMES.uploadEnglishPdf, async () => {
        const upload = await uploadFixtureForRun(state, "englishPdf");
        state.documentId = upload.documentId;
        state.jobId = upload.jobId;
        return "English PDF uploaded and extraction job was created";
      });

      if (!englishPdfUploaded) {
        skipStep(results, TEST_NAMES.extractEnglishPdf, "Skipped because English PDF upload failed");
        skipStep(results, TEST_NAMES.generateEnglishPdf, "Skipped because English PDF upload failed");
      } else {
        let englishPdfExtracted = false;
        const extractionOk = await runStep(results, TEST_NAMES.extractEnglishPdf, async () => {
          const document = getQaDocument(state, "englishPdf");
          try {
            await waitForExtraction(state.baseUrl, state.qaCookieHeader, document.documentId, document.jobId, {
              timeoutMs: 60_000,
              pollMs: 3_000,
            });
            englishPdfExtracted = true;
            return "English PDF extraction completed";
          } finally {
            if (!englishPdfExtracted) {
              await cleanupQaDocument(state, "englishPdf");
            }
          }
        });

        if (!extractionOk) {
          skipStep(results, TEST_NAMES.generateEnglishPdf, "Skipped because English PDF extraction failed");
        } else {
          await runStep(results, TEST_NAMES.generateEnglishPdf, async () => {
            const document = getQaDocument(state, "englishPdf");
            try {
              const generatedDocument = await waitForGenerationQuality(
                state.baseUrl,
                state.qaCookieHeader,
                document.documentId,
                state,
                { timeoutMs: 120_000, pollMs: 5_000 },
              );
              return formatQualityPassMessage(generatedDocument);
            } finally {
              await cleanupQaDocument(state, "englishPdf");
            }
          });
        }
      }

      await runUploadAndProcess({
        key: "englishDocx",
        uploadTestName: TEST_NAMES.uploadEnglishDocx,
        processTestName: TEST_NAMES.processEnglishDocx,
        totalTimeoutMs: 180_000,
      });

      await runUploadAndProcess({
        key: "englishPptx",
        uploadTestName: TEST_NAMES.uploadEnglishPptx,
        processTestName: TEST_NAMES.processEnglishPptx,
        totalTimeoutMs: 180_000,
      });

      await runUploadAndProcess({
        key: "arabicPdf",
        uploadTestName: TEST_NAMES.uploadArabicPdf,
        processTestName: TEST_NAMES.processArabicPdf,
        totalTimeoutMs: 240_000,
        uploadMessage: "Arabic scanned PDF - tests Mistral OCR path uploaded and extraction job was created",
      });

      await runUploadAndProcess({
        key: "arabicPptx",
        uploadTestName: TEST_NAMES.uploadArabicPptx,
        processTestName: TEST_NAMES.processArabicPptx,
        totalTimeoutMs: 180_000,
      });

      await runStep(results, TEST_NAMES.oversizedRejection, async () => {
        return await assertOversizedFileRejected(state);
      });

      await runStep(results, TEST_NAMES.corruptGracefulFailure, async () => {
        return await assertCorruptFileFailsGracefully(state);
      });

      await runStep(results, TEST_NAMES.exportPdf, async () => {
        let exportDocument = null;
        try {
          exportDocument = await uploadTestFile(state.baseUrl, state.qaCookieHeader, QA_FIXTURES.englishPdf);
          await waitForExtraction(state.baseUrl, state.qaCookieHeader, exportDocument.documentId, exportDocument.jobId, {
            timeoutMs: 60_000,
            pollMs: 3_000,
          });
          await waitForGenerationQuality(state.baseUrl, state.qaCookieHeader, exportDocument.documentId, state, {
            timeoutMs: 120_000,
            pollMs: 5_000,
          });
          await requestPdfExport(state.baseUrl, state.qaCookieHeader, exportDocument.documentId);
          return "Fresh English PDF generated and exported as application/pdf";
        } finally {
          if (exportDocument?.documentId) {
            await cleanupDocument(state.baseUrl, state.qaCookieHeader, exportDocument.documentId);
          }
        }
      });

      await runStep(results, TEST_NAMES.adminHealth, async () => {
        await checkAdminEndpoints(state.baseUrl, adminCookieHeader);
        return "Users, jobs, and usage admin endpoints returned 200";
      });
    }

    await cleanupAllQaDocuments(state);
    const estimatedCostUsd = await calculateEstimatedCost(prisma, state, runStartedAt);

    if (state.qaCookieHeader && !results.some((result) => result.name === TEST_NAMES.signOut)) {
      await runStep(results, TEST_NAMES.signOut, async () => {
        await signOutQaAccount(auth, state.qaCookieHeader);
        return "QA session was signed out";
      });
    }

    const totalDurationMs = elapsedSince(runStartedMs);
    const passed = results.filter((result) => result.status === "pass").length;
    const failed = results.filter((result) => result.status === "fail").length;
    const skipped = getSkippedCount(results);
    const savedRun = await saveQaRun(prisma, {
      target,
      ranAt: runStartedAt,
      totalDurationMs,
      passed,
      failed,
      skipped,
      estimatedCostUsd,
      triggeredBy,
      results,
    });

    const finalResult = {
      id: savedRun?.id || null,
      target,
      ranAt: runStartedAt.toISOString(),
      totalDurationMs,
      passed,
      failed,
      skipped,
      results,
      estimatedCostUsd,
      triggeredBy,
    };

    console.info("[qa] QA run completed", {
      id: finalResult.id,
      target,
      passed,
      failed,
      skipped,
      totalDurationMs,
    });

    if (currentQaProgress?.startedAtMs === progressStartedAtMs) {
      clearQaProgress();
    }
    })().catch((error) => {
      console.error("[qa] QA run failed unexpectedly:", error);
      clearQaProgress();
    });

    return res.status(202).json({
      started: true,
      target,
      totalTests: TEST_SEQUENCE.length,
    });
  });

  return router;
};
