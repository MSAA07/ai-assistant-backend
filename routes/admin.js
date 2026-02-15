import express from "express";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { logAdminAction } from "../utils/auditLog.js";
import { serializeUser, toNumber } from "../utils/serializers.js";

const getIpAddress = (req) => {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }

  return req.ip || "unknown";
};

const parseNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const unwrapAuthResult = async (result) => {
  if (!result) return null;
  if (typeof Response !== "undefined" && result instanceof Response) {
    return result.json();
  }
  return result;
};

export const createAdminRouter = ({ prisma, requireAuth, requireAdmin, auth }) => {
  const router = express.Router();
  const limiter = createRateLimiter({
    windowMs: 60000,
    max: 120,
    keyGenerator: (req) => req.session?.user?.id || req.ip,
  });

  router.use(requireAuth);
  router.use(requireAdmin);
  router.use(limiter);

  router.get("/users", async (req, res) => {
    try {
      const getQueryValue = (value) => (Array.isArray(value) ? value[0] : value);
      const search = getQueryValue(req.query.search);
      const role = getQueryValue(req.query.role);
      const plan = getQueryValue(req.query.plan);
      const status = getQueryValue(req.query.status);
      const limit = Math.min(parseNumber(getQueryValue(req.query.limit), 50), 200);
      const offset = Math.max(parseNumber(getQueryValue(req.query.offset), 0), 0);

      const where = { AND: [] };
      if (search) {
        where.AND.push({
          OR: [
            { email: { contains: search, mode: "insensitive" } },
            { name: { contains: search, mode: "insensitive" } },
          ],
        });
      }
      if (role) {
        where.AND.push({ role });
      }
      if (plan) {
        where.AND.push({ plan });
      }
      if (status === "banned") {
        where.AND.push({ banned: true });
      }
      if (status === "active") {
        where.AND.push({ OR: [{ banned: false }, { banned: null }] });
      }

      if (where.AND.length === 0) {
        delete where.AND;
      }

      const [total, users] = await prisma.$transaction([
        prisma.user.count({ where }),
        prisma.user.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: offset,
          take: limit,
          include: {
            _count: { select: { documents: true, sessions: true } },
          },
        }),
      ]);

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "LIST_USERS",
        details: { search, role, plan, status, limit, offset },
        ipAddress: getIpAddress(req),
      });

      res.json({
        total,
        users: users.map((user) => ({
          ...serializeUser(user),
          documentCount: user._count?.documents || 0,
          sessionCount: user._count?.sessions || 0,
        })),
      });
    } catch (error) {
      console.error("Error fetching users:", error);
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  router.post("/users", async (req, res) => {
    try {
      const { email, name, password, role, plan, monthlyLimit } = req.body;
      const normalizedRole = typeof role === "string" ? role.trim().toLowerCase() : undefined;
      const normalizedPlan = typeof plan === "string" ? plan.trim().toLowerCase() : undefined;

      if (!email || !name) {
        return res.status(400).json({ error: "Email and name are required" });
      }

      if (normalizedRole && !["admin", "user"].includes(normalizedRole)) {
        return res.status(400).json({ error: "Invalid role" });
      }

      if (normalizedPlan && !["free", "premium"].includes(normalizedPlan)) {
        return res.status(400).json({ error: "Invalid plan" });
      }

      if (!auth?.api?.createUser) {
        return res.status(500).json({ error: "Auth createUser not available" });
      }

      if (monthlyLimit !== undefined) {
        const parsed = Number(monthlyLimit);
        if (!Number.isFinite(parsed) || parsed < 1) {
          return res.status(400).json({ error: "Invalid monthly limit" });
        }
      }

      const payload = {
        email,
        name,
        password: password || undefined,
        role: normalizedRole || undefined,
        data: {
          ...(normalizedPlan ? { plan: normalizedPlan } : {}),
          ...(monthlyLimit !== undefined
            ? { monthlyLimit: Number(monthlyLimit) }
            : {}),
        },
      };

      const created = await unwrapAuthResult(
        await auth.api.createUser({
          headers: req.headers,
          body: payload,
        }),
      );

      if (!created?.user) {
        return res
          .status(400)
          .json({ error: created?.error?.message || "Failed to create user" });
      }

      const createdUser = await prisma.user.findUnique({
        where: { id: created.user.id },
      });

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "CREATE_USER",
        targetId: created.user.id,
        details: {
          email,
          role: normalizedRole || "user",
          plan: normalizedPlan || "free",
        },
        ipAddress: getIpAddress(req),
      });

      res.json({ user: serializeUser(createdUser) });
    } catch (error) {
      console.error("Error creating user:", error);
      res.status(500).json({ error: "Failed to create user" });
    }
  });

  router.get("/users/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const user = await prisma.user.findUnique({
        where: { id },
        include: {
          _count: { select: { documents: true, sessions: true } },
        },
      });

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const [examAttempts, flashcardProgress] = await prisma.$transaction([
        prisma.examAttempt.count({ where: { userId: id } }),
        prisma.flashcardProgress.count({ where: { userId: id } }),
      ]);

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "VIEW_USER",
        targetId: id,
        ipAddress: getIpAddress(req),
      });

      res.json({
        user: serializeUser(user),
        stats: {
          documents: user._count?.documents || 0,
          sessions: user._count?.sessions || 0,
          examAttempts,
          flashcardProgress,
        },
      });
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ error: "Failed to fetch user" });
    }
  });

  router.patch("/users/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { name, plan, monthlyLimit, role } = req.body;

      const updates = {};
      if (typeof name === "string" && name.trim()) updates.name = name.trim();
      if (typeof plan === "string" && plan.trim()) updates.plan = plan.trim().toLowerCase();
      if (updates.plan && !["free", "premium"].includes(updates.plan)) {
        return res.status(400).json({ error: "Invalid plan" });
      }
      if (monthlyLimit !== undefined) {
        const parsed = Number(monthlyLimit);
        if (!Number.isFinite(parsed) || parsed < 1) {
          return res.status(400).json({ error: "Invalid monthly limit" });
        }
        updates.monthlyLimit = parsed;
      }
      if (typeof role === "string" && role.trim()) {
        const normalizedRole = role.trim().toLowerCase();
        if (!["admin", "user"].includes(normalizedRole)) {
          return res.status(400).json({ error: "Invalid role" });
        }
        updates.role = normalizedRole;
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No valid updates provided" });
      }

      const existing = await prisma.user.findUnique({
        where: { id },
        select: { role: true, plan: true, monthlyLimit: true, name: true },
      });

      if (!existing) {
        return res.status(404).json({ error: "User not found" });
      }

      const updatedUser = await prisma.user.update({
        where: { id },
        data: updates,
      });

      const action = updates.role && updates.role !== existing.role
        ? "SET_ROLE"
        : "UPDATE_USER";

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action,
        targetId: id,
        details: { before: existing, after: updates },
        ipAddress: getIpAddress(req),
      });

      res.json({ user: serializeUser(updatedUser) });
    } catch (error) {
      console.error("Error updating user:", error);
      res.status(500).json({ error: "Failed to update user" });
    }
  });

  router.delete("/users/:id", async (req, res) => {
    try {
      const { id } = req.params;

      const user = await prisma.user.findUnique({
        where: { id },
        select: { email: true },
      });

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      await prisma.user.delete({ where: { id } });

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "DELETE_USER",
        targetId: id,
        details: { email: user.email },
        ipAddress: getIpAddress(req),
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting user:", error);
      res.status(500).json({ error: "Failed to delete user" });
    }
  });

  router.post("/users/:id/suspend", async (req, res) => {
    try {
      const { id } = req.params;
      const { reason, banExpires } = req.body;

      const existing = await prisma.user.findUnique({
        where: { id },
        select: { id: true },
      });

      if (!existing) {
        return res.status(404).json({ error: "User not found" });
      }

      const user = await prisma.user.update({
        where: { id },
        data: {
          banned: true,
          banReason: reason || "Admin action",
          banExpires: banExpires ? new Date(banExpires) : null,
        },
      });

      await prisma.session.deleteMany({ where: { userId: id } });

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "BAN_USER",
        targetId: id,
        details: { reason: reason || "Admin action" },
        ipAddress: getIpAddress(req),
      });

      res.json({ user: serializeUser(user) });
    } catch (error) {
      console.error("Error suspending user:", error);
      res.status(500).json({ error: "Failed to suspend user" });
    }
  });

  router.post("/users/:id/unsuspend", async (req, res) => {
    try {
      const { id } = req.params;
      const existing = await prisma.user.findUnique({
        where: { id },
        select: { id: true },
      });

      if (!existing) {
        return res.status(404).json({ error: "User not found" });
      }

      const user = await prisma.user.update({
        where: { id },
        data: {
          banned: false,
          banReason: null,
          banExpires: null,
        },
      });

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "UNBAN_USER",
        targetId: id,
        ipAddress: getIpAddress(req),
      });

      res.json({ user: serializeUser(user) });
    } catch (error) {
      console.error("Error unsuspending user:", error);
      res.status(500).json({ error: "Failed to unsuspend user" });
    }
  });

  router.get("/users/:id/files", async (req, res) => {
    try {
      const { id } = req.params;
      const exists = await prisma.user.findUnique({
        where: { id },
        select: { id: true },
      });

      if (!exists) {
        return res.status(404).json({ error: "User not found" });
      }

      const documents = await prisma.document.findMany({
        where: { userId: id },
        orderBy: { uploadDate: "desc" },
        select: {
          id: true,
          originalName: true,
          fileSize: true,
          fileType: true,
          language: true,
          uploadDate: true,
        },
      });

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "VIEW_USER_FILES",
        targetId: id,
        ipAddress: getIpAddress(req),
      });

      res.json({ documents });
    } catch (error) {
      console.error("Error fetching user files:", error);
      res.status(500).json({ error: "Failed to fetch user files" });
    }
  });

  router.delete("/users/:id/files/:documentId", async (req, res) => {
    try {
      const { id, documentId } = req.params;
      const document = await prisma.document.findUnique({
        where: { id: documentId },
      });

      if (!document || document.userId !== id) {
        return res.status(404).json({ error: "Document not found" });
      }

      await prisma.document.delete({ where: { id: documentId } });

      const owner = await prisma.user.findUnique({
        where: { id },
        select: { storageUsed: true },
      });

      const currentStorage = owner?.storageUsed ?? BigInt(0);
      const nextStorage = currentStorage - BigInt(document.fileSize);

      await prisma.user.update({
        where: { id },
        data: {
          storageUsed: nextStorage > 0 ? nextStorage : BigInt(0),
        },
      });

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "DELETE_USER_FILE",
        targetId: id,
        details: { documentId, originalName: document.originalName },
        ipAddress: getIpAddress(req),
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting user file:", error);
      res.status(500).json({ error: "Failed to delete file" });
    }
  });

  router.get("/users/:id/sessions", async (req, res) => {
    try {
      const { id } = req.params;
      const exists = await prisma.user.findUnique({
        where: { id },
        select: { id: true },
      });

      if (!exists) {
        return res.status(404).json({ error: "User not found" });
      }

      const sessions = await prisma.session.findMany({
        where: { userId: id },
        orderBy: { updatedAt: "desc" },
      });

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "VIEW_USER_SESSIONS",
        targetId: id,
        ipAddress: getIpAddress(req),
      });

      res.json({ sessions });
    } catch (error) {
      console.error("Error fetching sessions:", error);
      res.status(500).json({ error: "Failed to fetch sessions" });
    }
  });

  router.delete("/users/:id/sessions", async (req, res) => {
    try {
      const { id } = req.params;
      const result = await prisma.session.deleteMany({ where: { userId: id } });

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "REVOKE_USER_SESSIONS",
        targetId: id,
        details: { revoked: result.count },
        ipAddress: getIpAddress(req),
      });

      res.json({ success: true, revoked: result.count });
    } catch (error) {
      console.error("Error revoking sessions:", error);
      res.status(500).json({ error: "Failed to revoke sessions" });
    }
  });

  router.delete("/users/:id/sessions/:sessionId", async (req, res) => {
    try {
      const { id, sessionId } = req.params;
      const session = await prisma.session.findUnique({
        where: { id: sessionId },
      });

      if (!session || session.userId !== id) {
        return res.status(404).json({ error: "Session not found" });
      }

      await prisma.session.delete({ where: { id: sessionId } });

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "REVOKE_SESSION",
        targetId: id,
        details: { sessionId },
        ipAddress: getIpAddress(req),
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error revoking session:", error);
      res.status(500).json({ error: "Failed to revoke session" });
    }
  });

  router.get("/sessions", async (req, res) => {
    try {
      const getQueryValue = (value) => (Array.isArray(value) ? value[0] : value);
      const limit = Math.min(parseNumber(getQueryValue(req.query.limit), 50), 200);
      const offset = Math.max(parseNumber(getQueryValue(req.query.offset), 0), 0);

      const [total, sessions] = await prisma.$transaction([
        prisma.session.count(),
        prisma.session.findMany({
          orderBy: { updatedAt: "desc" },
          skip: offset,
          take: limit,
          include: {
            user: {
              select: { id: true, email: true, name: true, role: true },
            },
          },
        }),
      ]);

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "LIST_SESSIONS",
        details: { limit, offset },
        ipAddress: getIpAddress(req),
      });

      res.json({ total, sessions });
    } catch (error) {
      console.error("Error fetching sessions:", error);
      res.status(500).json({ error: "Failed to fetch sessions" });
    }
  });

  router.delete("/sessions/:sessionId", async (req, res) => {
    try {
      const { sessionId } = req.params;
      const existing = await prisma.session.findUnique({
        where: { id: sessionId },
        select: { id: true },
      });

      if (!existing) {
        return res.status(404).json({ error: "Session not found" });
      }

      await prisma.session.delete({ where: { id: sessionId } });

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "REVOKE_SESSION",
        targetId: sessionId,
        ipAddress: getIpAddress(req),
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error revoking session:", error);
      res.status(500).json({ error: "Failed to revoke session" });
    }
  });

  router.get("/analytics", async (req, res) => {
    try {
      const now = new Date();
      const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const [
        totalUsers,
        totalDocuments,
        totalStorage,
        active24h,
        active7d,
        active30d,
        activeSessions,
      ] = await prisma.$transaction([
        prisma.user.count(),
        prisma.document.count(),
        prisma.document.aggregate({ _sum: { fileSize: true } }),
        prisma.user.count({ where: { lastActive: { gte: dayAgo } } }),
        prisma.user.count({ where: { lastActive: { gte: weekAgo } } }),
        prisma.user.count({ where: { lastActive: { gte: monthAgo } } }),
        prisma.session.count({ where: { expiresAt: { gte: now } } }),
      ]);

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "VIEW_ANALYTICS",
        ipAddress: getIpAddress(req),
      });

      res.json({
        totals: {
          users: totalUsers,
          documents: totalDocuments,
          storageBytes: totalStorage._sum?.fileSize || 0,
          activeSessions,
        },
        activeUsers: {
          last24h: active24h,
          last7d: active7d,
          last30d: active30d,
        },
      });
    } catch (error) {
      console.error("Error fetching analytics:", error);
      res.status(500).json({ error: "Failed to fetch analytics" });
    }
  });

  router.get("/storage", async (req, res) => {
    try {
      const users = await prisma.user.findMany({
        select: {
          id: true,
          name: true,
          email: true,
          storageUsed: true,
          documentsUsed: true,
          _count: { select: { documents: true } },
        },
        orderBy: { storageUsed: "desc" },
      });

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "VIEW_STORAGE",
        ipAddress: getIpAddress(req),
      });

      res.json({
        users: users.map((user) => ({
          id: user.id,
          name: user.name,
          email: user.email,
          storageUsed: toNumber(user.storageUsed),
          documentsUsed: user.documentsUsed,
          documentCount: user._count?.documents || 0,
        })),
      });
    } catch (error) {
      console.error("Error fetching storage breakdown:", error);
      res.status(500).json({ error: "Failed to fetch storage breakdown" });
    }
  });

  router.get("/audit-logs", async (req, res) => {
    try {
      const getQueryValue = (value) => (Array.isArray(value) ? value[0] : value);
      const action = getQueryValue(req.query.action);
      const adminId = getQueryValue(req.query.adminId);
      const from = getQueryValue(req.query.from);
      const to = getQueryValue(req.query.to);
      const limit = Math.min(parseNumber(getQueryValue(req.query.limit), 50), 200);
      const offset = Math.max(parseNumber(getQueryValue(req.query.offset), 0), 0);

      const where = {};
      if (action) where.action = action;
      if (adminId) where.adminId = adminId;
      if (from || to) {
        where.createdAt = {
          ...(from ? { gte: new Date(from) } : {}),
          ...(to ? { lte: new Date(to) } : {}),
        };
      }

      const [total, logs] = await prisma.$transaction([
        prisma.auditLog.count({ where }),
        prisma.auditLog.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: offset,
          take: limit,
        }),
      ]);

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "VIEW_AUDIT_LOGS",
        details: { action, adminId, from, to, limit, offset },
        ipAddress: getIpAddress(req),
      });

      res.json({ total, logs });
    } catch (error) {
      console.error("Error fetching audit logs:", error);
      res.status(500).json({ error: "Failed to fetch audit logs" });
    }
  });

  return router;
};
