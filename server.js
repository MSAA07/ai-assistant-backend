import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { toNodeHandler } from "better-auth/node";

import { auth } from "./auth.js";
import { createRequireAuth } from "./middleware/auth.js";
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
import { getErrorStatusCode, initSentry, setupSentryExpressErrorHandler } from "./utils/sentry.js";

dotenv.config();

// Debugging for Railway deployment
console.log('OPENAI_API_KEY exists:', !!process.env.OPENAI_API_KEY);
console.log('OPENAI_API_KEY length:', process.env.OPENAI_API_KEY?.length || 0);

initSentry({ serviceName: "backend" });

const app = express();
const prisma = new PrismaClient();

app.use(
  cors({
    origin: createCorsOriginValidator(),
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "User-Agent"],
  }),
);
app.use(express.json());

app.all("/api/auth/*", toNodeHandler(auth));

const requireAuth = createRequireAuth({ auth, prisma });
const requireAdmin = createRequireAdmin({ prisma });

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", message: "AI Study Assistant API is running" });
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
