import { PrismaClient } from "@prisma/client";

import { GENERATION_JOB_TYPES } from "./documentGeneration.js";
import { sendTelegramAdminNotification } from "./telegramNotify.js";

export const DAILY_ADMIN_DIGEST_EVENT_TYPE = "daily_admin_digest";
const DEFAULT_DIGEST_WINDOW_HOURS = 24;
const STALE_JOB_OVERDUE_MS = 120_000;

function toNumber(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function formatUsd(value) {
  return `$${toNumber(value).toFixed(4)}`;
}

function buildSinceDate(now = new Date(), windowHours = DEFAULT_DIGEST_WINDOW_HOURS) {
  return new Date(now.getTime() - (windowHours * 60 * 60 * 1000));
}

export function buildDailyAdminDigestDetails(summary) {
  return [
    `New users: ${summary.newUsers}`,
    `Documents: ${summary.documentsCreated}`,
    `Generation jobs: ${summary.generationJobsCreated}`,
    `Failed jobs: ${summary.failedJobs}`,
    `Stale/overdue jobs: ${summary.staleRunningJobs}`,
    `Usage cost: ${formatUsd(summary.estimatedUsageCostUsd)}`,
    `Tokens: ${summary.usageTokens}`,
    `Unresolved anomalies: ${summary.unresolvedCostAnomalies}`,
  ].join(" | ");
}

export function getDailyAdminDigestSeverity(summary) {
  return summary.failedJobs > 0 || summary.unresolvedCostAnomalies > 0
    ? "warning"
    : "info";
}

export async function collectDailyAdminDigest(prisma, {
  now = new Date(),
  windowHours = DEFAULT_DIGEST_WINDOW_HOURS,
} = {}) {
  const since = buildSinceDate(now, windowHours);
  const staleCutoff = new Date(now.getTime() - STALE_JOB_OVERDUE_MS);
  const generationJobTypes = [
    GENERATION_JOB_TYPES.summary,
    GENERATION_JOB_TYPES.flashcards,
    GENERATION_JOB_TYPES.exam,
  ];

  const [
    newUsers,
    documentsCreated,
    generationJobsCreated,
    failedJobs,
    staleRunningJobs,
    usageAggregate,
    unresolvedCostAnomalies,
  ] = await Promise.all([
    prisma.user.count({
      where: { createdAt: { gte: since } },
    }),
    prisma.document.count({
      where: { uploadDate: { gte: since } },
    }),
    prisma.job.count({
      where: {
        jobType: { in: generationJobTypes },
        queuedAt: { gte: since },
      },
    }),
    prisma.job.count({
      where: {
        status: "failed",
        completedAt: { gte: since },
      },
    }),
    prisma.job.count({
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
    }),
    prisma.usageEvent.aggregate({
      where: { createdAt: { gte: since } },
      _sum: {
        estimatedCostUsd: true,
        inputTokens: true,
        outputTokens: true,
      },
    }),
    prisma.costAnomalyAlert.count({
      where: { resolved: false },
    }),
  ]);

  const inputTokens = toNumber(usageAggregate._sum.inputTokens);
  const outputTokens = toNumber(usageAggregate._sum.outputTokens);

  return {
    since: since.toISOString(),
    until: now.toISOString(),
    windowHours,
    newUsers,
    documentsCreated,
    generationJobsCreated,
    failedJobs,
    staleRunningJobs,
    estimatedUsageCostUsd: toNumber(usageAggregate._sum.estimatedCostUsd),
    usageTokens: inputTokens + outputTokens,
    unresolvedCostAnomalies,
  };
}

export async function sendDailyAdminDigest(prisma, options = {}) {
  const summary = await collectDailyAdminDigest(prisma, options);
  const severity = getDailyAdminDigestSeverity(summary);

  const result = await sendTelegramAdminNotification({
    eventType: DAILY_ADMIN_DIGEST_EVENT_TYPE,
    severity,
    details: buildDailyAdminDigestDetails(summary),
    errorSummary: `Window ${summary.since} to ${summary.until}`,
    timestamp: summary.until,
  });

  return { status: result.status, summary };
}

export async function runDailyAdminDigestScript({
  prisma = new PrismaClient(),
  dryRun = false,
  consoleImpl = console,
} = {}) {
  try {
    const summary = await collectDailyAdminDigest(prisma);
    const details = buildDailyAdminDigestDetails(summary);

    if (dryRun) {
      consoleImpl.log("Daily admin digest dry run:");
      consoleImpl.log(details);
      consoleImpl.log(`Window: ${summary.since} to ${summary.until}`);
      return { status: "dry_run", summary };
    }

    const result = await sendTelegramAdminNotification({
      eventType: DAILY_ADMIN_DIGEST_EVENT_TYPE,
      severity: getDailyAdminDigestSeverity(summary),
      details,
      errorSummary: `Window ${summary.since} to ${summary.until}`,
      timestamp: summary.until,
    });

    consoleImpl.log(`Daily admin digest ${result.status}.`);
    return { status: result.status, summary };
  } finally {
    if (typeof prisma.$disconnect === "function") {
      await prisma.$disconnect();
    }
  }
}
