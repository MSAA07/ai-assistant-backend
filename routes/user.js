import express from "express";
import { getMonthlyLimit } from "../utils/limits.js";
import { toNumber } from "../utils/serializers.js";

export const createUserRouter = ({ prisma, requireAuth }) => {
  const router = express.Router();

  router.get("/me", requireAuth, async (req, res) => {
    try {
      const userId = req.session.user.id;

      let user = await prisma.user.findUnique({
        where: { id: userId },
        include: { documents: true },
      });

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const now = new Date();
      const lastReset = new Date(user.lastReset);
      const daysSinceReset = (now - lastReset) / (1000 * 60 * 60 * 24);

      if (daysSinceReset >= 30) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: {
            documentsUsed: 0,
            lastReset: now,
          },
          include: { documents: true },
        });
      }

      const monthlyLimit = getMonthlyLimit(user);

      // Normalize documents to ensure flashcards/examQuestions are arrays (or at least have counts)
      // This handles legacy data where they might be null or malformed
      const normalizedDocuments = user.documents.map(doc => {
        let flashcards = [];
        let examQuestions = [];

        if (Array.isArray(doc.flashcards)) {
            flashcards = doc.flashcards;
        } else if (typeof doc.flashcards === 'string') {
             try { flashcards = JSON.parse(doc.flashcards); } catch (e) {}
        }
        
        if (Array.isArray(doc.examQuestions)) {
            examQuestions = doc.examQuestions;
        } else if (typeof doc.examQuestions === 'string') {
             try { examQuestions = JSON.parse(doc.examQuestions); } catch (e) {}
        }

        return {
            ...doc,
            flashcards,
            examQuestions,
            flashcardCount: Array.isArray(flashcards) ? flashcards.length : 0,
            questionCount: Array.isArray(examQuestions) ? examQuestions.length : 0
        };
      });

      res.json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          plan: user.plan,
          documentsUsed: user.documentsUsed,
          monthlyLimit,
          remainingDocuments: Math.max(monthlyLimit - user.documentsUsed, 0),
          storageUsed: toNumber(user.storageUsed),
          lastActive: user.lastActive,
        },
        documents: normalizedDocuments,
      });
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ error: "Failed to fetch user data" });
    }
  });

  return router;
};
