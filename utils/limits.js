import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export const DEFAULT_USAGE_CAPS_BY_PLAN = Object.freeze({
  free: Object.freeze({
    documentCap: 5,
    costCapUsd: 1.5,
    tokenCap: null,
    featureCaps: {},
  }),
  premium: Object.freeze({
    documentCap: 100,
    costCapUsd: null,
    tokenCap: null,
    featureCaps: {},
  }),
});

export const getMonthlyLimit = (user) => {
  const baseLimit = typeof user.monthlyLimit === "number" ? user.monthlyLimit : 5;
  const isPremium = user.plan === "premium" || user.role === "admin";
  const minLimit = isPremium ? 100 : 0;

  return Math.max(baseLimit, minLimit);
};

export const getRemainingDocuments = (user) => {
  return Math.max(getMonthlyLimit(user) - user.documentsUsed, 0);
};

function toFiniteNumber(value, fallback = null) {
  if (value === null || value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizePlan(plan) {
  return typeof plan === "string" && plan.trim().toLowerCase() === "premium"
    ? "premium"
    : "free";
}

function normalizeCapValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
}

const getUtcDateString = (value = new Date()) => {
  return new Date(value).toISOString().split("T")[0];
};

const isAdminUser = (user) => user?.role === "admin";

async function lockAndResetDailyUsageIfNeeded(tx, userId) {
  const rows = await tx.$queryRaw`
    SELECT * FROM "UserLimit" WHERE "userId" = ${userId} FOR UPDATE
  `;
  const row = rows[0];

  if (!row) {
    throw new Error("UserLimit not found - call ensureUserLimitExists first");
  }

  const today = getUtcDateString();
  const lastReset = getUtcDateString(row.lastResetDate);

  if (lastReset < today) {
    await tx.userLimit.update({
      where: { userId },
      data: {
        tokensUsedToday: 0,
        docsUsedToday: 0,
        lastResetDate: new Date(),
      },
    });

    row.tokensUsedToday = 0;
    row.docsUsedToday = 0;
    row.lastResetDate = new Date();
  }

  return row;
}

export async function ensureUserLimitExists(userId) {
  await prisma.userLimit.upsert({
    where: { userId },
    update: {},
    create: { userId },
  });
}

export async function ensureDefaultUsageCapConfigs(prismaClient = prisma) {
  if (!prismaClient.usageCapConfig) {
    return;
  }

  await Promise.all(
    Object.entries(DEFAULT_USAGE_CAPS_BY_PLAN).map(([plan, defaults]) => (
      prismaClient.usageCapConfig.upsert({
        where: { plan },
        update: {},
        create: {
          plan,
          documentCap: defaults.documentCap,
          costCapUsd: defaults.costCapUsd,
          tokenCap: defaults.tokenCap,
          featureCaps: defaults.featureCaps,
        },
      })
    )),
  );
}

export function getFallbackCapConfig(plan) {
  const normalizedPlan = normalizePlan(plan);
  return {
    plan: normalizedPlan,
    ...DEFAULT_USAGE_CAPS_BY_PLAN[normalizedPlan],
  };
}

export async function getUsageCapConfig(prismaClient = prisma, plan = "free") {
  const normalizedPlan = normalizePlan(plan);
  const fallback = getFallbackCapConfig(normalizedPlan);

  if (!prismaClient.usageCapConfig) {
    return fallback;
  }

  const config = await prismaClient.usageCapConfig.upsert({
    where: { plan: normalizedPlan },
    update: {},
    create: {
      plan: normalizedPlan,
      documentCap: fallback.documentCap,
      costCapUsd: fallback.costCapUsd,
      tokenCap: fallback.tokenCap,
      featureCaps: fallback.featureCaps,
    },
  });

  return {
    plan: normalizedPlan,
    documentCap: config.documentCap,
    costCapUsd: toFiniteNumber(config.costCapUsd),
    tokenCap: config.tokenCap,
    featureCaps: config.featureCaps ?? {},
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
}

async function getBillableModelSpendUsd(prismaClient, userId) {
  if (!prismaClient.modelUsageEvent) {
    const fallbackTotals = await prismaClient.usageEvent.aggregate({
      where: { userId },
      _sum: { estimatedCostUsd: true },
    });
    return toFiniteNumber(fallbackTotals._sum?.estimatedCostUsd, 0);
  }

  const totals = await prismaClient.modelUsageEvent.aggregate({
    where: {
      userId,
      billable: true,
    },
    _sum: {
      estimatedCostUsd: true,
      inputTokens: true,
      outputTokens: true,
      totalTokens: true,
    },
  });

  return {
    costUsd: toFiniteNumber(totals._sum?.estimatedCostUsd, 0),
    inputTokens: totals._sum?.inputTokens || 0,
    outputTokens: totals._sum?.outputTokens || 0,
    totalTokens: totals._sum?.totalTokens || 0,
  };
}

function serializeCapSource(defaultConfig, userLimit = null, user = null) {
  return {
    plan: defaultConfig.plan,
    documentCap: user?.role === "admin"
      ? "admin_unlimited"
      : userLimit?.documentCapOverride !== null && userLimit?.documentCapOverride !== undefined
        ? "user_override"
        : "global_default",
    costCapUsd: user?.role === "admin"
      ? "admin_unlimited"
      : userLimit?.costCapUsdOverride !== null && userLimit?.costCapUsdOverride !== undefined
        ? "user_override"
        : "global_default",
    tokenCap: user?.role === "admin"
      ? "admin_unlimited"
      : userLimit?.tokenCapOverride !== null && userLimit?.tokenCapOverride !== undefined
        ? "user_override"
        : "global_default",
  };
}

export async function getUserAllowance(prismaClient = prisma, userId) {
  const user = await prismaClient.user.findUnique({
    where: { id: userId },
    include: {
      userLimit: true,
    },
  });

  if (!user) {
    const error = new Error("User not found");
    error.code = "user_not_found";
    error.statusCode = 404;
    throw error;
  }

  const [defaultConfig, documentCount, spendTotals] = await Promise.all([
    getUsageCapConfig(prismaClient, user.plan),
    prismaClient.document.count({ where: { userId } }),
    getBillableModelSpendUsd(prismaClient, userId),
  ]);

  const usageTotals = typeof spendTotals === "number"
    ? {
      costUsd: spendTotals,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    }
    : spendTotals;

  const userLimit = user.userLimit;
  const admin = isAdminUser(user);
  const documentCap = admin
    ? null
    : userLimit?.documentCapOverride ?? defaultConfig.documentCap;
  const costCapUsd = admin
    ? null
    : toFiniteNumber(userLimit?.costCapUsdOverride, null) ?? defaultConfig.costCapUsd;
  const tokenCap = admin
    ? null
    : userLimit?.tokenCapOverride ?? defaultConfig.tokenCap;

  return {
    userId,
    plan: normalizePlan(user.plan),
    role: user.role,
    caps: {
      documentCap,
      costCapUsd,
      tokenCap,
      featureCaps: {
        ...(defaultConfig.featureCaps && typeof defaultConfig.featureCaps === "object"
          ? defaultConfig.featureCaps
          : {}),
        ...(userLimit?.featureCapsOverride && typeof userLimit.featureCapsOverride === "object"
          ? userLimit.featureCapsOverride
          : {}),
      },
    },
    consumed: {
      documents: documentCount,
      costUsd: usageTotals.costUsd,
      inputTokens: usageTotals.inputTokens,
      outputTokens: usageTotals.outputTokens,
      totalTokens: usageTotals.totalTokens,
    },
    remaining: {
      documents: documentCap === null ? null : Math.max(documentCap - documentCount, 0),
      costUsd: costCapUsd === null ? null : Math.max(costCapUsd - usageTotals.costUsd, 0),
      tokens: tokenCap === null ? null : Math.max(tokenCap - usageTotals.totalTokens, 0),
    },
    overLimit: {
      documents: documentCap !== null && documentCount >= documentCap,
      costUsd: costCapUsd !== null && usageTotals.costUsd >= costCapUsd,
      tokens: tokenCap !== null && usageTotals.totalTokens >= tokenCap,
    },
    source: serializeCapSource(defaultConfig, userLimit, user),
    overrides: {
      documentCapOverride: userLimit?.documentCapOverride ?? null,
      costCapUsdOverride: toFiniteNumber(userLimit?.costCapUsdOverride, null),
      tokenCapOverride: userLimit?.tokenCapOverride ?? null,
      featureCapsOverride: userLimit?.featureCapsOverride ?? {},
      overrideBy: userLimit?.overrideBy ?? null,
    },
  };
}

function createLimitError(message, code, allowance, statusCode = 403) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.allowance = allowance;
  return error;
}

export async function assertCanUploadDocument(prismaClient = prisma, userId) {
  if (typeof prismaClient.$queryRaw === "function") {
    await prismaClient.$queryRaw`
      SELECT "id"
      FROM "user"
      WHERE "id" = ${userId}
      FOR UPDATE
    `;
  }

  const allowance = await getUserAllowance(prismaClient, userId);

  if (allowance.overLimit.documents) {
    throw createLimitError(
      "Document upload cap reached",
      "document_cap_hit",
      allowance,
    );
  }

  return allowance;
}

export async function assertCanStartGeneration(prismaClient = prisma, userId) {
  const allowance = await getUserAllowance(prismaClient, userId);

  if (allowance.overLimit.costUsd) {
    throw createLimitError(
      "Cost allowance exhausted",
      "cost_cap_hit",
      allowance,
    );
  }

  if (allowance.overLimit.tokens) {
    throw createLimitError(
      "Token allowance exhausted",
      "token_cap_hit",
      allowance,
    );
  }

  return allowance;
}

export function parseCapOverride(value, { integer = false } = {}) {
  if (value === null) {
    return null;
  }

  const parsed = normalizeCapValue(value);
  if (parsed === null) {
    return undefined;
  }

  return integer ? Math.trunc(parsed) : parsed;
}

export async function checkAndIncrementDailyDocCap(userId) {
  await prisma.$transaction(async (tx) => {
    const [row, user] = await Promise.all([
      lockAndResetDailyUsageIfNeeded(tx, userId),
      tx.user.findUnique({
        where: { id: userId },
        select: { role: true },
      }),
    ]);

    if (isAdminUser(user)) {
      return;
    }

    if (row.docsUsedToday >= row.dailyDocCap) {
      const error = new Error("Daily document limit reached");
      error.code = "doc_cap_hit";
      throw error;
    }

    await tx.userLimit.update({
      where: { userId },
      data: {
        docsUsedToday: { increment: 1 },
      },
    });
  });
}

export async function checkAndIncrementDailyTokenCap(userId, estimatedTokens) {
  await prisma.$transaction(async (tx) => {
    const [row, user] = await Promise.all([
      lockAndResetDailyUsageIfNeeded(tx, userId),
      tx.user.findUnique({
        where: { id: userId },
        select: { role: true },
      }),
    ]);

    if (isAdminUser(user)) {
      return;
    }

    if (row.tokensUsedToday + estimatedTokens > row.dailyTokenCap) {
      const error = new Error("Daily token limit reached");
      error.code = "token_cap_hit";
      throw error;
    }

    await tx.userLimit.update({
      where: { userId },
      data: {
        tokensUsedToday: { increment: estimatedTokens },
      },
    });
  });
}
