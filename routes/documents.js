import express from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { mkdirSync } from "fs";
import dotenv from "dotenv";
import { getMonthlyLimit } from "../utils/limits.js";
import { enqueueJob } from "../utils/jobQueue.js";
import { uploadFile, deleteFile } from "../utils/storage.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const uploadsDir = "/tmp/uploads";
mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + "-" + file.originalname);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Invalid file type. Only PDF, DOCX, and PPTX files are allowed.",
        ),
      );
    }
  },
});

const resetMonthlyUsageIfNeeded = async (prisma, user) => {
  const now = new Date();
  const lastReset = new Date(user.lastReset);
  const daysSinceReset = (now - lastReset) / (1000 * 60 * 60 * 24);

  if (daysSinceReset < 30) {
    return user;
  }

  return prisma.user.update({
    where: { id: user.id },
    data: { documentsUsed: 0, lastReset: now },
  });
};

export const createDocumentsRouter = ({ prisma, requireAuth }) => {
  const router = express.Router();

  router.post("/upload", requireAuth, upload.single("file"), async (req, res) => {
    try {
      const { language } = req.body;
      const file = req.file;
      const user = req.session.user;
      const selectedLanguage = language === "arabic" ? "arabic" : "english";

      console.log("Upload request received:", {
        userId: user?.id,
        fileName: file?.originalname,
        fileType: file?.mimetype,
        fileSize: file?.size,
      });

      if (!file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      let dbUser = await prisma.user.findUnique({ where: { id: user.id } });
      if (!dbUser) {
        await fs.unlink(file.path).catch(() => {});
        return res.status(404).json({ error: "User not found" });
      }

      dbUser = await resetMonthlyUsageIfNeeded(prisma, dbUser);

      if (dbUser.storageUsed === null) {
        await prisma.user.update({
          where: { id: dbUser.id },
          data: { storageUsed: BigInt(0) },
        });
        dbUser.storageUsed = BigInt(0);
      }

      const monthlyLimit = getMonthlyLimit(dbUser);
      if (dbUser.documentsUsed >= monthlyLimit) {
        await fs.unlink(file.path).catch(() => {});
        return res.status(403).json({
          error: "Monthly upload limit reached",
          details: dbUser.plan === "premium" || dbUser.role === "admin"
            ? "Upgrade for more"
            : "Free limit reached",
        });
      }

      // Upload to R2 (or fallback to local)
      const { key } = await uploadFile(file.path, user.id, file.originalname, file.mimetype);

      // Create Document record immediately
      const document = await prisma.document.create({
        data: {
          userId: user.id,
          filename: file.filename,
          originalName: file.originalname,
          fileType: file.mimetype,
          fileSize: file.size,
          language: selectedLanguage,
          summary: "", // Will be populated by AI job later
          flashcards: [], 
          examQuestions: [],
          storageKey: key,
        },
      });

      // Update usage stats
      await prisma.user.update({
        where: { id: user.id },
        data: {
          documentsUsed: { increment: 1 },
          storageUsed: { increment: BigInt(file.size) },
        },
      });

      // Delete local temp file immediately after upload (if R2 is used)
      // If uploadFile returned a key that is the local path (fallback), we KEEP it so worker can find it
      const isLocalPath = path.isAbsolute(key);
      if (!isLocalPath) {
          await fs.unlink(file.path).catch(() => {});
      }

      // Enqueue extraction job
      // For R2, we rely on storageKey in Document record
      // For fallback local, we pass filePath in payload if needed, or rely on storageKey which is the path
      const jobPayload = { documentId: document.id };
      if (isLocalPath) {
          jobPayload.filePath = key; 
      }

      const job = await enqueueJob(user.id, 'extract_document', jobPayload);

      // Return 202 Accepted but keep previous response shape for frontend compatibility
      res.status(202).json({
        success: true,
        jobId: job.id,
        documentId: document.id,
        document: {
          id: document.id,
          filename: document.originalName,
          summary: document.summary,
          flashcards: document.flashcards,
          examQuestions: document.examQuestions,
          uploadDate: document.uploadDate,
        },
        message: "Document uploaded and extraction queued"
      });


    } catch (error) {
      console.error("Upload error:", error);
      if (error?.stack) {
        console.error(error.stack);
      }
      // Only unlink if we failed BEFORE creating the job/document
      // If job was created, worker handles it (or retry). 
      // But here we are in catch, so likely job wasn't created.
      if (req.file) {
        await fs.unlink(req.file.path).catch(() => {});
      }
      res.status(500).json({
        error: "Failed to process document",
        details: error.message,
      });
    }
  });

  router.get("/document/:id", requireAuth, async (req, res) => {
    try {
      const document = await prisma.document.findUnique({
        where: { id: req.params.id },
      });

      if (!document) {
        return res.status(404).json({ error: "Document not found" });
      }

      const isAdmin = req.session.user.role === "admin";
      if (!isAdmin && document.userId !== req.session.user.id) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Check for active processing job if content is missing
      let processingStatus = 'complete';
      // Safe check for empty content
      const isEmpty = !document.summary || 
                      (Array.isArray(document.flashcards) && document.flashcards.length === 0);

      if (isEmpty) {
        // Fetch recent jobs for this user to find the matching extraction job
        // We filter in memory to avoid Prisma JSON filter compatibility issues
        const recentJobs = await prisma.job.findMany({
          where: {
            userId: req.session.user.id,
            jobType: 'extract_document',
            // Look for active or recently failed jobs
            status: { in: ['queued', 'running', 'failed'] }
          },
          orderBy: { queuedAt: 'desc' },
          take: 10
        });
        
        console.log(`[API] Debug: Searching for doc ${document.id} in ${recentJobs.length} recent jobs`);

        const matchingJob = recentJobs.find(job => {
          // Check payload for documentId
          // payload is Json, so we treat it as an object
          const pid = job.payload?.documentId;
          // console.log(`[API] Debug: Job ${job.id} payload docId: ${pid}`);
          return pid === document.id;
        });

        if (matchingJob) {
          processingStatus = matchingJob.status;
          console.log(`[API] Found active job ${matchingJob.id} for doc ${document.id} status=${processingStatus}`);
        } else {
             console.log(`[API] No active job found for empty doc ${document.id} (User: ${req.session.user.id})`);
        }
      }

      res.json({ document: { ...document, processingStatus } });
    } catch (error) {
      console.error("Error fetching document:", error);
      res.status(500).json({ error: "Failed to fetch document" });
    }
  });

  router.delete("/document/:id", requireAuth, async (req, res) => {
    try {
      const document = await prisma.document.findUnique({
        where: { id: req.params.id },
      });

      if (!document) {
        return res.status(404).json({ error: "Document not found" });
      }

      const isAdmin = req.session.user.role === "admin";
      if (!isAdmin && document.userId !== req.session.user.id) {
        return res.status(403).json({ error: "Access denied" });
      }

      await prisma.document.delete({ where: { id: document.id } });
      
      // Delete from R2
      await deleteFile(document.storageKey);

      const owner = await prisma.user.findUnique({
        where: { id: document.userId },
        select: { storageUsed: true },
      });
      const currentStorage = owner?.storageUsed ?? BigInt(0);
      const nextStorage = currentStorage - BigInt(document.fileSize);
      await prisma.user.update({
        where: { id: document.userId },
        data: {
          storageUsed: nextStorage > 0 ? nextStorage : BigInt(0),
        },
      });

      res.json({ success: true, message: "Document deleted" });
    } catch (error) {
      console.error("Error deleting document:", error);
      res.status(500).json({ error: "Failed to delete document" });
    }
  });

  return router;
};
