import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Pricing per 1M tokens aligned to OpenAI's public API pricing page.
const PRICING = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10.0 },
};

export function estimateCost(modelName, inputTokens = 0, outputTokens = 0) {
  const pricing = PRICING[modelName] || PRICING["gpt-4o-mini"];
  return (inputTokens / 1_000_000) * pricing.input
    + (outputTokens / 1_000_000) * pricing.output;
}

export async function recordUsageEvent(
  userId,
  eventType,
  featureKey,
  modelUsed,
  inputTokens,
  outputTokens,
  metadata = {},
) {
  const estimatedCostUsd = estimateCost(modelUsed, inputTokens, outputTokens);

  await prisma.usageEvent.create({
    data: {
      userId,
      eventType,
      featureKey,
      aiModelUsed: modelUsed,
      inputTokens,
      outputTokens,
      estimatedCostUsd,
      metadata,
    },
  });

  checkAnomaly(userId).catch((error) => {
    console.error("[costGuard] anomaly check error:", error);
  });
}

export async function checkAnomaly(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { createdAt: true },
  });

  if (!user) {
    return;
  }

  const accountAgeDays = (Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24);
  let baselineUsd = 0;

  if (accountAgeDays > 7) {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result = await prisma.usageEvent.aggregate({
      where: {
        userId,
        createdAt: { gte: sevenDaysAgo },
      },
      _sum: { estimatedCostUsd: true },
    });

    baselineUsd = Number(result._sum.estimatedCostUsd || 0) / 7;
  } else {
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const cohortUsers = await prisma.user.findMany({
      where: {
        createdAt: { gte: twoWeeksAgo },
      },
      select: { id: true },
    });
    const cohortIds = cohortUsers.map((cohortUser) => cohortUser.id);

    if (cohortIds.length === 0) {
      return;
    }

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const cohortSpends = await Promise.all(
      cohortIds.map(async (cohortUserId) => {
        const result = await prisma.usageEvent.aggregate({
          where: {
            userId: cohortUserId,
            createdAt: { gte: sevenDaysAgo },
          },
          _sum: { estimatedCostUsd: true },
        });

        return Number(result._sum.estimatedCostUsd || 0) / 7;
      }),
    );

    cohortSpends.sort((a, b) => a - b);
    baselineUsd = cohortSpends[Math.floor(cohortSpends.length / 2)] || 0;
  }

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const todayResult = await prisma.usageEvent.aggregate({
    where: {
      userId,
      createdAt: { gte: todayStart },
    },
    _sum: { estimatedCostUsd: true },
  });
  const todaySpend = Number(todayResult._sum.estimatedCostUsd || 0);

  if (baselineUsd <= 0 || todaySpend <= baselineUsd * 3) {
    return;
  }

  const existingAlert = await prisma.costAnomalyAlert.findFirst({
    where: {
      userId,
      alertType: "daily_spend_3x_avg",
      resolved: false,
      createdAt: { gte: todayStart },
    },
  });

  if (existingAlert) {
    return;
  }

  await prisma.costAnomalyAlert.create({
    data: {
      userId,
      alertType: "daily_spend_3x_avg",
      thresholdUsd: baselineUsd * 3,
      actualUsd: todaySpend,
    },
  });

  console.warn(
    `[costGuard] anomaly alert created for user ${userId}: $${todaySpend.toFixed(4)} vs $${(baselineUsd * 3).toFixed(4)} threshold`,
  );
}
