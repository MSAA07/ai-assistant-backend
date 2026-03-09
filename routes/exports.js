import express from "express";
import fs from "fs/promises";
import path from "path";

import { captureSentryException } from "../utils/sentry.js";
import { downloadFileToTmp, safeUnlink } from "../utils/storage.js";
import { serializeExportArtifact } from "../utils/phase2Exports.js";

function normalizePositiveInteger(value, fallback, { min = 1, max = 100 } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

async function getOwnedExamRecord(prisma, examId, userId) {
  const examRecord = await prisma.examRecord.findUnique({
    where: { id: examId },
    include: {
      document: {
        select: { userId: true },
      },
    },
  });

  if (!examRecord) {
    return { status: 404, error: "Exam not found" };
  }

  if (examRecord.document.userId !== userId) {
    return { status: 403, error: "Access denied" };
  }

  return { examRecord };
}

async function getOwnedAttempt(prisma, attemptId, userId) {
  const attempt = await prisma.examAttempt.findUnique({
    where: { id: attemptId },
  });

  if (!attempt) {
    return { status: 404, error: "Attempt not found" };
  }

  if (attempt.userId !== userId) {
    return { status: 403, error: "Access denied" };
  }

  return { attempt };
}

async function getOwnedExportArtifact(prisma, artifactId, userId) {
  const artifact = await prisma.exportArtifact.findUnique({
    where: { id: artifactId },
  });

  if (!artifact) {
    return { status: 404, error: "Export artifact not found" };
  }

  if (artifact.userId !== userId) {
    return { status: 403, error: "Access denied" };
  }

  return { artifact };
}

function getDownloadFileName(artifact) {
  if (artifact.fileName && typeof artifact.fileName === "string") {
    return artifact.fileName;
  }

  return `${artifact.id}.${artifact.format || "pdf"}`;
}

export const createExportsRouter = ({ prisma, requireAuth }) => {
  const router = express.Router();

  router.post("/exams", requireAuth, async (req, res) => {
    try {
      const userId = req.session.user.id;
      const { examId, attemptId, format, config } = req.body ?? {};

      if (!examId && !attemptId) {
        return res.status(400).json({ error: "examId or attemptId is required" });
      }

      let resolvedExamId = null;
      let resolvedAttemptId = null;
      let resolvedDocumentId = null;

      if (typeof examId === "string" && examId.trim()) {
        const examOwnership = await getOwnedExamRecord(prisma, examId.trim(), userId);
        if (examOwnership.error) {
          return res.status(examOwnership.status).json({ error: examOwnership.error });
        }
        resolvedExamId = examOwnership.examRecord.id;
        resolvedDocumentId = examOwnership.examRecord.documentId;
      }

      if (typeof attemptId === "string" && attemptId.trim()) {
        const attemptOwnership = await getOwnedAttempt(prisma, attemptId.trim(), userId);
        if (attemptOwnership.error) {
          return res.status(attemptOwnership.status).json({ error: attemptOwnership.error });
        }

        resolvedAttemptId = attemptOwnership.attempt.id;
        resolvedExamId = resolvedExamId ?? attemptOwnership.attempt.examRecordId;
        resolvedDocumentId = resolvedDocumentId ?? attemptOwnership.attempt.documentId;
      }

      if (!resolvedExamId || !resolvedDocumentId) {
        return res.status(400).json({ error: "Unable to resolve exam export target" });
      }

      const artifact = await prisma.exportArtifact.create({
        data: {
          userId,
          documentId: resolvedDocumentId,
          examRecordId: resolvedExamId,
          attemptId: resolvedAttemptId,
          format: format === "pdf" ? "pdf" : "pdf",
          config: config && typeof config === "object" && !Array.isArray(config) ? config : {},
          status: "queued",
        },
      });

      return res.status(202).json({ success: true, artifact: serializeExportArtifact(artifact) });
    } catch (error) {
      console.error("Error creating export artifact:", error);
      captureSentryException(error, {
        tags: { route: "exports", action: "create_exam_export" },
        user: req.session?.user?.id ? { id: req.session.user.id } : undefined,
      });
      return res.status(500).json({ error: "Failed to create export artifact" });
    }
  });

  router.get("/", requireAuth, async (req, res) => {
    try {
      const page = normalizePositiveInteger(req.query?.page, 1, { min: 1, max: 10_000 });
      const limit = normalizePositiveInteger(req.query?.limit, 20, { min: 1, max: 100 });
      const skip = (page - 1) * limit;

      const where = { userId: req.session.user.id };
      const [total, artifacts] = await Promise.all([
        prisma.exportArtifact.count({ where }),
        prisma.exportArtifact.findMany({
          where,
          orderBy: [{ createdAt: "desc" }],
          skip,
          take: limit,
        }),
      ]);

      return res.json({
        artifacts: artifacts.map((artifact) => serializeExportArtifact(artifact)),
        pagination: {
          page,
          limit,
          total,
          hasMore: skip + artifacts.length < total,
        },
      });
    } catch (error) {
      console.error("Error listing export artifacts:", error);
      captureSentryException(error, {
        tags: { route: "exports", action: "list" },
        user: req.session?.user?.id ? { id: req.session.user.id } : undefined,
      });
      return res.status(500).json({ error: "Failed to list export artifacts" });
    }
  });

  router.get("/:id", requireAuth, async (req, res) => {
    try {
      const ownership = await getOwnedExportArtifact(prisma, req.params.id, req.session.user.id);
      if (ownership.error) {
        return res.status(ownership.status).json({ error: ownership.error });
      }

      return res.json({ artifact: serializeExportArtifact(ownership.artifact) });
    } catch (error) {
      console.error("Error fetching export artifact:", error);
      captureSentryException(error, {
        tags: { route: "exports", action: "fetch" },
        user: req.session?.user?.id ? { id: req.session.user.id } : undefined,
      });
      return res.status(500).json({ error: "Failed to fetch export artifact" });
    }
  });

  router.get("/:id/download", requireAuth, async (req, res) => {
    try {
      const ownership = await getOwnedExportArtifact(prisma, req.params.id, req.session.user.id);
      if (ownership.error) {
        return res.status(ownership.status).json({ error: ownership.error });
      }

      const artifact = ownership.artifact;
      if (!artifact.storageKey || artifact.status !== "complete") {
        return res.status(409).json({ error: "Export file is not ready" });
      }

      const fileName = getDownloadFileName(artifact);

      if (path.isAbsolute(artifact.storageKey)) {
        await fs.access(artifact.storageKey);
        await prisma.exportArtifact.update({
          where: { id: artifact.id },
          data: { lastDownloadedAt: new Date() },
        });
        return res.download(artifact.storageKey, fileName);
      }

      const tmpPath = await downloadFileToTmp(artifact.storageKey);
      await prisma.exportArtifact.update({
        where: { id: artifact.id },
        data: { lastDownloadedAt: new Date() },
      });

      res.download(tmpPath, fileName, async () => {
        await safeUnlink(tmpPath);
      });

      return undefined;
    } catch (error) {
      console.error("Error downloading export artifact:", error);
      captureSentryException(error, {
        tags: { route: "exports", action: "download" },
        user: req.session?.user?.id ? { id: req.session.user.id } : undefined,
      });
      return res.status(500).json({ error: "Failed to download export artifact" });
    }
  });

  return router;
};
