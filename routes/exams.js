import express from "express";
import { captureSentryException } from "../utils/sentry.js";
import { LEGACY_MIGRATION_SOURCE_TYPE } from "../utils/phase2Backfill.js";

export const createExamsRouter = ({ prisma, requireAuth }) => {
  const router = express.Router();

  router.post("/attempt", requireAuth, async (req, res) => {
    try {
      const { documentId, score, totalQuestions, answers } = req.body;
      const parsedScore = Number(score);
      const parsedTotal = Number(totalQuestions);

      if (!documentId || Number.isNaN(parsedScore) || Number.isNaN(parsedTotal)) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const document = await prisma.document.findUnique({
        where: { id: documentId },
        select: { userId: true },
      });

      if (!document) {
        return res.status(404).json({ error: "Document not found" });
      }

      if (document.userId !== req.session.user.id) {
        return res.status(403).json({ error: "Access denied" });
      }

      const attempt = await prisma.$transaction(async (tx) => {
        const latestExamRecord = await tx.examRecord.findFirst({
          where: {
            documentId,
            isLatest: true,
          },
          select: { id: true },
          orderBy: { createdAt: "desc" },
        });

        const migratedExamRecord = latestExamRecord ?? await tx.examRecord.findFirst({
          where: {
            documentId,
            sourceType: LEGACY_MIGRATION_SOURCE_TYPE,
            generationId: null,
          },
          select: { id: true },
          orderBy: { createdAt: "asc" },
        });

        return tx.examAttempt.create({
          data: {
            userId: req.session.user.id,
            documentId,
            examRecordId: migratedExamRecord?.id ?? null,
            score: parsedScore,
            totalQuestions: parsedTotal,
            answers,
            status: "submitted",
          },
        });
      });

      res.json({ success: true, attempt });
    } catch (error) {
      console.error("Error saving exam attempt:", error);
      captureSentryException(error);
      res.status(500).json({ error: "Failed to save exam attempt" });
    }
  });

  return router;
};
