import express from "express";
import { captureSentryException } from "../utils/sentry.js";
import { LEGACY_MIGRATION_SOURCE_TYPE } from "../utils/phase2Backfill.js";

export const createFlashcardsRouter = ({ prisma, requireAuth }) => {
  const router = express.Router();

  router.post("/progress", requireAuth, async (req, res) => {
    try {
      const { documentId, cardIndex, mastered } = req.body;
      const parsedIndex = Number(cardIndex);

      if (!documentId || Number.isNaN(parsedIndex)) {
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

      const progress = await prisma.$transaction(async (tx) => {
        const persistedProgress = await tx.flashcardProgress.upsert({
          where: {
            userId_documentId_cardIndex: {
              userId: req.session.user.id,
              documentId,
              cardIndex: parsedIndex,
            },
          },
          update: { mastered, lastReviewed: new Date() },
          create: {
            userId: req.session.user.id,
            documentId,
            cardIndex: parsedIndex,
            mastered: !!mastered,
          },
        });

        const latestSet = await tx.flashcardSet.findFirst({
          where: {
            documentId,
            isLatest: true,
          },
          select: { id: true },
          orderBy: { createdAt: "desc" },
        });

        const migratedSet = latestSet ?? await tx.flashcardSet.findFirst({
          where: {
            documentId,
            sourceType: LEGACY_MIGRATION_SOURCE_TYPE,
            generationId: null,
          },
          select: { id: true },
          orderBy: { createdAt: "asc" },
        });

        if (migratedSet?.id) {
          const card = await tx.flashcardCard.findFirst({
            where: {
              setId: migratedSet.id,
              position: parsedIndex,
              isDeleted: false,
            },
            select: { id: true },
          });

          if (card?.id) {
            await tx.flashcardCardState.upsert({
              where: {
                userId_cardId: {
                  userId: req.session.user.id,
                  cardId: card.id,
                },
              },
              update: {
                mastered: Boolean(mastered),
                lastReviewedAt: new Date(),
                lastResult: mastered ? "correct" : "unseen",
              },
              create: {
                userId: req.session.user.id,
                cardId: card.id,
                mastered: Boolean(mastered),
                lastReviewedAt: new Date(),
                lastResult: mastered ? "correct" : "unseen",
              },
            });
          }
        }

        return persistedProgress;
      });

      res.json({ success: true, progress });
    } catch (error) {
      console.error("Error saving flashcard progress:", error);
      captureSentryException(error);
      res.status(500).json({ error: "Failed to save progress" });
    }
  });

  return router;
};
