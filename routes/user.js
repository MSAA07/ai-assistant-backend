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
