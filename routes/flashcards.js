import express from "express";

import { captureSentryException } from "../utils/sentry.js";
import { LEGACY_MIGRATION_SOURCE_TYPE } from "../utils/phase2Backfill.js";
import { serializeFlashcardSet } from "../utils/phase2Flashcards.js";

function normalizePositiveInteger(value, fallback, { min = 1, max = 100 } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

function isValidLastResult(value) {
  return value === "correct" || value === "incorrect" || value === "unseen";
}

async function getOwnedDocument(prisma, documentId, userId) {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, userId: true },
  });

  if (!document) {
    return { status: 404, error: "Document not found" };
  }

  if (document.userId !== userId) {
    return { status: 403, error: "Access denied" };
  }

  return { document };
}

async function getOwnedFlashcardSet(prisma, setId, userId) {
  const flashcardSet = await prisma.flashcardSet.findUnique({
    where: { id: setId },
    include: {
      document: {
        select: { id: true, userId: true },
      },
    },
  });

  if (!flashcardSet) {
    return { status: 404, error: "Flashcard set not found" };
  }

  if (flashcardSet.document.userId !== userId) {
    return { status: 403, error: "Access denied" };
  }

  return { flashcardSet };
}

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

export const createFlashcardSetsRouter = ({ prisma, requireAuth }) => {
  const router = express.Router();

  router.get("/document/:id/flashcard-sets", requireAuth, async (req, res) => {
    try {
      const ownership = await getOwnedDocument(prisma, req.params.id, req.session.user.id);
      if (ownership.error) {
        return res.status(ownership.status).json({ error: ownership.error });
      }

      const page = normalizePositiveInteger(req.query?.page, 1, { min: 1, max: 10_000 });
      const limit = normalizePositiveInteger(req.query?.limit, 20, { min: 1, max: 100 });
      const skip = (page - 1) * limit;

      const where = { documentId: req.params.id };
      const [total, sets] = await Promise.all([
        prisma.flashcardSet.count({ where }),
        prisma.flashcardSet.findMany({
          where,
          orderBy: [{ createdAt: "desc" }],
          skip,
          take: limit,
          select: {
            id: true,
            title: true,
            cardCount: true,
            createdAt: true,
            sourceType: true,
            generationId: true,
          },
        }),
      ]);

      return res.json({
        documentId: req.params.id,
        flashcardSets: sets,
        pagination: {
          page,
          limit,
          total,
          hasMore: skip + sets.length < total,
        },
      });
    } catch (error) {
      console.error("Error listing flashcard sets:", error);
      captureSentryException(error, {
        tags: { route: "flashcard_sets", action: "list" },
        user: req.session?.user?.id ? { id: req.session.user.id } : undefined,
      });
      return res.status(500).json({ error: "Failed to list flashcard sets" });
    }
  });

  router.get("/flashcard-sets/:setId", requireAuth, async (req, res) => {
    try {
      const ownership = await getOwnedFlashcardSet(prisma, req.params.setId, req.session.user.id);
      if (ownership.error) {
        return res.status(ownership.status).json({ error: ownership.error });
      }

      const cards = await prisma.flashcardCard.findMany({
        where: { setId: ownership.flashcardSet.id },
        orderBy: [{ position: "asc" }],
      });
      const cardStates = await prisma.flashcardCardState.findMany({
        where: {
          userId: req.session.user.id,
          cardId: { in: cards.map((card) => card.id) },
        },
      });

      return res.json({
        flashcardSet: serializeFlashcardSet(ownership.flashcardSet, cards, cardStates),
      });
    } catch (error) {
      console.error("Error fetching flashcard set:", error);
      captureSentryException(error, {
        tags: { route: "flashcard_sets", action: "fetch" },
        user: req.session?.user?.id ? { id: req.session.user.id } : undefined,
      });
      return res.status(500).json({ error: "Failed to fetch flashcard set" });
    }
  });

  router.patch("/flashcard-sets/:setId/cards/:cardId/state", requireAuth, async (req, res) => {
    try {
      const ownership = await getOwnedFlashcardSet(prisma, req.params.setId, req.session.user.id);
      if (ownership.error) {
        return res.status(ownership.status).json({ error: ownership.error });
      }

      const card = await prisma.flashcardCard.findFirst({
        where: {
          id: req.params.cardId,
          setId: ownership.flashcardSet.id,
        },
        select: { id: true },
      });

      if (!card) {
        return res.status(404).json({ error: "Card not found" });
      }

      const updates = {};

      if (req.body?.isHidden !== undefined) {
        updates.isHidden = Boolean(req.body.isHidden);
      }

      if (req.body?.isDeletedForUser !== undefined) {
        updates.isDeletedForUser = Boolean(req.body.isDeletedForUser);
      }

      if (req.body?.mastered !== undefined) {
        updates.mastered = Boolean(req.body.mastered);
      }

      if (req.body?.lastResult !== undefined) {
        if (!isValidLastResult(req.body.lastResult)) {
          return res.status(400).json({ error: "Invalid lastResult" });
        }
        updates.lastResult = req.body.lastResult;
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No state fields provided" });
      }

      const state = await prisma.flashcardCardState.upsert({
        where: {
          userId_cardId: {
            userId: req.session.user.id,
            cardId: card.id,
          },
        },
        update: updates,
        create: {
          userId: req.session.user.id,
          cardId: card.id,
          ...updates,
        },
      });

      return res.json({ success: true, state });
    } catch (error) {
      console.error("Error updating flashcard card state:", error);
      captureSentryException(error, {
        tags: { route: "flashcard_sets", action: "patch_card_state" },
        user: req.session?.user?.id ? { id: req.session.user.id } : undefined,
      });
      return res.status(500).json({ error: "Failed to update card state" });
    }
  });

  router.get("/flashcard-sets/:setId/incorrect-session", requireAuth, async (req, res) => {
    try {
      const ownership = await getOwnedFlashcardSet(prisma, req.params.setId, req.session.user.id);
      if (ownership.error) {
        return res.status(ownership.status).json({ error: ownership.error });
      }

      const states = await prisma.flashcardCardState.findMany({
        where: {
          userId: req.session.user.id,
          lastResult: "incorrect",
          isHidden: false,
          isDeletedForUser: false,
          card: {
            setId: ownership.flashcardSet.id,
            isDeleted: false,
          },
        },
        include: {
          card: true,
        },
        orderBy: [{ updatedAt: "desc" }],
      });

      return res.json({
        setId: ownership.flashcardSet.id,
        cards: states.map((state) => ({
          id: state.card.id,
          position: state.card.position,
          question: state.card.question,
          answer: state.card.answer,
          explanation: state.card.explanation ?? null,
          sourceRefs: Array.isArray(state.card.sourceRefs) ? state.card.sourceRefs : [],
          state: {
            id: state.id,
            isHidden: state.isHidden,
            isDeletedForUser: state.isDeletedForUser,
            mastered: state.mastered,
            correctCount: state.correctCount,
            incorrectCount: state.incorrectCount,
            lastResult: state.lastResult,
            lastReviewedAt: state.lastReviewedAt,
            updatedAt: state.updatedAt,
          },
        })),
      });
    } catch (error) {
      console.error("Error building incorrect card session:", error);
      captureSentryException(error, {
        tags: { route: "flashcard_sets", action: "incorrect_session" },
        user: req.session?.user?.id ? { id: req.session.user.id } : undefined,
      });
      return res.status(500).json({ error: "Failed to fetch incorrect-session cards" });
    }
  });

  return router;
};
