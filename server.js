import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { toNodeHandler } from "better-auth/node";

import { auth, resolvedBetterAuthBaseURL } from "./auth.js";
import { createRequireAuth } from "./middleware/auth.js";
import { createAuthHardeningMiddleware } from "./middleware/authHardening.js";
import { createRequireAdmin } from "./middleware/adminGuard.js";
import { createMutatingOriginGuard } from "./middleware/mutatingOriginGuard.js";
import { createUserRouter } from "./routes/user.js";
import { createDocumentsRouter } from "./routes/documents.js";
import { createFlashcardsRouter, createFlashcardSetsRouter } from "./routes/flashcards.js";
import { createExamsRouter, createCanonicalExamsRouter } from "./routes/exams.js";
import { createExportsRouter } from "./routes/exports.js";
import { createAdminRouter } from "./routes/admin.js";
import { createQaRouter, initializeQaScheduler } from "./routes/qa.js";
import { createJobsRouter } from "./routes/jobs.js";
import { createTelegramRouter } from "./routes/telegram.js";
import { ensureDocumentGenerationSchema } from "./utils/documentGeneration.js";
import { backfillDocumentProcessingState } from "./utils/documentStatus.js";
import { createCorsOriginValidator } from "./utils/frontendOrigins.js";
import {
  buildFrontendAuthActionUrl,
  buildRelativeAuthBridgeCallbackPath,
} from "./utils/authBridgeUrls.js";
import { getErrorStatusCode, initSentry, setupSentryExpressErrorHandler } from "./utils/sentry.js";
import { STUDY_PDF_LAYOUT_VERSION } from "./utils/studyPdf.js";
import { assertStorageConfiguredForRuntime } from "./utils/storage.js";

dotenv.config();

console.log("OpenAI configuration loaded");

initSentry({ serviceName: "backend" });

const app = express();
const prisma = new PrismaClient();
app.set("trust proxy", 1);

const corsOptions = {
  origin: createCorsOriginValidator(),
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

function buildBetterAuthRedirectUrl(pathname, query = {}) {
  const baseUrl = resolvedBetterAuthBaseURL?.trim();
  if (!baseUrl) {
    return "";
  }

  const target = new URL(baseUrl);
  const basePath = target.pathname.replace(/\/+$/, "");
  const nextPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  target.pathname = `${basePath}${nextPath}`;

  Object.entries(query).forEach(([key, value]) => {
    if (value == null) return;

    if (Array.isArray(value)) {
      value.forEach((entry) => {
        if (entry != null) {
          target.searchParams.append(key, String(entry));
        }
      });
      return;
    }

    target.searchParams.set(key, String(value));
  });

  return target.toString();
}

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());
app.use("/api/auth", createAuthHardeningMiddleware({ auth, prisma }));

app.get("/verify-email", (req, res) => {
  const redirectUrl = buildBetterAuthRedirectUrl("/verify-email", req.query);
  if (!redirectUrl) {
    return res.status(500).send("Better Auth base URL is not configured");
  }

  return res.redirect(302, redirectUrl);
});

app.get("/auth/verify-email", (req, res) => {
  const token = Array.isArray(req.query.token) ? req.query.token[0] : req.query.token;
  if (token) {
    const callbackURL = buildRelativeAuthBridgeCallbackPath({
      pathname: "/auth/verify-email",
      nextUrl: req.query.next,
      action: "verify-email",
    });
    const redirectUrl = buildBetterAuthRedirectUrl("/verify-email", {
      token,
      callbackURL,
    });

    if (!redirectUrl) {
      return res.status(500).send("Better Auth base URL is not configured");
    }

    return res.redirect(302, redirectUrl);
  }

  const frontendUrl = buildFrontendAuthActionUrl({
    nextUrl: req.query.next,
    action: "verify-email",
    error: req.query.error,
  });
  return res.redirect(302, frontendUrl);
});

app.get("/auth/reset-password", (req, res) => {
  const frontendUrl = buildFrontendAuthActionUrl({
    nextUrl: req.query.next,
    action: "reset-password",
    token: req.query.token,
    error: req.query.error,
  });
  return res.redirect(302, frontendUrl);
});

app.get("/reset-password/:token", (req, res) => {
  const redirectUrl = buildBetterAuthRedirectUrl(`/reset-password/${req.params.token}`, req.query);
  if (!redirectUrl) {
    return res.status(500).send("Better Auth base URL is not configured");
  }

  return res.redirect(302, redirectUrl);
});

app.all("/api/auth/*", toNodeHandler(auth));

const requireAuth = createRequireAuth({ auth, prisma });
const requireAdmin = createRequireAdmin({ prisma });

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    studyPdfLayoutVersion: STUDY_PDF_LAYOUT_VERSION,
    deployGitCommit:
      process.env.RAILWAY_GIT_COMMIT_SHA
      || process.env.RAILWAY_GIT_COMMIT
      || process.env.VERCEL_GIT_COMMIT_SHA
      || "",
  });
});

app.use("/api", createMutatingOriginGuard());
app.use("/api/user", createUserRouter({ prisma, requireAuth }));
app.use("/api", createDocumentsRouter({ prisma, requireAuth }));
app.use("/api/flashcard", createFlashcardsRouter({ prisma, requireAuth }));
app.use("/api/exam", createExamsRouter({ prisma, requireAuth }));
app.use("/api", createFlashcardSetsRouter({ prisma, requireAuth }));
app.use("/api", createCanonicalExamsRouter({ prisma, requireAuth }));
app.use("/api/exports", createExportsRouter({ prisma, requireAuth }));
app.use("/api/jobs", createJobsRouter({ prisma, requireAuth }));
app.use("/api", createTelegramRouter({ prisma, requireAuth }));
app.use("/api/admin/qa", requireAuth, requireAdmin, createQaRouter({ prisma, auth }));
app.use(
  "/api/admin",
  createAdminRouter({ prisma, requireAuth, requireAdmin, auth }),
);

setupSentryExpressErrorHandler(app);

app.use((error, req, res, next) => {
  console.error("Unhandled API error:", error);

  if (res.headersSent) {
    return next(error);
  }

  const statusCode = getErrorStatusCode(error);
  const message = statusCode >= 500
    ? "Internal Server Error"
    : error?.message || "Request failed";

  return res.status(statusCode).json({ error: message });
});

const PORT = process.env.PORT || 3001;

async function startServer() {
  assertStorageConfiguredForRuntime();
  await ensureDocumentGenerationSchema(prisma);
  await backfillDocumentProcessingState(prisma);

  app.listen(PORT, () => {
    console.log(`AI Study Assistant API running on port ${PORT}`);
    console.log("Database connected");
    void initializeQaScheduler({ prisma, auth }).catch((error) => {
      console.error("Failed to start QA scheduler:", error);
    });
  });
}

startServer().catch((error) => {
  console.error("Failed to start API server:", error);
  process.exit(1);
});

process.on("SIGINT", async () => {
  await prisma.$disconnect();
  process.exit(0);
});
