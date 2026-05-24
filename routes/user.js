import express from "express";
import { reconcileDocumentProcessingState, serializeDocument } from "../utils/documentStatus.js";
import { getUserAllowance } from "../utils/limits.js";
import { toNumber } from "../utils/serializers.js";
import { captureSentryException } from "../utils/sentry.js";

export const createUserRouter = ({ prisma, requireAuth }) => {
  const router = express.Router();

  router.get("/me", requireAuth, async (req, res) => {
    try {
      const userId = req.session.user.id;

      let user = await prisma.user.findUnique({
        where: { id: userId },
        include: {
          documents: {
            include: {
              _count: {
                select: { excerpts: true },
              },
              generations: {
                where: { isLatest: true },
                orderBy: [{ generationType: "asc" }, { createdAt: "desc" }],
              },
            },
            orderBy: { uploadDate: "desc" },
          },
        },
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
          include: {
            documents: {
              include: {
                _count: {
                  select: { excerpts: true },
                },
                generations: {
                  where: { isLatest: true },
                  orderBy: [{ generationType: "asc" }, { createdAt: "desc" }],
                },
              },
              orderBy: { uploadDate: "desc" },
            },
          },
        });
      }

      const reconciledDocuments = await Promise.all(
        user.documents.map((document) => reconcileDocumentProcessingState(prisma, document)),
      );

      const allowance = await getUserAllowance(prisma, userId);
      const monthlyLimit = allowance.caps.documentCap ?? user.monthlyLimit;
      const documents = reconciledDocuments.map((document) => serializeDocument(document, {
        excerptCount: document._count?.excerpts ?? 0,
      }));

      res.json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          plan: user.plan,
          documentsUsed: allowance.consumed.documents,
          monthlyLimit,
          remainingDocuments: allowance.remaining.documents,
          storageUsed: toNumber(user.storageUsed),
          lastActive: user.lastActive,
          allowance,
        },
        documents,
      });
    } catch (error) {
      console.error("Error fetching user:", error);
      captureSentryException(error);
      res.status(500).json({ error: "Failed to fetch user data" });
    }
  });

  router.get("/export", requireAuth, async (req, res) => {
    try {
      const userId = req.session.user.id;

      const [
        user,
        documents,
        flashcardSets,
        examAttempts,
        telegramConnection,
        lastTelegramSend,
      ] = await Promise.all([
        prisma.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            email: true,
            name: true,
            emailVerified: true,
            image: true,
            createdAt: true,
            updatedAt: true,
            lastActive: true,
            role: true,
            plan: true,
            documentsUsed: true,
            monthlyLimit: true,
            storageUsed: true,
            lastReset: true,
          },
        }),
        prisma.document.findMany({
          where: { userId },
          orderBy: { uploadDate: "desc" },
          select: {
            id: true,
            originalName: true,
            filename: true,
            uploadDate: true,
            processingStatus: true,
          },
        }),
        prisma.flashcardSet.findMany({
          where: {
            document: { userId },
          },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            documentId: true,
            title: true,
            options: true,
            cardCount: true,
            sourceType: true,
            isLatest: true,
            createdAt: true,
            updatedAt: true,
            cards: {
              where: { isDeleted: false },
              orderBy: { position: "asc" },
              select: {
                id: true,
                position: true,
                question: true,
                answer: true,
                explanation: true,
                sourceRefs: true,
                createdAt: true,
                updatedAt: true,
              },
            },
          },
        }),
        prisma.examAttempt.findMany({
          where: { userId },
          orderBy: [{ startedAt: "desc" }],
          select: {
            id: true,
            documentId: true,
            examRecordId: true,
            score: true,
            totalQuestions: true,
            answers: true,
            status: true,
            startedAt: true,
            lastSavedAt: true,
            submittedAt: true,
            completedAt: true,
            feedbackMode: true,
          },
        }),
        prisma.telegramConnection.findUnique({
          where: { userId },
          select: {
            telegramUsername: true,
            connectedAt: true,
            disconnectedAt: true,
          },
        }),
        prisma.telegramDeliveryLog.findFirst({
          where: {
            userId,
            status: "sent",
            sentAt: { not: null },
          },
          orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
          select: { sentAt: true },
        }),
      ]);

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      return res.json({
        profile: {
          ...user,
          storageUsed: toNumber(user.storageUsed),
        },
        documents: documents.map((document) => ({
          id: document.id,
          title: document.originalName || document.filename,
          createdAt: document.uploadDate,
          status: document.processingStatus,
        })),
        flashcardSets,
        examAttempts,
        telegram: {
          connected: Boolean(telegramConnection && !telegramConnection.disconnectedAt),
          username: telegramConnection?.telegramUsername ?? null,
          connectedAt: telegramConnection && !telegramConnection.disconnectedAt
            ? telegramConnection.connectedAt
            : null,
          lastSendAt: lastTelegramSend?.sentAt ?? null,
        },
      });
    } catch (error) {
      console.error("Error exporting user data:", error);
      captureSentryException(error);
      return res.status(500).json({ error: "Failed to export user data" });
    }
  });

  router.get("/allowance", requireAuth, async (req, res) => {
    try {
      const allowance = await getUserAllowance(prisma, req.session.user.id);
      res.json({ allowance });
    } catch (error) {
      console.error("Error fetching allowance:", error);
      captureSentryException(error);
      res.status(error?.statusCode || 500).json({
        error: error?.message || "Failed to fetch allowance",
        code: error?.code,
      });
    }
  });

  return router;
};
