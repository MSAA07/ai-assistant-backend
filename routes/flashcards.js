import express from "express";

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

      const progress = await prisma.flashcardProgress.upsert({
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

      res.json({ success: true, progress });
    } catch (error) {
      console.error("Error saving flashcard progress:", error);
      res.status(500).json({ error: "Failed to save progress" });
    }
  });

  return router;
};
