import express from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { mkdirSync } from "fs";
import dotenv from "dotenv";
import { getMonthlyLimit } from "../utils/limits.js";
import { uploadFile, deleteFile } from "../utils/storage.js";
import { serializeDocument } from "../utils/documentStatus.js";
import { captureSentryException } from "../utils/sentry.js";

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

      const { key } = await uploadFile(file.path, user.id, file.originalname, file.mimetype);
      const isLocalPath = path.isAbsolute(key);

      let document;
      let job;

      try {
        const persisted = await prisma.$transaction(async (tx) => {
          const createdDocument = await tx.document.create({
            data: {
              userId: user.id,
              filename: file.filename,
              originalName: file.originalname,
              fileType: file.mimetype,
              fileSize: file.size,
              language: selectedLanguage,
              summary: "",
              flashcards: [],
              examQuestions: [],
              storageKey: key,
              processingStatus: "queued",
              processingError: null,
            },
          });

          await tx.user.update({
            where: { id: user.id },
            data: {
              documentsUsed: { increment: 1 },
              storageUsed: { increment: BigInt(file.size) },
            },
          });

          const jobPayload = { documentId: createdDocument.id };
          if (isLocalPath) {
            jobPayload.filePath = key;
          }

          const createdJob = await tx.job.create({
            data: {
              userId: user.id,
              documentId: createdDocument.id,
              jobType: "extract_document",
              payload: jobPayload,
              status: "queued",
            },
          });

          const linkedDocument = await tx.document.update({
            where: { id: createdDocument.id },
            data: { processingJobId: createdJob.id },
          });

          return { document: linkedDocument, job: createdJob };
        });

        document = persisted.document;
        job = persisted.job;
      } catch (transactionError) {
        if (!isLocalPath) {
          await deleteFile(key);
        }
        throw transactionError;
      }

      if (isLocalPath) {
        console.info(`[upload] Using local storage fallback for document ${document.id}`);
      } else {
        await fs.unlink(file.path).catch(() => {});
      }

      // Return 202 Accepted but keep previous response shape for frontend compatibility
      res.status(202).json({
        success: true,
        jobId: job.id,
        documentId: document.id,
        document: {
          ...serializeDocument({
            ...document,
            originalName: document.originalName,
            filename: document.originalName,
            excerptCount: 0,
          }),
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
      captureSentryException(error, {
        tags: { route: "documents", action: "upload" },
        user: req.session?.user?.id ? { id: req.session.user.id } : undefined,
      });
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
        include: {
          _count: {
            select: { excerpts: true },
          },
        },
      });

      if (!document) {
        return res.status(404).json({ error: "Document not found" });
      }

      const isAdmin = req.session.user.role === "admin";
      if (!isAdmin && document.userId !== req.session.user.id) {
        return res.status(403).json({ error: "Access denied" });
      }

      res.json({
        document: serializeDocument(document, {
          excerptCount: document._count?.excerpts ?? 0,
        }),
      });
    } catch (error) {
      console.error("Error fetching document:", error);
      captureSentryException(error, {
        tags: { route: "documents", action: "fetch" },
        user: req.session?.user?.id ? { id: req.session.user.id } : undefined,
      });
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
      captureSentryException(error, {
        tags: { route: "documents", action: "delete" },
        user: req.session?.user?.id ? { id: req.session.user.id } : undefined,
      });
      res.status(500).json({ error: "Failed to delete document" });
    }
  });

  return router;
};
