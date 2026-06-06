import express from "express";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const QA_TEST_PDF_PATH = path.resolve(__dirname, "../tests/qa-test-document.pdf");
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
  upload: "Upload test PDF",
  extraction: "Wait for extraction to complete",
  generation: "Wait for AI generation to complete",
  exportPdf: "PDF export",
  adminHealth: "Admin endpoints health",
  signOut: "Sign out QA account",
});

const TEST_SEQUENCE = Object.freeze([
  TEST_NAMES.health,
  TEST_NAMES.signIn,
  TEST_NAMES.upload,
  TEST_NAMES.extraction,
  TEST_NAMES.generation,
  TEST_NAMES.exportPdf,
  TEST_NAMES.adminHealth,
  TEST_NAMES.signOut,
]);

const TEST_INDEX_BY_NAME = new Map(TEST_SEQUENCE.map((name, index) => [name, index + 1]));

const BASELINE_TEST_DURATIONS_MS = Object.freeze({
  [TEST_NAMES.health]: 500,
  [TEST_NAMES.signIn]: 1_000,
  [TEST_NAMES.upload]: 3_000,
  [TEST_NAMES.extraction]: 20_000,
  [TEST_NAMES.generation]: 90_000,
  [TEST_NAMES.exportPdf]: 5_000,
  [TEST_NAMES.adminHealth]: 1_000,
  [TEST_NAMES.signOut]: 500,
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

function hasGeneratedMaterials(document) {
  const summary = typeof document?.summary === "string" ? document.summary.trim() : "";
  const flashcards = Array.isArray(document?.flashcards) ? document.flashcards : [];
  const examQuestions = Array.isArray(document?.examQuestions) ? document.examQuestions : [];
  const flashcardCount = Number(document?.flashcardCount) || flashcards.length;
  const questionCount = Number(document?.questionCount) || examQuestions.length;

  return {
    summary: summary.length > 0,
    flashcards: flashcards.length > 0 || flashcardCount > 0,
    exam: examQuestions.length > 0 || questionCount > 0,
  };
}

function getMissingMaterials(document) {
  const materials = hasGeneratedMaterials(document);
  return Object.entries(materials)
    .filter(([, exists]) => !exists)
    .map(([name]) => name);
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

async function uploadTestPdf(baseUrl, cookieHeader) {
  const pdfBuffer = await fs.readFile(QA_TEST_PDF_PATH);
  const formData = new FormData();
  formData.append(
    "file",
    new Blob([pdfBuffer], { type: "application/pdf" }),
    "qa-test-document.pdf",
  );

  const { data } = await fetchJson(`${baseUrl}/api/upload`, {
    method: "POST",
    headers: buildCookieHeaders(cookieHeader),
    body: formData,
  }, 30_000, "PDF upload failed");

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

async function waitForExtraction(baseUrl, cookieHeader, documentId, jobId) {
  const startedAt = Date.now();

  while (elapsedSince(startedAt) < 60_000) {
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

    await sleep(3_000);
  }

  throw new Error("Extraction timed out after 60s");
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

async function waitForGeneration(baseUrl, cookieHeader, documentId, state) {
  const queuedGenerations = [];

  for (const generationType of ["summary", "flashcards", "exam"]) {
    const queuedGeneration = await queueGeneration(baseUrl, cookieHeader, documentId, generationType);
    queuedGenerations.push(queuedGeneration);
    if (queuedGeneration.jobId) {
      state.generationJobIds.push(queuedGeneration.jobId);
    }
  }

  const startedAt = Date.now();

  while (elapsedSince(startedAt) < 120_000) {
    const document = await getDocument(baseUrl, cookieHeader, documentId);
    const missing = getMissingMaterials(document);

    if (missing.length === 0) {
      return;
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

    await sleep(5_000);
  }

  const document = await getDocument(baseUrl, cookieHeader, documentId).catch(() => null);
  const missing = getMissingMaterials(document);
  throw new Error(
    missing.length > 0
      ? `Generation timed out after 120s; missing ${missing.join(", ")}`
      : "Generation timed out after 120s",
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

async function checkAdminEndpoints(baseUrl, req) {
  const adminCookieHeader = req.headers.cookie || "";
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
    };

    beginQaProgress({ target, triggeredBy, estimates: durationEstimates });
    const progressStartedAtMs = currentQaProgress?.startedAtMs;
    res.on("finish", () => {
      if (currentQaProgress?.startedAtMs === progressStartedAtMs) {
        clearQaProgress();
      }
    });

    let shouldContinue = true;

    shouldContinue = await runStep(results, TEST_NAMES.health, async () => {
      const response = await fetchWithTimeout(`${state.baseUrl}/api/health`, { method: "GET" }, 15_000);
      if (!response.ok) {
        throw new Error(`Health check returned ${response.status}`);
      }
      return "Health endpoint returned 200";
    });

    if (!shouldContinue) {
      skipStep(results, TEST_NAMES.signIn, "Skipped because the health check failed");
      skipStep(results, TEST_NAMES.upload, "Skipped because the health check failed");
      skipStep(results, TEST_NAMES.extraction, "Skipped because the health check failed");
      skipStep(results, TEST_NAMES.generation, "Skipped because the health check failed");
      skipStep(results, TEST_NAMES.exportPdf, "Skipped because the health check failed");
      skipStep(results, TEST_NAMES.adminHealth, "Skipped because the health check failed");
      skipStep(results, TEST_NAMES.signOut, "Skipped because no QA session was created");
    }

    if (shouldContinue) {
      shouldContinue = await runStep(results, TEST_NAMES.signIn, async () => {
        const session = await signInQaAccount(auth);
        state.qaCookieHeader = session.cookieHeader;
        state.qaUserId = session.userId;
        return "QA account signed in and returned a session token";
      });
    }

    if (!shouldContinue && state.qaCookieHeader) {
      skipStep(results, TEST_NAMES.upload, "Skipped because QA sign-in failed");
      skipStep(results, TEST_NAMES.extraction, "Skipped because QA sign-in failed");
      skipStep(results, TEST_NAMES.generation, "Skipped because QA sign-in failed");
      skipStep(results, TEST_NAMES.exportPdf, "Skipped because QA sign-in failed");
      skipStep(results, TEST_NAMES.adminHealth, "Skipped because QA sign-in failed");
    } else if (!shouldContinue && results.at(-1)?.name === TEST_NAMES.signIn) {
      skipStep(results, TEST_NAMES.upload, "Skipped because QA sign-in failed");
      skipStep(results, TEST_NAMES.extraction, "Skipped because QA sign-in failed");
      skipStep(results, TEST_NAMES.generation, "Skipped because QA sign-in failed");
      skipStep(results, TEST_NAMES.exportPdf, "Skipped because QA sign-in failed");
      skipStep(results, TEST_NAMES.adminHealth, "Skipped because QA sign-in failed");
      skipStep(results, TEST_NAMES.signOut, "Skipped because no QA session was created");
    }

    if (shouldContinue) {
      shouldContinue = await runStep(results, TEST_NAMES.upload, async () => {
        const upload = await uploadTestPdf(state.baseUrl, state.qaCookieHeader);
        state.documentId = upload.documentId;
        state.jobId = upload.jobId;
        return "Test PDF uploaded and extraction job was created";
      });
    }

    if (!shouldContinue && state.qaCookieHeader && results.at(-1)?.name === TEST_NAMES.upload) {
      skipStep(results, TEST_NAMES.extraction, "Skipped because upload failed");
      skipStep(results, TEST_NAMES.generation, "Skipped because upload failed");
      skipStep(results, TEST_NAMES.exportPdf, "Skipped because upload failed");
      skipStep(results, TEST_NAMES.adminHealth, "Skipped because upload failed");
    }

    if (shouldContinue) {
      shouldContinue = await runStep(results, TEST_NAMES.extraction, async () => {
        await waitForExtraction(state.baseUrl, state.qaCookieHeader, state.documentId, state.jobId);
        return "Extraction completed for the QA document";
      });
    }

    if (!shouldContinue && state.qaCookieHeader && results.at(-1)?.name === TEST_NAMES.extraction) {
      skipStep(results, TEST_NAMES.generation, "Skipped because extraction did not complete");
      skipStep(results, TEST_NAMES.exportPdf, "Skipped because extraction did not complete");
      skipStep(results, TEST_NAMES.adminHealth, "Skipped because extraction did not complete");
    }

    if (shouldContinue) {
      shouldContinue = await runStep(results, TEST_NAMES.generation, async () => {
        await waitForGeneration(state.baseUrl, state.qaCookieHeader, state.documentId, state);
        return "Summary, flashcards, and exam content were generated";
      });
    }

    if (!shouldContinue && state.qaCookieHeader && results.at(-1)?.name === TEST_NAMES.generation) {
      skipStep(results, TEST_NAMES.exportPdf, "Skipped because AI generation did not complete");
      skipStep(results, TEST_NAMES.adminHealth, "Skipped because AI generation did not complete");
    }

    if (shouldContinue) {
      await runStep(results, TEST_NAMES.exportPdf, async () => {
        await requestPdfExport(state.baseUrl, state.qaCookieHeader, state.documentId);
        return "PDF export returned an application/pdf file";
      });

      await runStep(results, TEST_NAMES.adminHealth, async () => {
        await checkAdminEndpoints(state.baseUrl, req);
        return "Users, jobs, and usage admin endpoints returned 200";
      });
    }

    const estimatedCostUsd = await calculateEstimatedCost(prisma, state, runStartedAt);

    await cleanupDocument(state.baseUrl, state.qaCookieHeader, state.documentId);

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

    return res.json({
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
    });
  });

  return router;
};
