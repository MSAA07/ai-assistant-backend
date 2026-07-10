import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const ISSUE_TYPES = new Set(["job_failure", "admin_alert", "cost_anomaly"]);
const DEFAULT_LIMIT = 50;

const asNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeFilterValues = (value) => {
  if (value === undefined || value === null || value === "" || value === "all") {
    return null;
  }

  const values = Array.isArray(value) ? value : [value];
  return new Set(values.filter((item) => typeof item === "string" && item.length > 0));
};

const toJobFailureIssue = (job) => ({
  id: `job_${job.id}`,
  type: "job_failure",
  severity: "error",
  title: `Job failure: ${job.jobType}`,
  message: job.errorMessage || "Job failed without an error message.",
  createdAt: job.completedAt || job.startedAt || job.queuedAt,
  resolved: false,
  relatedId: job.id,
  metadata: {
    jobType: job.jobType,
    userId: job.userId,
    documentId: job.documentId,
    retryCount: job.retryCount,
    maxRetries: job.maxRetries,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  },
});

const toAdminAlertIssue = (alert) => ({
  id: `alert_${alert.id}`,
  type: "admin_alert",
  severity: alert.severity || "warning",
  title: `Admin alert: ${alert.alertType}`,
  message: alert.errorMessage || alert.emailSubject || "Admin alert triggered.",
  createdAt: alert.createdAt,
  resolved: alert.resolved,
  relatedId: alert.id,
  metadata: {
    alertType: alert.alertType,
    targetType: alert.targetType,
    targetId: alert.targetId,
    userId: alert.userId,
    documentId: alert.documentId,
    jobId: alert.jobId,
    emailStatus: alert.emailStatus,
    thresholdUsd: alert.thresholdUsd === null ? null : asNumber(alert.thresholdUsd),
    actualUsd: alert.actualUsd === null ? null : asNumber(alert.actualUsd),
    thresholdCount: alert.thresholdCount,
    actualCount: alert.actualCount,
    metadata: alert.metadata,
  },
});

const toCostAnomalyIssue = (alert) => {
  const thresholdUsd = asNumber(alert.thresholdUsd);
  const actualUsd = asNumber(alert.actualUsd);

  return {
    id: `anomaly_${alert.id}`,
    type: "cost_anomaly",
    // Cost anomaly alerts do not have a source severity field.
    severity: "warning",
    title: `Cost anomaly: ${alert.alertType}`,
    message: `Actual spend $${actualUsd.toFixed(4)} exceeded threshold $${thresholdUsd.toFixed(4)}.`,
    createdAt: alert.createdAt,
    resolved: alert.resolved,
    relatedId: alert.id,
    metadata: {
      alertType: alert.alertType,
      userId: alert.userId,
      thresholdUsd,
      actualUsd,
      deltaUsd: actualUsd - thresholdUsd,
    },
  };
};

const matchesFilters = (issue, { types, severity, resolved, startDate, endDate }) => {
  if (types && !types.has(issue.type)) return false;
  if (severity && !severity.has(issue.severity)) return false;
  if (resolved !== undefined && resolved !== null && issue.resolved !== resolved) return false;
  if (startDate && issue.createdAt < startDate) return false;
  if (endDate && issue.createdAt > endDate) return false;
  return true;
};

export async function getIssuesFeed({
  types,
  severity,
  resolved,
  startDate,
  endDate,
  page = 1,
  limit = DEFAULT_LIMIT,
} = {}) {
  const pageNumber = Number(page);
  const limitNumber = Number(limit);
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new RangeError("page must be a positive integer");
  }
  if (!Number.isInteger(limitNumber) || limitNumber < 1) {
    throw new RangeError("limit must be a positive integer");
  }

  const typeFilter = normalizeFilterValues(types);
  if (typeFilter && [...typeFilter].some((type) => !ISSUE_TYPES.has(type))) {
    throw new RangeError("type must be job_failure, admin_alert, or cost_anomaly");
  }

  const [failedJobs, adminAlerts, costAnomalies] = await Promise.all([
    prisma.job.findMany({
      where: { status: "failed" },
      select: {
        id: true,
        userId: true,
        documentId: true,
        jobType: true,
        retryCount: true,
        maxRetries: true,
        errorMessage: true,
        queuedAt: true,
        startedAt: true,
        completedAt: true,
      },
    }),
    prisma.adminAlert.findMany({
      select: {
        id: true,
        alertType: true,
        severity: true,
        targetType: true,
        targetId: true,
        userId: true,
        documentId: true,
        jobId: true,
        thresholdUsd: true,
        actualUsd: true,
        thresholdCount: true,
        actualCount: true,
        emailStatus: true,
        emailSubject: true,
        errorMessage: true,
        resolved: true,
        metadata: true,
        createdAt: true,
      },
    }),
    prisma.costAnomalyAlert.findMany({
      select: {
        id: true,
        userId: true,
        alertType: true,
        thresholdUsd: true,
        actualUsd: true,
        resolved: true,
        createdAt: true,
      },
    }),
  ]);

  const filters = {
    types: typeFilter,
    severity: normalizeFilterValues(severity),
    resolved,
    startDate,
    endDate,
  };
  const items = [
    ...failedJobs.map(toJobFailureIssue),
    ...adminAlerts.map(toAdminAlertIssue),
    ...costAnomalies.map(toCostAnomalyIssue),
  ]
    .filter((issue) => matchesFilters(issue, filters))
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());

  const total = items.length;
  const offset = (pageNumber - 1) * limitNumber;
  return {
    items: items.slice(offset, offset + limitNumber),
    total,
    page: pageNumber,
    limit: limitNumber,
  };
}
