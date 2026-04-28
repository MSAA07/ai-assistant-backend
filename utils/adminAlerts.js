import { getUserAllowance } from "./limits.js";

export const ADMIN_ALERT_TYPES = Object.freeze({
  jobFailure: "job_failure",
  userCostThreshold: "user_cost_threshold",
  dailySystemCostThreshold: "daily_system_cost_threshold",
  userUsageSpike: "user_usage_spike",
  failedJobSpike: "failed_job_spike",
  systemCostSpike: "system_cost_spike",
});

const DEFAULT_DAILY_COST_THRESHOLD_USD = 10;
const DEFAULT_USER_CAP_THRESHOLD_RATIO = 0.8;
const DEFAULT_SPIKE_MULTIPLIER = 3;
const DEFAULT_FAILED_JOB_THRESHOLD = 3;
const DEFAULT_DEDUP_WINDOW_MINUTES = 60;

function toFiniteNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toPositiveNumber(value, fallback) {
  const parsed = toFiniteNumber(value, NaN);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getBooleanEnv(value, fallback = true) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  return fallback;
}

function maskEmailAddress(address = "") {
  const [localPart = "", domain = ""] = String(address).split("@");
  if (!domain) return "***";
  if (localPart.length <= 2) return `${localPart[0] || "*"}***@${domain}`;
  return `${localPart.slice(0, 2)}***@${domain}`;
}

function normalizePath(path = "/admin") {
  return path.startsWith("/") ? path : `/${path}`;
}

function getAppBaseUrl(env = process.env) {
  return env.AUTH_EMAIL_APP_URL?.trim()
    || env.FRONTEND_URL?.trim()
    || env.PUBLIC_APP_URL?.trim()
    || "";
}

function buildAdminUrl(adminPath, env = process.env) {
  const path = normalizePath(adminPath);
  const baseUrl = getAppBaseUrl(env).replace(/\/+$/, "");
  return baseUrl ? `${baseUrl}${path}` : path;
}

export function getAdminAlertConfig(env = process.env) {
  return {
    enabled: getBooleanEnv(env.ALERTS_ENABLED, true),
    apiKey: env.RESEND_API_KEY?.trim() || "",
    to: env.ADMIN_ALERT_EMAIL?.trim() || "",
    from: env.ALERT_FROM_EMAIL?.trim() || "",
    dailyCostThresholdUsd: toPositiveNumber(
      env.ALERT_DAILY_COST_THRESHOLD_USD,
      DEFAULT_DAILY_COST_THRESHOLD_USD,
    ),
    userCostThresholdUsd: toPositiveNumber(env.ALERT_USER_COST_THRESHOLD_USD, null),
    spikeMultiplier: toPositiveNumber(env.ALERT_SPIKE_MULTIPLIER, DEFAULT_SPIKE_MULTIPLIER),
    failedJobThreshold: Math.max(
      1,
      Math.trunc(toPositiveNumber(env.ALERT_FAILED_JOB_THRESHOLD, DEFAULT_FAILED_JOB_THRESHOLD)),
    ),
    dedupWindowMinutes: Math.max(
      1,
      Math.trunc(toPositiveNumber(env.ALERT_DEDUP_WINDOW_MINUTES, DEFAULT_DEDUP_WINDOW_MINUTES)),
    ),
  };
}

function formatUsd(value) {
  if (value === null || value === undefined) return "";
  return `$${Number(value || 0).toFixed(4)}`;
}

function toMoneyString(value) {
  if (value === null || value === undefined) return null;
  return Number(value).toFixed(8);
}

function formatValue(label, value) {
  return value === null || value === undefined || value === ""
    ? ""
    : `${label}: ${value}`;
}

function getAlertLabel(alertType) {
  return alertType
    .split("_")
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function buildSuggestedAction(alertType) {
  if (alertType === ADMIN_ALERT_TYPES.jobFailure) {
    return "Open the Jobs tab, inspect the failed job stages, and retry only after confirming the root cause.";
  }
  if (alertType === ADMIN_ALERT_TYPES.userCostThreshold || alertType === ADMIN_ALERT_TYPES.userUsageSpike) {
    return "Review the user's usage breakdown and adjust caps or contact the user if activity looks unintended.";
  }
  if (alertType === ADMIN_ALERT_TYPES.failedJobSpike) {
    return "Check worker logs and recent failed jobs for a shared provider, parsing, or queue issue.";
  }
  return "Review the Usage tab, confirm whether spend is expected, and adjust thresholds or caps if needed.";
}

function buildSubject(alert) {
  return `[Studymaxing ${alert.severity || "warning"}] ${getAlertLabel(alert.alertType)}`;
}

function buildEmailPayload(alert, env = process.env) {
  const timestamp = alert.timestamp || new Date().toISOString();
  const adminUrl = buildAdminUrl(alert.adminPath || "/admin", env);
  const lines = [
    formatValue("Alert type", getAlertLabel(alert.alertType)),
    formatValue("Severity", alert.severity || "warning"),
    formatValue("User", alert.userEmail || alert.userId),
    formatValue("Document", alert.documentId),
    formatValue("Job", alert.jobId),
    formatValue("Threshold", alert.thresholdUsd !== undefined ? formatUsd(alert.thresholdUsd) : alert.thresholdCount),
    formatValue("Actual", alert.actualUsd !== undefined ? formatUsd(alert.actualUsd) : alert.actualCount),
    formatValue("Timestamp", timestamp),
    formatValue("Suggested next action", alert.suggestedAction || buildSuggestedAction(alert.alertType)),
    formatValue("Admin page", adminUrl),
  ].filter(Boolean);

  const text = lines.join("\n");
  const htmlRows = lines
    .map((line) => {
      const [label, ...rest] = line.split(": ");
      return `<tr><th align="left" style="padding:6px 12px 6px 0;color:#6b7280;">${escapeHtml(label)}</th><td style="padding:6px 0;">${escapeHtml(rest.join(": "))}</td></tr>`;
    })
    .join("");

  return {
    subject: buildSubject(alert),
    text,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827;">
        <h1 style="font-size:18px;margin:0 0 12px;">${escapeHtml(getAlertLabel(alert.alertType))}</h1>
        <table cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:14px;">
          ${htmlRows}
        </table>
      </div>
    `,
  };
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function sendAdminAlertEmail(alert, {
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const config = getAdminAlertConfig(env);

  if (!config.enabled) {
    return { status: "disabled" };
  }

  const missing = [];
  if (!config.apiKey) missing.push("RESEND_API_KEY");
  if (!config.to) missing.push("ADMIN_ALERT_EMAIL");
  if (!config.from) missing.push("ALERT_FROM_EMAIL");
  if (!fetchImpl) missing.push("fetch");

  if (missing.length > 0) {
    return {
      status: "configuration_missing",
      errorMessage: `Missing alert email configuration: ${missing.join(", ")}`,
    };
  }

  const email = buildEmailPayload(alert, env);
  const response = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: config.from,
      to: [config.to],
      subject: email.subject,
      html: email.html,
      text: email.text,
    }),
  });

  const bodyText = await response.text();
  let body = null;
  if (bodyText) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = { raw: bodyText };
    }
  }

  if (!response.ok) {
    return {
      status: "failed",
      errorMessage: `Resend alert email failed (${response.status}): ${JSON.stringify(body ?? response.statusText)}`,
    };
  }

  return {
    status: "sent",
    providerMessageId: body?.id || body?.data?.id || "",
    subject: email.subject,
    to: config.to,
  };
}

function getDedupKey({ alertType, targetType, targetId }) {
  return [
    alertType,
    targetType || "system",
    targetId || "global",
  ].join(":");
}

async function findRecentDuplicate(prisma, dedupKey, windowMinutes) {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000);
  return prisma.adminAlert.findFirst({
    where: {
      dedupKey,
      createdAt: { gte: since },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function recordAdminAlert(prisma, alert, options = {}) {
  const {
    env = process.env,
    fetchImpl = globalThis.fetch,
  } = options;

  if (!prisma?.adminAlert) {
    return { status: "unavailable" };
  }

  const config = getAdminAlertConfig(env);
  const dedupKey = alert.dedupKey || getDedupKey(alert);
  const duplicate = await findRecentDuplicate(prisma, dedupKey, config.dedupWindowMinutes);

  if (duplicate) {
    return { status: "deduped", alert: duplicate };
  }

  const timestamp = new Date();
  const emailPayload = buildEmailPayload({ ...alert, timestamp: timestamp.toISOString() }, env);
  const created = await prisma.adminAlert.create({
    data: {
      alertType: alert.alertType,
      severity: alert.severity || "warning",
      targetType: alert.targetType || null,
      targetId: alert.targetId || null,
      userId: alert.userId || null,
      documentId: alert.documentId || null,
      jobId: alert.jobId || null,
      thresholdUsd: toMoneyString(alert.thresholdUsd),
      actualUsd: toMoneyString(alert.actualUsd),
      thresholdCount: alert.thresholdCount ?? null,
      actualCount: alert.actualCount ?? null,
      dedupKey,
      emailTo: config.to || null,
      emailSubject: emailPayload.subject,
      emailStatus: config.enabled ? "pending" : "disabled",
      metadata: {
        ...(options.metadata && typeof options.metadata === "object" ? options.metadata : {}),
        ...(alert.metadata && typeof alert.metadata === "object" ? alert.metadata : {}),
        adminPath: alert.adminPath || "/admin",
        suggestedAction: alert.suggestedAction || buildSuggestedAction(alert.alertType),
      },
      createdAt: timestamp,
    },
  });

  if (!config.enabled) {
    return { status: "disabled", alert: created };
  }

  try {
    const delivery = await sendAdminAlertEmail(alert, { env, fetchImpl });
    const emailStatus = delivery.status === "sent" ? "sent" : delivery.status;

    const updated = await prisma.adminAlert.update({
      where: { id: created.id },
      data: {
        emailStatus,
        providerMessageId: delivery.providerMessageId || null,
        errorMessage: delivery.errorMessage || null,
        sentAt: delivery.status === "sent" ? new Date() : null,
      },
    });

    if (delivery.status !== "sent") {
      console.error("[admin-alerts] alert email not sent", {
        alertType: alert.alertType,
        targetType: alert.targetType,
        targetId: alert.targetId,
        status: delivery.status,
        error: delivery.errorMessage,
      });
    } else {
      console.info("[admin-alerts] alert email sent", {
        alertType: alert.alertType,
        targetType: alert.targetType,
        targetId: alert.targetId,
        to: maskEmailAddress(config.to),
        messageId: delivery.providerMessageId || "(missing)",
      });
    }

    return { status: emailStatus, alert: updated };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[admin-alerts] alert email delivery failed", {
      alertType: alert.alertType,
      targetType: alert.targetType,
      targetId: alert.targetId,
      error: message,
    });

    const updated = await prisma.adminAlert.update({
      where: { id: created.id },
      data: {
        emailStatus: "failed",
        errorMessage: message,
      },
    });

    return { status: "failed", alert: updated };
  }
}

function startOfUtcDay(now = new Date()) {
  const value = new Date(now);
  value.setUTCHours(0, 0, 0, 0);
  return value;
}

function startOfUtcHour(now = new Date()) {
  const value = new Date(now);
  value.setUTCMinutes(0, 0, 0);
  return value;
}

async function sumBillableCost(prisma, where) {
  const result = await prisma.modelUsageEvent.aggregate({
    where: {
      ...where,
      billable: true,
    },
    _sum: { estimatedCostUsd: true },
  });

  return toFiniteNumber(result._sum?.estimatedCostUsd, 0);
}

async function loadUserRef(prisma, userId) {
  if (!userId) return null;
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, plan: true, role: true },
  });
}

export async function alertJobFailure(prisma, job, error, options = {}) {
  const errorMessage = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "Job failed";

  return recordAdminAlert(prisma, {
    alertType: ADMIN_ALERT_TYPES.jobFailure,
    severity: "error",
    targetType: "job",
    targetId: job.id,
    userId: job.userId || null,
    documentId: job.documentId || job.payload?.documentId || null,
    jobId: job.id,
    actualCount: job.retryCount || 0,
    adminPath: "/admin?tab=jobs",
    suggestedAction: buildSuggestedAction(ADMIN_ALERT_TYPES.jobFailure),
    metadata: {
      jobType: job.jobType,
      retryCount: job.retryCount || 0,
      maxRetries: job.maxRetries,
      errorMessage,
      ...options.metadata,
    },
  }, options);
}

export async function evaluateUserCostThreshold(prisma, userId, options = {}) {
  const config = getAdminAlertConfig(options.env);
  const [user, allowance] = await Promise.all([
    loadUserRef(prisma, userId),
    getUserAllowance(prisma, userId).catch(() => null),
  ]);

  if (!user || !allowance) {
    return { status: "skipped" };
  }

  const totalCostUsd = toFiniteNumber(allowance.consumed?.costUsd, 0);
  const configuredThreshold = config.userCostThresholdUsd;
  const capThreshold = allowance.caps?.costCapUsd === null || allowance.caps?.costCapUsd === undefined
    ? null
    : Number(allowance.caps.costCapUsd) * DEFAULT_USER_CAP_THRESHOLD_RATIO;
  const threshold = configuredThreshold ?? capThreshold;

  if (!threshold || totalCostUsd < threshold) {
    return { status: "below_threshold", threshold, actualUsd: totalCostUsd };
  }

  return recordAdminAlert(prisma, {
    alertType: ADMIN_ALERT_TYPES.userCostThreshold,
    severity: "warning",
    targetType: "user",
    targetId: userId,
    userId,
    userEmail: user.email,
    thresholdUsd: threshold,
    actualUsd: totalCostUsd,
    adminPath: "/admin?tab=usage",
    metadata: {
      thresholdSource: configuredThreshold ? "ALERT_USER_COST_THRESHOLD_USD" : "80_percent_of_active_cost_cap",
      plan: user.plan,
      role: user.role,
      caps: allowance.caps,
      consumed: allowance.consumed,
    },
  }, options);
}

export async function evaluateUserUsageSpike(prisma, userId, options = {}) {
  const config = getAdminAlertConfig(options.env);
  const now = options.now || new Date();
  const currentHourStart = startOfUtcHour(now);
  const previousWindowStart = new Date(currentHourStart.getTime() - 24 * 60 * 60 * 1000);
  const [user, currentHourCost, previousWindowCost] = await Promise.all([
    loadUserRef(prisma, userId),
    sumBillableCost(prisma, { userId, createdAt: { gte: currentHourStart } }),
    sumBillableCost(prisma, { userId, createdAt: { gte: previousWindowStart, lt: currentHourStart } }),
  ]);

  if (!user) {
    return { status: "skipped" };
  }

  const hourlyBaseline = previousWindowCost / 24;
  const multiplierThreshold = hourlyBaseline > 0 ? hourlyBaseline * config.spikeMultiplier : null;
  const configuredFloor = config.userCostThresholdUsd;
  const threshold = multiplierThreshold || configuredFloor;

  if (!threshold || currentHourCost < threshold) {
    return { status: "below_threshold", threshold, actualUsd: currentHourCost };
  }

  return recordAdminAlert(prisma, {
    alertType: ADMIN_ALERT_TYPES.userUsageSpike,
    severity: "warning",
    targetType: "user",
    targetId: userId,
    userId,
    userEmail: user.email,
    thresholdUsd: threshold,
    actualUsd: currentHourCost,
    adminPath: "/admin?tab=usage",
    metadata: {
      currentHourStart: currentHourStart.toISOString(),
      previousWindowStart: previousWindowStart.toISOString(),
      previousWindowCostUsd: previousWindowCost,
      hourlyBaselineUsd: hourlyBaseline,
      spikeMultiplier: config.spikeMultiplier,
    },
  }, options);
}

export async function evaluateDailySystemCostThreshold(prisma, options = {}) {
  const config = getAdminAlertConfig(options.env);
  const dayStart = startOfUtcDay(options.now || new Date());
  const todayCost = await sumBillableCost(prisma, {
    createdAt: { gte: dayStart },
  });

  if (todayCost < config.dailyCostThresholdUsd) {
    return { status: "below_threshold", threshold: config.dailyCostThresholdUsd, actualUsd: todayCost };
  }

  return recordAdminAlert(prisma, {
    alertType: ADMIN_ALERT_TYPES.dailySystemCostThreshold,
    severity: "warning",
    targetType: "system",
    targetId: "daily-cost",
    thresholdUsd: config.dailyCostThresholdUsd,
    actualUsd: todayCost,
    adminPath: "/admin?tab=usage",
    metadata: {
      dayStart: dayStart.toISOString(),
    },
  }, options);
}

export async function evaluateSystemCostSpike(prisma, options = {}) {
  const config = getAdminAlertConfig(options.env);
  const now = options.now || new Date();
  const currentHourStart = startOfUtcHour(now);
  const previousWindowStart = new Date(currentHourStart.getTime() - 24 * 60 * 60 * 1000);
  const [currentHourCost, previousWindowCost] = await Promise.all([
    sumBillableCost(prisma, { createdAt: { gte: currentHourStart } }),
    sumBillableCost(prisma, { createdAt: { gte: previousWindowStart, lt: currentHourStart } }),
  ]);
  const hourlyBaseline = previousWindowCost / 24;
  const threshold = hourlyBaseline > 0
    ? hourlyBaseline * config.spikeMultiplier
    : config.dailyCostThresholdUsd;

  if (!threshold || currentHourCost < threshold) {
    return { status: "below_threshold", threshold, actualUsd: currentHourCost };
  }

  return recordAdminAlert(prisma, {
    alertType: ADMIN_ALERT_TYPES.systemCostSpike,
    severity: "warning",
    targetType: "system",
    targetId: "hourly-cost-spike",
    thresholdUsd: threshold,
    actualUsd: currentHourCost,
    adminPath: "/admin?tab=usage",
    metadata: {
      currentHourStart: currentHourStart.toISOString(),
      previousWindowStart: previousWindowStart.toISOString(),
      previousWindowCostUsd: previousWindowCost,
      hourlyBaselineUsd: hourlyBaseline,
      spikeMultiplier: config.spikeMultiplier,
    },
  }, options);
}

export async function evaluateFailedJobSpike(prisma, options = {}) {
  const config = getAdminAlertConfig(options.env);
  const windowStart = new Date(
    (options.now || new Date()).getTime() - config.dedupWindowMinutes * 60 * 1000,
  );
  const failedCount = await prisma.job.count({
    where: {
      status: "failed",
      completedAt: { gte: windowStart },
    },
  });

  if (failedCount < config.failedJobThreshold) {
    return { status: "below_threshold", threshold: config.failedJobThreshold, actualCount: failedCount };
  }

  return recordAdminAlert(prisma, {
    alertType: ADMIN_ALERT_TYPES.failedJobSpike,
    severity: "error",
    targetType: "system",
    targetId: "failed-jobs",
    thresholdCount: config.failedJobThreshold,
    actualCount: failedCount,
    adminPath: "/admin?tab=jobs",
    metadata: {
      windowStart: windowStart.toISOString(),
      windowMinutes: config.dedupWindowMinutes,
    },
  }, options);
}

export async function evaluateUsageAlertsForUser(prisma, userId, options = {}) {
  if (!prisma?.modelUsageEvent || !prisma?.adminAlert) {
    return [];
  }

  const checks = [
    evaluateUserCostThreshold,
    evaluateUserUsageSpike,
  ];

  const results = [];
  for (const check of checks) {
    try {
      results.push(await check(prisma, userId, options));
    } catch (error) {
      console.error("[admin-alerts] usage alert check failed", {
        userId,
        check: check.name,
        error: error instanceof Error ? error.message : String(error),
      });
      results.push({ status: "failed", error });
    }
  }

  return results;
}

export async function evaluateSystemUsageAlerts(prisma, options = {}) {
  if (!prisma?.modelUsageEvent || !prisma?.adminAlert) {
    return [];
  }

  const checks = [
    evaluateDailySystemCostThreshold,
    evaluateSystemCostSpike,
  ];

  const results = [];
  for (const check of checks) {
    try {
      results.push(await check(prisma, options));
    } catch (error) {
      console.error("[admin-alerts] system alert check failed", {
        check: check.name,
        error: error instanceof Error ? error.message : String(error),
      });
      results.push({ status: "failed", error });
    }
  }

  return results;
}

export async function evaluateJobAlertSweeps(prisma, options = {}) {
  if (!prisma?.job || !prisma?.adminAlert) {
    return [];
  }

  try {
    return [await evaluateFailedJobSpike(prisma, options)];
  } catch (error) {
    console.error("[admin-alerts] job alert sweep failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [{ status: "failed", error }];
  }
}
