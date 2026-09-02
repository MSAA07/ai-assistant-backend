import { PrismaClient } from "@prisma/client";

import { sentryIssuesClient } from "./sentryIssues.js";

const defaultPrisma = new PrismaClient();

export const INCIDENT_STATUSES = Object.freeze(["open", "in_progress", "resolved"]);
export const INCIDENT_SOURCES = Object.freeze(["sentry", "job", "alert", "cost"]);
const SOURCE_FILTERS = new Set(["all", "sentry", "job", "cost_alert"]);
const SEVERITIES = new Set(["critical", "warning", "info"]);
const DEFAULT_LIMIT = 25;

const asNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeAlertSeverity = (value) => {
  const normalized = String(value || "warning").toLowerCase();
  if (["fatal", "error", "critical"].includes(normalized)) return "critical";
  if (normalized === "info") return "info";
  return "warning";
};

const sourceMeta = (status, { refreshedAt = new Date(), lastSuccessfulAt = null, error = null } = {}) => ({
  status,
  refreshedAt,
  lastSuccessfulAt,
  error,
});

const buildDateWhere = (field, startDate, endDate) => {
  if (!startDate && !endDate) return {};
  return {
    [field]: {
      ...(startDate ? { gte: startDate } : {}),
      ...(endDate ? { lte: endDate } : {}),
    },
  };
};

const matchesSeverity = (severity, requested) => !requested || severity === requested;

export const toJobFailureIncident = (job) => ({
  id: `job:${job.id}`,
  source: "job",
  sourceGroup: "job",
  sourceId: job.id,
  severity: "critical",
  title: `Job failure: ${String(job.jobType || "unknown").replaceAll("_", " ")}`,
  message: job.errorMessage || "Job failed without an error message.",
  createdAt: job.completedAt || job.startedAt || job.queuedAt,
  baseResolved: false,
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

export const toAdminAlertIncident = (alert) => ({
  id: `alert:${alert.id}`,
  source: "alert",
  sourceGroup: "cost_alert",
  sourceId: alert.id,
  severity: normalizeAlertSeverity(alert.severity),
  title: `Admin alert: ${String(alert.alertType || "unknown").replaceAll("_", " ")}`,
  message: alert.errorMessage || alert.emailSubject || "Admin alert triggered.",
  createdAt: alert.createdAt,
  baseResolved: Boolean(alert.resolved),
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

export const toCostAnomalyIncident = (alert) => {
  const thresholdUsd = asNumber(alert.thresholdUsd);
  const actualUsd = asNumber(alert.actualUsd);
  return {
    id: `cost:${alert.id}`,
    source: "cost",
    sourceGroup: "cost_alert",
    sourceId: alert.id,
    severity: "warning",
    title: `Cost anomaly: ${String(alert.alertType || "unknown").replaceAll("_", " ")}`,
    message: `Actual spend $${actualUsd.toFixed(4)} exceeded threshold $${thresholdUsd.toFixed(4)}.`,
    createdAt: alert.createdAt,
    baseResolved: Boolean(alert.resolved),
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

const toSentryIncident = (issue) => ({
  id: `sentry:${issue.id}`,
  source: "sentry",
  sourceGroup: "sentry",
  sourceId: issue.id,
  severity: issue.severity,
  title: issue.shortId ? `${issue.shortId}: ${issue.title}` : issue.title,
  message: issue.message,
  createdAt: issue.createdAt,
  baseResolved: issue.status === "resolved",
  relatedId: issue.id,
  permalink: issue.permalink,
  metadata: issue.metadata,
});

function alertSeverityWhere(severity) {
  if (!severity) return undefined;
  if (severity === "critical") return { in: ["fatal", "error", "critical"] };
  return severity;
}

async function getResolvedIds(prisma, source) {
  if (!prisma.incidentState) return [];
  const rows = await prisma.incidentState.findMany({
    where: { source, status: "resolved" },
    select: { sourceId: true },
  });
  return rows.map((row) => row.sourceId);
}

async function loadJobSource({ prisma, take, severity, startDate, endDate, includeResolved, resolvedIds }) {
  const excluded = includeResolved ? [] : resolvedIds;
  const where = {
    status: "failed",
    ...(severity && severity !== "critical" ? { id: { in: [] } } : {}),
    ...(excluded.length ? { id: { notIn: excluded } } : {}),
    ...buildDateWhere("completedAt", startDate, endDate),
  };
  const openWhere = {
    status: "failed",
    ...(resolvedIds.length ? { id: { notIn: resolvedIds } } : {}),
  };
  const [items, total, openCount] = await Promise.all([
    prisma.job.findMany({
      where,
      orderBy: [{ completedAt: "desc" }, { queuedAt: "desc" }],
      take,
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
    prisma.job.count({ where }),
    prisma.job.count({ where: openWhere }),
  ]);
  return { incidents: items.map(toJobFailureIncident), total, openCount };
}

async function loadCostAlertSource({ prisma, take, severity, startDate, endDate, includeResolved }) {
  const alertWhere = {
    NOT: { alertType: "job_failure", jobId: { not: null } },
    ...(!includeResolved ? { resolved: false } : {}),
    ...(severity ? { severity: alertSeverityWhere(severity) } : {}),
    ...buildDateWhere("createdAt", startDate, endDate),
  };
  const costWhere = {
    ...(!includeResolved ? { resolved: false } : {}),
    ...(severity && severity !== "warning" ? { id: { in: [] } } : {}),
    ...buildDateWhere("createdAt", startDate, endDate),
  };
  const openAlertWhere = {
    NOT: { alertType: "job_failure", jobId: { not: null } },
    resolved: false,
  };
  const [alerts, costs, alertTotal, costTotal, openAlerts, openCosts] = await Promise.all([
    prisma.adminAlert.findMany({
      where: alertWhere,
      orderBy: { createdAt: "desc" },
      take,
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
      where: costWhere,
      orderBy: { createdAt: "desc" },
      take,
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
    prisma.adminAlert.count({ where: alertWhere }),
    prisma.costAnomalyAlert.count({ where: costWhere }),
    prisma.adminAlert.count({ where: openAlertWhere }),
    prisma.costAnomalyAlert.count({ where: { resolved: false } }),
  ]);
  return {
    incidents: [...alerts.map(toAdminAlertIncident), ...costs.map(toCostAnomalyIncident)],
    total: alertTotal + costTotal,
    openCount: openAlerts + openCosts,
  };
}

async function loadIncidentStates(prisma, incidents) {
  if (!prisma.incidentState || incidents.length === 0) return new Map();
  const states = await prisma.incidentState.findMany({
    where: { OR: incidents.map((incident) => ({ source: incident.source, sourceId: incident.sourceId })) },
  });
  return new Map(states.map((state) => [`${state.source}:${state.sourceId}`, state]));
}

function applyState(incident, state) {
  const status = state?.status || (incident.baseResolved ? "resolved" : "open");
  return {
    ...incident,
    status,
    resolved: status === "resolved",
    lifecycleUpdatedAt: state?.updatedAt || null,
  };
}

const severityRank = { critical: 3, warning: 2, info: 1 };
const sortIncidents = (left, right) => (
  (severityRank[right.severity] || 0) - (severityRank[left.severity] || 0)
  || new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
);

export async function getIssuesFeed({
  prismaClient = defaultPrisma,
  sentryClient = sentryIssuesClient,
  source = "all",
  severity,
  includeResolved = false,
  startDate,
  endDate,
  page = 1,
  limit = DEFAULT_LIMIT,
  forceSentryRefresh = false,
} = {}) {
  const pageNumber = Number(page);
  const limitNumber = Number(limit);
  if (!Number.isInteger(pageNumber) || pageNumber < 1) throw new RangeError("page must be a positive integer");
  if (!Number.isInteger(limitNumber) || limitNumber < 1 || limitNumber > 100) {
    throw new RangeError("limit must be an integer between 1 and 100");
  }
  if (!SOURCE_FILTERS.has(source)) throw new RangeError("source must be all, sentry, job, or cost_alert");
  if (severity && !SEVERITIES.has(severity)) throw new RangeError("severity must be critical, warning, or info");

  const offset = (pageNumber - 1) * limitNumber;
  // Each independently loaded source only needs enough rows to contribute to
  // the requested merged page. This stays query-bounded without imposing an
  // artificial maximum page that could disagree with the reported total.
  const take = offset + limitNumber;
  const refreshedAt = new Date();

  let resolvedJobIds = [];
  let resolvedSentryIds = [];
  try {
    [resolvedJobIds, resolvedSentryIds] = await Promise.all([
      getResolvedIds(prismaClient, "job"),
      getResolvedIds(prismaClient, "sentry"),
    ]);
  } catch {
    // Lifecycle lookup failure must not take down independently healthy sources.
  }

  const [sentryResult, jobResult, costAlertResult] = await Promise.allSettled([
    sentryClient.getIssues({ force: forceSentryRefresh }),
    loadJobSource({ prisma: prismaClient, take, severity, startDate, endDate, includeResolved, resolvedIds: resolvedJobIds }),
    loadCostAlertSource({ prisma: prismaClient, take, severity, startDate, endDate, includeResolved }),
  ]);

  const sources = {};
  let sentryIncidents = [];
  let sentryTotal = 0;
  let sentryOpen = 0;
  if (sentryResult.status === "fulfilled") {
    const value = sentryResult.value;
    const mapped = value.items.map(toSentryIncident);
    sentryOpen = mapped.filter((item) => !resolvedSentryIds.includes(item.sourceId) && !item.baseResolved).length;
    sentryIncidents = mapped.filter((item) => (
      matchesSeverity(item.severity, severity)
      && (!startDate || item.createdAt >= startDate)
      && (!endDate || item.createdAt <= endDate)
      && (includeResolved || (!resolvedSentryIds.includes(item.sourceId) && !item.baseResolved))
    ));
    sentryTotal = sentryIncidents.length;
    sources.sentry = sourceMeta(value.status, { refreshedAt, lastSuccessfulAt: value.fetchedAt, error: value.error });
  } else {
    sources.sentry = sourceMeta("unavailable", { refreshedAt, error: sentryResult.reason?.message || "Sentry unavailable" });
  }

  const jobValue = jobResult.status === "fulfilled" ? jobResult.value : { incidents: [], total: 0, openCount: 0 };
  sources.job = jobResult.status === "fulfilled"
    ? sourceMeta("fresh", { refreshedAt, lastSuccessfulAt: refreshedAt })
    : sourceMeta("unavailable", { refreshedAt, error: jobResult.reason?.message || "Jobs unavailable" });

  const costAlertValue = costAlertResult.status === "fulfilled" ? costAlertResult.value : { incidents: [], total: 0, openCount: 0 };
  sources.costAlert = costAlertResult.status === "fulfilled"
    ? sourceMeta("fresh", { refreshedAt, lastSuccessfulAt: refreshedAt })
    : sourceMeta("unavailable", { refreshedAt, error: costAlertResult.reason?.message || "Cost and alerts unavailable" });

  const candidates = [
    ...(source === "all" || source === "sentry" ? sentryIncidents : []),
    ...(source === "all" || source === "job" ? jobValue.incidents : []),
    ...(source === "all" || source === "cost_alert" ? costAlertValue.incidents : []),
  ];
  let stateMap = new Map();
  try {
    stateMap = await loadIncidentStates(prismaClient, candidates);
  } catch {
    // Base source state is still useful if lifecycle metadata cannot refresh.
  }

  const normalized = candidates
    .map((incident) => applyState(incident, stateMap.get(incident.id)))
    .filter((incident) => includeResolved || incident.status !== "resolved")
    .sort(sortIncidents);

  const total = (
    (source === "all" || source === "sentry" ? sentryTotal : 0)
    + (source === "all" || source === "job" ? jobValue.total : 0)
    + (source === "all" || source === "cost_alert" ? costAlertValue.total : 0)
  );
  const items = normalized.slice(offset, offset + limitNumber);
  const openBySource = { sentry: sentryOpen, job: jobValue.openCount, costAlert: costAlertValue.openCount };

  return {
    items,
    total,
    page: pageNumber,
    limit: limitNumber,
    kpis: { open: openBySource.sentry + openBySource.job + openBySource.costAlert, openBySource },
    sources,
    partial: Object.values(sources).some((entry) => entry.status === "unavailable"),
    refreshedAt,
  };
}

function validateStatus(status) {
  if (!INCIDENT_STATUSES.includes(status)) throw new RangeError("status must be open, in_progress, or resolved");
}

function validateIncidentRef(incident) {
  if (!incident || !INCIDENT_SOURCES.includes(incident.source) || !incident.sourceId) {
    throw new RangeError("incident source and sourceId are required");
  }
}

async function setSourceResolved(tx, incident, resolved) {
  if (incident.source === "alert") {
    await tx.adminAlert.update({ where: { id: incident.sourceId }, data: { resolved } });
  } else if (incident.source === "cost") {
    await tx.costAnomalyAlert.update({ where: { id: incident.sourceId }, data: { resolved } });
  } else if (incident.source === "job") {
    const job = await tx.job.findUnique({ where: { id: incident.sourceId }, select: { id: true } });
    if (!job) throw Object.assign(new Error("Job incident not found"), { statusCode: 404 });
  }
}

export async function setIncidentStatuses(prisma, incidents, status, adminId, { now = new Date() } = {}) {
  validateStatus(status);
  if (!Array.isArray(incidents) || incidents.length === 0 || incidents.length > 100) {
    throw new RangeError("incidents must contain between 1 and 100 items");
  }
  incidents.forEach(validateIncidentRef);

  return prisma.$transaction(async (tx) => {
    const states = [];
    for (const incident of incidents) {
      await setSourceResolved(tx, incident, status === "resolved");
      const state = await tx.incidentState.upsert({
        where: { source_sourceId: { source: incident.source, sourceId: incident.sourceId } },
        update: {
          status,
          updatedByAdminId: adminId,
          ...(status === "in_progress" ? { acknowledgedAt: now, resolvedAt: null } : {}),
          ...(status === "resolved" ? { resolvedAt: now } : {}),
          ...(status === "open" ? { reopenedAt: now, resolvedAt: null } : {}),
        },
        create: {
          source: incident.source,
          sourceId: incident.sourceId,
          status,
          updatedByAdminId: adminId,
          acknowledgedAt: status === "in_progress" ? now : null,
          resolvedAt: status === "resolved" ? now : null,
          reopenedAt: status === "open" ? now : null,
        },
      });
      states.push(state);
    }
    return states;
  });
}
