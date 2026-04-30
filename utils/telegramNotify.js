const TELEGRAM_SEND_TIMEOUT_MS = 5_000;
const MAX_FIELD_LENGTH = 240;

const SECRET_PATTERNS = [
  /(authorization\s*[:=]\s*)(bearer\s+)?[^\s,;]+/gi,
  /(cookie\s*[:=]\s*)[^\n\r]+/gi,
  /((?:api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*)[^\s,;]+/gi,
  /(TELEGRAM_BOT_TOKEN\s*[:=]\s*)[^\s,;]+/gi,
  /(TELEGRAM_ADMIN_CHAT_ID\s*[:=]\s*)[^\s,;]+/gi,
  /((?:document|generated)\s+(?:text|content)|extracted\s+text|excerpt\s+content)\s*[:=]\s*[\s\S]+/gi,
];

const EVENT_METADATA = Object.freeze({
  extraction_permanent_failure: {
    label: "Extraction failed permanently",
    severity: "critical",
    action: "Check document extraction logs and file type.",
  },
  generation_permanent_failure: {
    label: "Generation failed permanently",
    severity: "critical",
    action: "Check worker logs, model/provider response, and generation inputs.",
  },
  job_failed_after_retries: {
    label: "Job failed after retries",
    severity: "critical",
    action: "Check worker logs and retry history.",
  },
  stale_job_recovered: {
    label: "Stale job recovered",
    severity: "warning",
    action: "Monitor job queue and worker heartbeat.",
  },
  cost_anomaly_created: {
    label: "Cost anomaly detected",
    severity: "warning",
    action: "Review user usage and cost anomaly dashboard.",
  },
  cost_anomaly_resolved: {
    label: "Cost anomaly resolved",
    severity: "info",
    action: "No action needed.",
  },
  telegram_test_alert: {
    label: "Telegram test alert",
    severity: "info",
    action: "No action needed.",
  },
  new_user_signup: {
    label: "New user signup",
    severity: "info",
    action: "Review user activity if needed.",
  },
  daily_admin_digest: {
    label: "Daily admin digest",
    severity: "info",
    action: "Review admin dashboard if any warnings are present.",
  },
});

function getEnvironmentName(env = process.env) {
  return env.RAILWAY_ENVIRONMENT
    || env.VERCEL_ENV
    || env.STAGE
    || env.NODE_ENV
    || "unknown";
}

function truncate(value, maxLength = MAX_FIELD_LENGTH) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

export function redactTelegramText(value) {
  if (value === undefined || value === null) {
    return "";
  }

  let text = String(value)
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, "$1[redacted]");
  }

  return truncate(text);
}

function getErrorSummary(error) {
  if (!error) {
    return "";
  }

  if (error instanceof Error) {
    return redactTelegramText(error.message || error.name);
  }

  return redactTelegramText(error);
}

function getEventMetadata(eventType) {
  return EVENT_METADATA[eventType] || {
    label: redactTelegramText(eventType || "Unknown event"),
    severity: "info",
    action: "Review backend logs.",
  };
}

function formatField(value, fallback = "n/a") {
  const redacted = redactTelegramText(value);
  return redacted || fallback;
}

function formatUser(user, userId) {
  const safeUserId = user?.id || userId;
  const safeEmail = user?.email;

  if (!safeUserId && !safeEmail) {
    return "n/a";
  }

  if (safeUserId && safeEmail) {
    return `${formatField(safeUserId)} / ${formatField(safeEmail)}`;
  }

  return formatField(safeUserId || safeEmail);
}

async function maybeGetUser(prisma, userId) {
  if (!prisma || !userId) {
    return null;
  }

  try {
    return await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true },
    });
  } catch (error) {
    console.error("[telegramNotify] failed to load notification user context:", {
      error: getErrorSummary(error),
      userId: redactTelegramText(userId),
    });
    return null;
  }
}

function buildMessage({
  env,
  eventType,
  user,
  userId,
  documentId,
  jobId,
  generationType,
  error,
  errorSummary,
  severity,
  timestamp,
  details,
  action,
}) {
  const metadata = getEventMetadata(eventType);
  const safeErrorSummary = errorSummary || getErrorSummary(error);
  const lines = [
    "🚨 StudyMaxing Admin Alert",
    `Environment: ${formatField(env)}`,
    `Event: ${formatField(metadata.label)}`,
    `Severity: ${formatField(severity || metadata.severity)}`,
    `User: ${formatUser(user, userId)}`,
    `Document: ${formatField(documentId)}`,
    `Job: ${formatField(jobId)}`,
    `Generation: ${formatField(generationType)}`,
    `Details: ${formatField(details)}`,
    `Error: ${formatField(safeErrorSummary)}`,
    `Time: ${formatField(timestamp || new Date().toISOString())}`,
    `Action: ${formatField(action || metadata.action)}`,
  ];

  return lines.join("\n");
}

export async function sendTelegramAdminNotification({
  eventType,
  user,
  userId,
  documentId,
  jobId,
  generationType,
  error,
  errorSummary,
  severity,
  details,
  action,
  timestamp = new Date().toISOString(),
  prisma,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_ADMIN_CHAT_ID;

  if (!botToken || !chatId) {
    return { status: "disabled" };
  }

  if (typeof fetchImpl !== "function") {
    console.error("[telegramNotify] fetch is unavailable; skipping Telegram notification");
    return { status: "failed" };
  }

  try {
    const resolvedUser = user || await maybeGetUser(prisma, userId);
    const message = buildMessage({
      env: getEnvironmentName(env),
      eventType,
      user: resolvedUser,
      userId,
      documentId,
      jobId,
      generationType,
      error,
      errorSummary,
      severity,
      details,
      action,
      timestamp,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TELEGRAM_SEND_TIMEOUT_MS);

    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = typeof response.text === "function" ? await response.text() : "";
        console.error("[telegramNotify] Telegram sendMessage failed:", {
          status: response.status,
          body: redactTelegramText(body),
        });
        return { status: "failed" };
      }

      return { status: "sent" };
    } finally {
      clearTimeout(timeout);
    }
  } catch (telegramError) {
    console.error("[telegramNotify] Telegram notification error:", {
      error: getErrorSummary(telegramError),
    });
    return { status: "failed" };
  }
}

export async function sendTelegramTestAlert(options = {}) {
  return sendTelegramAdminNotification({
    ...options,
    eventType: "telegram_test_alert",
    errorSummary: "Manual Telegram admin notification test",
  });
}
