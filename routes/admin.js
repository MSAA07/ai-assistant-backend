import express from "express";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { logAdminAction, withAuditDiff } from "../utils/auditLog.js";
import { serializeUser, toNumber } from "../utils/serializers.js";
import { captureSentryException } from "../utils/sentry.js";
import { deleteFile } from "../utils/storage.js";
import { toggleGlobalFlag, grantFeature, revokeFeature } from "../utils/featureFlags.js";
import {
  ensureDefaultUsageCapConfigs,
  getFallbackCapConfig,
  getUserAllowance,
} from "../utils/limits.js";
import { getUsdToSarRate } from "../utils/modelPricing.js";
import {
  ALLOWED_MODELS,
  VALID_FEATURES,
  VALID_PLANS,
  VALID_REASONING_EFFORTS,
  invalidateRoutingCache,
} from "../utils/modelRoutingPolicy.js";
import { sendTelegramAdminNotification } from "../utils/telegramNotify.js";
import {
  TELEGRAM_DELIVERY_STATUS,
  TELEGRAM_DELIVERY_TYPES,
} from "../utils/telegramDelivery.js";
import { getIssuesFeed } from "../utils/issuesFeed.js";

const getIpAddress = (req) => {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }

  return req.ip || "unknown";
};

async function collectUserStorageKeys(prisma, userId) {
  const [documents, exportArtifacts] = await Promise.all([
    prisma.document.findMany({
      where: { userId },
      select: { storageKey: true },
    }),
    prisma.exportArtifact.findMany({
      where: { userId },
      select: { storageKey: true },
    }),
  ]);

  return Array.from(new Set([
    ...documents.map((document) => document.storageKey),
    ...exportArtifacts.map((artifact) => artifact.storageKey),
  ].filter(Boolean)));
}

const buildUserFilter = ({ search, role, plan, status } = {}) => {
  const where = { AND: [{ email: { not: QA_SYSTEM_EMAIL } }] };

  if (search) {
    where.AND.push({
      OR: [
        { email: { contains: search, mode: "insensitive" } },
        { name: { contains: search, mode: "insensitive" } },
      ],
    });
  }
  if (role && role !== "all") where.AND.push({ role });
  if (plan && plan !== "all") where.AND.push({ plan });
  if (status === "banned") where.AND.push({ banned: true });
  if (status === "active") {
    where.AND.push({ OR: [{ banned: false }, { banned: null }] });
  }

  return where;
};

const normalizeUserFilters = (input = {}) => ({
  search: typeof input.search === "string" ? input.search.trim() : "",
  role: typeof input.role === "string" ? input.role.trim().toLowerCase() : "",
  plan: typeof input.plan === "string" ? input.plan.trim().toLowerCase() : "",
  status: typeof input.status === "string" ? input.status.trim().toLowerCase() : "",
});

const resolveBulkUsers = async (prisma, selection = {}) => {
  if (selection.mode === "matching") {
    return prisma.user.findMany({
      where: buildUserFilter(normalizeUserFilters(selection.filters)),
      select: { id: true, email: true, banned: true, role: true },
    });
  }

  const ids = Array.isArray(selection.ids)
    ? [...new Set(selection.ids.filter((id) => typeof id === "string" && id.trim()))]
    : [];
  if (ids.length === 0) return [];

  return prisma.user.findMany({
    where: {
      AND: [
        { id: { in: ids } },
        { email: { not: QA_SYSTEM_EMAIL } },
      ],
    },
    select: { id: true, email: true, banned: true, role: true },
  });
};

const getBulkEligibility = (users, action, actingAdminId) => {
  const eligible = [];
  const excluded = [];

  for (const user of users) {
    const reason = user.id === actingAdminId
      ? "acting_admin"
      : action === "suspend" && user.banned
        ? "already_suspended"
        : null;

    if (reason) excluded.push({ id: user.id, email: user.email, reason });
    else eligible.push(user);
  }

  return { eligible, excluded };
};

const buildAuditData = (req, { action, targetId = null, details = null, previousValue, newValue }) => withAuditDiff({
  adminId: req.session.user.id,
  action,
  targetId,
  details,
  ...(previousValue !== undefined ? { previousValue } : {}),
  ...(newValue !== undefined ? { newValue } : {}),
  ipAddress: getIpAddress(req),
});

const omitInternalStorageKey = ({ storageKey: _storageKey, ...record }) => record;

const transactWithAudit = async (prisma, auditData, mutate) => {
  if (typeof prisma.$transaction !== "function") {
    await prisma.auditLog.create({ data: auditData });
    return mutate(prisma);
  }

  return prisma.$transaction(async (tx) => {
    await tx.auditLog.create({ data: auditData });
    return mutate(tx);
  });
};

const deleteDependentUserRows = async (tx, userId) => {
  const deletions = [
    ["flashcardCardState", { userId }],
    ["flashcardProgress", { userId }],
    ["examAttempt", { userId }],
    ["exportArtifact", { userId }],
    ["usageEvent", { userId }],
    ["costAnomalyAlert", { userId }],
    ["job", { userId }],
    ["userLimit", { userId }],
    ["featureFlagAssignment", { entityType: "user", entityId: userId }],
  ];

  for (const [model, where] of deletions) {
    if (typeof tx[model]?.deleteMany === "function") {
      await tx[model].deleteMany({ where });
    }
  }
};

export async function deleteAdminUserData({
  prisma,
  userId,
  auditData,
  deleteStorageFile = deleteFile,
}) {
  const storageKeys = await collectUserStorageKeys(prisma, userId);

  // Storage is the non-transactional dependency. It must succeed before the
  // database row is removed so a storage failure leaves the account intact.
  await Promise.all(storageKeys.map((key) => deleteStorageFile(key)));

  await transactWithAudit(prisma, {
    ...auditData,
    details: {
      ...(auditData.details || {}),
      storageObjectsDeleted: storageKeys.length,
    },
  }, async (tx) => {
    await deleteDependentUserRows(tx, userId);
    await tx.user.delete({ where: { id: userId } });
  });

  return { storageObjectsDeleted: storageKeys.length };
}

const parseNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const MAX_PAGE_SIZE = 100;
const QA_SYSTEM_EMAIL = "qa@studymaxing.com";

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

const parseNullableNumberInput = (value, minimum = 0) => {
  if (value === null) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : undefined;
};

const isBlankInput = (value) => (
  value === undefined
  || value === null
  || (typeof value === "string" && value.trim() === "")
);

const parseCreateIntegerOverride = (value, field) => {
  if (isBlankInput(value)) {
    return { valid: true, value: null, provided: false };
  }

  const parsed = parseIntegerInput(value, 0);
  if (parsed === null) {
    return {
      valid: false,
      error: `${field} must be a non-negative integer`,
    };
  }

  return { valid: true, value: parsed, provided: true };
};

const parseCreateCostOverride = (value) => {
  if (isBlankInput(value)) {
    return { valid: true, value: null, provided: false };
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return {
      valid: false,
      error: "costCapUsdOverride must be a non-negative number",
    };
  }

  return { valid: true, value: parsed, provided: true };
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

async function getTelegramUsageByUserIds(prisma, userIds = []) {
  const uniqueUserIds = [...new Set(userIds.filter(Boolean))];
  const usageByUserId = new Map(
    uniqueUserIds.map((userId) => [userId, {
      connected: false,
      usedTelegramSend: false,
      lastTelegramSendAt: null,
      flashcardSendCount: 0,
      examSendCount: 0,
    }]),
  );

  if (uniqueUserIds.length === 0) {
    return usageByUserId;
  }

  const [connections, deliveryGroups, lastSendGroups] = await prisma.$transaction([
    prisma.telegramConnection.findMany({
      where: { userId: { in: uniqueUserIds } },
      select: {
        userId: true,
        connectedAt: true,
        disconnectedAt: true,
      },
    }),
    prisma.telegramDeliveryLog.groupBy({
      by: ["userId", "type"],
      where: {
        userId: { in: uniqueUserIds },
        status: TELEGRAM_DELIVERY_STATUS.sent,
      },
      _count: { _all: true },
    }),
    prisma.telegramDeliveryLog.groupBy({
      by: ["userId"],
      where: {
        userId: { in: uniqueUserIds },
        status: TELEGRAM_DELIVERY_STATUS.sent,
        sentAt: { not: null },
      },
      _max: { sentAt: true },
    }),
  ]);

  for (const connection of connections) {
    const usage = usageByUserId.get(connection.userId);
    if (!usage) continue;
    usage.connected = Boolean(connection.connectedAt && !connection.disconnectedAt);
  }

  for (const group of deliveryGroups) {
    const usage = usageByUserId.get(group.userId);
    if (!usage) continue;
    const count = group._count?._all || 0;
    if (group.type === TELEGRAM_DELIVERY_TYPES.flashcards) {
      usage.flashcardSendCount = count;
    } else if (group.type === TELEGRAM_DELIVERY_TYPES.exam) {
      usage.examSendCount = count;
    }
    usage.usedTelegramSend = usage.flashcardSendCount > 0 || usage.examSendCount > 0;
  }

  for (const group of lastSendGroups) {
    const usage = usageByUserId.get(group.userId);
    if (!usage) continue;
    usage.lastTelegramSendAt = group._max?.sentAt ?? null;
  }

  return usageByUserId;
}

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
  documentCapOverride: userLimit.documentCapOverride,
  costCapUsdOverride:
    userLimit.costCapUsdOverride === null || userLimit.costCapUsdOverride === undefined
      ? null
      : toNumericValue(userLimit.costCapUsdOverride),
  tokenCapOverride: userLimit.tokenCapOverride,
  featureCapsOverride: userLimit.featureCapsOverride,
  overrideBy: userLimit.overrideBy,
});

const serializeUsageCapConfig = (config) => ({
  id: config.id,
  plan: config.plan,
  documentCap: config.documentCap,
  costCapUsd:
    config.costCapUsd === null || config.costCapUsd === undefined
      ? null
      : toNumericValue(config.costCapUsd),
  tokenCap: config.tokenCap,
  featureCaps: config.featureCaps,
  updatedBy: config.updatedBy,
  createdAt: config.createdAt,
  updatedAt: config.updatedAt,
});

const serializeModelRoutingConfig = (config) => ({
  id: config.id,
  feature: config.feature,
  plan: config.plan,
  model: config.model,
  reasoningEffort: config.reasoningEffort,
  updatedByAdminId: config.updatedByAdminId,
  createdAt: config.createdAt,
  updatedAt: config.updatedAt,
});

const getAllowedModel = (modelId) => (
  ALLOWED_MODELS.find((allowedModel) => allowedModel.id === modelId)
);

const validateModelRoutingUpdate = ({ feature, plan, model, reasoningEffort }) => {
  if (!VALID_FEATURES.includes(feature)) {
    return { error: "feature must be one of: summary, flashcards, exam" };
  }

  if (!VALID_PLANS.includes(plan)) {
    return { error: "plan must be one of: free, premium" };
  }

  const allowedModel = getAllowedModel(model);
  if (!allowedModel) {
    return { error: "model must be one of the allowed model ids" };
  }

  if (reasoningEffort !== null && !VALID_REASONING_EFFORTS.includes(reasoningEffort)) {
    return { error: "reasoningEffort must be null or one of: none, low, medium, high, xhigh" };
  }

  if (reasoningEffort !== null && !allowedModel.supportsReasoningEffort) {
    return { error: "reasoningEffort is only supported for models with reasoning effort enabled" };
  }

  return { allowedModel };
};

const buildIssuesFeedFilters = (query) => {
  const type = getQueryValue(query.type);
  const severity = getQueryValue(query.severity);
  const resolvedValue = getQueryValue(query.resolved);
  const startDateValue = getQueryValue(query.startDate);
  const endDateValue = getQueryValue(query.endDate);
  const startDate = parseDateInput(startDateValue);
  const endDate = parseDateInput(endDateValue, { endOfDay: true });

  if (startDateValue && !startDate) return { error: "Invalid startDate" };
  if (endDateValue && !endDate) return { error: "Invalid endDate" };
  if (startDate && endDate && startDate > endDate) {
    return { error: "startDate must be before or equal to endDate" };
  }
  if (resolvedValue && resolvedValue !== "true" && resolvedValue !== "false") {
    return { error: "resolved must be true or false" };
  }

  return {
    filters: {
      types: type && type !== "all" ? type : undefined,
      severity: severity && severity !== "all" ? severity : undefined,
      resolved: resolvedValue === "true" ? true : resolvedValue === "false" ? false : undefined,
      startDate,
      endDate,
    },
  };
};

const escapeCsvField = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;

const issuesToCsv = (items) => {
  const header = ["id", "type", "severity", "title", "message", "createdAt", "resolved", "relatedId"];
  const rows = items.map((issue) => [
    issue.id,
    issue.type,
    issue.severity,
    issue.title,
    issue.message,
    issue.createdAt.toISOString(),
    issue.resolved,
    issue.relatedId,
  ].map(escapeCsvField).join(","));

  return [header.join(","), ...rows].join("\r\n");
};

async function buildUsageCapImpact(prisma, plan, proposedCaps) {
  const normalizedPlan = plan === "premium" ? "premium" : "free";
  const users = await prisma.user.findMany({
    where: {
      plan: normalizedPlan,
      NOT: { role: "admin" },
    },
    select: {
      id: true,
      email: true,
      name: true,
      userLimit: true,
      _count: { select: { documents: true } },
    },
  });
  const userIds = users.map((user) => user.id);
  const costGroups = userIds.length > 0
    ? await prisma.modelUsageEvent.groupBy({
      by: ["userId"],
      where: {
        userId: { in: userIds },
        billable: true,
      },
      _sum: {
        estimatedCostUsd: true,
        totalTokens: true,
      },
    })
    : [];
  const costByUserId = new Map(costGroups.map((group) => [group.userId, {
    costUsd: toNumericValue(group._sum?.estimatedCostUsd),
    totalTokens: group._sum?.totalTokens || 0,
  }]));

  const overDocumentUsers = [];
  const overCostUsers = [];
  const overTokenUsers = [];

  for (const user of users) {
    const usage = costByUserId.get(user.id) ?? { costUsd: 0, totalTokens: 0 };
    const documentCap = user.userLimit?.documentCapOverride ?? proposedCaps.documentCap ?? null;
    const costCapUsd = user.userLimit?.costCapUsdOverride !== null && user.userLimit?.costCapUsdOverride !== undefined
      ? toNumericValue(user.userLimit.costCapUsdOverride)
      : proposedCaps.costCapUsd ?? null;
    const tokenCap = user.userLimit?.tokenCapOverride ?? proposedCaps.tokenCap ?? null;

    if (documentCap !== null && user._count.documents >= documentCap) {
      overDocumentUsers.push({
        id: user.id,
        email: user.email,
        name: user.name,
        consumed: user._count.documents,
        cap: documentCap,
        override: user.userLimit?.documentCapOverride !== null && user.userLimit?.documentCapOverride !== undefined,
      });
    }

    if (costCapUsd !== null && usage.costUsd >= costCapUsd) {
      overCostUsers.push({
        id: user.id,
        email: user.email,
        name: user.name,
        consumed: usage.costUsd,
        cap: costCapUsd,
        override: user.userLimit?.costCapUsdOverride !== null && user.userLimit?.costCapUsdOverride !== undefined,
      });
    }

    if (tokenCap !== null && usage.totalTokens >= tokenCap) {
      overTokenUsers.push({
        id: user.id,
        email: user.email,
        name: user.name,
        consumed: usage.totalTokens,
        cap: tokenCap,
        override: user.userLimit?.tokenCapOverride !== null && user.userLimit?.tokenCapOverride !== undefined,
      });
    }
  }

  return {
    plan: normalizedPlan,
    userCount: users.length,
    overLimit: {
      documents: overDocumentUsers.length,
      costUsd: overCostUsers.length,
      tokens: overTokenUsers.length,
    },
    samples: {
      documents: overDocumentUsers.slice(0, 5),
      costUsd: overCostUsers.slice(0, 5),
      tokens: overTokenUsers.slice(0, 5),
    },
  };
}

const getJobDocumentId = (job) => job.documentId ?? job.payload?.documentId ?? null;
const getJobGenerationId = (job) => job.payload?.generationId ?? null;

const getJobDurationMs = (job, now = new Date()) => {
  const start = job.startedAt ?? job.queuedAt;
  const end = job.completedAt ?? (job.status === "running" ? now : null);
  if (!start || !end) return null;
  return Math.max(0, new Date(end).getTime() - new Date(start).getTime());
};

const isJobStuck = (job, now = new Date()) => (
  job.status === "running"
  && (
    (job.leaseExpiresAt && new Date(job.leaseExpiresAt) < now)
    || (!job.leaseExpiresAt && job.startedAt && new Date(job.startedAt).getTime() < now.getTime() - 120_000)
  )
);

const serializeJobStageEvent = (stage) => ({
  id: stage.id,
  stageName: stage.stageName,
  status: stage.status,
  attemptNumber: stage.attemptNumber,
  startedAt: stage.startedAt,
  endedAt: stage.endedAt,
  durationMs: stage.durationMs,
  errorSummary: stage.errorSummary,
  metadata: stage.metadata,
});

const serializeAdminJob = (job, { documentsById = new Map(), generationsByJobId = new Map(), now = new Date() } = {}) => {
  const documentId = getJobDocumentId(job);
  const generation = generationsByJobId.get(job.id) ?? null;
  const document = documentId ? documentsById.get(documentId) ?? null : null;

  return {
    id: job.id,
    shortId: job.id.slice(0, 8),
    userId: job.userId,
    user: serializeAdminUserRef(job.user),
    documentId,
    document: document
      ? {
        id: document.id,
        originalName: document.originalName,
        processingStatus: document.processingStatus,
      }
      : null,
    generationId: getJobGenerationId(job) ?? generation?.id ?? null,
    generation: generation
      ? {
        id: generation.id,
        generationType: generation.generationType,
        status: generation.status,
        isLatest: generation.isLatest,
      }
      : null,
    jobType: job.jobType,
    status: job.status,
    progressPct: job.progressPct,
    retryCount: job.retryCount,
    maxRetries: job.maxRetries,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    workerId: job.workerId,
    leaseExpiresAt: job.leaseExpiresAt,
    lastHeartbeatAt: job.lastHeartbeatAt,
    errorMessage: job.errorMessage,
    totalDurationMs: getJobDurationMs(job, now),
    stuck: isJobStuck(job, now),
    stageEvents: Array.isArray(job.stageEvents)
      ? job.stageEvents.map(serializeJobStageEvent)
      : undefined,
  };
};

const USAGE_GRANULARITIES = new Set(["hour", "day", "week", "month", "year"]);

function buildUsageLedgerWhere(query) {
  const dateRange = buildDateRangeFilter(query);
  if (dateRange.error) {
    return { error: dateRange.error };
  }

  const userId = getQueryValue(query.userId);
  const documentId = getQueryValue(query.documentId);
  const featureKey = getQueryValue(query.featureKey);
  const model = getQueryValue(query.model);
  const status = getQueryValue(query.status);
  const billable = getQueryValue(query.billable);
  const where = {};

  if (dateRange.filter) where.createdAt = dateRange.filter;
  if (userId) where.userId = userId;
  if (documentId) where.documentId = documentId;
  if (featureKey && featureKey !== "all") where.featureKey = featureKey;
  if (model && model !== "all") where.model = model;
  if (status && status !== "all") where.status = status;
  if (billable === "true") where.billable = true;
  if (billable === "false") where.billable = false;

  return {
    where,
    dateRange,
    filters: {
      userId: userId || null,
      documentId: documentId || null,
      featureKey: featureKey || null,
      model: model || null,
      status: status || null,
      billable: billable || null,
      from: dateRange.fromRaw || null,
      to: dateRange.toRaw || null,
    },
  };
}

function buildUsageMoney(usd, sarRate) {
  const costUsd = toNumericValue(usd);
  return {
    costUsd,
    costSar: costUsd * sarRate,
  };
}

function buildUsageTotalsFromAggregate(aggregate, count, sarRate) {
  const inputTokens = aggregate?._sum?.inputTokens || 0;
  const outputTokens = aggregate?._sum?.outputTokens || 0;
  const totalTokens = aggregate?._sum?.totalTokens || inputTokens + outputTokens;

  return {
    events: count || 0,
    inputTokens,
    outputTokens,
    totalTokens,
    ...buildUsageMoney(aggregate?._sum?.estimatedCostUsd, sarRate),
  };
}

function serializeUsageGroup(group, keyField, sarRate, keyAlias = keyField) {
  const inputTokens = group._sum?.inputTokens || 0;
  const outputTokens = group._sum?.outputTokens || 0;
  const totalTokens = group._sum?.totalTokens || inputTokens + outputTokens;

  return {
    [keyAlias]: group[keyField],
    events: group._count?._all || 0,
    inputTokens,
    outputTokens,
    totalTokens,
    ...buildUsageMoney(group._sum?.estimatedCostUsd, sarRate),
  };
}

function sortUsageGroups(groups) {
  return groups.sort((left, right) => right.costUsd - left.costUsd);
}

function buildDocumentUsageWhere(where) {
  return where.documentId ? where : { ...where, documentId: { not: null } };
}

async function getUsageSummary(prisma, where, sarRate) {
  const [
    totalEvents,
    totals,
    billableTotals,
    failedEvents,
    userGroups,
    documentGroups,
    featureGroups,
    modelGroups,
  ] = await prisma.$transaction([
    prisma.modelUsageEvent.count({ where }),
    prisma.modelUsageEvent.aggregate({
      where,
      _sum: {
        estimatedCostUsd: true,
        inputTokens: true,
        outputTokens: true,
        totalTokens: true,
      },
    }),
    prisma.modelUsageEvent.aggregate({
      where: { ...where, billable: true },
      _sum: {
        estimatedCostUsd: true,
        inputTokens: true,
        outputTokens: true,
        totalTokens: true,
      },
    }),
    prisma.modelUsageEvent.count({ where: { ...where, status: "failed" } }),
    prisma.modelUsageEvent.groupBy({
      by: ["userId"],
      where,
      _count: { _all: true },
      _sum: { estimatedCostUsd: true, inputTokens: true, outputTokens: true, totalTokens: true },
    }),
    prisma.modelUsageEvent.groupBy({
      by: ["documentId"],
      where: buildDocumentUsageWhere(where),
      _count: { _all: true },
      _sum: { estimatedCostUsd: true, inputTokens: true, outputTokens: true, totalTokens: true },
    }),
    prisma.modelUsageEvent.groupBy({
      by: ["featureKey"],
      where,
      _count: { _all: true },
      _sum: { estimatedCostUsd: true, inputTokens: true, outputTokens: true, totalTokens: true },
    }),
    prisma.modelUsageEvent.groupBy({
      by: ["model"],
      where,
      _count: { _all: true },
      _sum: { estimatedCostUsd: true, inputTokens: true, outputTokens: true, totalTokens: true },
    }),
  ]);

  return {
    totals: {
      ...buildUsageTotalsFromAggregate(totals, totalEvents, sarRate),
      billableCostUsd: toNumericValue(billableTotals._sum?.estimatedCostUsd),
      billableCostSar: toNumericValue(billableTotals._sum?.estimatedCostUsd) * sarRate,
      failedEvents,
    },
    topUsers: sortUsageGroups(userGroups.map((group) => serializeUsageGroup(group, "userId", sarRate))).slice(0, 10),
    topDocuments: sortUsageGroups(documentGroups.map((group) => serializeUsageGroup(group, "documentId", sarRate))).slice(0, 10),
    features: sortUsageGroups(featureGroups.map((group) => serializeUsageGroup(group, "featureKey", sarRate))),
    models: sortUsageGroups(modelGroups.map((group) => serializeUsageGroup(group, "model", sarRate))),
  };
}

function getUsageBucketStart(date, granularity) {
  const value = new Date(date);
  if (granularity === "hour") {
    value.setUTCMinutes(0, 0, 0);
  } else if (granularity === "day") {
    value.setUTCHours(0, 0, 0, 0);
  } else if (granularity === "week") {
    value.setUTCHours(0, 0, 0, 0);
    const day = value.getUTCDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    value.setUTCDate(value.getUTCDate() + mondayOffset);
  } else if (granularity === "month") {
    value.setUTCDate(1);
    value.setUTCHours(0, 0, 0, 0);
  } else if (granularity === "year") {
    value.setUTCMonth(0, 1);
    value.setUTCHours(0, 0, 0, 0);
  }
  return value.toISOString();
}

function addUsageToBucket(bucket, event, sarRate) {
  bucket.events += 1;
  bucket.inputTokens += event.inputTokens || 0;
  bucket.outputTokens += event.outputTokens || 0;
  bucket.totalTokens += event.totalTokens || 0;
  bucket.costUsd += toNumericValue(event.estimatedCostUsd);
  bucket.costSar = bucket.costUsd * sarRate;
}

export async function buildUsageTimeSeries(prisma, where, granularity, sarRate) {
  const events = [];
  const pageSize = 1000;
  let cursor = null;

  while (true) {
    const page = await prisma.modelUsageEvent.findMany({
      where,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        createdAt: true,
        inputTokens: true,
        outputTokens: true,
        totalTokens: true,
        estimatedCostUsd: true,
      },
      take: pageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    events.push(...page);
    if (page.length < pageSize) {
      break;
    }
    cursor = page[page.length - 1].id;
  }

  const buckets = new Map();

  for (const event of events) {
    const bucketKey = getUsageBucketStart(event.createdAt, granularity);
    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, {
        bucketStart: bucketKey,
        events: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        costSar: 0,
      });
    }
    addUsageToBucket(buckets.get(bucketKey), event, sarRate);
  }

  return [...buckets.values()].sort((left, right) => new Date(left.bucketStart) - new Date(right.bucketStart));
}

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

const serializeAdminAlert = (alert) => ({
  id: alert.id,
  alertType: alert.alertType,
  severity: alert.severity,
  targetType: alert.targetType,
  targetId: alert.targetId,
  userId: alert.userId,
  documentId: alert.documentId,
  jobId: alert.jobId,
  thresholdUsd:
    alert.thresholdUsd === null || alert.thresholdUsd === undefined
      ? null
      : toNumericValue(alert.thresholdUsd),
  actualUsd:
    alert.actualUsd === null || alert.actualUsd === undefined
      ? null
      : toNumericValue(alert.actualUsd),
  thresholdCount: alert.thresholdCount,
  actualCount: alert.actualCount,
  emailTo: alert.emailTo,
  emailSubject: alert.emailSubject,
  emailStatus: alert.emailStatus,
  providerMessageId: alert.providerMessageId,
  errorMessage: alert.errorMessage,
  resolved: alert.resolved,
  metadata: alert.metadata,
  sentAt: alert.sentAt,
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

export const createAdminRouter = ({
  prisma,
  requireAuth,
  requireAdmin,
  auth,
  healthDiagnostics,
  deleteStorageFile = deleteFile,
}) => {
  const router = express.Router();
  const limiter = createRateLimiter({
    windowMs: 60000,
    max: 240,
    keyGenerator: (req) => req.session?.user?.id || req.ip,
  });

  router.use(requireAuth);
  router.use(requireAdmin);
  router.use(limiter);

  router.get("/health-diagnostics", (req, res) => {
    res.json({
      status: "ok",
      message: "AI Study Assistant API is running",
      authEmail: healthDiagnostics.getAuthEmailDiagnostics(),
      authCallbacks: healthDiagnostics.getAuthCallbackDiagnostics(),
      authTelemetry: healthDiagnostics.getAuthTelemetrySnapshot(),
      authSecurity: healthDiagnostics.getAuthSecurityDiagnostics(),
      betterAuthBaseURL: healthDiagnostics.resolvedBetterAuthBaseURL,
    });
  });

  router.get("/model-routing", async (req, res) => {
    try {
      const configs = await prisma.modelRoutingConfig.findMany({
        orderBy: [
          { feature: "asc" },
          { plan: "asc" },
        ],
      });

      res.json({
        configs: configs.map(serializeModelRoutingConfig),
        allowedModels: ALLOWED_MODELS,
      });
    } catch (error) {
      console.error("Error fetching model routing config:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to fetch model routing config" });
    }
  });

  router.patch("/model-routing/:feature/:plan", async (req, res) => {
    try {
      const feature = typeof req.params.feature === "string"
        ? req.params.feature.trim().toLowerCase()
        : "";
      const plan = typeof req.params.plan === "string"
        ? req.params.plan.trim().toLowerCase()
        : "";
      const model = typeof req.body?.model === "string"
        ? req.body.model.trim()
        : req.body?.model;
      const reasoningEffort = req.body?.reasoningEffort === null
        ? null
        : typeof req.body?.reasoningEffort === "string"
          ? req.body.reasoningEffort.trim()
          : req.body?.reasoningEffort;
      const validation = validateModelRoutingUpdate({
        feature,
        plan,
        model,
        reasoningEffort,
      });

      if (validation.error) {
        return res.status(400).json({ error: validation.error });
      }

      const before = await prisma.modelRoutingConfig.findUnique({
        where: {
          feature_plan: {
            feature,
            plan,
          },
        },
      });

      if (!before) {
        return res.status(404).json({ error: "Model routing config row not found" });
      }

      const updated = await prisma.modelRoutingConfig.update({
        where: {
          feature_plan: {
            feature,
            plan,
          },
        },
        data: {
          model,
          reasoningEffort,
          updatedByAdminId: req.session.user.id,
        },
      });
      await invalidateRoutingCache();

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "model_routing.update",
        targetId: `${feature}:${plan}`,
        details: {
          before: {
            model: before.model,
            reasoningEffort: before.reasoningEffort,
          },
          after: {
            model: updated.model,
            reasoningEffort: updated.reasoningEffort,
          },
        },
        ipAddress: getIpAddress(req),
      });

      res.json(serializeModelRoutingConfig(updated));
    } catch (error) {
      console.error("Error updating model routing config:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to update model routing config" });
    }
  });

  router.get("/users", async (req, res) => {
    try {
      const filters = normalizeUserFilters({
        search: getQueryValue(req.query.search),
        role: getQueryValue(req.query.role),
        plan: getQueryValue(req.query.plan),
        status: getQueryValue(req.query.status),
      });
      const limit = Math.min(Math.max(parseNumber(getQueryValue(req.query.limit), 50), 1), 200);
      const offset = Math.max(parseNumber(getQueryValue(req.query.offset), 0), 0);
      const where = buildUserFilter(filters);

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
      const telegramUsageByUserId = await getTelegramUsageByUserIds(
        prisma,
        users.map((user) => user.id),
      );

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "LIST_USERS",
        details: { ...filters, limit, offset },
        ipAddress: getIpAddress(req),
      });

      res.json({
        total,
        limit,
        offset,
        users: users.map((user) => ({
          ...serializeUser(user),
          documentCount: user._count?.documents || 0,
          sessionCount: user._count?.sessions || 0,
          telegram: telegramUsageByUserId.get(user.id),
        })),
      });
    } catch (error) {
      console.error("Error fetching users:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  router.post("/users/bulk-action", async (req, res) => {
    try {
      const action = typeof req.body?.action === "string"
        ? req.body.action.trim().toLowerCase()
        : "";
      if (!new Set(["suspend", "delete"]).has(action)) {
        return res.status(400).json({ error: "action must be suspend or delete" });
      }

      const matchedUsers = await resolveBulkUsers(prisma, req.body?.selection);
      const { eligible, excluded } = getBulkEligibility(
        matchedUsers,
        action,
        req.session.user.id,
      );
      const confirmationText = `${action.toUpperCase()} ${eligible.length}`;
      const summary = {
        action,
        matched: matchedUsers.length,
        affected: eligible.length,
        excluded,
        confirmationText,
      };

      if (req.body?.preview === true) {
        return res.json({ preview: true, ...summary });
      }

      if (req.body?.confirmation !== confirmationText) {
        return res.status(400).json({
          error: `Type ${confirmationText} to confirm this bulk action`,
          ...summary,
        });
      }

      if (eligible.length === 0) {
        return res.json({ success: true, ...summary });
      }

      if (action === "suspend") {
        const ids = eligible.map((user) => user.id);
        await transactWithAudit(prisma, buildAuditData(req, {
          action: "BULK_SUSPEND_USERS",
          details: {
            userIds: ids,
            matched: matchedUsers.length,
            excluded,
            reason: typeof req.body?.reason === "string"
              ? req.body.reason.trim().slice(0, 500)
              : "Bulk admin action",
          },
          previousValue: eligible.map((user) => ({ id: user.id, banned: Boolean(user.banned) })),
          newValue: eligible.map((user) => ({ id: user.id, banned: true })),
        }), async (tx) => {
          await tx.user.updateMany({
            where: { id: { in: ids } },
            data: {
              banned: true,
              banReason: typeof req.body?.reason === "string" && req.body.reason.trim()
                ? req.body.reason.trim().slice(0, 500)
                : "Bulk admin action",
              banExpires: null,
            },
          });
          await tx.session.deleteMany({ where: { userId: { in: ids } } });
        });
      } else {
        for (const user of eligible) {
          await deleteAdminUserData({
            prisma,
            userId: user.id,
            deleteStorageFile,
            auditData: buildAuditData(req, {
              action: "DELETE_USER",
              targetId: user.id,
              details: { email: user.email, source: "bulk" },
              previousValue: { email: user.email, accountPresent: true },
              newValue: { deleted: true },
            }),
          });
        }
      }

      res.json({ success: true, ...summary });
    } catch (error) {
      console.error("Error applying bulk user action:", error);
      captureSentryException(error, { tags: { route: "admin", endpoint: "users_bulk_action" } });
      res.status(500).json({ error: "Failed to apply bulk user action" });
    }
  });

  router.post("/users", async (req, res) => {
    try {
      const {
        email,
        name,
        password,
        role,
        plan,
        documentCapOverride,
        costCapUsdOverride,
        tokenCapOverride,
        monthlyLimit,
      } = req.body;
      const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
      const normalizedName = typeof name === "string" ? name.trim() : "";
      const normalizedPassword = typeof password === "string" ? password : "";
      const normalizedRole = typeof role === "string" ? role.trim().toLowerCase() : undefined;
      const normalizedPlan = typeof plan === "string" ? plan.trim().toLowerCase() : undefined;

      if (!normalizedEmail || !normalizedName) {
        return res.status(400).json({ error: "Email and name are required" });
      }

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        return res.status(400).json({ error: "Invalid email" });
      }

      if (!normalizedPassword.trim()) {
        return res.status(400).json({ error: "Temporary password is required" });
      }

      if (!normalizedRole || !["admin", "user"].includes(normalizedRole)) {
        return res.status(400).json({ error: "Invalid role" });
      }

      if (!normalizedPlan || !["free", "premium"].includes(normalizedPlan)) {
        return res.status(400).json({ error: "Invalid plan" });
      }

      if (!auth?.api?.createUser) {
        return res.status(500).json({ error: "Auth createUser not available" });
      }

      const parsedDocumentCap = parseCreateIntegerOverride(documentCapOverride, "documentCapOverride");
      if (!parsedDocumentCap.valid) {
        return res.status(400).json({ error: parsedDocumentCap.error });
      }

      const parsedCostCap = parseCreateCostOverride(costCapUsdOverride);
      if (!parsedCostCap.valid) {
        return res.status(400).json({ error: parsedCostCap.error });
      }

      const parsedTokenCap = parseCreateIntegerOverride(tokenCapOverride, "tokenCapOverride");
      if (!parsedTokenCap.valid) {
        return res.status(400).json({ error: parsedTokenCap.error });
      }

      const payload = {
        email: normalizedEmail,
        name: normalizedName,
        password: normalizedPassword,
        role: normalizedRole,
        data: {
          plan: normalizedPlan,
          emailVerified: true,
        },
      };

      const limitUpdates = {};
      if (parsedDocumentCap.provided) {
        limitUpdates.documentCapOverride = parsedDocumentCap.value;
      }
      if (parsedCostCap.provided) {
        limitUpdates.costCapUsdOverride = parsedCostCap.value;
      }
      if (parsedTokenCap.provided) {
        limitUpdates.tokenCapOverride = parsedTokenCap.value;
      }

      await prisma.auditLog.create({
        data: buildAuditData(req, {
          action: "CREATE_USER",
          targetId: normalizedEmail,
          details: {
            email: normalizedEmail,
            role: normalizedRole,
            plan: normalizedPlan,
            passwordCredentialRequested: true,
            emailVerified: true,
            capOverrides: limitUpdates,
            legacyMonthlyLimitIgnored: monthlyLimit !== undefined,
            ordering: "audit_before_auth_mutation",
          },
          previousValue: null,
          newValue: {
            email: normalizedEmail,
            name: normalizedName,
            role: normalizedRole,
            plan: normalizedPlan,
            capOverrides: limitUpdates,
          },
        }),
      });

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

      if (Object.keys(limitUpdates).length > 0) {
        await prisma.userLimit.upsert({
          where: { userId: created.user.id },
          update: {
            ...limitUpdates,
            overrideBy: req.session.user.id,
          },
          create: {
            userId: created.user.id,
            ...limitUpdates,
            overrideBy: req.session.user.id,
          },
        });
      }

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

      const [examAttempts, flashcardProgress, activeSessions] = await prisma.$transaction([
        prisma.examAttempt.count({ where: { userId: id } }),
        prisma.flashcardProgress.count({ where: { userId: id } }),
        prisma.session.count({
          where: {
            userId: id,
            expiresAt: { gt: new Date() },
          },
        }),
      ]);
      const telegramUsage = (await getTelegramUsageByUserIds(prisma, [id])).get(id);

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "VIEW_USER",
        targetId: id,
        ipAddress: getIpAddress(req),
      });

      res.json({
        user: {
          ...serializeUser(user),
          telegram: telegramUsage,
        },
        stats: {
          documents: user._count?.documents || 0,
          sessions: activeSessions,
          examAttempts,
          flashcardProgress,
          telegram: telegramUsage,
        },
      });
    } catch (error) {
      console.error("Error fetching user:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to fetch user" });
    }
  });

  router.get("/users/:id/export", async (req, res) => {
    try {
      const { id } = req.params;
      const user = await prisma.user.findUnique({ where: { id } });
      if (!user) return res.status(404).json({ error: "User not found" });

      const [
        documents,
        examAttempts,
        flashcardProgress,
        flashcardCardStates,
        usageEvents,
        modelUsageEvents,
        exportArtifacts,
        jobs,
        sessions,
        telegramConnection,
        telegramDeliveryLogs,
        userLimit,
      ] = await Promise.all([
        prisma.document.findMany({ where: { userId: id } }),
        prisma.examAttempt.findMany({ where: { userId: id } }),
        prisma.flashcardProgress.findMany({ where: { userId: id } }),
        prisma.flashcardCardState.findMany({ where: { userId: id } }),
        prisma.usageEvent.findMany({ where: { userId: id } }),
        prisma.modelUsageEvent.findMany({ where: { userId: id } }),
        prisma.exportArtifact.findMany({ where: { userId: id } }),
        prisma.job.findMany({ where: { userId: id } }),
        prisma.session.findMany({
          where: { userId: id },
          select: {
            id: true,
            createdAt: true,
            updatedAt: true,
            expiresAt: true,
            ipAddress: true,
            userAgent: true,
            impersonatedBy: true,
          },
        }),
        prisma.telegramConnection.findUnique({ where: { userId: id } }),
        prisma.telegramDeliveryLog.findMany({ where: { userId: id } }),
        prisma.userLimit.findUnique({ where: { userId: id } }),
      ]);

      await logAdminAction(prisma, buildAuditData(req, {
        action: "EXPORT_USER_DATA",
        targetId: id,
        details: { email: user.email },
      }));

      const exportedAt = new Date().toISOString();
      const filenameEmail = user.email.replace(/[^a-z0-9@._-]+/gi, "_");
      res.setHeader("Content-Disposition", `attachment; filename=studymaxing-${filenameEmail}-${exportedAt.slice(0, 10)}.json`);
      res.json({
        schemaVersion: 1,
        exportedAt,
        user: serializeUser(user),
        documents: documents.map(omitInternalStorageKey),
        examAttempts,
        flashcardProgress,
        flashcardCardStates,
        usageEvents,
        modelUsageEvents,
        exportArtifacts: exportArtifacts.map(omitInternalStorageKey),
        jobs,
        sessions,
        telegramConnection,
        telegramDeliveryLogs,
        userLimit: userLimit ? serializeUserLimit(userLimit) : null,
      });
    } catch (error) {
      console.error("Error exporting user data:", error);
      captureSentryException(error, { tags: { route: "admin", endpoint: "user_export" } });
      res.status(500).json({ error: "Failed to export user data" });
    }
  });

  router.post("/users/:id/impersonate", async (req, res) => {
    try {
      const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
      if (!reason) return res.status(400).json({ error: "A support-login reason is required" });
      if (!auth?.api?.impersonateUser) {
        return res.status(500).json({ error: "Auth impersonation is not available" });
      }

      const target = await prisma.user.findUnique({
        where: { id: req.params.id },
        select: { id: true, email: true, name: true, role: true },
      });
      if (!target) return res.status(404).json({ error: "User not found" });
      if (target.id === req.session.user.id) {
        return res.status(400).json({ error: "You cannot support-login as yourself" });
      }

      await prisma.auditLog.create({
        data: buildAuditData(req, {
          action: "IMPERSONATE_USER",
          targetId: target.id,
          details: {
            actingAdminId: req.session.user.id,
            targetUserId: target.id,
            targetEmail: target.email,
            reason: reason.slice(0, 1000),
            maxDurationMinutes: 60,
          },
          previousValue: { impersonatingUserId: null },
          newValue: { impersonatingUserId: target.id, maxDurationMinutes: 60 },
        }),
      });

      const authResponse = await auth.api.impersonateUser({
        headers: req.headers,
        body: { userId: target.id },
        asResponse: true,
      });
      const setCookies = typeof authResponse.headers.getSetCookie === "function"
        ? authResponse.headers.getSetCookie()
        : [authResponse.headers.get("set-cookie")].filter(Boolean);
      if (setCookies.length > 0) res.setHeader("Set-Cookie", setCookies);

      const payload = await authResponse.text();
      res.status(authResponse.status);
      res.type(authResponse.headers.get("content-type") || "application/json");
      res.send(payload);
    } catch (error) {
      console.error("Error starting support login:", error);
      captureSentryException(error, { tags: { route: "admin", endpoint: "user_impersonate" } });
      res.status(error?.statusCode || 500).json({
        error: error?.body?.message || error?.message || "Failed to start support login",
      });
    }
  });

  router.post("/users/:id/erase", async (req, res) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.params.id },
        select: { id: true, email: true },
      });
      if (!user) return res.status(404).json({ error: "User not found" });
      if (user.id === req.session.user.id) {
        return res.status(400).json({ error: "You cannot erase your own active admin account" });
      }
      if (req.body?.confirmation !== user.email) {
        return res.status(400).json({ error: "Type the user's exact email address to erase their data" });
      }

      await deleteAdminUserData({
        prisma,
        userId: user.id,
        deleteStorageFile,
        auditData: buildAuditData(req, {
          action: "ERASE_USER_DATA",
          targetId: user.id,
          details: { email: user.email },
          previousValue: { email: user.email, dataPresent: true },
          newValue: { deleted: true },
        }),
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error erasing user data:", error);
      captureSentryException(error, { tags: { route: "admin", endpoint: "user_erase" } });
      res.status(500).json({ error: "Failed to erase user data" });
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

      const action = updates.role && updates.role !== existing.role
        ? "SET_ROLE"
        : "UPDATE_USER";

      const updatedUser = await transactWithAudit(prisma, buildAuditData(req, {
        action,
        targetId: id,
        details: { before: existing, after: updates },
      }), (tx) => tx.user.update({
        where: { id },
        data: updates,
      }));

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

      if (id === req.session.user.id) {
        return res.status(400).json({ error: "You cannot delete your own active admin account" });
      }

      if (req.body?.confirmation !== "DELETE") {
        return res.status(400).json({ error: "Type DELETE to confirm account deletion" });
      }

      await deleteAdminUserData({
        prisma,
        userId: id,
        deleteStorageFile,
        auditData: buildAuditData(req, {
          action: "DELETE_USER",
          targetId: id,
          details: { email: user.email },
          previousValue: { email: user.email, accountPresent: true },
          newValue: { deleted: true },
        }),
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
        select: { id: true, banned: true, banReason: true, banExpires: true },
      });

      if (!existing) {
        return res.status(404).json({ error: "User not found" });
      }

      const user = await transactWithAudit(prisma, buildAuditData(req, {
        action: "BAN_USER",
        targetId: id,
        details: {
          reason: reason || "Admin action",
          before: existing,
          after: { banned: true, banReason: reason || "Admin action", banExpires: banExpires || null },
        },
      }), async (tx) => {
        const updated = await tx.user.update({
          where: { id },
          data: {
            banned: true,
            banReason: reason || "Admin action",
            banExpires: banExpires ? new Date(banExpires) : null,
          },
        });
        await tx.session.deleteMany({ where: { userId: id } });
        return updated;
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
        select: { id: true, banned: true, banReason: true, banExpires: true },
      });

      if (!existing) {
        return res.status(404).json({ error: "User not found" });
      }

      const user = await transactWithAudit(prisma, buildAuditData(req, {
        action: "UNBAN_USER",
        targetId: id,
        details: {
          before: existing,
          after: { banned: false, banReason: null, banExpires: null },
        },
      }), (tx) => tx.user.update({
        where: { id },
        data: {
          banned: false,
          banReason: null,
          banExpires: null,
        },
      }));

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

      // Storage deletion is the non-transactional precondition. If it fails,
      // the database document and accounting remain unchanged.
      if (document.storageKey) {
        await deleteStorageFile(document.storageKey);
      }

      const owner = await prisma.user.findUnique({
        where: { id },
        select: { storageUsed: true },
      });

      const currentStorage = owner?.storageUsed ?? BigInt(0);
      const nextStorage = currentStorage - BigInt(document.fileSize);

      await transactWithAudit(prisma, buildAuditData(req, {
        action: "DELETE_USER_FILE",
        targetId: id,
        details: { documentId, originalName: document.originalName },
        previousValue: { documentId, originalName: document.originalName, fileSize: document.fileSize },
        newValue: { deleted: true },
      }), async (tx) => {
        await tx.document.delete({ where: { id: documentId } });
        await tx.user.update({
          where: { id },
          data: {
            storageUsed: nextStorage > 0 ? nextStorage : BigInt(0),
          },
        });
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
        where: {
          userId: id,
          expiresAt: { gt: new Date() },
        },
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
      const revokeAll = async (tx) => {
        const activeBefore = await tx.session.count({
          where: { userId: id, expiresAt: { gt: new Date() } },
        });
        const result = await tx.session.deleteMany({ where: { userId: id } });
        await tx.auditLog.create({
          data: buildAuditData(req, {
            action: "REVOKE_USER_SESSIONS",
            targetId: id,
            details: {
              scope: "all_active_and_expired",
              revokedCount: result.count,
              activeRevokedCount: activeBefore,
            },
            previousValue: { activeSessions: activeBefore },
            newValue: { activeSessions: 0 },
          }),
        });
        return { ...result, activeRevoked: activeBefore };
      };
      const result = typeof prisma.$transaction === "function"
        ? await prisma.$transaction(revokeAll)
        : await revokeAll(prisma);

      res.json({ success: true, revoked: result.count, activeRevoked: result.activeRevoked });
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

      await transactWithAudit(prisma, buildAuditData(req, {
        action: "REVOKE_SESSION",
        targetId: id,
        details: { sessionId, revokedCount: 1, activeRevokedCount: 1 },
        previousValue: { sessionId, status: "active" },
        newValue: { sessionId, status: "revoked" },
      }), (tx) => tx.session.delete({ where: { id: sessionId } }));

      res.json({ success: true });
    } catch (error) {
      console.error("Error revoking session:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to revoke session" });
    }
  });

  router.get("/sessions", async (req, res) => {
    try {
      const limit = Math.min(parseNumber(getQueryValue(req.query.limit), 50), 200);
      const offset = Math.max(parseNumber(getQueryValue(req.query.offset), 0), 0);
      const userId = getQueryValue(req.query.userId)?.trim() || "";
      const now = new Date();
      const todayStart = new Date(now);
      todayStart.setUTCHours(0, 0, 0, 0);
      const activeWhere = {
        expiresAt: { gt: now },
        ...(userId ? { userId } : {}),
      };
      const expiredWhere = {
        expiresAt: { lte: now },
        ...(userId ? { userId } : {}),
      };
      const revokeWhere = {
        action: { in: ["REVOKE_SESSION", "REVOKE_USER_SESSIONS"] },
        createdAt: { gte: todayStart },
        ...(userId ? { targetId: userId } : {}),
      };

      const [total, expiredExcluded, sessions, revokeLogs] = await prisma.$transaction([
        prisma.session.count({ where: activeWhere }),
        prisma.session.count({ where: expiredWhere }),
        prisma.session.findMany({
          where: activeWhere,
          orderBy: { updatedAt: "desc" },
          skip: offset,
          take: limit,
          include: {
            user: {
              select: { id: true, email: true, name: true, role: true },
            },
          },
        }),
        prisma.auditLog.findMany({
          where: revokeWhere,
          select: { details: true },
        }),
      ]);
      const revokedToday = revokeLogs.reduce(
        (sum, log) => sum + Math.max(Number(log.details?.activeRevokedCount ?? log.details?.revokedCount ?? 1), 0),
        0,
      );

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "LIST_SESSIONS",
        details: { limit, offset, userId: userId || null },
        ipAddress: getIpAddress(req),
      });

      res.json({
        total,
        limit,
        offset,
        sessions,
        kpis: { active: total, revokedToday, expiredExcluded },
      });
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
        select: { id: true, userId: true },
      });

      if (!existing) {
        return res.status(404).json({ error: "Session not found" });
      }

      await transactWithAudit(prisma, buildAuditData(req, {
        action: "REVOKE_SESSION",
        targetId: existing.userId,
        details: { sessionId, revokedCount: 1, activeRevokedCount: 1 },
        previousValue: { sessionId, status: "active" },
        newValue: { sessionId, status: "revoked" },
      }), (tx) => tx.session.delete({ where: { id: sessionId } }));

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

  router.get("/usage/summary", async (req, res) => {
    try {
      const ledgerQuery = buildUsageLedgerWhere(req.query);
      if (ledgerQuery.error) {
        return res.status(400).json({ error: ledgerQuery.error });
      }

      const sarRate = getUsdToSarRate();
      const summary = await getUsageSummary(prisma, ledgerQuery.where, sarRate);

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "VIEW_LEDGER_USAGE_SUMMARY",
        details: ledgerQuery.filters,
        ipAddress: getIpAddress(req),
      });

      res.json({
        sarRate,
        sarApproximate: true,
        filters: ledgerQuery.filters,
        ...summary,
      });
    } catch (error) {
      console.error("Error fetching ledger usage summary:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to fetch usage summary" });
    }
  });

  router.get("/usage/timeseries", async (req, res) => {
    try {
      const granularity = getQueryValue(req.query.granularity) || "day";
      if (!USAGE_GRANULARITIES.has(granularity)) {
        return res.status(400).json({ error: "granularity must be hour, day, week, month, or year" });
      }

      const ledgerQuery = buildUsageLedgerWhere(req.query);
      if (ledgerQuery.error) {
        return res.status(400).json({ error: ledgerQuery.error });
      }

      const sarRate = getUsdToSarRate();
      const series = await buildUsageTimeSeries(prisma, ledgerQuery.where, granularity, sarRate);

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "VIEW_LEDGER_USAGE_TIMESERIES",
        details: { ...ledgerQuery.filters, granularity },
        ipAddress: getIpAddress(req),
      });

      res.json({
        granularity,
        sarRate,
        sarApproximate: true,
        filters: ledgerQuery.filters,
        series,
      });
    } catch (error) {
      console.error("Error fetching usage timeseries:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to fetch usage timeseries" });
    }
  });

  router.get("/usage/users", async (req, res) => {
    try {
      const ledgerQuery = buildUsageLedgerWhere(req.query);
      if (ledgerQuery.error) {
        return res.status(400).json({ error: ledgerQuery.error });
      }

      const sarRate = getUsdToSarRate();
      const groups = await prisma.modelUsageEvent.groupBy({
        by: ["userId"],
        where: ledgerQuery.where,
        _count: { _all: true },
        _sum: { estimatedCostUsd: true, inputTokens: true, outputTokens: true, totalTokens: true },
      });
      const userIds = groups.map((group) => group.userId);
      const users = userIds.length
        ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, email: true, name: true, plan: true, role: true },
        })
        : [];
      const usersById = new Map(users.map((user) => [user.id, user]));
      const usageUsers = sortUsageGroups(groups.map((group) => ({
        ...serializeUsageGroup(group, "userId", sarRate),
        user: usersById.get(group.userId) ?? null,
      })));

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "VIEW_LEDGER_USAGE_USERS",
        details: ledgerQuery.filters,
        ipAddress: getIpAddress(req),
      });

      res.json({ sarRate, sarApproximate: true, filters: ledgerQuery.filters, users: usageUsers });
    } catch (error) {
      console.error("Error fetching usage users:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to fetch usage by users" });
    }
  });

  router.get("/usage/users/:userId", async (req, res) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.params.userId },
        select: { id: true, email: true, name: true, plan: true, role: true },
      });
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const ledgerQuery = buildUsageLedgerWhere({
        ...req.query,
        userId: req.params.userId,
      });
      if (ledgerQuery.error) {
        return res.status(400).json({ error: ledgerQuery.error });
      }

      const granularity = getQueryValue(req.query.granularity) || "day";
      if (!USAGE_GRANULARITIES.has(granularity)) {
        return res.status(400).json({ error: "granularity must be hour, day, week, month, or year" });
      }

      const sarRate = getUsdToSarRate();
      const [summary, featureGroups, modelGroups, documentGroups, series] = await Promise.all([
        getUsageSummary(prisma, ledgerQuery.where, sarRate),
        prisma.modelUsageEvent.groupBy({
          by: ["featureKey"],
          where: ledgerQuery.where,
          _count: { _all: true },
          _sum: { estimatedCostUsd: true, inputTokens: true, outputTokens: true, totalTokens: true },
        }),
        prisma.modelUsageEvent.groupBy({
          by: ["model"],
          where: ledgerQuery.where,
          _count: { _all: true },
          _sum: { estimatedCostUsd: true, inputTokens: true, outputTokens: true, totalTokens: true },
        }),
        prisma.modelUsageEvent.groupBy({
          by: ["documentId"],
          where: buildDocumentUsageWhere(ledgerQuery.where),
          _count: { _all: true },
          _sum: { estimatedCostUsd: true, inputTokens: true, outputTokens: true, totalTokens: true },
        }),
        buildUsageTimeSeries(prisma, ledgerQuery.where, granularity, sarRate),
      ]);
      const documentIds = documentGroups.map((group) => group.documentId).filter(Boolean);
      const documents = documentIds.length
        ? await prisma.document.findMany({
          where: { id: { in: documentIds } },
          select: { id: true, originalName: true, processingStatus: true },
        })
        : [];
      const documentsById = new Map(documents.map((document) => [document.id, document]));

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "VIEW_LEDGER_USER_USAGE_DETAIL",
        targetId: req.params.userId,
        details: { ...ledgerQuery.filters, granularity },
        ipAddress: getIpAddress(req),
      });

      res.json({
        user,
        sarRate,
        sarApproximate: true,
        granularity,
        filters: ledgerQuery.filters,
        totals: summary.totals,
        features: sortUsageGroups(featureGroups.map((group) => serializeUsageGroup(group, "featureKey", sarRate))),
        models: sortUsageGroups(modelGroups.map((group) => serializeUsageGroup(group, "model", sarRate))),
        documents: sortUsageGroups(documentGroups.map((group) => ({
          ...serializeUsageGroup(group, "documentId", sarRate),
          document: documentsById.get(group.documentId) ?? null,
        }))),
        series,
      });
    } catch (error) {
      console.error("Error fetching user usage detail:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to fetch user usage detail" });
    }
  });

  router.get("/usage/documents", async (req, res) => {
    try {
      const ledgerQuery = buildUsageLedgerWhere(req.query);
      if (ledgerQuery.error) return res.status(400).json({ error: ledgerQuery.error });

      const sarRate = getUsdToSarRate();
      const groups = await prisma.modelUsageEvent.groupBy({
        by: ["documentId"],
        where: buildDocumentUsageWhere(ledgerQuery.where),
        _count: { _all: true },
        _sum: { estimatedCostUsd: true, inputTokens: true, outputTokens: true, totalTokens: true },
      });
      const documentIds = groups.map((group) => group.documentId).filter(Boolean);
      const documents = documentIds.length
        ? await prisma.document.findMany({
          where: { id: { in: documentIds } },
          select: { id: true, originalName: true, userId: true, processingStatus: true },
        })
        : [];
      const documentsById = new Map(documents.map((document) => [document.id, document]));
      const documentsUsage = sortUsageGroups(groups.map((group) => ({
        ...serializeUsageGroup(group, "documentId", sarRate),
        document: documentsById.get(group.documentId) ?? null,
      })));

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "VIEW_LEDGER_USAGE_DOCUMENTS",
        details: ledgerQuery.filters,
        ipAddress: getIpAddress(req),
      });

      res.json({ sarRate, sarApproximate: true, filters: ledgerQuery.filters, documents: documentsUsage });
    } catch (error) {
      console.error("Error fetching usage documents:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to fetch usage by documents" });
    }
  });

  router.get("/usage/models", async (req, res) => {
    try {
      const ledgerQuery = buildUsageLedgerWhere(req.query);
      if (ledgerQuery.error) return res.status(400).json({ error: ledgerQuery.error });

      const sarRate = getUsdToSarRate();
      const groups = await prisma.modelUsageEvent.groupBy({
        by: ["model"],
        where: ledgerQuery.where,
        _count: { _all: true },
        _sum: { estimatedCostUsd: true, inputTokens: true, outputTokens: true, totalTokens: true },
      });

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "VIEW_LEDGER_USAGE_MODELS",
        details: ledgerQuery.filters,
        ipAddress: getIpAddress(req),
      });

      res.json({
        sarRate,
        sarApproximate: true,
        filters: ledgerQuery.filters,
        models: sortUsageGroups(groups.map((group) => serializeUsageGroup(group, "model", sarRate))),
      });
    } catch (error) {
      console.error("Error fetching usage models:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to fetch usage by models" });
    }
  });

  router.get("/usage/features", async (req, res) => {
    try {
      const ledgerQuery = buildUsageLedgerWhere(req.query);
      if (ledgerQuery.error) return res.status(400).json({ error: ledgerQuery.error });

      const sarRate = getUsdToSarRate();
      const groups = await prisma.modelUsageEvent.groupBy({
        by: ["featureKey"],
        where: ledgerQuery.where,
        _count: { _all: true },
        _sum: { estimatedCostUsd: true, inputTokens: true, outputTokens: true, totalTokens: true },
      });

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "VIEW_LEDGER_USAGE_FEATURES",
        details: ledgerQuery.filters,
        ipAddress: getIpAddress(req),
      });

      res.json({
        sarRate,
        sarApproximate: true,
        filters: ledgerQuery.filters,
        features: sortUsageGroups(groups.map((group) => serializeUsageGroup(group, "featureKey", sarRate))),
      });
    } catch (error) {
      console.error("Error fetching usage features:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to fetch usage by features" });
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

  router.get("/jobs/summary", async (req, res) => {
    try {
      const now = new Date();
      const staleCutoff = new Date(now.getTime() - 120_000);
      const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      const [totalsByStatus, failedLast24h, stuckJobs, runningJobs] = await prisma.$transaction([
        prisma.job.groupBy({
          by: ["status"],
          _count: { _all: true },
        }),
        prisma.job.count({
          where: {
            status: "failed",
            completedAt: { gte: since24h },
          },
        }),
        prisma.job.findMany({
          where: {
            status: "running",
            OR: [
              { leaseExpiresAt: { lt: now } },
              {
                leaseExpiresAt: null,
                startedAt: { lt: staleCutoff },
              },
            ],
          },
          orderBy: { startedAt: "asc" },
          take: 20,
          include: {
            user: { select: { id: true, email: true, name: true } },
          },
        }),
        prisma.job.count({ where: { status: "running" } }),
      ]);

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "VIEW_JOB_SUMMARY",
        ipAddress: getIpAddress(req),
      });

      res.json({
        totalsByStatus: totalsByStatus.reduce((acc, group) => ({
          ...acc,
          [group.status]: group._count?._all || 0,
        }), {}),
        failedLast24h,
        runningJobs,
        stuckJobs: stuckJobs.map((job) => serializeAdminJob(job, { now })),
      });
    } catch (error) {
      console.error("Error fetching job summary:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to fetch job summary" });
    }
  });

  router.get("/jobs/:id", async (req, res) => {
    try {
      const job = await prisma.job.findUnique({
        where: { id: req.params.id },
        include: {
          user: { select: { id: true, email: true, name: true } },
          stageEvents: {
            orderBy: [
              { startedAt: "asc" },
              { createdAt: "asc" },
            ],
          },
        },
      });

      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      const documentId = getJobDocumentId(job);
      const [document, generation] = await Promise.all([
        documentId
          ? prisma.document.findUnique({
            where: { id: documentId },
            select: { id: true, originalName: true, processingStatus: true },
          })
          : null,
        prisma.documentGeneration.findFirst({
          where: { jobId: job.id },
          select: { id: true, generationType: true, status: true, isLatest: true },
          orderBy: { createdAt: "desc" },
        }),
      ]);

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "VIEW_JOB_DETAIL",
        targetId: job.id,
        ipAddress: getIpAddress(req),
      });

      res.json({
        job: serializeAdminJob(job, {
          documentsById: document ? new Map([[document.id, document]]) : new Map(),
          generationsByJobId: generation ? new Map([[job.id, generation]]) : new Map(),
        }),
      });
    } catch (error) {
      console.error("Error fetching job detail:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to fetch job detail" });
    }
  });

  router.get("/jobs", async (req, res) => {
    try {
      const pagination = buildPagination(req.query);
      if (pagination.error) {
        return res.status(400).json({ error: pagination.error });
      }

      const dateRange = buildDateRangeFilter(req.query);
      if (dateRange.error) {
        return res.status(400).json({ error: dateRange.error });
      }

      const status = getQueryValue(req.query.status);
      const jobType = getQueryValue(req.query.jobType);
      const userId = getQueryValue(req.query.userId);
      const documentId = getQueryValue(req.query.documentId);
      const failedOnly = getQueryValue(req.query.failedOnly) === "true";
      const stuckOnly = getQueryValue(req.query.stuckOnly) === "true";
      const now = new Date();
      const staleCutoff = new Date(now.getTime() - 120_000);
      const where = {};

      if (failedOnly) {
        where.status = "failed";
      } else if (status && status !== "all") {
        where.status = status;
      }
      if (jobType && jobType !== "all") where.jobType = jobType;
      if (userId) where.userId = userId;
      if (documentId) where.documentId = documentId;
      if (dateRange.filter) where.queuedAt = dateRange.filter;
      if (stuckOnly) {
        where.status = "running";
        where.OR = [
          { leaseExpiresAt: { lt: now } },
          {
            leaseExpiresAt: null,
            startedAt: { lt: staleCutoff },
          },
        ];
      }

      const [total, jobs] = await prisma.$transaction([
        prisma.job.count({ where }),
        prisma.job.findMany({
          where,
          orderBy: { queuedAt: "desc" },
          skip: pagination.skip,
          take: pagination.limit,
          include: {
            user: { select: { id: true, email: true, name: true } },
          },
        }),
      ]);
      const documentIds = [...new Set(jobs.map(getJobDocumentId).filter(Boolean))];
      const jobIds = jobs.map((job) => job.id);
      const [documents, generations] = await Promise.all([
        documentIds.length > 0
          ? prisma.document.findMany({
            where: { id: { in: documentIds } },
            select: { id: true, originalName: true, processingStatus: true },
          })
          : [],
        jobIds.length > 0
          ? prisma.documentGeneration.findMany({
            where: { jobId: { in: jobIds } },
            select: { id: true, jobId: true, generationType: true, status: true, isLatest: true },
          })
          : [],
      ]);
      const documentsById = new Map(documents.map((document) => [document.id, document]));
      const generationsByJobId = new Map(generations.map((generation) => [generation.jobId, generation]));

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "LIST_JOBS",
        details: {
          status: status || null,
          jobType: jobType || null,
          userId: userId || null,
          documentId: documentId || null,
          failedOnly,
          stuckOnly,
          page: pagination.page,
          limit: pagination.limit,
        },
        ipAddress: getIpAddress(req),
      });

      res.json({
        ...createPaginationMeta(pagination.page, pagination.limit, total),
        jobs: jobs.map((job) => serializeAdminJob(job, { documentsById, generationsByJobId, now })),
      });
    } catch (error) {
      console.error("Error fetching jobs:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to fetch jobs" });
    }
  });

  router.get("/caps/defaults", async (req, res) => {
    try {
      await ensureDefaultUsageCapConfigs(prisma);
      const configs = await prisma.usageCapConfig.findMany({
        orderBy: { plan: "asc" },
      });

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "VIEW_USAGE_CAP_DEFAULTS",
        ipAddress: getIpAddress(req),
      });

      res.json({ caps: configs.map(serializeUsageCapConfig) });
    } catch (error) {
      console.error("Error fetching usage cap defaults:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to fetch usage cap defaults" });
    }
  });

  router.post("/caps/defaults/:plan/impact", async (req, res) => {
    try {
      const plan = typeof req.params.plan === "string"
        ? req.params.plan.trim().toLowerCase()
        : "";
      if (!["free", "premium"].includes(plan)) {
        return res.status(400).json({ error: "Invalid plan" });
      }

      const fallback = getFallbackCapConfig(plan);
      const current = await prisma.usageCapConfig.findUnique({ where: { plan } });
      const baseCaps = current
        ? serializeUsageCapConfig(current)
        : fallback;
      const proposedCaps = {
        documentCap: req.body?.documentCap === undefined
          ? baseCaps.documentCap
          : req.body.documentCap === null
            ? null
            : parseIntegerInput(req.body.documentCap, 0),
        costCapUsd: req.body?.costCapUsd === undefined
          ? baseCaps.costCapUsd
          : parseNullableNumberInput(req.body.costCapUsd, 0),
        tokenCap: req.body?.tokenCap === undefined
          ? baseCaps.tokenCap
          : req.body.tokenCap === null
            ? null
            : parseIntegerInput(req.body.tokenCap, 0),
      };

      if (
        proposedCaps.documentCap === null && req.body?.documentCap !== null && req.body?.documentCap !== undefined
      ) {
        return res.status(400).json({ error: "documentCap must be a non-negative integer or null" });
      }
      if (proposedCaps.costCapUsd === undefined) {
        return res.status(400).json({ error: "costCapUsd must be a non-negative number or null" });
      }
      if (proposedCaps.tokenCap === null && req.body?.tokenCap !== null && req.body?.tokenCap !== undefined) {
        return res.status(400).json({ error: "tokenCap must be a non-negative integer or null" });
      }

      const impact = await buildUsageCapImpact(prisma, plan, proposedCaps);

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "PREVIEW_USAGE_CAP_IMPACT",
        details: {
          plan,
          current: current ? serializeUsageCapConfig(current) : null,
          proposed: proposedCaps,
          impact,
        },
        ipAddress: getIpAddress(req),
      });

      res.json({
        current: current ? serializeUsageCapConfig(current) : null,
        proposed: proposedCaps,
        impact,
      });
    } catch (error) {
      console.error("Error previewing usage cap impact:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to preview usage cap impact" });
    }
  });

  router.patch("/caps/defaults/:plan", async (req, res) => {
    try {
      const plan = typeof req.params.plan === "string"
        ? req.params.plan.trim().toLowerCase()
        : "";
      if (!["free", "premium"].includes(plan)) {
        return res.status(400).json({ error: "Invalid plan" });
      }

      const updates = {};
      for (const field of ["documentCap", "tokenCap"]) {
        if (req.body?.[field] === undefined) {
          continue;
        }

        const parsed = req.body[field] === null
          ? null
          : parseIntegerInput(req.body[field], 0);
        if (parsed === null && req.body[field] !== null) {
          return res.status(400).json({ error: `${field} must be a non-negative integer or null` });
        }
        updates[field] = parsed;
      }

      if (req.body?.costCapUsd !== undefined) {
        const parsedCostCap = parseNullableNumberInput(req.body.costCapUsd, 0);
        if (parsedCostCap === undefined) {
          return res.status(400).json({ error: "costCapUsd must be a non-negative number or null" });
        }
        updates.costCapUsd = parsedCostCap;
      }

      if (req.body?.featureCaps !== undefined) {
        if (!req.body.featureCaps || typeof req.body.featureCaps !== "object" || Array.isArray(req.body.featureCaps)) {
          return res.status(400).json({ error: "featureCaps must be an object" });
        }
        updates.featureCaps = req.body.featureCaps;
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No valid cap updates provided" });
      }

      const before = await prisma.usageCapConfig.findUnique({ where: { plan } });
      const fallback = getFallbackCapConfig(plan);
      const capConfig = await prisma.usageCapConfig.upsert({
        where: { plan },
        update: {
          ...updates,
          updatedBy: req.session.user.id,
        },
        create: {
          plan,
          documentCap: updates.documentCap === undefined ? fallback.documentCap : updates.documentCap,
          costCapUsd: updates.costCapUsd === undefined ? fallback.costCapUsd : updates.costCapUsd,
          tokenCap: updates.tokenCap === undefined ? fallback.tokenCap : updates.tokenCap,
          featureCaps: updates.featureCaps ?? fallback.featureCaps,
          updatedBy: req.session.user.id,
        },
      });
      const impact = await buildUsageCapImpact(prisma, plan, {
        documentCap: capConfig.documentCap,
        costCapUsd: capConfig.costCapUsd === null || capConfig.costCapUsd === undefined
          ? null
          : toNumericValue(capConfig.costCapUsd),
        tokenCap: capConfig.tokenCap,
      });

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "UPDATE_USAGE_CAP_DEFAULTS",
        details: {
          plan,
          before: before ? serializeUsageCapConfig(before) : null,
          after: serializeUsageCapConfig(capConfig),
          impact,
          reason: typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : null,
        },
        ipAddress: getIpAddress(req),
      });

      res.json({ cap: serializeUsageCapConfig(capConfig), impact });
    } catch (error) {
      console.error("Error updating usage cap defaults:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to update usage cap defaults" });
    }
  });

  router.get("/users/:id/allowance", async (req, res) => {
    try {
      const allowance = await getUserAllowance(prisma, req.params.id);

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "VIEW_USER_ALLOWANCE",
        targetId: req.params.id,
        ipAddress: getIpAddress(req),
      });

      res.json({ allowance });
    } catch (error) {
      console.error("Error fetching user allowance:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(error?.statusCode || 500).json({
        error: error?.message || "Failed to fetch user allowance",
        code: error?.code,
      });
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

      const userLimit = await prisma.userLimit.findUnique({
        where: { userId: id },
      });

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "VIEW_USER_LIMITS",
        targetId: id,
        ipAddress: getIpAddress(req),
      });

      const allowance = await getUserAllowance(prisma, id);

      res.json({
        userLimit: userLimit ? serializeUserLimit(userLimit) : null,
        allowance,
      });
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

      for (const field of ["documentCapOverride", "tokenCapOverride"]) {
        if (req.body?.[field] === undefined) {
          continue;
        }

        const parsed = req.body[field] === null
          ? null
          : parseIntegerInput(req.body[field], 0);
        if (parsed === null && req.body[field] !== null) {
          return res.status(400).json({
            error: `${field} must be a non-negative integer or null`,
          });
        }

        updates[field] = parsed;
      }

      if (req.body?.costCapUsdOverride !== undefined) {
        const parsedCostCap = parseNullableNumberInput(req.body.costCapUsdOverride, 0);
        if (parsedCostCap === undefined) {
          return res.status(400).json({
            error: "costCapUsdOverride must be a non-negative number or null",
          });
        }
        updates.costCapUsdOverride = parsedCostCap;
      }

      if (req.body?.featureCapsOverride !== undefined) {
        if (
          !req.body.featureCapsOverride
          || typeof req.body.featureCapsOverride !== "object"
          || Array.isArray(req.body.featureCapsOverride)
        ) {
          return res.status(400).json({ error: "featureCapsOverride must be an object" });
        }
        updates.featureCapsOverride = req.body.featureCapsOverride;
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No valid limit updates provided" });
      }

      const existingLimit = await prisma.userLimit.findUnique({
        where: { userId: id },
      });

      const userLimit = await transactWithAudit(prisma, buildAuditData(req, {
        action: "UPDATE_USER_LIMITS",
        targetId: id,
        details: {
          before: existingLimit ? serializeUserLimit(existingLimit) : null,
          updates,
        },
      }), (tx) => tx.userLimit.upsert({
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
      }));

      const allowance = await getUserAllowance(prisma, id);

      res.json({
        userLimit: serializeUserLimit(userLimit),
        allowance,
      });
    } catch (error) {
      console.error("Error updating user limits:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to update user limits" });
    }
  });

  router.post("/users/:id/limits/overrides", async (req, res) => {
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
      for (const field of ["documentCapOverride", "tokenCapOverride"]) {
        if (req.body?.[field] === undefined) {
          continue;
        }

        const parsed = req.body[field] === null
          ? null
          : parseIntegerInput(req.body[field], 0);
        if (parsed === null && req.body[field] !== null) {
          return res.status(400).json({
            error: `${field} must be a non-negative integer or null`,
          });
        }

        updates[field] = parsed;
      }

      if (req.body?.costCapUsdOverride !== undefined) {
        const parsedCostCap = parseNullableNumberInput(req.body.costCapUsdOverride, 0);
        if (parsedCostCap === undefined) {
          return res.status(400).json({
            error: "costCapUsdOverride must be a non-negative number or null",
          });
        }
        updates.costCapUsdOverride = parsedCostCap;
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No valid override updates provided" });
      }

      const before = await prisma.userLimit.findUnique({ where: { userId: id } });
      const userLimit = await transactWithAudit(prisma, buildAuditData(req, {
        action: "SET_USER_CAP_OVERRIDES",
        targetId: id,
        details: {
          before: before ? serializeUserLimit(before) : null,
          updates,
          reason: typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : null,
        },
      }), (tx) => tx.userLimit.upsert({
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
      }));
      const allowance = await getUserAllowance(prisma, id);

      res.json({
        userLimit: serializeUserLimit(userLimit),
        allowance,
      });
    } catch (error) {
      console.error("Error setting user cap overrides:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to set user cap overrides" });
    }
  });

  router.post("/users/:id/limits/overrides/clear", async (req, res) => {
    try {
      const { id } = req.params;
      const user = await prisma.user.findUnique({
        where: { id },
        select: { id: true },
      });

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const fields = Array.isArray(req.body?.fields)
        ? req.body.fields
        : ["documentCapOverride", "costCapUsdOverride", "tokenCapOverride", "featureCapsOverride"];
      const allowedFields = new Set([
        "documentCapOverride",
        "costCapUsdOverride",
        "tokenCapOverride",
        "featureCapsOverride",
      ]);
      const updates = {};

      for (const field of fields) {
        if (!allowedFields.has(field)) {
          return res.status(400).json({ error: `Invalid override field: ${field}` });
        }
        updates[field] = field === "featureCapsOverride" ? {} : null;
      }

      const before = await prisma.userLimit.findUnique({ where: { userId: id } });
      const userLimit = await transactWithAudit(prisma, buildAuditData(req, {
        action: "CLEAR_USER_CAP_OVERRIDES",
        targetId: id,
        details: {
          fields,
          before: before ? serializeUserLimit(before) : null,
          reason: typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : null,
        },
      }), (tx) => tx.userLimit.upsert({
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
      }));
      const allowance = await getUserAllowance(prisma, id);

      res.json({
        userLimit: serializeUserLimit(userLimit),
        allowance,
      });
    } catch (error) {
      console.error("Error clearing user cap overrides:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to clear user cap overrides" });
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

      if (!existingAlert.resolved) {
        await sendTelegramAdminNotification({
          eventType: "cost_anomaly_resolved",
          user: alert.user,
          userId: alert.userId,
          errorSummary: `Cost anomaly ${id} resolved by admin ${req.session.user.id}`,
          details: `Alert type ${alert.alertType}`,
        });
      }

      res.json({ anomaly: serializeAnomalyAlert(alert) });
    } catch (error) {
      console.error("Error resolving anomaly alert:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to resolve anomaly alert" });
    }
  });

  router.get("/issues", async (req, res) => {
    try {
      const pagination = buildPagination(req.query);
      if (pagination.error) {
        return res.status(400).json({ error: pagination.error });
      }

      const parsedFilters = buildIssuesFeedFilters(req.query);
      if (parsedFilters.error) {
        return res.status(400).json({ error: parsedFilters.error });
      }

      const feed = await getIssuesFeed({
        ...parsedFilters.filters,
        page: pagination.page,
        limit: pagination.limit,
      });

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "VIEW_ISSUES_FEED",
        details: {
          page: feed.page,
          limit: feed.limit,
          type: parsedFilters.filters.types || null,
          severity: parsedFilters.filters.severity || null,
          resolved: parsedFilters.filters.resolved ?? null,
          startDate: parsedFilters.filters.startDate?.toISOString() || null,
          endDate: parsedFilters.filters.endDate?.toISOString() || null,
          total: feed.total,
        },
        ipAddress: getIpAddress(req),
      });

      res.json(feed);
    } catch (error) {
      if (error instanceof RangeError) {
        return res.status(400).json({ error: error.message });
      }

      console.error("Error fetching issues feed:", error);
      captureSentryException(error, { tags: { route: "admin", endpoint: "issues" } });
      res.status(500).json({ error: "Failed to fetch issues feed" });
    }
  });

  router.get("/issues/export", async (req, res) => {
    try {
      const parsedFilters = buildIssuesFeedFilters(req.query);
      if (parsedFilters.error) {
        return res.status(400).json({ error: parsedFilters.error });
      }

      const feed = await getIssuesFeed({
        ...parsedFilters.filters,
        page: 1,
        limit: 5000,
      });
      if (feed.total > 5000) {
        return res.status(400).json({
          error: "Export exceeds 5000 rows; narrow the filters and try again",
        });
      }

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "EXPORT_ISSUES_FEED",
        details: {
          type: parsedFilters.filters.types || null,
          severity: parsedFilters.filters.severity || null,
          resolved: parsedFilters.filters.resolved ?? null,
          startDate: parsedFilters.filters.startDate?.toISOString() || null,
          endDate: parsedFilters.filters.endDate?.toISOString() || null,
          total: feed.total,
        },
        ipAddress: getIpAddress(req),
      });

      res
        .status(200)
        .type("text/csv")
        .set("Content-Disposition", 'attachment; filename="issues-feed.csv"')
        .send(issuesToCsv(feed.items));
    } catch (error) {
      if (error instanceof RangeError) {
        return res.status(400).json({ error: error.message });
      }

      console.error("Error exporting issues feed:", error);
      captureSentryException(error, { tags: { route: "admin", endpoint: "issues_export" } });
      res.status(500).json({ error: "Failed to export issues feed" });
    }
  });

  router.get("/alerts", async (req, res) => {
    try {
      const pagination = buildPagination(req.query);
      if (pagination.error) {
        return res.status(400).json({ error: pagination.error });
      }

      const alertType = getQueryValue(req.query.alertType);
      const emailStatus = getQueryValue(req.query.emailStatus);
      const resolved = getQueryValue(req.query.resolved);
      const where = {};

      if (alertType && alertType !== "all") {
        where.alertType = alertType;
      }
      if (emailStatus && emailStatus !== "all") {
        where.emailStatus = emailStatus;
      }
      if (resolved === "true") {
        where.resolved = true;
      }
      if (resolved === "false") {
        where.resolved = false;
      }

      const [total, alerts] = await prisma.$transaction([
        prisma.adminAlert.count({ where }),
        prisma.adminAlert.findMany({
          where,
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
        action: "VIEW_ADMIN_ALERTS",
        details: {
          page: pagination.page,
          limit: pagination.limit,
          alertType: alertType || null,
          emailStatus: emailStatus || null,
          resolved: resolved || null,
        },
        ipAddress: getIpAddress(req),
      });

      res.json({
        ...createPaginationMeta(pagination.page, pagination.limit, total),
        alerts: alerts.map(serializeAdminAlert),
      });
    } catch (error) {
      console.error("Error fetching admin alerts:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to fetch admin alerts" });
    }
  });

  router.patch("/alerts/:id/resolve", async (req, res) => {
    try {
      const { id } = req.params;
      const existingAlert = await prisma.adminAlert.findUnique({
        where: { id },
      });

      if (!existingAlert) {
        return res.status(404).json({ error: "Admin alert not found" });
      }

      const alert = await prisma.adminAlert.update({
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
        action: "RESOLVE_ADMIN_ALERT",
        targetId: id,
        details: {
          alertType: existingAlert.alertType,
          previouslyResolved: existingAlert.resolved,
        },
        ipAddress: getIpAddress(req),
      });

      res.json({ alert: serializeAdminAlert(alert) });
    } catch (error) {
      console.error("Error resolving admin alert:", error);
      captureSentryException(error, { tags: { route: "admin" } });
      res.status(500).json({ error: "Failed to resolve admin alert" });
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
      const action = getQueryValue(req.query.action);
      const adminId = getQueryValue(req.query.adminId);
      const userId = getQueryValue(req.query.userId);
      const adminActivity = getQueryValue(req.query.view) === "admin";
      const from = getQueryValue(req.query.from);
      const to = getQueryValue(req.query.to);
      const limit = Math.min(parseNumber(getQueryValue(req.query.limit), 50), 200);
      const offset = Math.max(parseNumber(getQueryValue(req.query.offset), 0), 0);
      const parsedFrom = from ? parseDateInput(from) : null;
      const parsedTo = to ? parseDateInput(to, { endOfDay: true }) : null;
      if ((from && !parsedFrom) || (to && !parsedTo) || (parsedFrom && parsedTo && parsedFrom > parsedTo)) {
        return res.status(400).json({ error: "Invalid audit log date range" });
      }

      const adminUsers = adminActivity
        ? await prisma.user.findMany({
          where: { role: "admin" },
          select: { id: true, email: true, name: true },
        })
        : [];
      const adminIds = adminUsers.map((user) => user.id);

      const where = {};
      if (action) where.action = action;
      if (adminId) where.adminId = adminId;
      if (userId) where.OR = [{ adminId: userId }, { targetId: userId }];
      if (adminActivity) where.adminId = { in: adminIds };
      if (from || to) {
        where.createdAt = {
          ...(parsedFrom ? { gte: parsedFrom } : {}),
          ...(parsedTo ? { lte: parsedTo } : {}),
        };
      }
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      const todayWhere = {
        createdAt: { gte: todayStart },
        ...(adminActivity ? { adminId: { in: adminIds } } : {}),
      };

      const [total, logs, actionRows, todayRows] = await prisma.$transaction([
        prisma.auditLog.count({ where }),
        prisma.auditLog.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: offset,
          take: limit,
        }),
        prisma.auditLog.findMany({
          distinct: ["action"],
          select: { action: true },
          orderBy: { action: "asc" },
        }),
        prisma.auditLog.findMany({
          where: todayWhere,
          select: { adminId: true },
        }),
      ]);
      const userIds = [...new Set(logs.flatMap((log) => [log.adminId, log.targetId]).filter(Boolean))];
      const users = userIds.length > 0
        ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, email: true, name: true, role: true },
        })
        : [];
      const usersById = new Map(users.map((user) => [user.id, user]));
      const actorCounts = new Map();
      for (const row of todayRows) {
        actorCounts.set(row.adminId, (actorCounts.get(row.adminId) || 0) + 1);
      }
      const mostActiveEntry = [...actorCounts.entries()].sort((left, right) => right[1] - left[1])[0];
      const mostActiveUser = mostActiveEntry
        ? usersById.get(mostActiveEntry[0]) || adminUsers.find((user) => user.id === mostActiveEntry[0])
        : null;

      await logAdminAction(prisma, {
        adminId: req.session.user.id,
        action: "VIEW_AUDIT_LOGS",
        details: { action, adminId, userId, view: adminActivity ? "admin" : "all", from, to, limit, offset },
        ipAddress: getIpAddress(req),
      });

      res.json({
        total,
        limit,
        offset,
        actions: actionRows.map((row) => row.action),
        logs: logs.map((log) => ({
          ...log,
          actor: serializeAdminUserRef(usersById.get(log.adminId)),
          targetUser: serializeAdminUserRef(usersById.get(log.targetId)),
        })),
        kpis: {
          actionsToday: todayRows.length,
          mostActiveAdmin: mostActiveEntry
            ? { ...serializeAdminUserRef(mostActiveUser), id: mostActiveEntry[0], actions: mostActiveEntry[1] }
            : null,
        },
      });
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
