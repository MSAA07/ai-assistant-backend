import express from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { mkdirSync } from "fs";
import dotenv from "dotenv";

import { createRateLimiter } from "../middleware/rateLimit.js";
import {
  areGenerationOptionsEqual,
  buildDocumentGenerationState,
  DOCUMENT_GENERATION_STATUS,
  getFeatureKeyForGenerationType,
  getJobTypeForGenerationType,
  getUsableExcerptCount,
  normalizeGenerationOptions,
  normalizeGenerationType,
  serializeDocumentGeneration,
} from "../utils/documentGeneration.js";
import { reconcileDocumentProcessingState, serializeDocument } from "../utils/documentStatus.js";
import { isFeatureEnabledIfConfigured } from "../utils/featureFlags.js";
import { getMonthlyLimit } from "../utils/limits.js";
import { captureSentryException } from "../utils/sentry.js";
import {
  buildStudyPdfBuffer,
  buildStudyPdfFileName,
  hasStudyExportContent,
  normalizeStudyExportFeature,
} from "../utils/studyPdf.js";
import {
  getStorageFileExtension,
  normalizeDocumentName,
  normalizeUploadedFilename,
} from "../utils/filenames.js";
import { uploadFile, deleteFile } from "../utils/storage.js";
import { normalizePositiveInteger } from "../utils/routeHelpers.js";

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
    const normalizedOriginalName = normalizeUploadedFilename(file.originalname);
    file.originalname = normalizedOriginalName;
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, `${uniqueSuffix}${getStorageFileExtension(normalizedOriginalName)}`);
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

const generationRateLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 10,
  keyGenerator: (req) => req.session?.user?.id || req.ip || "unknown",
});

const latestGenerationInclude = {
  generations: {
    where: { isLatest: true },
    orderBy: [{ generationType: "asc" }, { createdAt: "desc" }],
  },
};

const documentDetailsInclude = {
  include: {
    _count: {
      select: { excerpts: true },
    },
    ...latestGenerationInclude,
  },
};

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

function isAdminUser(user) {
  return user?.role === "admin";
}

function createHttpError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) {
    error.code = code;
  }
  return error;
}

async function getAuthorizedDocument(prisma, documentId, user, queryOptions = {}) {
  let document = await prisma.document.findUnique({
    where: { id: documentId },
    ...queryOptions,
  });

  if (!document) {
    throw createHttpError(404, "Document not found", "document_not_found");
  }

  if (!isAdminUser(user) && document.userId !== user.id) {
    throw createHttpError(403, "Access denied", "forbidden");
  }

  document = await reconcileDocumentProcessingState(prisma, document);
  return document;
}

function jsonError(res, error, fallbackMessage) {
  const statusCode = error?.statusCode || 500;
  return res.status(statusCode).json({
    error: error?.message || fallbackMessage,
  });
}

async function queueGenerationJob(tx, { documentId, userId, generationType, options, regenerate }) {
  await tx.$queryRaw`
    SELECT "id"
    FROM "Document"
    WHERE "id" = ${documentId}
    FOR UPDATE
  `;

  const latestGeneration = await tx.documentGeneration.findFirst({
    where: {
      documentId,
      generationType,
      isLatest: true,
    },
    orderBy: { createdAt: "desc" },
  });

  if (
    latestGeneration
    && (
      latestGeneration.status === DOCUMENT_GENERATION_STATUS.queued
      || latestGeneration.status === DOCUMENT_GENERATION_STATUS.running
    )
  ) {
    if (areGenerationOptionsEqual(generationType, latestGeneration.options, options)) {
      return {
        action: "reused_active",
        generation: latestGeneration,
        jobId: latestGeneration.jobId ?? null,
      };
    }

    throw createHttpError(
      409,
      "A generation job for this feature is already in progress with different options",
      "generation_active_conflict",
    );
  }

  if (
    latestGeneration
    && !regenerate
    && areGenerationOptionsEqual(generationType, latestGeneration.options, options)
  ) {
    return {
      action: "reused_existing",
      generation: latestGeneration,
      jobId: latestGeneration.jobId ?? null,
    };
  }

  if (latestGeneration) {
    await tx.documentGeneration.update({
      where: { id: latestGeneration.id },
      data: { isLatest: false },
    });
  }

  const generation = await tx.documentGeneration.create({
    data: {
      documentId,
      generationType,
      status: DOCUMENT_GENERATION_STATUS.queued,
      options,
      errorMessage: null,
      isLatest: true,
    },
  });

  const job = await tx.job.create({
    data: {
      userId,
      documentId,
      jobType: getJobTypeForGenerationType(generationType),
      status: "queued",
      payload: {
        documentId,
        generationId: generation.id,
        generationType,
        options,
      },
    },
  });

  const linkedGeneration = await tx.documentGeneration.update({
    where: { id: generation.id },
    data: { jobId: job.id },
  });

  return {
    action: "queued",
    generation: linkedGeneration,
    jobId: job.id,
  };
}

function getGenerationResponseStatus(action) {
  if (action === "queued" || action === "reused_active") {
    return 202;
  }

  return 200;
}

export const createDocumentsRouter = ({ prisma, requireAuth }) => {
  const router = express.Router();

  router.post("/upload", requireAuth, upload.single("file"), async (req, res) => {
    try {
      const file = req.file;
      const user = req.session.user;
      const originalName = normalizeUploadedFilename(file?.originalname);

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
      if (!isAdminUser(dbUser) && dbUser.documentsUsed >= monthlyLimit) {
        await fs.unlink(file.path).catch(() => {});
        return res.status(403).json({
          error: "Monthly upload limit reached",
          details: dbUser.plan === "premium" || dbUser.role === "admin"
            ? "Upgrade for more"
            : "Free limit reached",
        });
      }

      const { key } = await uploadFile(file.path, user.id, originalName, file.mimetype);
      const isLocalPath = path.isAbsolute(key);

      let document;
      let job;

      try {
        const persisted = await prisma.$transaction(async (tx) => {
          const createdDocument = await tx.document.create({
            data: {
              userId: user.id,
              filename: file.filename,
              originalName,
              fileType: file.mimetype,
              fileSize: file.size,
              language: "english",
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

      res.status(202).json({
        success: true,
        jobId: job.id,
        documentId: document.id,
        document: serializeDocument({
          ...document,
          originalName,
          filename: document.originalName,
          excerptCount: 0,
          generations: [],
        }),
        message: "Document uploaded and extraction queued",
      });
    } catch (error) {
      console.error("Upload error:", error);
      if (error?.stack) {
        console.error(error.stack);
      }
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

  router.post("/document/:id/generations", requireAuth, generationRateLimiter, async (req, res) => {
    try {
      const user = req.session.user;
      const documentId = req.params.id;
      const generationType = normalizeGenerationType(req.body?.type);
      const options = normalizeGenerationOptions(generationType, req.body?.options ?? {});
      const regenerate = Boolean(req.body?.regenerate);

      const document = await getAuthorizedDocument(prisma, documentId, user, {
        select: {
          id: true,
          userId: true,
          processingStatus: true,
        },
      });

      if (document.processingStatus !== "complete") {
        throw createHttpError(
          409,
          "Document extraction must be complete before generation",
          "document_not_ready",
        );
      }

      const usableExcerptCount = await getUsableExcerptCount(prisma, documentId);
      if (usableExcerptCount <= 0) {
        throw createHttpError(
          409,
          "Document has no usable excerpts for generation",
          "no_usable_excerpts",
        );
      }

      const featureEnabled = await isFeatureEnabledIfConfigured(
        getFeatureKeyForGenerationType(generationType),
        user.id,
        user.plan,
      );
      if (!featureEnabled) {
        throw createHttpError(403, "Feature not available", "feature_disabled");
      }

      const queuedGeneration = await prisma.$transaction((tx) => queueGenerationJob(tx, {
        documentId,
        userId: user.id,
        generationType,
        options,
        regenerate,
      }));
      const serializedGeneration = serializeDocumentGeneration(queuedGeneration.generation);

      return res.status(getGenerationResponseStatus(queuedGeneration.action)).json({
        generationId: serializedGeneration.id,
        jobId: queuedGeneration.jobId,
        generationStatus: serializedGeneration.status,
        generation: serializedGeneration,
      });
    } catch (error) {
      console.error("Error queueing document generation:", error);
      captureSentryException(error, {
        tags: { route: "documents", action: "queue_generation" },
        user: req.session?.user?.id ? { id: req.session.user.id } : undefined,
        extra: {
          documentId: req.params.id,
          generationType: req.body?.type,
        },
      });
      return jsonError(res, error, "Failed to queue generation");
    }
  });

  router.get("/document/:id/generations", requireAuth, async (req, res) => {
    try {
      const document = await getAuthorizedDocument(prisma, req.params.id, req.session.user, {
        select: {
          id: true,
          userId: true,
          generations: latestGenerationInclude.generations,
        },
      });

      res.json({
        documentId: document.id,
        generations: buildDocumentGenerationState(document.generations),
      });
    } catch (error) {
      console.error("Error fetching document generations:", error);
      captureSentryException(error, {
        tags: { route: "documents", action: "fetch_generations" },
        user: req.session?.user?.id ? { id: req.session.user.id } : undefined,
      });
      return jsonError(res, error, "Failed to fetch document generations");
    }
  });

  router.get("/document/:id", requireAuth, async (req, res) => {
    try {
      const document = await getAuthorizedDocument(prisma, req.params.id, req.session.user, documentDetailsInclude);

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
      return jsonError(res, error, "Failed to fetch document");
    }
  });

  router.get("/document/:id/export-pdf", requireAuth, async (req, res) => {
    try {
      const feature = normalizeStudyExportFeature(req.query?.feature);
      if (!feature) {
        throw createHttpError(400, "feature must be one of summary, flashcards, or exam", "invalid_export_feature");
      }

      const document = await getAuthorizedDocument(prisma, req.params.id, req.session.user, documentDetailsInclude);
      const serializedDocument = serializeDocument(document, {
        excerptCount: document._count?.excerpts ?? 0,
      });

      if (serializedDocument.processingStatus !== "complete") {
        throw createHttpError(409, "Document content is not ready for export", "document_not_ready");
      }

      if (!hasStudyExportContent(serializedDocument, feature)) {
        throw createHttpError(409, "Selected study content is not ready for export", "export_not_ready");
      }

      const pdfBuffer = await buildStudyPdfBuffer(serializedDocument, feature);
      const fileName = buildStudyPdfFileName(serializedDocument, feature);

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      res.setHeader("Content-Length", pdfBuffer.length);
      return res.send(pdfBuffer);
    } catch (error) {
      console.error("Error exporting study PDF:", error);
      captureSentryException(error, {
        tags: { route: "documents", action: "export_pdf" },
        user: req.session?.user?.id ? { id: req.session.user.id } : undefined,
        extra: {
          documentId: req.params.id,
          feature: req.query?.feature,
        },
      });
      return jsonError(res, error, "Failed to export study PDF");
    }
  });

  router.get("/document/:id/excerpts", requireAuth, async (req, res) => {
    try {
      const page = normalizePositiveInteger(req.query?.page, 1, { min: 1, max: 10_000 });
      const limit = normalizePositiveInteger(req.query?.limit, 25, { min: 1, max: 100 });
      const skip = (page - 1) * limit;

      const document = await getAuthorizedDocument(prisma, req.params.id, req.session.user, {
        select: {
          id: true,
          userId: true,
          processingStatus: true,
        },
      });

      if (document.processingStatus !== "complete") {
        throw createHttpError(
          409,
          "Document extraction must be complete before reading excerpts",
          "document_not_ready",
        );
      }

      const where = {
        documentId: document.id,
        excerptType: { not: "image_flag" },
        content: { not: "" },
      };

      const [total, excerpts] = await Promise.all([
        prisma.documentExcerpt.count({ where }),
        prisma.documentExcerpt.findMany({
          where,
          orderBy: [
            { slideOrPage: "asc" },
            { excerptType: "asc" },
            { charOffset: "asc" },
            { createdAt: "asc" },
          ],
          skip,
          take: limit,
          select: {
            id: true,
            slideOrPage: true,
            excerptType: true,
            content: true,
            charOffset: true,
            createdAt: true,
          },
        }),
      ]);

      return res.json({
        documentId: document.id,
        excerpts,
        pagination: {
          page,
          limit,
          total,
          hasMore: skip + excerpts.length < total,
        },
      });
    } catch (error) {
      console.error("Error fetching document excerpts:", error);
      captureSentryException(error, {
        tags: { route: "documents", action: "fetch_excerpts" },
        user: req.session?.user?.id ? { id: req.session.user.id } : undefined,
        extra: {
          documentId: req.params.id,
        },
      });
      return jsonError(res, error, "Failed to fetch document excerpts");
    }
  });

  router.patch("/document/:id", requireAuth, async (req, res) => {
    try {
      const document = await getAuthorizedDocument(prisma, req.params.id, req.session.user, {
        select: {
          id: true,
          userId: true,
          originalName: true,
        },
      });

      const nextOriginalName = normalizeDocumentName(req.body?.originalName);

      if (!nextOriginalName) {
        throw createHttpError(400, "Document name is required", "invalid_document_name");
      }

      if (nextOriginalName.length > 255) {
        throw createHttpError(400, "Document name is too long", "invalid_document_name");
      }

      if (nextOriginalName === document.originalName) {
        return res.json({
          success: true,
          documentId: document.id,
          originalName: document.originalName,
          message: "Document name unchanged",
        });
      }

      const updatedDocument = await prisma.document.update({
        where: { id: document.id },
        data: {
          originalName: nextOriginalName,
        },
        select: {
          id: true,
          originalName: true,
        },
      });

      return res.json({
        success: true,
        documentId: updatedDocument.id,
        originalName: updatedDocument.originalName,
        message: "Document renamed",
      });
    } catch (error) {
      console.error("Error renaming document:", error);
      captureSentryException(error, {
        tags: { route: "documents", action: "rename" },
        user: req.session?.user?.id ? { id: req.session.user.id } : undefined,
        extra: {
          documentId: req.params.id,
        },
      });
      return jsonError(res, error, "Failed to rename document");
    }
  });

  router.delete("/document/:id", requireAuth, async (req, res) => {
    try {
      const document = await getAuthorizedDocument(prisma, req.params.id, req.session.user);

      await prisma.document.delete({ where: { id: document.id } });
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
      return jsonError(res, error, "Failed to delete document");
    }
  });

  return router;
};
