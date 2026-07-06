import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { toNodeHandler } from "better-auth/node";

import { auth, resolvedBetterAuthBaseURL } from "./auth.js";
import { createRequireAuth } from "./middleware/auth.js";
import { createAuthHardeningMiddleware, getAuthSecurityDiagnostics } from "./middleware/authHardening.js";
import { createRequireAdmin } from "./middleware/adminGuard.js";
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
import { getAuthEmailDiagnostics } from "./utils/email.js";
import { getAuthCallbackDiagnostics } from "./utils/authCallbackUrls.js";
import { getAuthTelemetrySnapshot } from "./utils/authTelemetry.js";
import { getErrorStatusCode, initSentry, setupSentryExpressErrorHandler } from "./utils/sentry.js";

dotenv.config();

initSentry({ serviceName: "backend" });

const app = express();
const prisma = new PrismaClient();
app.set("trust proxy", 1);

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

app.use(
  cors({
    origin: createCorsOriginValidator(),
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "User-Agent"],
  }),
);
app.use(express.json());
app.use("/api/auth", createAuthHardeningMiddleware({ auth, prisma }));

app.get("/verify-email", (req, res) => {
  const redirectUrl = buildBetterAuthRedirectUrl("/verify-email", req.query);
  if (!redirectUrl) {
    return res.status(500).send("Better Auth base URL is not configured");
  }

  return res.redirect(302, redirectUrl);
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
    message: "AI Study Assistant API is running",
  });
});

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
  createAdminRouter({
    prisma,
    requireAuth,
    requireAdmin,
    auth,
    healthDiagnostics: {
      getAuthEmailDiagnostics,
      getAuthCallbackDiagnostics,
      getAuthTelemetrySnapshot,
      getAuthSecurityDiagnostics,
      resolvedBetterAuthBaseURL,
    },
  }),
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
