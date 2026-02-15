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
import { createFlashcardsRouter } from "./routes/flashcards.js";
import { createExamsRouter } from "./routes/exams.js";
import { createAdminRouter } from "./routes/admin.js";

dotenv.config();

// Debugging for Railway deployment
console.log('OPENAI_API_KEY exists:', !!process.env.OPENAI_API_KEY);
console.log('OPENAI_API_KEY length:', process.env.OPENAI_API_KEY?.length || 0);

const app = express();
const prisma = new PrismaClient();

app.use(
  cors({
    origin: (origin, callback) => {
      const allowedOrigins = [
        "http://localhost:5173",
        "http://localhost:5174",
        "https://my-ai-assistant-ypzx.vercel.app",
      ];
      
      // Allow requests with no origin (like mobile apps or curl requests)
      if (!origin) return callback(null, true);
      
      if (allowedOrigins.indexOf(origin) !== -1) {
        return callback(null, true);
      }
      
      // Allow Vercel preview deployments for this project
      if (origin.endsWith(".vercel.app") && origin.includes("my-ai-assistant")) {
        return callback(null, true);
      }
      
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
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
app.use(
  "/api/admin",
  createAdminRouter({ prisma, requireAuth, requireAdmin, auth }),
);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`AI Study Assistant API running on port ${PORT}`);
  console.log("Database connected");
});

process.on("SIGINT", async () => {
  await prisma.$disconnect();
  process.exit(0);
});
