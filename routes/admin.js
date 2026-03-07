import express from "express";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { logAdminAction } from "../utils/auditLog.js";
import { serializeUser, toNumber } from "../utils/serializers.js";
import { captureSentryException } from "../utils/sentry.js";
import { deleteFile } from "../utils/storage.js";
import { toggleGlobalFlag, grantFeature, revokeFeature } from "../utils/featureFlags.js";

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

const MAX_PAGE_SIZE = 100;

const getQueryValue = (value) => (Array.isArray(value) ? value[0] : value);

const parseIntegerInput = (value, minimum = 0) => {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= minimum ? value : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : null;
};

const parsePositiveInteger = (value, fallback) => {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return parseIntegerInput(value, 1);
};

const parsePageSize = (value, fallback = 50) => {
  const parsed = parsePositiveInteger(value, fallback);
  if (parsed === null) {
    return null;
  }

  return Math.min(parsed, MAX_PAGE_SIZE);
};

const parseDateInput = (value, { endOfDay = false } = {}) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? `${trimmed}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`
    : trimmed;

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const buildPagination = (query) => {
  const page = parsePositiveInteger(getQueryValue(query.page), 1);
  const limit = parsePageSize(getQueryValue(query.limit), 50);

  if (page === null || limit === null) {
    return { error: "page and limit must be positive integers" };
  }

  return {
    page,
    limit,
    skip: (page - 1) * limit,
  };
};

const buildDateRangeFilter = (query) => {
  const fromRaw = getQueryValue(query.from);
  const toRaw = getQueryValue(query.to);
  const from = parseDateInput(fromRaw);
  const to = parseDateInput(toRaw, { endOfDay: true });

  if (fromRaw && !from) {
    return { error: "Invalid from date" };
  }

  if (toRaw && !to) {
    return { error: "Invalid to date" };
  }

  if (from && to && from > to) {
    return { error: "from must be before or equal to to" };
  }

  return {
    filter: from || to
      ? {
        ...(from ? { gte: from } : {}),
        ...(to ? { lte: to } : {}),
      }
      : undefined,
    fromRaw,
    toRaw,
  };
};

const createPaginationMeta = (page, limit, total) => ({
  page,
  limit,
  total,
  totalPages: total === 0 ? 0 : Math.ceil(total / limit),
});

const toNumericValue = (value, fallback = 0) => {
  if (value === null || value === undefined) {
    return fallback;
  }

  if (typeof value === "number" || typeof value === "bigint") {
    return Number(value);
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const serializeAdminUserRef = (user) => {
  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    name: user.name,
  };
};

const serializeUsageEvent = (event) => ({
  id: event.id,
  userId: event.userId,
  eventType: event.eventType,
  featureKey: event.featureKey,
  aiModelUsed: event.aiModelUsed,
  inputTokens: event.inputTokens,
  outputTokens: event.outputTokens,
  estimatedCostUsd:
    event.estimatedCostUsd === null || event.estimatedCostUsd === undefined
      ? null
      : toNumericValue(event.estimatedCostUsd),
  metadata: event.metadata,
  createdAt: event.createdAt,
  user: serializeAdminUserRef(event.user),
});

const serializeUserLimit = (userLimit) => ({
  userId: userLimit.userId,
  dailyTokenCap: userLimit.dailyTokenCap,
  dailyDocCap: userLimit.dailyDocCap,
  requestsPerMin: userLimit.requestsPerMin,
  tokensUsedToday: userLimit.tokensUsedToday,
  docsUsedToday: userLimit.docsUsedToday,
  lastResetDate: userLimit.lastResetDate,
  overrideBy: userLimit.overrideBy,
});

const serializeAnomalyAlert = (alert) => ({
  id: alert.id,
  userId: alert.userId,
  alertType: alert.alertType,
  thresholdUsd: toNumericValue(alert.thresholdUsd),
  actualUsd: toNumericValue(alert.actualUsd),
  resolved: alert.resolved,
  createdAt: alert.createdAt,
  user: serializeAdminUserRef(alert.user),
});

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
      captureSentryException(error, { tags: { route: "admin" } });
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
      captureSentryException(error, { tags: { route: "admin" } });
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
      captureSentryException(error, { tags: { route: "admin" } });
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
      captureSentryException(error, { tags: { route: "admin" } });
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
      captureSentryException(error, { tags: { route: "admin" } });
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
      captureSentryException(error, { tags: { route: "admin" } });
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
      captureSentryException(error, { tags: { route: "admin" } });
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
      captureSentryException(error, { tags: { route: "admin" } });
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

      // Delete from R2
      await deleteFile(document.storageKey);

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
      captureSentryException(error, { tags: { route: "admin" } });
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
      captureSentryException(error, { tags: { route: "admin" } });
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
      captureSentryException(error, { tags: { route: "admin" } });
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
      captureSentryException(error, { tags: { route: "admin" } });
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
      captureSentryException(error, { tags: { route: "admin" } });
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
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to revoke session" });
    }
  });

  router.get("/usage", async (req, res) => {
    try {
      const pagination = buildPagination(req.query);
      if (pagination.error) {
        return res.status(400).json({ error: pagination.error });
      }

      const dateRange = buildDateRangeFilter(req.query);
      if (dateRange.error) {
        return res.status(400).json({ error: dateRange.error });
      }

      const userId = getQueryValue(req.query.userId);
      const where = {};

      if (userId) {
        where.userId = userId;
      }

      if (dateRange.filter) {
        where.createdAt = dateRange.filter;
      }

      const [total, usageEvents] = await prisma.$transaction([
        prisma.usageEvent.count({ where }),
        prisma.usageEvent.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: pagination.skip,
          take: pagination.limit,
          include: {
            user: {
              select: { id: true, email: true, name: true },
            },
          },
        }),
      ]);

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "VIEW_USAGE_EVENTS",
        details: {
          page: pagination.page,
          limit: pagination.limit,
          userId: userId || null,
          from: dateRange.fromRaw || null,
          to: dateRange.toRaw || null,
        },
        ipAddress: getIpAddress(req),
      });

      res.json({
        ...createPaginationMeta(pagination.page, pagination.limit, total),
        usageEvents: usageEvents.map(serializeUsageEvent),
      });
    } catch (error) {
      console.error("Error fetching usage events:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to fetch usage events" });
    }
  });

  router.get("/usage/:userId", async (req, res) => {
    try {
      const { userId } = req.params;
      const pagination = buildPagination(req.query);
      if (pagination.error) {
        return res.status(400).json({ error: pagination.error });
      }

      const dateRange = buildDateRangeFilter(req.query);
      if (dateRange.error) {
        return res.status(400).json({ error: dateRange.error });
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, name: true },
      });

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const where = {
        userId,
        ...(dateRange.filter ? { createdAt: dateRange.filter } : {}),
      };

      const [total, usageEvents] = await prisma.$transaction([
        prisma.usageEvent.count({ where }),
        prisma.usageEvent.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: pagination.skip,
          take: pagination.limit,
          include: {
            user: {
              select: { id: true, email: true, name: true },
            },
          },
        }),
      ]);

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "VIEW_USER_USAGE_EVENTS",
        targetId: userId,
        details: {
          page: pagination.page,
          limit: pagination.limit,
          from: dateRange.fromRaw || null,
          to: dateRange.toRaw || null,
        },
        ipAddress: getIpAddress(req),
      });

      res.json({
        user: serializeAdminUserRef(user),
        ...createPaginationMeta(pagination.page, pagination.limit, total),
        usageEvents: usageEvents.map(serializeUsageEvent),
      });
    } catch (error) {
      console.error("Error fetching user usage events:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to fetch user usage events" });
    }
  });

  router.get("/costs/summary", async (req, res) => {
    try {
      const [totalUsageEvents, totals, modelGroups] = await prisma.$transaction([
        prisma.usageEvent.count(),
        prisma.usageEvent.aggregate({
          _sum: {
            estimatedCostUsd: true,
            inputTokens: true,
            outputTokens: true,
          },
        }),
        prisma.usageEvent.groupBy({
          by: ["aiModelUsed"],
          where: {
            aiModelUsed: {
              not: null,
            },
          },
          _count: {
            _all: true,
          },
          _sum: {
            estimatedCostUsd: true,
            inputTokens: true,
            outputTokens: true,
          },
        }),
      ]);

      const inputTokens = totals._sum?.inputTokens || 0;
      const outputTokens = totals._sum?.outputTokens || 0;
      const modelBreakdown = modelGroups
        .map((group) => {
          const modelInputTokens = group._sum?.inputTokens || 0;
          const modelOutputTokens = group._sum?.outputTokens || 0;

          return {
            model: group.aiModelUsed,
            usageEvents: group._count?._all || 0,
            estimatedCostUsd: toNumericValue(group._sum?.estimatedCostUsd),
            inputTokens: modelInputTokens,
            outputTokens: modelOutputTokens,
            totalTokens: modelInputTokens + modelOutputTokens,
          };
        })
        .sort((left, right) => right.estimatedCostUsd - left.estimatedCostUsd);

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "VIEW_COST_SUMMARY",
        ipAddress: getIpAddress(req),
      });

      res.json({
        totals: {
          usageEvents: totalUsageEvents,
          estimatedCostUsd: toNumericValue(totals._sum?.estimatedCostUsd),
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
        modelBreakdown,
      });
    } catch (error) {
      console.error("Error fetching cost summary:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to fetch cost summary" });
    }
  });

  router.get("/users/:id/limits", async (req, res) => {
    try {
      const { id } = req.params;
      const user = await prisma.user.findUnique({
        where: { id },
        select: { id: true },
      });

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const userLimit = await prisma.userLimit.upsert({
        where: { userId: id },
        update: {},
        create: { userId: id },
      });

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "VIEW_USER_LIMITS",
        targetId: id,
        ipAddress: getIpAddress(req),
      });

      res.json({ userLimit: serializeUserLimit(userLimit) });
    } catch (error) {
      console.error("Error fetching user limits:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to fetch user limits" });
    }
  });

  router.patch("/users/:id/limits", async (req, res) => {
    try {
      const { id } = req.params;
      const user = await prisma.user.findUnique({
        where: { id },
        select: { id: true },
      });

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const updates = {};
      const editableFields = ["dailyTokenCap", "dailyDocCap", "requestsPerMin"];

      for (const field of editableFields) {
        if (req.body?.[field] === undefined) {
          continue;
        }

        const parsed = parseIntegerInput(req.body[field], 0);
        if (parsed === null) {
          return res.status(400).json({
            error: `${field} must be a non-negative integer`,
          });
        }

        updates[field] = parsed;
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No valid limit updates provided" });
      }

      const existingLimit = await prisma.userLimit.findUnique({
        where: { userId: id },
      });

      const userLimit = await prisma.userLimit.upsert({
        where: { userId: id },
        update: {
          ...updates,
          overrideBy: req.session.user.id,
        },
        create: {
          userId: id,
          ...updates,
          overrideBy: req.session.user.id,
        },
      });

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "UPDATE_USER_LIMITS",
        targetId: id,
        details: {
          before: existingLimit ? serializeUserLimit(existingLimit) : null,
          after: serializeUserLimit(userLimit),
        },
        ipAddress: getIpAddress(req),
      });

      res.json({ userLimit: serializeUserLimit(userLimit) });
    } catch (error) {
      console.error("Error updating user limits:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to update user limits" });
    }
  });

  router.get("/anomalies", async (req, res) => {
    try {
      const pagination = buildPagination(req.query);
      if (pagination.error) {
        return res.status(400).json({ error: pagination.error });
      }

      const [total, anomalies] = await prisma.$transaction([
        prisma.costAnomalyAlert.count(),
        prisma.costAnomalyAlert.findMany({
          orderBy: [{ resolved: "asc" }, { createdAt: "desc" }],
          skip: pagination.skip,
          take: pagination.limit,
          include: {
            user: {
              select: { id: true, email: true, name: true },
            },
          },
        }),
      ]);

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "VIEW_COST_ANOMALIES",
        details: {
          page: pagination.page,
          limit: pagination.limit,
        },
        ipAddress: getIpAddress(req),
      });

      res.json({
        ...createPaginationMeta(pagination.page, pagination.limit, total),
        anomalies: anomalies.map(serializeAnomalyAlert),
      });
    } catch (error) {
      console.error("Error fetching cost anomalies:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to fetch anomalies" });
    }
  });

  router.patch("/anomalies/:id/resolve", async (req, res) => {
    try {
      const { id } = req.params;
      const existingAlert = await prisma.costAnomalyAlert.findUnique({
        where: { id },
      });

      if (!existingAlert) {
        return res.status(404).json({ error: "Anomaly alert not found" });
      }

      const alert = await prisma.costAnomalyAlert.update({
        where: { id },
        data: { resolved: true },
        include: {
          user: {
            select: { id: true, email: true, name: true },
          },
        },
      });

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "RESOLVE_COST_ANOMALY",
        targetId: id,
        details: {
          alertType: existingAlert.alertType,
          previouslyResolved: existingAlert.resolved,
        },
        ipAddress: getIpAddress(req),
      });

      res.json({ anomaly: serializeAnomalyAlert(alert) });
    } catch (error) {
      console.error("Error resolving anomaly alert:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to resolve anomaly alert" });
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
      captureSentryException(error, { tags: { route: "admin" } });
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
      captureSentryException(error, { tags: { route: "admin" } });
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
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to fetch audit logs" });
    }
  });

  router.get("/features", async (req, res) => {
    try {
      const flags = await prisma.featureFlag.findMany({
        include: {
          assignments: true,
          auditLogs: { orderBy: { changedAt: "desc" }, take: 10 },
        },
        orderBy: { featureKey: "asc" },
      });

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "LIST_FEATURE_FLAGS",
        ipAddress: getIpAddress(req),
      });

      res.json(flags);
    } catch (error) {
      console.error("Error fetching feature flags:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to fetch feature flags" });
    }
  });

  router.post("/features/:key/toggle", async (req, res) => {
    try {
      if (typeof req.body?.enabled !== "boolean") {
        return res.status(400).json({ error: "enabled boolean is required" });
      }

      const flag = await toggleGlobalFlag(
        req.params.key,
        req.body.enabled,
        req.session.user.id,
      );

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "TOGGLE_FEATURE_FLAG",
        targetId: flag.id,
        details: { featureKey: flag.featureKey, enabled: req.body.enabled },
        ipAddress: getIpAddress(req),
      });

      res.json(flag);
    } catch (error) {
      console.error("Error toggling feature flag:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to toggle feature flag" });
    }
  });

  router.post("/features/:key/grant", async (req, res) => {
    try {
      const { entityType, entityId, expiresAt } = req.body;
      if (!entityType || !["user", "tier"].includes(entityType)) {
        return res.status(400).json({ error: "Invalid entity type" });
      }
      if (!entityId || typeof entityId !== "string") {
        return res.status(400).json({ error: "entityId is required" });
      }

      const assignment = await grantFeature(
        req.params.key,
        entityType,
        entityId,
        req.session.user.id,
        expiresAt,
      );

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "GRANT_FEATURE_FLAG",
        targetId: assignment.id,
        details: { featureKey: req.params.key, entityType, entityId, expiresAt },
        ipAddress: getIpAddress(req),
      });

      res.json(assignment);
    } catch (error) {
      console.error("Error granting feature flag:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to grant feature flag" });
    }
  });

  router.post("/features/:key/revoke", async (req, res) => {
    try {
      const { entityType, entityId } = req.body;
      if (!entityType || !["user", "tier"].includes(entityType)) {
        return res.status(400).json({ error: "Invalid entity type" });
      }
      if (!entityId || typeof entityId !== "string") {
        return res.status(400).json({ error: "entityId is required" });
      }

      await revokeFeature(
        req.params.key,
        entityType,
        entityId,
        req.session.user.id,
      );

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "REVOKE_FEATURE_FLAG",
        details: { featureKey: req.params.key, entityType, entityId },
        ipAddress: getIpAddress(req),
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error revoking feature flag:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to revoke feature flag" });
    }
  });

  router.get("/features/audit", async (req, res) => {
    try {
      const logs = await prisma.featureFlagAuditLog.findMany({
        orderBy: { changedAt: "desc" },
        take: 100,
        include: { flag: { select: { featureKey: true } } },
      });

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "LIST_FEATURE_FLAG_AUDIT",
        ipAddress: getIpAddress(req),
      });

      res.json(logs);
    } catch (error) {
      console.error("Error fetching feature flag audit logs:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to fetch feature flag audit logs" });
    }
  });

  return router;
};
