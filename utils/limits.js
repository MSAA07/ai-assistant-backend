import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export const getMonthlyLimit = (user) => {
  const baseLimit = typeof user.monthlyLimit === "number" ? user.monthlyLimit : 5;
  const isPremium = user.plan === "premium" || user.role === "admin";
  const minLimit = isPremium ? 100 : 0;

  return Math.max(baseLimit, minLimit);
};

export const getRemainingDocuments = (user) => {
  return Math.max(getMonthlyLimit(user) - user.documentsUsed, 0);
};

const getUtcDateString = (value = new Date()) => {
  return new Date(value).toISOString().split("T")[0];
};

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

export async function checkAndIncrementDailyDocCap(userId) {
  await prisma.$transaction(async (tx) => {
    const row = await lockAndResetDailyUsageIfNeeded(tx, userId);

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
    const row = await lockAndResetDailyUsageIfNeeded(tx, userId);

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
