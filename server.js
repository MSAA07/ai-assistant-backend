import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { toNodeHandler } from "better-auth/node";
import { hashPassword } from "better-auth/crypto";

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
import { createJobsRouter } from "./routes/jobs.js";
import { ensureDocumentGenerationSchema } from "./utils/documentGeneration.js";
import { backfillDocumentProcessingState } from "./utils/documentStatus.js";
import { createCorsOriginValidator } from "./utils/frontendOrigins.js";
import { getAuthEmailDiagnostics } from "./utils/email.js";
import { getAuthCallbackDiagnostics } from "./utils/authCallbackUrls.js";
import { getAuthTelemetrySnapshot } from "./utils/authTelemetry.js";
import { getErrorStatusCode, initSentry, setupSentryExpressErrorHandler } from "./utils/sentry.js";
import { STUDY_PDF_LAYOUT_VERSION } from "./utils/studyPdf.js";

dotenv.config();

// Debugging for Railway deployment
console.log('OPENAI_API_KEY exists:', !!process.env.OPENAI_API_KEY);
console.log('OPENAI_API_KEY length:', process.env.OPENAI_API_KEY?.length || 0);

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

const LEGACY_STAGE_ADMIN_EMAIL = "admin@ai.com";
const LEGACY_STAGE_ADMIN_PASSWORD = "admin123";
const LEGACY_STAGE_ADMIN_NAME = "Admin";

function shouldRepairLegacyStageAdmin() {
  const deploymentHint = [
    process.env.BETTER_AUTH_URL,
    process.env.BETTER_AUTH_BASE_URL,
    process.env.RAILWAY_PUBLIC_DOMAIN,
    process.env.RAILWAY_STATIC_URL,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return deploymentHint.includes("staging");
}

async function ensureLegacyStageAdminAccess() {
  if (!shouldRepairLegacyStageAdmin()) {
    return;
  }

  const hashedPassword = await hashPassword(LEGACY_STAGE_ADMIN_PASSWORD);
  const now = new Date();

  const user = await prisma.user.upsert({
    where: { email: LEGACY_STAGE_ADMIN_EMAIL },
    update: {
      name: LEGACY_STAGE_ADMIN_NAME,
      role: "admin",
      emailVerified: true,
      plan: "premium",
      monthlyLimit: 9999,
    },
    create: {
      email: LEGACY_STAGE_ADMIN_EMAIL,
      name: LEGACY_STAGE_ADMIN_NAME,
      emailVerified: true,
      role: "admin",
      plan: "premium",
      monthlyLimit: 9999,
    },
  });

  const existingCredentialAccount = await prisma.account.findFirst({
    where: {
      userId: user.id,
      providerId: "credential",
    },
  });

  if (existingCredentialAccount) {
    await prisma.account.update({
      where: { id: existingCredentialAccount.id },
      data: {
        accountId: user.id,
        password: hashedPassword,
        updatedAt: now,
      },
    });
  } else {
    await prisma.account.create({
      data: {
        id: `credential:${user.id}`,
        accountId: user.id,
        providerId: "credential",
        userId: user.id,
        password: hashedPassword,
        createdAt: now,
        updatedAt: now,
      },
    });
  }

  console.log("[startup] ensured legacy stage admin credentials");
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
    studyPdfLayoutVersion: STUDY_PDF_LAYOUT_VERSION,
    deployGitCommit:
      process.env.RAILWAY_GIT_COMMIT_SHA
      || process.env.RAILWAY_GIT_COMMIT
      || process.env.VERCEL_GIT_COMMIT_SHA
      || "",
    authEmail: getAuthEmailDiagnostics(),
    authCallbacks: getAuthCallbackDiagnostics(),
    authTelemetry: getAuthTelemetrySnapshot(),
    authSecurity: getAuthSecurityDiagnostics(),
    betterAuthBaseURL: resolvedBetterAuthBaseURL,
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
  await ensureDocumentGenerationSchema(prisma);
  await backfillDocumentProcessingState(prisma);
  await ensureLegacyStageAdminAccess();

  app.listen(PORT, () => {
    console.log(`AI Study Assistant API running on port ${PORT}`);
    console.log("Database connected");
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
