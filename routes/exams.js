import express from "express";

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

      const attempt = await prisma.examAttempt.create({
        data: {
          userId: req.session.user.id,
          documentId,
          score: parsedScore,
          totalQuestions: parsedTotal,
          answers,
        },
      });

      res.json({ success: true, attempt });
    } catch (error) {
      console.error("Error saving exam attempt:", error);
      res.status(500).json({ error: "Failed to save exam attempt" });
    }
  });

  return router;
};
