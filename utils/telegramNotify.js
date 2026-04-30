const TELEGRAM_SEND_TIMEOUT_MS = 5_000;
const MAX_FIELD_LENGTH = 240;

const SECRET_PATTERNS = [
  /(authorization\s*[:=]\s*)(bearer\s+)?[^\s,;]+/gi,
  /(cookie\s*[:=]\s*)[^\n\r]+/gi,
  /((?:api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*)[^\s,;]+/gi,
  /(TELEGRAM_BOT_TOKEN\s*[:=]\s*)[^\s,;]+/gi,
  /(TELEGRAM_ADMIN_CHAT_ID\s*[:=]\s*)[^\s,;]+/gi,
  /(document\s+(?:text|content)|extracted\s+text|excerpt\s+content)\s*[:=]\s*[\s\S]+/gi,
];

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
  timestamp,
  details,
}) {
  const safeUserId = user?.id || userId;
  const safeErrorSummary = errorSummary || getErrorSummary(error) || "No error summary provided";
  const lines = [
    "StudyMaxing admin alert",
    `Environment: ${redactTelegramText(env)}`,
    `Event: ${redactTelegramText(eventType)}`,
  ];

  if (safeUserId || user?.email) {
    lines.push(`User: ${redactTelegramText(safeUserId || "unknown")}${user?.email ? ` / ${redactTelegramText(user.email)}` : ""}`);
  }
  if (documentId) {
    lines.push(`Document: ${redactTelegramText(documentId)}`);
  }
  if (jobId) {
    lines.push(`Job: ${redactTelegramText(jobId)}`);
  }
  if (generationType) {
    lines.push(`Generation: ${redactTelegramText(generationType)}`);
  }
  if (details) {
    lines.push(`Details: ${redactTelegramText(details)}`);
  }

  lines.push(`Error: ${safeErrorSummary}`);
  lines.push(`Timestamp: ${redactTelegramText(timestamp || new Date().toISOString())}`);

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
  details,
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
      details,
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
